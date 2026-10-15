const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// R4 (Plan B1, 0214): a recording's end follows the guide. The real engine in a sandboxed
// database; ffmpeg is a node script that writes until it is told to stop ("q"). On 0213 the end
// was fixed at scheduling and the hard stop fired at it whatever the guide said later.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-rec-guide-end-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const engine = load('services/recordingEngine');
engine._setPrepareQueue(false);
const guideEnd = load('services/recordingGuideEnd');
const { scheduled } = load('db/recordingsDb');

const FFMPEG = path.join(sandbox, 'ffmpeg-fake');
fs.writeFileSync(FFMPEG, `#!${process.execPath}
const fs = require('fs');
const out = process.argv[process.argv.length - 1];
fs.writeFileSync(out, Buffer.alloc(4000));
setInterval(() => fs.appendFileSync(out, Buffer.alloc(500)), 50);
process.stdin.on('data', (d) => { if (String(d).includes('q')) process.exit(0); });
`);
fs.chmodSync(FFMPEG, 0o755);

const realConsole = { log: console.log, warn: console.warn };
console.log = () => {}; console.warn = () => {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MIN = 60000, H = 60 * MIN;
let A;

before(async () => {
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://strong.invalid/get.php?username=u&password=p' });
    const d = sqlite.getDb();
    d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, tvg_id, stream_url)
               VALUES (?, ?, 'pos_1', 'live', 'Fox Cricket 501', 'Sport', 0, 1, 's501', 'fox.au', 'http://strong.invalid/live/u/p/501.ts')`).run(`${A.id}:pos_1`, A.id);
    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 5 });
    engine.init({ ffmpegPath: FFMPEG, ffprobePath: 'ffprobe' });
    engine.shutdown(); // the test drives tick() itself
});

after(async () => {
    await engine.stopAllActive(3000);
    Object.assign(console, realConsole);
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

function guide(rows) {
    const d = sqlite.getDb();
    d.prepare('DELETE FROM epg_programs').run();
    d.prepare('INSERT OR REPLACE INTO epg_state (source_id, active_gen) VALUES (?, 0)').run(A.id);
    const ins = d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, gen) VALUES (?, ?, ?, ?, ?, 0)');
    for (const r of rows) ins.run(r.channel || 'fox.au', A.id, r.start, r.end, r.title);
}
let n = 0;
function schedule({ start, end, title = 'Australia v South Africa - 1st Test, Day 1' }) {
    return scheduled.create({ title: `${title}`, description: null, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 's501',
        channel_name: 'Fox Cricket 501', channel_logo: null, program_start: start, program_end: end,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: Date.now() + n++ });
}

// ---- the rules (pure) --------------------------------------------------------

test('the end moves to the guide programme in the same slot, never before the original, at most +3 h', () => {
    const t = Date.UTC(2026, 11, 18, 0);
    const s = { title: 'Australia v South Africa - 1st Test, Day 1', program_start: t, program_end: t + 7 * H, program_end_original: null };
    const at = (title, start, end) => ({ title, start_time: start, end_time: end });

    assert.equal(guideEnd.guideEndFor(s, [at('Australia v South Africa - 1st Test, Day 1', t, t + 7.5 * H)]).end, t + 7.5 * H, 'an overrun');
    assert.equal(guideEnd.guideEndFor(s, [at('LIVE: Australia v South Africa - 1st Test, Day 1', t + 5 * MIN, t + 8 * H)]).end, t + 8 * H, '"Live" and a nudged start ignored');
    assert.equal(guideEnd.guideEndFor(s, [at('Australia v South Africa - 1st Test, Day 1', t, t + 6 * H)]), null, 'never shorter than scheduled');
    assert.equal(guideEnd.guideEndFor(s, [at('Australia v South Africa - 1st Test, Day 1', t, t + 20 * H)]).end, t + 10 * H, 'capped at +3 h');
    assert.equal(guideEnd.guideEndFor(s, [at('Cricket Post-Match', t + 7 * H, t + 8 * H)]), null, 'the next programme is not this one');
    assert.equal(guideEnd.guideEndFor(s, [at('Test Cricket Day 1', t + MIN, t + 7.25 * H)]).end, t + 7.25 * H, 'the same slot renamed (same start)');
    assert.equal(guideEnd.guideEndFor(s, [at('Something else', t + 20 * MIN, t + 9 * H)]), null, 'a different title at another start');

    // A correction back down returns towards the original, not below it.
    const moved = { ...s, program_end: t + 9 * H, program_end_original: t + 7 * H };
    assert.equal(guideEnd.guideEndFor(moved, [at('Australia v South Africa - 1st Test, Day 1', t, t + 7.5 * H)]).end, t + 7.5 * H);
    assert.equal(guideEnd.guideEndFor(moved, [at('Australia v South Africa - 1st Test, Day 1', t, t + 6 * H)]).end, t + 7 * H);
});

// ---- the engine --------------------------------------------------------------

test('after a sync, a pending schedule takes the guide end and keeps its original', () => {
    const t = Date.now() + 2 * H;
    const s = schedule({ start: t, end: t + 7 * H });
    guide([{ title: 'Australia v South Africa - 1st Test, Day 1', start: t, end: t + 7.5 * H },
           { title: 'Australia v South Africa - 1st Test, Day 1', channel: 'other.au', start: t, end: t + 9 * H }]);
    const changes = engine.followGuide();
    assert.deepEqual(changes.map(c => [c.id, c.to]), [[s.id, t + 7.5 * H]]);
    const row = scheduled.getById(s.id);
    assert.equal(row.program_end, t + 7.5 * H);
    assert.equal(row.program_end_original, t + 7 * H);
    assert.deepEqual(engine.followGuide(), [], 'idempotent');
    scheduled.setStatus(s.id, 'cancelled');
});

test('a running recording outlives its old end when the guide extends it, and stops at the new one', async () => {
    const now = Date.now();
    const s = schedule({ start: now - 1000, end: now + 1200, title: 'Rain delay special' });
    for (let i = 0; i < 50 && scheduled.getById(s.id).status !== 'recording'; i++) { await engine.tick(); await sleep(40); }
    assert.equal(scheduled.getById(s.id).status, 'recording');

    guide([{ title: 'Rain delay special', start: now - 1000, end: now + 3200 }]);
    engine.followGuide();
    await sleep(2000);
    assert.equal(scheduled.getById(s.id).status, 'recording', 'still recording past the old end');
    for (let i = 0; i < 60 && scheduled.getById(s.id).status === 'recording'; i++) await sleep(50);
    assert.equal(scheduled.getById(s.id).status, 'completed', 'stopped at the new end');
});

test('the hard stop re-reads the end when it fires (an end moved without a re-arm still counts)', async () => {
    const now = Date.now();
    const s = schedule({ start: now - 1000, end: now + 1000, title: 'Extra time' });
    for (let i = 0; i < 50 && scheduled.getById(s.id).status !== 'recording'; i++) { await engine.tick(); await sleep(40); }
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET program_end = ? WHERE id = ?').run(now + 2500, s.id);
    await sleep(1600);
    assert.equal(scheduled.getById(s.id).status, 'recording');
    for (let i = 0; i < 60 && scheduled.getById(s.id).status === 'recording'; i++) await sleep(50);
    assert.equal(scheduled.getById(s.id).status, 'completed');
});
