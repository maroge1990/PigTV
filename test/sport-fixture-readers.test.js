const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #272 (D-1): ESPN's scoreboards were fetched and stored twice, by the fixture refresh (sport_fixtures, read by the
// guide's live/replay classification through sportsFixtures.snapshot) and by the score collector
// (sports_dashboard_catalog, read by the front page, follows, the dashboard and recording rules). This file pins what
// every READER answers for the same recorded ESPN scoreboards, whichever store feeds it: the snapshot the classifier
// reads, the live/replay verdict of a set of airings, the collector's catalogue, and the games a sport rule and a team
// rule would schedule. The answers are kept in test/golden/sport-fixture-readers.json (GOLDEN_UPDATE=1 rewrites it);
// a change that moves any of them must say so in its commit message.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-fixture-readers-')));
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
const sportsEvents = load('services/sportsEvents');
const rules = load('services/recordingRules');
const requestPolicy = load('services/espnRequestPolicy');
const sportCatalog = load('services/sportCatalog');

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const GOLDEN = path.join(__dirname, 'golden/sport-fixture-readers.json');
const UPDATE = process.env.GOLDEN_UPDATE === '1';
const FX = path.join(__dirname, 'fixtures/espn');
const readFx = name => JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
const H = 3600000, M = 60000;

// #195: the International cricket groups take a series by its matches' class; the captured panel kept no events.
function cricketPanel() {
    const panel = readFx('cricket-scorepanel');
    panel.scores[0].events = [{ competitions: [{ class: { internationalClassId: '3' } }] }];
    for (const block of panel.scores.slice(1)) block.events = [{ competitions: [{ class: { internationalClassId: '0' } }] }];
    return panel;
}

// Each scenario: one league, the time the fetches happen, and ESPN's answer per scoreboard day (every other day of the
// window answers with no events, as ESPN does). `teams`: the league's /teams answer.
const SCENARIOS = [
    { league: 'NFL', path: 'football/nfl', now: '2026-09-27T12:00Z', days: { 20260927: 'nfl-20260927' }, teams: 'teams-nfl' },
    { league: 'MLB', path: 'baseball/mlb', now: '2026-09-27T14:00Z', days: { 20260927: 'mlb-20260927' } },
    { league: 'NBA', path: 'basketball/nba', now: '2026-10-03T15:00Z', days: { 20261003: 'nba-20261003' } },
    { league: 'AFL', path: 'australian-football/afl', now: '2026-09-26T12:00Z', days: { 20260926: 'afl-20260926' }, teams: 'teams-afl' },
    { league: 'F1', path: 'racing/f1', now: '2026-09-25T14:00Z', days: { 20260924: 'f1-scoreboard', 20260925: 'f1-scoreboard', 20260926: 'f1-scoreboard' } },
    // before noon UTC: the fixture window (36 h back) reaches the day before yesterday, where FP1 and FP2 are
    { league: 'F1', name: 'F1 morning', path: 'racing/f1', now: '2026-09-26T08:00Z', days: { 20260924: 'f1-scoreboard', 20260925: 'f1-scoreboard', 20260926: 'f1-scoreboard' } },
    { league: 'IPL', path: 'cricket/8048', now: '2026-05-31T12:00Z', days: { 20260531: 'ipl-scoreboard' } },
    { league: 'BBL', path: 'cricket/8044', now: '2026-12-12T12:00Z', days: { 20261212: 'bbl-scoreboard' } },
    { league: 'Cricket', path: 'cricket/24377', now: '2026-09-27T12:00Z', days: { 20260927: 'cricket-24377-20260927' }, panel: true }
];

/** global.fetch answering as ESPN would for one scenario; returns the list of URLs asked. */
function serve(s) {
    const asked = [];
    global.fetch = async (url) => {
        url = String(url);
        asked.push(url);
        const body = (json) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
            body: new Response(JSON.stringify(json)).body, json: async () => json, text: async () => JSON.stringify(json) });
        if (url.includes('cricket/scorepanel')) return body(s.panel ? cricketPanel() : { scores: [] });
        if (url.includes(`/${s.path}/teams`)) return s.teams ? body(readFx(s.teams)) : { ok: false, status: 404, headers: new Headers(), body: null, json: async () => ({}) };
        if (url.includes(`/${s.path}/scoreboard`)) {
            const day = /dates=(\d{8})/.exec(url)?.[1];
            return body(day && s.days[day] ? readFx(s.days[day]) : { events: [] });
        }
        if (url.includes('/scoreboard')) return body({ events: [] });
        return { ok: false, status: 404, headers: new Headers(), body: null, json: async () => ({}) };
    };
    return asked;
}

