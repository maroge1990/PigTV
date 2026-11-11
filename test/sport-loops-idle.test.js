const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #272 (audit C-5 / I-5): the sport event list rebuilt every 5 minutes (288 a day) and the fixture refresh ran every
// 30 minutes whether or not anyone looked; only the score collector was gated (#238). They now share the collector's
// "is anyone looking" rule (services/sportDemand.js), plus one reason the collector does not need: an enabled sport
// recording rule schedules future games from these two outputs with nobody looking, so it keeps both running.
// The old code has no sportDemand module and builds / fetches on every pass.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-loops-idle-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sportsEvents = load('services/sportsEvents');
sportsEvents._buildInline(true);
const fixtures = load('services/sportsFixtures');
const sqlite = load('db/sqlite');
const { initSchema } = load('db/recordingsDb');
const rules = load('services/recordingRules');
const sportDemand = (() => { try { return load('services/sportDemand'); } catch { return null; } })();

const M = 60 * 1000;
// A mocked clock that starts 2 s past a 5-minute boundary: the loop's timer then fires 4 min 59 s in, inside the 5-minute look window.
const aligned = () => Math.floor(Date.now() / (5 * M)) * 5 * M + 2000;
const settle = () => sportsEvents.idle();
const logs = [];
const realLog = console.log;

before(() => {
    initSchema();
    console.log = (...a) => { logs.push(a.join(' ')); };
    load('services/sportPagePrefs').setFollows(1, { sports: [{ sport: 'American football', leagues: ['NFL'] }] });
});
beforeEach(() => {
    sqlite.getDb().prepare('DELETE FROM recording_rules').run();
    sqlite.getDb().prepare('DELETE FROM scheduled_recordings').run();
    sportDemand?.reset();
    sportsEvents.stopBackgroundRebuilds();
    logs.length = 0;
});
after(() => {
    console.log = realLog;
    sportsEvents.stopBackgroundRebuilds();
    fixtures.stopBackgroundRefresh();
    sportsEvents.shutdown();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const addRule = (kind = 'team', enabled = 1) => sqlite.getDb().prepare(
    `INSERT INTO recording_rules (kind, match, pre_buffer_min, post_buffer_min, new_only, enabled, created_at, sport) VALUES (?, 'Bears', 0, 0, 0, ?, ?, 'American football')`)
    .run(kind, enabled, Date.now());

/** Count ESPN requests made while `fn` runs. */
async function countFetches(fn) {
    const original = global.fetch;
    let n = 0;
    global.fetch = async () => { n++; return { ok: false, status: 404, json: async () => ({}) }; };
    try { await fn(); for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); }
    finally { global.fetch = original; load('services/espnRequestPolicy').reset(); }
    return n;
}

test('events loop, nobody looking and no rule: six 5-minute timer passes build nothing, with one log line', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: aligned() });
    sportsEvents.reset();
    await sportsEvents.eventsFor({ hours: 72 });
    const builds = sportsEvents.stats.builds;
    sportsEvents.startBackgroundRebuilds();
    for (let i = 0; i < 6; i++) { t.mock.timers.tick(5 * M); await settle(); }
    sportsEvents.stopBackgroundRebuilds();
    assert.equal(sportsEvents.stats.builds, builds, 'no rebuild');
    assert.equal(logs.filter(l => /event list rebuild paused/.test(l)).length, 1, 'one line for the transition, not one per pass');
});

test('events loop: an enabled recording rule keeps it running; a disabled one or a series rule does not', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: aligned() });
    sportsEvents.reset();
    await sportsEvents.eventsFor({ hours: 72 });
    addRule('team', 0);
    addRule('series', 1);
    let builds = sportsEvents.stats.builds;
    sportsEvents.startBackgroundRebuilds();
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(5 * M); await settle(); }
    assert.equal(sportsEvents.stats.builds, builds, 'a disabled rule and a series rule need no sport list');
    sqlite.getDb().prepare('DELETE FROM recording_rules').run();
    addRule('team', 1);
    builds = sportsEvents.stats.builds;
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(5 * M); await settle(); }
    sportsEvents.stopBackgroundRebuilds();
    assert.equal(sportsEvents.stats.builds, builds + 3, 'one build per pass while a rule is on');
});

