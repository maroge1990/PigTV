const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #272 (D-1): with the score collector on, the guide's live/replay classifier (sportsFixtures.snapshot, read by
// sportsEvents' build) takes ESPN's games from the collector's store: the cards its last complete window listed, that
// window's span and time (sports_dashboard_coverage, 0550). What the fixture refresh's own store gave it must hold: a
// game a complete answer no longer lists is gone (its full replace), a day that fails keeps what the last complete window
// had, a multi-day cricket match keeps ESPN's end. On 0550 snapshot() reads only sport_fixtures, which nothing here fills.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-facts-catalog-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
delete process.env.PIGTV_SPORTS_DASHBOARD;
delete process.env.PIGTV_SPORT_FIXTURES;

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const classify = load('services/sportsClassify');
const fixtures = load('services/sportsFixtures');
const dashboard = load('services/sportsDashboard');
const requestPolicy = load('services/espnRequestPolicy');

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const FX = path.join(__dirname, 'fixtures/espn');
const readFx = name => JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
const H = 3600000, M = 60000;

function clear() {
    const db = sqlite.getDb();
    dashboard.store();
    for (const t of ['sport_fixtures', 'sport_fixture_teams', 'sport_fixture_status', 'sports_dashboard_catalog', 'sports_score_history', 'sports_dashboard_coverage'])
        db.prepare(`DELETE FROM ${t}`).run();
}

/** A collector over `answer(url)` at a movable clock, writing the server's own store. */
function collector(league, at, answer) {
    requestPolicy.reset();
    const clock = { now: Date.parse(at) };
    const c = dashboard.createCollector({ store: dashboard.store(), clock: () => clock.now, enabled: () => true,
        leagues: () => new Set([league]), followed: () => new Map(), feedGames: async () => ({ ok: true, games: [] }),
        recordFeed: () => {}, busy: () => true, every: () => null, windowDemand: () => true,
        fetchJson: async (url) => { const a = answer(url); if (a instanceof Error) throw a; return a; } });
    return { c, clock, refresh: async (n = 4) => { for (let i = 0; i < n; i++) await c.refresh(); } };
}

async function nflRoster() {
    const original = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
        body: new Response(JSON.stringify(readFx('teams-nfl'))).body });
    try { await fixtures.rosterFor('NFL'); } finally { global.fetch = original; requestPolicy.reset(); }
}

let order = 0;
function verdict(snap, now, title, start, league) {
    const parsed = classify.parseTitle(title);
    const kind = classify.classifyKind({ title, start, parsed, rule: 'keyword', chTokens: new Set() });
    const a = { title, start, end: start + 3 * H, parsed, kind: kind.kind, why: kind.why, flags: 0, order: order++, league, channel: { name: 'x' } };
    classify.resolveLive([a], snap, now);
    return `${a.kind}: ${a.why}`;
}

test('a game a complete window no longer lists is gone, as the fixture refresh\'s full replace removed it', async () => {
    clear();
    await nflRoster();
    let board = readFx('nfl-20260927');
    const r = collector('NFL', '2026-09-27T12:00Z', url => url.includes('football/nfl/scoreboard') && url.includes('dates=20260927') ? board : { events: [] });
    await r.refresh();
    const kickoff = Date.parse('2026-09-27T17:00Z');
    let snap = fixtures.snapshot(new Set(['NFL']));
    assert.equal(snap.get('NFL').fixtures.length, 4);
    assert.equal(snap.get('NFL').coverage.at, Date.parse('2026-09-27T12:00Z'), 'the oldest answer\'s time: the classifier ages it');
    assert.equal(verdict(snap, r.clock.now, 'NFL: Chargers v Bills', kickoff, 'NFL'), 'event: a match-up, ESPN: the game started Sun 1:00 pm');

    board = { ...board, events: board.events.filter(e => e.id !== '401872953') }; // Chargers at Bills taken off
    r.clock.now += 16 * M;
    await r.refresh();
    r.c.stop();
    snap = fixtures.snapshot(new Set(['NFL']));
    assert.equal(snap.get('NFL').fixtures.length, 3);
    assert.ok(dashboard.store().catalog().some(g => g.id === 'espn:football/nfl:401872953'), 'the front page\'s catalogue still holds it (unchanged)');
    assert.equal(verdict(snap, r.clock.now, 'NFL: Chargers v Bills', kickoff, 'NFL'), 'replay: ESPN has no such game at this time');
});