function clearStores() {
    const db = sqlite.getDb();
    for (const t of ['sport_fixtures', 'sport_fixture_teams', 'sport_fixture_status']) db.prepare(`DELETE FROM ${t}`).run();
    dashboard.store();
    for (const t of ['sports_dashboard_catalog', 'sports_score_history']) db.prepare(`DELETE FROM ${t}`).run();
}

/** Run everything the server runs to fill its stores for one scenario at its time: the fixture refresh (while it
 * exists), then the score collector until its window is answered. */
async function fill(s) {
    clearStores();
    requestPolicy.reset();
    const original = global.fetch;
    const now = Date.parse(s.now);
    try {
        serve(s);
        if (s.panel) await fixtures.refreshCricket({ now, league: s.league });
        else await fixtures.refreshLeague(s.league, { now });
        const c = dashboard.createCollector({ store: dashboard.store(), clock: () => now, enabled: () => true,
            leagues: () => new Set([s.league]), followed: () => new Map(), feedGames: async () => ({ ok: true, games: [] }),
            recordFeed: () => {}, busy: () => true, every: () => null });
        for (let i = 0; i < 6; i++) await c.refresh();
        c.stop();
    } finally {
        global.fetch = original;
        requestPolicy.reset();
    }
}

let order = 0;
function airing(title, start, league, hours = 3) {
    const parsed = classify.parseTitle(title);
    const kind = classify.classifyKind({ title, start, parsed, rule: 'keyword', chTokens: new Set() });
    return { title, start, end: start + hours * H, parsed, kind: kind.kind, why: kind.why, flags: 0, order: order++, league, channel: { name: 'x' } };
}

const sides = list => (list || []).map(side => side.tokens.join(' '));
/** The snapshot as plain, ordered data (the store's row order is not part of the answer). */
function plainSnapshot(snap) {
    const out = {};
    for (const [league, data] of snap) {
        out[league] = {
            fixtures: data.fixtures.map(f => ({ start: new Date(f.start).toISOString(), end: f.end ? new Date(f.end).toISOString() : null,
                teams: f.teamsAliases ? f.teamsAliases.map(sides) : null, session: f.session, location: f.location }))
                .sort((a, b) => a.start.localeCompare(b.start) || JSON.stringify(a).localeCompare(JSON.stringify(b))),
            rosterTeams: data.teamsAliases.length,
            covered: Boolean(data.coverage && Number.isFinite(data.coverage.from) && Number.isFinite(data.coverage.to))
        };
    }
    return out;
}

/** The airings each scenario asks the classifier about: every game at its start, a day later, and long before; a pair
 * of known teams with no game; for F1 each session, a session at the wrong time and last weekend's race midweek. */
function airingsFor(s, snap) {
    const now = Date.parse(s.now);
    const games = (snap.get(s.league)?.fixtures || []);
    const list = [];
    const prefix = ['Cricket', 'IPL', 'BBL'].includes(s.league) ? '' : `${s.league}: `;
    for (const f of games) {
        if (f.teamsAliases) {
            const [a, b] = f.teamsAliases.map(x => x[0].name);
            list.push(airing(`${prefix}${a} v ${b}`, f.start, s.league));
            list.push(airing(`${prefix}${b} v ${a}`, f.start + 20 * H, s.league));
            list.push(airing(`${prefix}${a} v ${b}`, f.start - 30 * H, s.league));
        } else if (f.session) {
            list.push(airing(`F1: Azerbaijan Grand Prix ${f.session.label}`, f.start, s.league, 2));
            list.push(airing(`F1: Azerbaijan Grand Prix ${f.session.label}`, f.start + 26 * H, s.league, 2));
        }
    }
    if (s.league === 'F1') {
        list.push(airing('F1: Azerbaijan Grand Prix Race', now + 60 * H, s.league, 2));
        list.push(airing('F1: Singapore Grand Prix Race', now - 20 * H, s.league, 2));
        list.push(airing('F1: Azerbaijan Grand Prix Practice 1', now - 30 * H, s.league, 2));
    }
    const roster = snap.get(s.league)?.teamsAliases || [];
    if (roster.length >= 2) {
        const playing = new Set(games.flatMap(f => (f.teamsAliases || []).map(x => x[0].tokens.join(' '))));
        const idle = roster.map(x => x[0]).filter(side => !playing.has(side.tokens.join(' '))).slice(0, 2);
        if (idle.length === 2) {
            list.push(airing(`${prefix}${idle[0].name} v ${idle[1].name}`, now + 6 * H, s.league));
            list.push(airing(`${prefix}${idle[0].name} v ${idle[1].name}`, now - 30 * H, s.league));
        }
    }
    return list;
}

