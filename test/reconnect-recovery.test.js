const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0191, from the 3 Oct channel diagnosis (Fox Footy and 7mate on Strong8K):
//  - a live session whose timestamps loop after ffmpeg reconnected in place is ended as
//    lost ('timestamps'), so the relay restarts it cleanly or the player re-resolves;
//  - a live session whose picture carries almost no data is marked blank (logged, the
//    channel quarantined on that provider, its health row failed with reason 'blank').
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-reconnect-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const ts = load('services/transcodeSession');
const { TranscodeSession } = ts;
const sqlite = load('db/sqlite');
const health = load('services/channelHealth');
const routing = load('services/providerRouting');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-reconnect-run-'));
after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

const URL_ = 'http://provider.invalid/live/u/p/441304.ts';
const RECONNECT = '[http @ 0x1] Will reconnect at 90799524 in 0 second(s), error=Input/output error.';
const AUDIO_JUMP = '[aist#0:1/aac @ 0x2] timestamp discontinuity (stream id=257): -140478, new offset= -91889983655';

/** A live session that has played (a playlist exists), with its folder kept and nothing spawned. */
function playing(extra = {}) {
    const s = new TranscodeSession(URL_, { live: true, segmentType: 'fmp4', videoMode: 'copy', ...extra });
    s.timings.playlistReady = Date.now();
    s.retainDir = true;
    const lost = [];
    s.on('lost', info => lost.push(info));
    return { s, lost };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

// ---- the reconnect timestamp loop ----

test('a flood of timestamp warnings after a reconnect ends the session as lost, for a provider reason', async () => {
    const { s, lost } = playing();
    const t0 = 1_000_000;
    s.noteStderrLine(RECONNECT, t0);
    // Fox Footy's log: ~47 a second. The guard needs 25 inside 10 s.
    for (let i = 0; i < ts.TS_LOOP_LINES - 1; i++) s.noteStderrLine(AUDIO_JUMP, t0 + 1000 + i * 21);
    assert.equal(lost.length, 0, 'one short of the threshold: still playing');
    s.noteStderrLine(AUDIO_JUMP, t0 + 1600);
    await settle();
    assert.deepEqual(lost, [{ how: 'timestamps', providerReason: true }]);
    assert.equal(s.stopRequested, true, 'its ffmpeg is stopped, as a stall does');
    // Once is enough: the lines that keep coming do not end it twice.
    for (let i = 0; i < 50; i++) s.noteStderrLine(AUDIO_JUMP, t0 + 1700 + i);
    await settle();
    assert.equal(lost.length, 1);
});

test('the other warnings ffmpeg prints in the loop count too', async () => {
    const { s, lost } = playing();
    s.noteStderrLine(RECONNECT, 0);
    const lines = [
        '[hls @ 0x3] Non-monotonic DTS in output stream 0:1; previous: 4321792, current: 4319730; changing to 4321793.',
        '[mp4 @ 0x4] Packet duration: -1 / dts: 4236288 is out of range',
        AUDIO_JUMP
    ];
    for (let i = 0; i < ts.TS_LOOP_LINES; i++) s.noteStderrLine(lines[i % 3], 500 + i * 100);
    await settle();
    assert.equal(lost.length, 1);
    assert.equal(lost[0].how, 'timestamps');
});

test('a single rebase after a reconnect (the 7 channels\' ~38 s cut) is left alone', async () => {
    const { s, lost } = playing();
    s.noteStderrLine(RECONNECT, 0);
    // What blueprint §3 recorded: one discontinuity and a few non-monotonic lines.
    s.noteStderrLine('[vist#0:0/h264 @ 0x5] timestamp discontinuity (stream id=256): -19040000, new offset= 1', 400);
    for (let i = 0; i < 4; i++) s.noteStderrLine('[hls @ 0x3] Non-monotonic DTS in output stream 0:1; previous: 1, current: 0; changing to 2.', 500 + i);
    await settle();
    assert.equal(lost.length, 0);
});

test('warnings without a reconnect, or long after one, never end a session', async () => {
    const quiet = playing();
    for (let i = 0; i < 200; i++) quiet.s.noteStderrLine(AUDIO_JUMP, i * 10);
    const late = playing();
    late.s.noteStderrLine(RECONNECT, 0);
    for (let i = 0; i < 200; i++) late.s.noteStderrLine(AUDIO_JUMP, ts.TS_LOOP_AFTER_RECONNECT_MS + 1 + i * 10);
    // Spread out: 25 lines, but never 25 inside one window.
    const sparse = playing();
    sparse.s.noteStderrLine(RECONNECT, 0);
    for (let i = 0; i < 60; i++) sparse.s.noteStderrLine(AUDIO_JUMP, i * 1000);
    await settle();
    assert.equal(quiet.lost.length, 0, 'no reconnect: the feed\'s own warnings are the bench\'s business');
    assert.equal(late.lost.length, 0, 'over two minutes after the reconnect');
    assert.equal(sparse.lost.length, 0, 'one a second is not a loop');
});

test('only a live session that has played: not a recording or VOD, not during the start', async () => {
    const vod = playing({ live: false });
    const starting = playing();
    starting.s.timings.playlistReady = null;
    for (const { s } of [vod, starting]) {
        s.noteStderrLine(RECONNECT, 0);
        for (let i = 0; i < 100; i++) s.noteStderrLine(AUDIO_JUMP, 100 + i);
    }
    await settle();
    assert.equal(vod.lost.length, 0);
    assert.equal(starting.lost.length, 0, 'before a playlist exists a failure is the resolve\'s to judge');
});

test('the provider closing a live response mid-play counts as a provider reason', () => {
    assert.equal(ts.providerFailureIn(['[http @ 0x1] Stream ends prematurely at 691276940, should be 18446744073709551615']), true);
    assert.equal(ts.providerFailureIn(['[libx264 @ 0x1] some encoder complaint']), false);
});

test('the routing log and Status page name the new loss', () => {
    const relay = fs.readFileSync(path.join(sandbox, 'server/services/streamRelay.js'), 'utf8');
    assert.match(relay, /broke its timestamps after a reconnect/);
    const status = fs.readFileSync(path.join(__dirname, '../public/js/pages/StatusPage.js'), 'utf8');
    assert.match(status, /Timestamps broke after a reconnect/);
    assert.match(status, /Blank picture/);
});

// ---- the blank picture ----

function sessionWithSegments(name, { kbps, segments, segSec = 4, height = 1080 }) {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MAP:URI="init.mp4"'];
    for (let i = 0; i < segments; i++) {
        const seg = `seg${String(i).padStart(4, '0')}.m4s`;
        fs.writeFileSync(path.join(dir, seg), Buffer.alloc(Math.round((kbps * 1000 / 8) * segSec)));
        lines.push(`#EXTINF:${segSec.toFixed(6)},`, seg);
    }
    fs.writeFileSync(path.join(dir, 'stream.m3u8'), lines.join('\n') + '\n');
    const { s } = playing({ height });
    s.dir = dir;
    s.playlistPath = path.join(dir, 'stream.m3u8');
    const blanks = [];
    s.on('blank', info => blanks.push(info));
    return { s, blanks };
}

test('7mate\'s black 1080p (193 kbps with its audio) is marked blank once there are 20 s of it', async () => {
    const early = sessionWithSegments('early', { kbps: 193, segments: 3 });
    assert.equal(await early.s.checkPicture(), null, '12 s: too early to say');
    assert.equal(early.s.blank, undefined);

    const { s, blanks } = sessionWithSegments('seven-mate', { kbps: 193, segments: 6 });
    const r = await s.checkPicture();
    assert.equal(r.kbps, 193);
    assert.equal(s.blank, true);
    assert.deepEqual(blanks, [{ kbps: 193, seconds: 24 }]);
    assert.equal(await s.checkPicture(), null, 'decided once');
    assert.equal(blanks.length, 1);
});

test('a real picture is not blank: Fox Footy\'s 5 Mbps, and a modest SD channel', async () => {
    const fox = sessionWithSegments('fox', { kbps: 5100, segments: 6 });
    await fox.s.checkPicture();
    assert.equal(fox.s.blank, false);
    assert.equal(fox.blanks.length, 0);
    const sd = sessionWithSegments('sd', { kbps: 700, segments: 6, height: 576 });
    await sd.s.checkPicture();
    assert.equal(sd.s.blank, false);
});

test('the threshold: 500 kbps from 720p up, 250 below, PIGTV_BLANK_KBPS overrides', () => {
    assert.equal(ts.blankKbps(1080), 500);
    assert.equal(ts.blankKbps(720), 500);
    assert.equal(ts.blankKbps(0), 500, 'unknown height (an encode) uses the HD figure');
    assert.equal(ts.blankKbps(576), 250);
    process.env.PIGTV_BLANK_KBPS = '0';
    try { assert.equal(ts.blankKbps(1080), 0, '0 switches it off'); } finally { delete process.env.PIGTV_BLANK_KBPS; }
});

test('only live sessions are checked', () => {
    const vod = new TranscodeSession(URL_, { live: false });
    vod.startPictureCheck();
    assert.equal(vod._pictureTimer, undefined);
    const live = new TranscodeSession(URL_, { live: true, pictureCheckMs: 60000 });
    live.startPictureCheck();
    assert.ok(live._pictureTimer);
    live.stopPictureCheck();
    assert.equal(live._pictureTimer, null);
});

test('a blank play quarantines the channel on that provider without tripping its breaker', async () => {
    const { s } = sessionWithSegments('quarantine', { kbps: 150, segments: 6 });
    const candidate = { providerId: 77, providerName: 'Strong8K', channelKey: 's441367' };
    routing.watchSession(s, candidate, 's441367', '7 Mate Melbourne');
    assert.equal(routing.isQuarantined(77, 's441367'), false);
    await s.checkPicture();
    assert.equal(routing.isQuarantined(77, 's441367'), true);
});

test('a blank play fails its health row with reason "blank", and Status flags it', () => {
    const db = sqlite.getDb();
    db.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, stable_id) VALUES ('8:pos_1157', 8, 'pos_1157', 'live', '7 Mate Melbourne', 's441367')`).run();
    const now = Date.now();
    assert.equal(health.sessionBlank('device:tv', now), false, 'no play for this owner yet');
    const rowId = health.recordResolve({ sourceId: 8, channelId: 'pos_1157', ok: true, owner: 'device:tv', now });
    assert.ok(rowId);
    assert.equal(health.clientStarted('device:tv', 4.8, now + 5000), true, 'it "played"');
    assert.equal(health.sessionBlank('device:tv', now + 25000), true);
    const row = db.prepare('SELECT ok, reason FROM channel_health WHERE id = ?').get(rowId);
    assert.deepEqual({ ...row }, { ok: 0, reason: 'blank' });
    // play-end still lands on the same row afterwards.
    assert.equal(health.clientEnded('device:tv', 120, 0, now + 125000), true);
    const listed = health.leastReliable({ now: now + 130000 }).find(c => c.name === '7 Mate Melbourne');
    assert.equal(listed.blank, true);
    assert.equal(listed.failures, 1);
});

test('the resolve route listens for a blank picture', () => {
    const route = fs.readFileSync(path.join(sandbox, 'server/routes/playback.js'), 'utf8');
    assert.match(route, /played\.once\('blank', \(\) => channelHealth\.sessionBlank\(owner\)\)/);
});
