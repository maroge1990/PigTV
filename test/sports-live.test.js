const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

// 0152 (contract C-I): live or replay needs more than the title. Mark: "it is currently reporting
// MLB games being played, despite being 7am in the US" - a match-up airing at an implausible
// local time is almost always a rebroadcast titled like the live game. Three signals, in order:
//   (a) the guide's XMLTV flags, captured at ingest into epg_programs.flags:
//       <previously-shown/> -> replay; <live/>, <new/>, <premiere/> (or a "Live" category) -> live;
//   (b) the first airing of the same game within 36 h is live, later ones (> 30 min after) replays;
//   (c) a league's live hours in its home time zone (MLB: 11:00-23:30 New York): outside -> replay.
// The old code has no flags column, no resolveLive, and reads no programme that ended before now.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sports-live-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

// A database as 0147-0151 left it: categories, but no flags, in the table and the view.
fs.mkdirSync(path.join(sandbox, 'data'));
{
    const legacy = new Database(path.join(sandbox, 'data/content.db'));
    legacy.exec(`
        CREATE TABLE epg_programs (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, source_id INTEGER NOT NULL,
            start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, title TEXT, description TEXT, data JSON,
            gen INTEGER NOT NULL DEFAULT 0, categories TEXT);
        CREATE TABLE epg_state (source_id INTEGER PRIMARY KEY, active_gen INTEGER NOT NULL DEFAULT 0);
        CREATE VIEW epg_live AS
            SELECT p.id, p.channel_id, p.source_id, p.start_time, p.end_time, p.title, p.description, p.data, p.categories
            FROM epg_programs p LEFT JOIN epg_state s ON s.source_id = p.source_id
            WHERE p.gen = COALESCE(s.active_gen, 0);`);
    legacy.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title) VALUES (?, ?, ?, ?, ?)')
        .run('old.1', 99, 1000, 2000, 'Old programme');
    legacy.close();
}

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');
const epgParser = load('services/epgParser');
const classify = load('services/sportsClassify');
const sportsEvents = load('services/sportsEvents');

const H = 60 * 60 * 1000;
const M = 60 * 1000;
const { FLAGS } = classify;
// New York is on EDT (UTC-4) in late September.
const NY = (iso) => Date.parse(`${iso}-04:00`);
const EVENING = NY('2026-09-25T19:05:00');   // Yankees v Red Sox, live
const MORNING = NY('2026-09-26T07:00:00');   // the same game again at 7 am
const YANKEES = 'MLB: New York Yankees v Boston Red Sox';