const sportOf = league => sportCatalog.sportOf(league);

/** The games a sport rule and a team rule would schedule from these stores (recordingRules' own selection). */
async function ruleSets(s, snap) {
    const now = Date.parse(s.now) - 40 * H; // every airing below is still to start
    const list = airingsFor(s, snap);
    const channels = list.map((a, i) => ({ key: `1:${i}`, id: `1:${i}`, sourceId: 1, order: i, tvgId: `ch${i}`, name: `Sport ${i}`, sportChannel: true }));
    const progs = list.map((a, i) => ({ channel_id: `ch${i}`, title: a.title, start_time: a.start, end_time: a.end, flags: 0 }));
    const rosters = new Map([[s.league, fixtures.teamsOf(s.league)]]);
    const follow = sportsEvents.compileFollow([s.league], rosters);
    const events = sportsEvents.eventsFromProgrammes(channels, progs, follow, snap);
    const sport = events.filter(e => (!e.kind || e.kind === 'event') && sportsEvents.followedKeyword(follow, e.title, e.aliases || [], e.league ? [e.league] : []))
        .map(e => `${e.title} @ ${new Date(e.start).toISOString()} on ${e.channels.map(c => c.key).join(',')}`).sort();
    const games = dashboard.store().catalog();
    const first = games.find(g => g.competitors?.length)?.competitors[0].name;
    const team = first ? (await rules.teamCandidates({ kind: 'team', match: first, sport: sportOf(s.league), created_by: null }, now, { games, events }))
        .map(c => `${c.identity} @ ${new Date(c.start).toISOString()} on ${c.channelId}`).sort() : [];
    return { sport, team };
}

async function answers() {
    const out = {};
    for (const s of SCENARIOS) {
        await fill(s);
        const now = Date.parse(s.now);
        const snap = fixtures.snapshot(new Set([s.league]));
        const list = airingsFor(s, snap);
        classify.resolveLive(list, snap, now + 10 * M);
        out[s.name || s.league] = {
            snapshot: plainSnapshot(snap),
            verdicts: list.map(a => `${a.title} @ ${new Date(a.start).toISOString()}: ${a.kind}: ${a.why}`),
            catalog: dashboard.store().catalog().map(g => ({ id: g.id, league: g.league, start: new Date(g.start).toISOString(), title: g.title,
                competitors: (g.competitors || []).map(c => c.name), session: g.session || null })),
            rules: await ruleSets(s, snap)
        };
    }
    return out;
}

test('every reader of the scoreboards answers as pinned, for the same recorded ESPN answers', async () => {
    load('db/recordingsDb').initSchema();
    const got = await answers();
    if (UPDATE) { fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n'); return; }
    const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const name of Object.keys(want)) {
        assert.deepEqual(got[name].snapshot, want[name].snapshot, `${name}: the classifier's snapshot`);
        assert.deepEqual(got[name].verdicts, want[name].verdicts, `${name}: live/replay verdicts`);
        assert.deepEqual(got[name].catalog, want[name].catalog, `${name}: the collector's catalogue`);
        assert.deepEqual(got[name].rules, want[name].rules, `${name}: what a sport and a team rule would schedule`);
    }
    assert.deepEqual(Object.keys(got), Object.keys(want));
});

test('the pinned answers really use ESPN: every scenario has an ESPN verdict', () => {
    const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const [name, a] of Object.entries(want)) assert.ok(a.verdicts.some(v => /ESPN/.test(v)), `${name} has an ESPN verdict`);
});
