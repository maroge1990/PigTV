const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0114 (roadmap S1.1): a channel's probe analysis is kept in SQLite, so a repeat play
// skips ffprobe (3.3-4.7 s of every cold start in Mark's build-0109 log) instead of
// probing again once the 5-minute in-memory cache has expired.
//
// Sandbox copy of the server (its own data/content.db), as in resolve-timing.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-profiles-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));

// ffprobe is replaced before playbackStrategy is loaded, so the stub is what it calls.
const streamProbe = load('services/streamProbe');
let probeCalls = 0;
const RAW = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '25/1' },
                        { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 }],
              format: { format_name: 'mpegts' }, packets: [] };
streamProbe.probeStream = async () => { probeCalls++; return JSON.parse(JSON.stringify(RAW)); };

const strategy = load('services/playbackStrategy');
const transcodeSession = load('services/transcodeSession');
const { getDb } = load('db/sqlite');

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const SETTINGS = { userAgentPreset: 'chrome', ffmpegPath: 'ffmpeg' };
const WEB = { segmentedDelivery: true };
const APPLE = { segmentedDelivery: true, hevc: true, fmp4: true };

// Sessions are stubbed: ready (a playlist was produced) or not.
let sessionReady = true;
const realCreate = transcodeSession.createSession;
const realRemove = transcodeSession.removeSession;
transcodeSession.createSession = async () => ({ id: 'stub', start: async () => {}, waitForPlaylist: async () => sessionReady });
transcodeSession.removeSession = async () => {};
after(() => { transcodeSession.createSession = realCreate; transcodeSession.removeSession = realRemove; });

beforeEach(() => {
    delete process.env.PIGTV_PROFILE_MAX_AGE_DAYS;
    sessionReady = true;
    probeCalls = 0;
    streamProbe.probeCache.clear();
    getDb().prepare('DELETE FROM channel_profiles').run();
});

// A repeat play more than 5 minutes later: the in-memory cache has expired.
const laterOn = () => streamProbe.probeCache.clear();

async function play(url, capabilities = WEB) {
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    let decision, error;
    try { decision = await strategy.resolve({ url, capabilities, settings: SETTINGS }); }
    catch (err) { error = err; }
    finally { console.log = realLog; }
    return { decision, error, timing: lines.find(l => l.includes('resolve timing')) };
}
const rows = () => getDb().prepare('SELECT key, info, probed_at, last_ok_at FROM channel_profiles').all();

test('a repeat play of the same channel skips ffprobe and says it used the profile', async () => {
    const url = 'http://provider.invalid/live/user/secret/441367.ts';
    const first = await play(url);
    assert.equal(probeCalls, 1);
    assert.match(first.timing, /probe [\d.]+s,/);

    laterOn();
    const second = await play(url);
    assert.equal(probeCalls, 1, 'the second play must not probe: the old code probed again once the 5-min cache expired');
    assert.match(second.timing, /resolve timing: HLS session, probe profile \(age 0d\), first segment after/);
    assert.equal(second.decision.info.video, 'h264', 'the profile carries the analysis');
});

test('the stored key is a hash: the provider credentials in the URL are not written to the table', async () => {
    await play('http://provider.invalid/live/user/secret/441368.ts');
    const all = JSON.stringify(rows());
    assert.ok(!all.includes('secret') && !all.includes('provider.invalid'));
});

test('a session that fails to start from a profile deletes it, so the next play probes afresh', async () => {
    const url = 'http://provider.invalid/live/u/p/441372.ts';
    await play(url);
    assert.equal(probeCalls, 1);

    laterOn();
    sessionReady = false;
    const failed = await play(url);
    assert.ok(failed.error, 'the start failed');
    assert.equal(probeCalls, 1, 'that attempt used the profile');

    sessionReady = true;
    const again = await play(url);
    assert.equal(probeCalls, 2, 'the profile was dropped, and the in-memory copy of it too');
    assert.match(again.timing, /probe [\d.]+s,/);
});

test('a fresh probe whose session fails is not kept', async () => {
    const url = 'http://provider.invalid/live/u/p/441373.ts';
    sessionReady = false;
    await play(url);
    laterOn();
    sessionReady = true;
    await play(url);
    assert.equal(probeCalls, 2, 'nothing was stored from the failed start');
});

test('a profiled play that works refreshes last_ok_at, not probed_at', async () => {
    const url = 'http://provider.invalid/live/u/p/441374.ts';
    await play(url);
    const probedAt = Date.now() - 86400000;
    getDb().prepare('UPDATE channel_profiles SET probed_at = ?, last_ok_at = 1').run(probedAt);
    laterOn();
    await play(url);
    assert.equal(probeCalls, 1);
    const [row] = rows();
    assert.equal(rows().length, 1);
    assert.equal(row.probed_at, probedAt, 'probed_at is unchanged: the age still counts from the probe');
    assert.ok(row.last_ok_at > Date.now() - 60000, 'last_ok_at moved to now');
});

test('a profile older than the limit (7 days, or PIGTV_PROFILE_MAX_AGE_DAYS) is probed again', async () => {
    const url = 'http://provider.invalid/live/u/p/441375.ts';
    await play(url);
    getDb().prepare('UPDATE channel_profiles SET probed_at = ?').run(Date.now() - 8 * 86400000);
    laterOn();
    await play(url);
    assert.equal(probeCalls, 2, 'eight days old is too old by default');

    process.env.PIGTV_PROFILE_MAX_AGE_DAYS = '1';
    getDb().prepare('UPDATE channel_profiles SET probed_at = ?').run(Date.now() - 2 * 86400000);
    laterOn();
    await play(url);
    assert.equal(probeCalls, 3, 'the limit is configurable');
});

test('the capability key separates profiles: a client that decodes HEVC gets its own', async () => {
    const url = 'http://provider.invalid/live/u/p/441377.ts';
    await play(url, WEB);
    laterOn();
    await play(url, APPLE);
    assert.equal(probeCalls, 2, 'a different client is a different analysis');
    assert.equal(rows().length, 2);
    laterOn();
    await play(url, WEB);
    await play(url, APPLE);
    assert.equal(probeCalls, 2, 'and each is reused for its own client');
});