after(() => {
    try { load('services/sportsEvents').shutdown(); } catch { /* never loaded */ }
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// ---- the classifier on its own ------------------------------------------------------------

let order = 0;
/** One airing as sportsEvents builds it, classified by classifyKind first. */
function airing(title, start, { hours = 3, flags = 0, league, channel = `Channel ${order}` } = {}) {
    const parsed = classify.parseTitle(title);
    const kind = classify.classifyKind({ title, start, parsed, rule: 'keyword', chTokens: new Set() });
    return {
        title, start, end: start + hours * H, parsed, kind: kind.kind, why: kind.why, flags, order: order++,
        league: league || classify.detectLeague(title) || 'Sport', channel: { name: channel }
    };
}
const resolve = (...list) => { classify.resolveLive(list); return list.map(a => `${a.kind}: ${a.why}`); };

test('(c) league hours: the MLB 7 am airing with nothing before it is a replay; an afternoon game is live', () => {
    assert.deepEqual(resolve(airing(YANKEES, MORNING)), ['replay: outside MLB hours (07:00 America/New_York)']);
    assert.deepEqual(resolve(airing(YANKEES, NY('2026-09-26T13:05:00'))), ['event: a match-up']);
    assert.deepEqual(resolve(airing(YANKEES, NY('2026-09-26T23:30:00'))), ['event: a match-up'], 'the window is inclusive');
    assert.deepEqual(resolve(airing(YANKEES, NY('2026-09-26T23:45:00'))), ['replay: outside MLB hours (23:45 America/New_York)']);
    // other zones, with their own daylight saving
    assert.deepEqual(resolve(airing('EPL: Arsenal v Chelsea', Date.parse('2026-09-26T05:00:00Z'))), ['replay: outside EPL hours (06:00 Europe/London)']);
    assert.deepEqual(resolve(airing('AFL: Carlton v Richmond', Date.parse('2026-10-10T08:40:00Z'))), ['event: a match-up'], '19:40 AEDT');
    assert.deepEqual(resolve(airing('AFL: Carlton v Richmond', Date.parse('2026-10-10T12:00:00Z'))), ['replay: outside AFL hours (23:00 Australia/Melbourne)']);
    // F1 travels: no hours; an unknown league neither
    assert.deepEqual(resolve(airing('F1: Azerbaijan GP Qualifying', NY('2026-09-26T04:00:00'))), ['event: a session (Qualifying)']);
    assert.deepEqual(resolve(airing('Rugby: Wallabies v All Blacks', MORNING)), ['event: a match-up']);
});

test('the hours table is easy to extend, and names leagues by any spelling', () => {
    assert.equal(classify.liveHoursFor('MLB Baseball').tz, 'America/New_York', 'category text that names a league');
    assert.equal(classify.liveHoursFor('Champions League').tz, 'Europe/London', 'UEFA');
    assert.equal(classify.liveHoursFor('A-League Men').tz, 'Australia/Melbourne');
    assert.equal(classify.liveHoursFor('F1'), null);
    classify.LIVE_HOURS.Rugby = { tz: 'Pacific/Auckland', from: '12:00', to: '21:00' };
    try {
        assert.deepEqual(resolve(airing('Rugby: Wallabies v All Blacks', MORNING, { league: 'Rugby' })),
            ['replay: outside Rugby hours (23:00 Pacific/Auckland)']);
    } finally {
        delete classify.LIVE_HOURS.Rugby;
    }
});

test('(b) the first airing wins: a later airing of the same game is a replay; a simulcast within 30 min is not', () => {
    const [live, simulcast, later] = resolve(
        airing('Rugby: Wallabies v All Blacks', MORNING, { channel: 'Stan Sport' }),
        airing('Wallabies vs All Blacks (Live)', MORNING + 20 * M),
        airing('Rugby Union: All Blacks v Wallabies', MORNING + 5 * H)
    );
    assert.equal(live, 'event: a match-up');
    assert.equal(simulcast, 'event: a match-up', 'the same airing on another channel');
    assert.equal(later, 'replay: aired first 5 h earlier (Stan Sport)', 'either order of the teams, no hours table needed');
    // beyond 36 h it is a new first airing
    assert.deepEqual(resolve(airing('Rugby: Wallabies v All Blacks', MORNING), airing('Rugby: Wallabies v All Blacks', MORNING + 37 * H)),
        ['event: a match-up', 'event: a match-up']);
    // sessions: league + grand prix + session
    assert.deepEqual(resolve(airing('F1: Azerbaijan GP Practice 3', MORNING, { channel: 'Sky Sports F1' }),
        airing('Formula 1 : Azerbaijan Practice 3', MORNING + 26 * H)),
    ['event: a session (Practice 3)', 'replay: aired first 26 h earlier (Sky Sports F1)'], 'F1 has no hours, so no "next game" either');
});

test('(b) a series: the same teams a day later inside league hours are the next game, not a replay', () => {
    const next = NY('2026-09-26T19:05:00');
    const got = resolve(airing(YANKEES, EVENING, { channel: 'MLB Network' }), airing(YANKEES, MORNING),
        airing(YANKEES, next, { channel: 'YES' }), airing(YANKEES, next + 4 * H));
    assert.deepEqual(got, [
        'event: a match-up',
        'replay: aired first 11 h 55 min earlier (MLB Network)',
        'event: a match-up, a day after the last airing and within MLB hours (the next game)',
        'replay: aired first 4 h earlier (YES)'
    ]);
});

test('(a) the guide\'s flags: previously-shown is a replay, live/new/premiere are live', () => {
    assert.deepEqual(resolve(airing(YANKEES, NY('2026-09-26T13:05:00'), { flags: FLAGS.PREVIOUSLY_SHOWN })),
        ['replay: previously shown, says the guide'], 'even inside MLB hours');
    assert.deepEqual(resolve(airing(YANKEES, MORNING, { flags: FLAGS.LIVE })), ['event: a match-up, flagged live in the guide']);
    assert.deepEqual(resolve(airing(YANKEES, MORNING, { flags: FLAGS.NEW })), ['event: a match-up, flagged new in the guide']);
    assert.deepEqual(resolve(airing(YANKEES, MORNING, { flags: FLAGS.PREMIERE })), ['event: a match-up, flagged a premiere in the guide']);
    assert.deepEqual(resolve(airing(YANKEES, MORNING, { flags: FLAGS.PREVIOUSLY_SHOWN | FLAGS.LIVE })), ['replay: previously shown, says the guide']);
});

test('precedence: flags > first airing > a "Live" title > league hours', () => {
    // a flag beats the first airing, both ways
    assert.deepEqual(resolve(airing(YANKEES, EVENING, { flags: FLAGS.PREVIOUSLY_SHOWN }), airing(YANKEES, MORNING)),
        ['replay: previously shown, says the guide', 'replay: outside MLB hours (07:00 America/New_York)'],
        'a replay is never the first airing others are measured from');
    assert.deepEqual(resolve(airing(YANKEES, EVENING), airing(YANKEES, MORNING, { flags: FLAGS.LIVE })),
        ['event: a match-up', 'event: a match-up, flagged live in the guide']);
    // the first airing beats a "Live" title and the hours
    const later = NY('2026-09-25T21:30:00');
    assert.deepEqual(resolve(airing(YANKEES, EVENING, { channel: 'ESPN' }), airing(`LIVE ${YANKEES}`, later)),
        ['event: a match-up', 'replay: aired first 2 h 25 min earlier (ESPN)'], 'inside MLB hours, "Live" in the title, still the second airing');
    // a "Live" title beats the hours
    assert.deepEqual(resolve(airing(`Live: ${YANKEES}`, MORNING)), ['event: a match-up, "live" in the title']);
    // an airing outside hours is not the first airing: the evening game after it is live
    assert.deepEqual(resolve(airing(YANKEES, MORNING), airing(YANKEES, NY('2026-09-26T19:05:00'))),
        ['replay: outside MLB hours (07:00 America/New_York)', 'event: a match-up']);
});

test('only events that name a game are touched: shows, placeholders and replays by title stay as they were', () => {
    assert.deepEqual(resolve(airing('MLB Tonight', MORNING), airing('MLB Classic: Yankees v Red Sox', MORNING),
        airing('MLB: Off Air', MORNING)).map(s => s.split(':')[0]), ['show', 'replay', 'placeholder']);
    assert.equal(resolve(airing('MLB Classic: Yankees v Red Sox', MORNING))[0], 'replay: a game with "classic"');
});

// ---- the MLB 7 am case, end to end ------------------------------------------------------------

const CHANNELS = ['MLB Network', 'ESPN', 'Fox Sports'].map((name, i) => ({ key: `1:c${i}`, order: i, tvgId: `c${i}`, sportChannel: false, name, quality: null }));
const prog = (ch, title, start, flags = null) => ({ channel_id: `c${ch}`, title, start_time: start, end_time: start + 3 * H, categories: '["Baseball"]', flags });
const kindsOf = (progs) => sportsEvents.eventsFromProgrammes(CHANNELS, progs, ['MLB'])
    .filter(e => e.start >= MORNING).map(e => [e.kind, e.kindRule]);

test('Mark\'s MLB 7 am case: an earlier 19:05 airing -> replay; none -> replay by hours; <live/> -> live', () => {
    assert.deepEqual(kindsOf([prog(0, YANKEES, EVENING), prog(1, YANKEES, MORNING)]),
        [['replay', 'replay: aired first 11 h 55 min earlier (MLB Network)']]);
    assert.deepEqual(kindsOf([prog(1, YANKEES, MORNING)]), [['replay', 'replay: outside MLB hours (07:00 America/New_York)']]);
    assert.deepEqual(kindsOf([prog(0, YANKEES, EVENING), prog(1, YANKEES, MORNING, FLAGS.LIVE)]),
        [['event', 'event: a match-up, flagged live in the guide']]);
    // two channels re-airing it at 7 am are one replay item
    const both = sportsEvents.eventsFromProgrammes(CHANNELS, [prog(0, YANKEES, EVENING), prog(1, YANKEES, MORNING), prog(2, 'MLB: Yankees vs Red Sox', MORNING)], ['MLB']);
    assert.deepEqual(both.map(e => [e.kind, e.title, e.channels.length]),
        [['event', 'New York Yankees v Boston Red Sox', 1], ['replay', 'New York Yankees v Boston Red Sox', 2]]);
});

// ---- ingest: the parser, the sync and the database ------------------------------------------

const T = (iso) => new Date(iso).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="mlb"><display-name>MLB Network</display-name><icon src="http://x.invalid/l.png"/></channel>
  <programme start="${T('2026-09-26T11:00:00Z')}" stop="${T('2026-09-26T14:00:00Z')}" channel="mlb">
    <title>${YANKEES}</title><category>Baseball</category><previously-shown start="20260925230500 +0000"/>
  </programme>
  <programme start="${T('2026-09-26T14:00:00Z')}" stop="${T('2026-09-26T15:00:00Z')}" channel="mlb">
    <title>MLB Tonight</title><previously-shown/>
  </programme>
  <programme start="${T('2026-09-26T17:05:00Z')}" stop="${T('2026-09-26T20:05:00Z')}" channel="mlb">
    <title>MLB: Mets v Braves</title><category>Baseball</category><live/>
  </programme>
  <programme start="${T('2026-09-26T20:05:00Z')}" stop="${T('2026-09-26T21:00:00Z')}" channel="mlb">
    <title>Documentary</title><premiere>First showing</premiere><new />
  </programme>
  <programme start="${T('2026-09-26T21:00:00Z')}" stop="${T('2026-09-26T23:00:00Z')}" channel="mlb">
    <title>MLB: Cubs v Cardinals</title><category>Sport</category><category>Live</category>
  </programme>
  <programme start="${T('2026-09-26T23:00:00Z')}" stop="${T('2026-09-27T01:00:00Z')}" channel="mlb">
    <title>Movie</title>
  </programme>
</tv>`;
const EXPECTED = [
    [YANKEES, FLAGS.PREVIOUSLY_SHOWN],
    ['MLB Tonight', FLAGS.PREVIOUSLY_SHOWN],
    ['MLB: Mets v Braves', FLAGS.LIVE],
    ['Documentary', FLAGS.PREMIERE | FLAGS.NEW],
    ['MLB: Cubs v Cardinals', FLAGS.LIVE],
    ['Movie', 0]
];

test('the parser collects the flags, in both the whole-document and the streaming parser', async () => {
    const whole = await epgParser.parse(XMLTV);
    assert.deepEqual(whole.programmes.map(p => [p.title, p.flags]), EXPECTED);
    assert.equal(whole.channels[0].flags, undefined, 'a channel has no flags');
    const { Readable } = require('node:stream');
    const streamed = [];
    for await (const batch of epgParser.parseStreaming(Readable.from([XMLTV]), 2)) streamed.push(...batch.programmes);
    assert.deepEqual(streamed.map(p => [p.title, p.flags]), EXPECTED);
    assert.deepEqual(epgParser.PROGRAMME_FLAGS, { 'previously-shown': FLAGS.PREVIOUSLY_SHOWN, premiere: FLAGS.PREMIERE, new: FLAGS.NEW, live: FLAGS.LIVE });
});

let epgSource, xtreamSource;
before(async () => {
    epgSource = await db.sources.create({ type: 'epg', name: 'Guide', url: 'http://guide.invalid/epg.xml' });
    xtreamSource = await db.sources.create({ type: 'xtream', name: 'Provider', url: 'http://xtream.invalid', username: 'u', password: 'p' });
});
async function withFetch(handler, fn) {
    const originalFetch = global.fetch;
    global.fetch = async (url) => handler(String(url));
    try { return await fn(); } finally { global.fetch = originalFetch; }
}
const stored = (sourceId) => sqlite.getDb().prepare('SELECT title, flags FROM epg_live WHERE source_id = ? ORDER BY start_time')
    .all(sourceId).map(r => [r.title, r.flags ?? 0]);

test('an older database gains the flags column, and its epg_live view is made again with it', () => {
    const d = sqlite.getDb();
    assert.ok(d.prepare('PRAGMA table_info(epg_programs)').all().some(c => c.name === 'flags'));
    const view = d.prepare('PRAGMA table_info(epg_live)').all().map(c => c.name);
    assert.ok(view.includes('flags') && view.includes('categories'));
    assert.deepEqual({ ...d.prepare('SELECT title, flags FROM epg_live WHERE source_id = 99').get() }, { title: 'Old programme', flags: null });
    sqlite.initSchema();
    assert.ok(d.prepare('PRAGMA table_info(epg_live)').all().some(c => c.name === 'flags'), 'opening again leaves it alone');
});

test('an XMLTV source sync and an Xtream sync (xmltv.php) store the flags', async () => {
    await withFetch(() => new Response(XMLTV), () => sync.syncSource(epgSource.id));
    assert.deepEqual(stored(epgSource.id), EXPECTED);
    await withFetch((url) => new Response(url.includes('xmltv.php') ? XMLTV : '[]'), () => sync.syncSource(xtreamSource.id));
    assert.deepEqual(stored(xtreamSource.id), EXPECTED);
    const raw = sqlite.getDb().prepare(`SELECT flags FROM epg_programs WHERE source_id = ? AND title = 'Movie'`).get(epgSource.id);
    assert.equal(raw.flags, null, 'no flags is NULL');
});

test('a build reads the 36 h before now, so a re-air inside MLB hours is told from last night\'s game', async () => {
    const d = sqlite.getDb();
    d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, tvg_id, is_hidden)
               VALUES (?, 600, ?, 'live', ?, 'Sport', ?, ?, ?, 0)`).run('600:a', 'a', 'MLB Network', 1, 'sa', 'live.a');
    const ins = d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories) VALUES (?, 600, ?, ?, ?, ?)');
    const afternoon = NY('2026-09-26T13:00:00');
    ins.run('live.a', EVENING, EVENING + 3 * H, YANKEES, '["Baseball"]');       // ended 15 h before
    ins.run('live.a', afternoon, afternoon + 3 * H, YANKEES, '["Baseball"]');   // inside MLB hours
    sportsEvents.reset();
    const { events } = await sportsEvents.eventsFor({ now: afternoon + 10 * M, hours: 6, withRule: true, include: 'all' });
    const game = events.filter(e => e.title === 'New York Yankees v Boston Red Sox');
    assert.deepEqual(game.map(e => [e.kind, e.kindRule, e.live]),
        [['replay', 'replay: aired first 17 h 55 min earlier (MLB Network)', true]], 'last night\'s game is not listed, but counted');
});