test('events loop: someone asking for sport, or a running recording, keeps it running', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: aligned() });
    sportsEvents.reset();
    await sportsEvents.eventsFor({ hours: 72 });
    sportsEvents.startBackgroundRebuilds();
    let builds = sportsEvents.stats.builds;
    sportDemand.noteAsk();
    t.mock.timers.tick(4 * M + 59000); await settle(); // the timer fires 4 min 59 s in
    assert.equal(sportsEvents.stats.builds, builds + 1, 'asked within the last 5 minutes');
    t.mock.timers.tick(5 * M); await settle();
    assert.equal(sportsEvents.stats.builds, builds + 1, '5 minutes after the ask: idle again');
    sqlite.getDb().prepare(`INSERT INTO scheduled_recordings (title, source_id, channel_item_id, program_start, program_end, status, created_at)
        VALUES ('x', 1, 'c', ?, ?, 'recording', ?)`).run(Date.now(), Date.now() + 3600000, Date.now());
    builds = sportsEvents.stats.builds;
    t.mock.timers.tick(5 * M); await settle();
    sportsEvents.stopBackgroundRebuilds();
    assert.equal(sportsEvents.stats.builds, builds + 1, 'a recording is running');
});

test('events loop: the first ask after an idle spell rebuilds at once, and the list is not served hours old', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: aligned() });
    sportsEvents.reset();
    const first = await sportsEvents.eventsFor({ hours: 72 });
    sportsEvents.startBackgroundRebuilds();
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(5 * M); await settle(); }
    const builds = sportsEvents.stats.builds;
    assert.equal(sportDemand.status().eventList.running, false);
    sportDemand.noteAsk();
    await settle();
    assert.equal(sportsEvents.stats.builds, builds + 1, 'the ask ran the skipped pass at once');
    assert.equal(sportDemand.status().eventList.running, true);
    assert.ok(logs.some(l => /event list rebuild resumed/.test(l)));
    sportsEvents.stopBackgroundRebuilds();

    // after the idle spell the cache is hours old: a request waits for the build instead of being handed it as current
    t.mock.timers.tick(3 * 60 * M);
    const second = await sportsEvents.eventsFor({ hours: 72 });
    assert.equal(sportsEvents.stats.builds, builds + 2, 'a request found a list more than two buckets old and waited for a fresh build');
    assert.notEqual(second.rev ?? second, first.rev ?? first);
});

test('fixtures loop: no ask and no rule: passes (and the one at start) make no ESPN request; a rule or an ask runs it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    assert.equal(await countFetches(async () => { for (let i = 0; i < 6; i++) { t.mock.timers.tick(30 * M); fixtures.refreshPass(); } }), 0, 'idle: nothing fetched');
    assert.equal(logs.filter(l => /fixture refresh paused/.test(l)).length, 1, 'one line for the transition');
    addRule('team', 1);
    assert.ok(await countFetches(async () => { fixtures.refreshPass(); }) > 0, 'an enabled rule keeps the refresh going');
    sqlite.getDb().prepare('DELETE FROM recording_rules').run();
    t.mock.timers.tick(30 * M);
    assert.equal(await countFetches(async () => { fixtures.refreshPass(); }), 0, 'rule gone: idle again');
    assert.ok(await countFetches(async () => { sportDemand.noteAsk(); }) > 0, 'the first ask after the idle spell fetches at once');
    assert.ok(logs.some(l => /fixture refresh resumed/.test(l)));
});

test('fixtures loop: creating a recording rule while idle refreshes at once', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    await countFetches(async () => { fixtures.refreshPass(); });
    assert.equal(sportDemand.status().fixtures.running, false);
    const n = await countFetches(async () => { assert.ok(rules.create({ kind: 'sport', match: 'Bears' }).rule); });
    assert.ok(n > 0, 'the new rule woke the fixture refresh');
});

test('Status facts: both loops say whether they are running and since when they are idle', async () => {
    fixtures.refreshPass(); sportsEvents.rebuildPass();
    const s = sportDemand.status();
    assert.equal(s.eventList.running, false);
    assert.equal(s.fixtures.running, false);
    assert.ok(Number.isFinite(s.eventList.idleSince));
    addRule('team', 1);
    sportsEvents.rebuildPass();
    assert.deepEqual({ ...sportDemand.status().eventList, idleSince: null }, { running: true, why: 'rule', idleSince: null });
});

test('the collector rule is unchanged: a rule alone does not give it the busy pace; a look or a recording does', () => {
    addRule('team', 1);
    assert.equal(sportDemand.demand(), null);
    assert.equal(sportDemand.loopDemand(), 'rule');
    const quiet = sportDemand.noteLook();
    assert.equal(quiet, true);
    assert.equal(sportDemand.demand(), 'looking');
    assert.equal(sportDemand.noteLook(), false, 'a second look is not a quiet spell');
});