test('a day that fails keeps what the last complete window listed, and its time', async () => {
    clear();
    let failing = false;
    const r = collector('NFL', '2026-09-27T12:00Z', url => {
        if (failing && url.includes('dates=20260927')) return Object.assign(new Error('Score source unavailable'), { status: 503, hostBackoffRecorded: true });
        return url.includes('football/nfl/scoreboard') && url.includes('dates=20260927') ? readFx('nfl-20260927') : { events: [] };
    });
    await r.refresh();
    const before = fixtures.snapshot(new Set(['NFL'])).get('NFL');
    failing = true;
    r.clock.now += 16 * M;
    await r.refresh();
    r.c.stop();
    const after = fixtures.snapshot(new Set(['NFL'])).get('NFL');
    assert.equal(after.fixtures.length, 4);
    assert.deepEqual(after.coverage, before.coverage);
});

test('a multi-day cricket match keeps ESPN\'s end (the card has none): day 3 is live, an overnight block is not', async () => {
    clear();
    const panel = { scores: [{ leagues: [{ id: '24377', name: 'Tour' }], events: [{ competitions: [{ class: { internationalClassId: '3' } }] }] }] };
    const r = collector('Cricket', '2026-09-28T12:00Z', url => url.includes('cricket/scorepanel') ? panel
        : url.includes('cricket/24377/scoreboard') && url.includes('dates=20260927') ? readFx('cricket-24377-20260927') : { events: [] });
    await r.refresh(6);
    r.c.stop();
    const snap = fixtures.snapshot(new Set(['Cricket']));
    assert.equal(snap.get('Cricket').fixtures[0].end, Date.parse('2026-10-01T23:59Z'));
    const day3 = Date.parse('2026-09-29T04:00Z');
    assert.match(verdict(snap, r.clock.now, 'India Under-19s v Australia Under-19s', day3, 'Cricket'), /^event: .*ESPN: the game started/);
    assert.match(verdict(snap, r.clock.now, 'India Under-19s v Australia Under-19s', day3 + 14 * H, 'Cricket'), /^replay: ESPN/);
});

test('a card stored before 0550 (no ESPN facts) is read with its own end; a league never wholly answered reads the old store, else is left out', async () => {
    clear();
    const store = dashboard.store();
    const [card] = load('services/sportsScoresEspn').normalize(readFx('nba-20261003'), 'NBA', 'basketball/nba');
    const { fixture, ...old } = card;
    assert.ok(fixture);
    store.ingest([old], Date.parse('2026-10-03T12:00Z'));
    store.putCoverage('NBA', { from: 0, to: Date.parse('2026-10-06T12:00Z'), at: Date.parse('2026-10-03T12:00Z'), listed: [card.id] });
    // the first minutes after an upgrade: the fixture refresh's last store answers for a league the collector has not
    // wholly answered yet (bounded by its own window and age, as before)
    const db = sqlite.getDb();
    db.prepare(`INSERT INTO sport_fixture_status (league, last_success_at, covered_from, covered_to) VALUES ('MLB', ?, ?, ?)`)
        .run(Date.parse('2026-10-03T11:00Z'), Date.parse('2026-10-01T23:00Z'), Date.parse('2026-10-06T11:00Z'));
    const snap = fixtures.snapshot(new Set(['NBA', 'NFL', 'MLB']));
    assert.deepEqual([...snap.keys()], ['NBA', 'MLB'], 'NFL has no window in either store: the heuristics answer for it');
    assert.deepEqual(snap.get('MLB').coverage, { from: Date.parse('2026-10-01T23:00Z'), to: Date.parse('2026-10-06T11:00Z'), at: Date.parse('2026-10-03T11:00Z') });
    assert.equal(snap.get('NBA').fixtures[0].end, null);
    assert.equal(snap.get('NBA').fixtures[0].start, Date.parse('2026-10-03T23:00Z'));
});
