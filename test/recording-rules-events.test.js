const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// F4 (23 Oct fix review, 0245; DVR-3): which Sport event a rule's schedule is. A Sport event's id
// changes with its time, so 0237 matched by title within six hours - which merged two real matches
// three hours apart and let a cancelled one moved seven hours come back. The real rule service and
// engine over a sandboxed database; Sport's events are given directly (sportsEvents.eventsFor), as
// the guide would produce them, with the ids changing as their times do.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-rule-events-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const engine = load('services/recordingEngine');
engine._setPrepareQueue(false);
const sportsEvents = load('services/sportsEvents');
const rules = load('services/recordingRules');
const { scheduled, initSchema } = load('db/recordingsDb');

const H = 3600000;
const NOW = Date.now();
const TITLE = 'AFL: Collingwood v Carlton';
let source, events = [];
const realLog = console.log;

before(async () => {
    console.log = () => {};
    initSchema();
    source = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, stream_url)
        VALUES (?, ?, 'pos_1', 'live', 'Fox Footy', 'Sport', 1, 'ff', 'http://provider.invalid/1.ts')`).run(`${source.id}:pos_1`, source.id);
    sportsEvents.eventsFor = async () => ({ events });
});
beforeEach(() => {
    const d = sqlite.getDb();
    d.prepare('DELETE FROM recording_rule_hits').run();
    d.prepare('DELETE FROM recording_rules').run();
    d.prepare('DELETE FROM scheduled_recordings').run();
});
after(() => {
    console.log = realLog;
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

// Sport's id is a hash of title and start: a moved event is a new id, as here.
const ev = (start, title = TITLE) => ({ id: `${title}@${start}`, kind: 'event', title, aliases: [], league: 'AFL', start, end: start + 3 * H,
    channels: [{ sourceId: source.id, id: 'pos_1', name: 'Fox Footy' }] });
const rule = () => rules.create({ kind: 'sport', match: 'Collingwood' }).rule;
const ofRule = (id) => sqlite.getDb().prepare('SELECT * FROM scheduled_recordings WHERE rule_id = ? ORDER BY program_start').all(id);

test('F4: two matches of the same teams three hours apart are two recordings, not one', async () => {
    const r = rule();
    events = [ev(NOW + 2 * H)];
    assert.equal((await rules.evaluate({ now: NOW })).length, 1);
    events = [ev(NOW + 2 * H), ev(NOW + 5 * H)]; // the second game of a doubleheader appears in the guide
    const made = await rules.evaluate({ now: NOW });
    assert.equal(made.length, 1, 'the second match is its own event');
    assert.deepEqual(ofRule(r.id).map(s => s.program_start), [NOW + 2 * H, NOW + 5 * H]);
});

test('F4: both matches appearing together are both recorded', async () => {
    const r = rule();
    events = [ev(NOW + 2 * H), ev(NOW + 3 * H)];
    assert.equal((await rules.evaluate({ now: NOW })).length, 2);
    assert.equal(ofRule(r.id).length, 2);
});

for (const hours of [0.33, 2, 7, 26]) {
    test(`F4: a cancelled match the guide moves ${hours} h stays cancelled`, async () => {
        rule();
        events = [ev(NOW + 2 * H)];
        const [made] = await rules.evaluate({ now: NOW });
        await engine.cancelScheduled(made.scheduleId);
        events = [ev(NOW + 2 * H + hours * H)]; // the original slot is gone: the same match, moved
        assert.deepEqual(await rules.evaluate({ now: NOW }), []);
        events = [ev(NOW + 2 * H + hours * H + 0.5 * H)]; // and moved again
        assert.deepEqual(await rules.evaluate({ now: NOW }), [], 'still cancelled after a second move');
        assert.equal(scheduled.listUpcoming().filter(s => s.title === TITLE).length, 0);
    });
}

test('F4: a cancelled match stays cancelled, and another match of the same teams beside it is still recorded', async () => {
    const r = rule();
    events = [ev(NOW + 2 * H)];
    const [made] = await rules.evaluate({ now: NOW });
    await engine.cancelScheduled(made.scheduleId);
    events = [ev(NOW + 2 * H), ev(NOW + 4 * H)];
    const again = await rules.evaluate({ now: NOW });
    assert.equal(again.length, 1);
    assert.equal(again[0].start, NOW + 4 * H);
    assert.deepEqual(ofRule(r.id).map(s => [s.program_start, s.status]), [[NOW + 2 * H, 'cancelled'], [NOW + 4 * H, 'scheduled']]);
});

test('F4: a pending recording follows its match when the guide moves it (no second recording)', async () => {
    const r = rule();
    events = [ev(NOW + 2 * H)];
    await rules.evaluate({ now: NOW });
    events = [ev(NOW + 5 * H)];
    assert.deepEqual(await rules.evaluate({ now: NOW }), []);
    const [s] = ofRule(r.id);
    assert.equal(ofRule(r.id).length, 1);
    assert.deepEqual([s.program_start, s.program_end, s.status], [NOW + 5 * H, NOW + 8 * H, 'scheduled']);
});

test('F4: a match that has already happened is not taken for one that moved - the next game is recorded', async () => {
    const r = rule();
    events = [ev(NOW + 2 * H)];
    const [made] = await rules.evaluate({ now: NOW });
    await engine.cancelScheduled(made.scheduleId);
    const later = NOW + 4 * H; // the cancelled game's time has passed
    events = [ev(later + 20 * H)];
    const next = await rules.evaluate({ now: later });
    assert.equal(next.length, 1, 'the following day\'s game is a new one');
    assert.equal(ofRule(r.id).length, 2);
});

test('D3: a pending recording follows its match back when the guide corrects it A -> B -> A', async () => {
    const r = rule();
    events = [ev(NOW + 2 * H)];
    await rules.evaluate({ now: NOW });
    events = [ev(NOW + 5 * H)];
    await rules.evaluate({ now: NOW });
    assert.equal(ofRule(r.id)[0].program_start, NOW + 5 * H);
    events = [ev(NOW + 2 * H)]; // the correction is withdrawn: this identity was seen (hit) before
    assert.deepEqual(await rules.evaluate({ now: NOW }), []);
    const all = ofRule(r.id);
    assert.equal(all.length, 1, 'still one recording');
    assert.deepEqual([all[0].program_start, all[0].program_end, all[0].status], [NOW + 2 * H, NOW + 5 * H, 'scheduled']);
    events = [ev(NOW + 5 * H)]; // and once more
    await rules.evaluate({ now: NOW });
    assert.deepEqual(ofRule(r.id).map(x => x.program_start), [NOW + 5 * H]);
});

test('D3: a cancelled match corrected A -> B -> A stays cancelled and is not recorded again', async () => {
    const r = rule();
    events = [ev(NOW + 2 * H)];
    const [made] = await rules.evaluate({ now: NOW });
    await engine.cancelScheduled(made.scheduleId);
    for (const at of [NOW + 5 * H, NOW + 2 * H, NOW + 5 * H]) {
        events = [ev(at)];
        assert.deepEqual(await rules.evaluate({ now: NOW }), []);
    }
    assert.deepEqual(ofRule(r.id).map(x => x.status), ['cancelled']);
});

test('D4: a recording already running in its pre-buffer never absorbs a later match of the same teams', async () => {
    const r = rule();
    events = [ev(NOW + 2 * 60000)];
    const [made] = await rules.evaluate({ now: NOW });
    scheduled.setStatus(made.scheduleId, 'recording'); // the pre-buffer started it; nominal start still ahead
    events = [ev(NOW + H)]; // its slot gone, a same-title match an hour later
    const next = await rules.evaluate({ now: NOW });
    assert.equal(next.length, 1, 'the later match is recorded');
    assert.deepEqual(ofRule(r.id).map(s => [s.program_start, s.status]), [[NOW + 2 * 60000, 'recording'], [NOW + H, 'scheduled']],
        'the running recording is left as it is');
});

// ---- The F4 policy Mark accepted on 25 Oct (0259; docs/reviews/2026-10-24/REPAIR-STATUS.md, "F4 policy"):
// A2 an unclear pairing records rather than suppresses; B1 the 72-hour Sport horizon stays; C2 a series
// airing without episode data pairs on its channel up to 3 hours. Not durable identity: the guide has none.

test('F4 A2: two vanished and two new same-title games - the cancel cannot be placed, so both games are recorded', async () => {
    const r = rule();
    events = [ev(NOW + 2 * H), ev(NOW + 10 * H)];
    const made = await rules.evaluate({ now: NOW });
    await engine.cancelScheduled(made[0].scheduleId); // the 2 h game is cancelled
    events = [ev(NOW + 6 * H), ev(NOW + 11 * H)];     // both slots gone, two new ones
    const again = await rules.evaluate({ now: NOW });
    assert.deepEqual(again.map(m => m.start), [NOW + 6 * H], 'the game the cancel may have been is recorded');
    // The pending 10 h one still follows its nearest (11 h): either way one recording per game.
    assert.deepEqual(ofRule(r.id).map(s => [s.program_start, s.status]),
        [[NOW + 2 * H, 'cancelled'], [NOW + 6 * H, 'scheduled'], [NOW + 11 * H, 'scheduled']]);
    assert.deepEqual(await rules.evaluate({ now: NOW }), [], 'and nothing more on the next evaluation');
});

test('F4 A2: one vanished cancelled game and one new one is clear - the cancel still holds however far it moved', async () => {
    const r = rule();
    events = [ev(NOW + 2 * H), ev(NOW + 30 * H)];
    const made = await rules.evaluate({ now: NOW });
    await engine.cancelScheduled(made[0].scheduleId);
    events = [ev(NOW + 9 * H), ev(NOW + 30 * H)]; // the other game is still where it was
    assert.deepEqual(await rules.evaluate({ now: NOW }), []);
    assert.deepEqual(ofRule(r.id).map(s => s.status), ['cancelled', 'scheduled']);
});

test('F4 B1: a schedule past the 72-hour guide horizon is not a move candidate (absence there proves nothing)', async () => {
    const r = rule();
    events = [ev(NOW + 2 * H)];
    const [made] = await rules.evaluate({ now: NOW });
    await engine.cancelScheduled(made.scheduleId);
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET program_start = ?, program_end = ? WHERE id = ?').run(NOW + 73 * H, NOW + 76 * H, made.scheduleId);
    events = [ev(NOW + 5 * H)];
    assert.equal((await rules.evaluate({ now: NOW })).length, 1, 'a new game');
    assert.equal(ofRule(r.id).length, 2);
});

/** A series rule on Fox Footy and its airings (no episode data unless `data` is given). */
function seriesFixture(airings) {
    const d = sqlite.getDb();
    d.prepare('UPDATE playlist_items SET tvg_id = ? WHERE source_id = ?').run('ff', source.id);
    d.prepare('DELETE FROM epg_programs').run();
    const insert = d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, flags, data) VALUES (?, ?, ?, ?, ?, 0, ?)');
    for (const a of airings) insert.run('ff', source.id, a.start, a.start + H, 'Series Example', a.data || null);
    return rules.create({ kind: 'series', match: 'Series Example', sourceId: source.id, channelId: 'pos_1' }).rule;
}
const shiftAirings = (ms) => sqlite.getDb().prepare('UPDATE epg_programs SET start_time = start_time + ?, end_time = end_time + ?').run(ms, ms);
const clearAirings = () => sqlite.getDb().prepare('DELETE FROM epg_programs').run();

test('F4 C2: a cancelled series airing without episode data stays cancelled when the guide moves it 20 minutes or 2 hours', async () => {
    const r = seriesFixture([{ start: NOW + H }]);
    const [made] = await rules.evaluate({ now: NOW });
    assert.ok(made);
    await engine.cancelScheduled(made.scheduleId);
    shiftAirings(20 * 60000);
    assert.deepEqual(await rules.evaluate({ now: NOW }), [], '20 minutes: the same airing');
    shiftAirings(100 * 60000);
    assert.deepEqual(await rules.evaluate({ now: NOW }), [], '2 hours from the original: still the same airing');
    assert.deepEqual(ofRule(r.id).map(s => s.status), ['cancelled']);
    clearAirings();
});

test('F4 C2: a pending series airing follows a move of up to 3 hours; further away it is a new airing', async () => {
    const r = seriesFixture([{ start: NOW + H }]);
    await rules.evaluate({ now: NOW });
    shiftAirings(150 * 60000); // 2.5 h
    assert.deepEqual(await rules.evaluate({ now: NOW }), []);
    assert.deepEqual(ofRule(r.id).map(s => s.program_start), [NOW + H + 150 * 60000], 'one schedule, moved');
    shiftAirings(4 * H); // 4 h further
    assert.equal((await rules.evaluate({ now: NOW })).length, 1, 'beyond 3 hours: a new airing');
    assert.equal(ofRule(r.id).length, 2);
    clearAirings();
});

test('F4 C2: two airings close together both stay recorded when the guide shifts them both', async () => {
    const r = seriesFixture([{ start: NOW + H }, { start: NOW + H + 30 * 60000 }]);
    assert.equal((await rules.evaluate({ now: NOW })).length, 2);
    shiftAirings(20 * 60000);
    assert.deepEqual(await rules.evaluate({ now: NOW }), []);
    assert.equal(ofRule(r.id).length, 2, 'still two schedules, one per airing');
    clearAirings();
});

test('F4 C2: an airing with episode data is still matched by its episode, never paired by time', async () => {
    const r = seriesFixture([{ start: NOW + H, data: JSON.stringify({ ep: '1.4' }) }]);
    const [made] = await rules.evaluate({ now: NOW });
    await engine.cancelScheduled(made.scheduleId);
    shiftAirings(2 * H);
    assert.deepEqual(await rules.evaluate({ now: NOW }), [], 'episode 1.4 was cancelled: not again');
    assert.equal(ofRule(r.id).length, 1);
    clearAirings();
});
