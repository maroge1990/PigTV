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

