const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// 0174 (multi-provider P6): resolve with failover. A play that fails on the primary
// for a provider reason goes to the primary's sibling "(Backup)" feed, then to each
// backup that has the channel; a provider failing on two channels is skipped for a
// cooldown (breaker); a channel that failed on a provider, or died there mid-play, is
// skipped there for 10 min (quarantine), so the player's own re-resolve lands on the
// next provider. The answer names the provider (contract C-J). With no backup
// configured nothing changes.
//
// The real route, strategy and session classes, in a sandboxed database; ffmpeg and
// ffprobe are node scripts that behave per stream URL, as in start-failure.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-failover-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
delete process.env.PIGTV_TUNER;
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const transcodeSession = load('services/transcodeSession');
const coordinator = load('services/streamCoordinator');
const recordingEngine = load('services/recordingEngine');
const routing = load('services/providerRouting');
const playbackEvents = load('services/playbackEvents');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DEFAULTS = { DEADLINE_MS: routing.DEADLINE_MS, NEXT_RESERVE_MS: routing.NEXT_RESERVE_MS, MIN_START_MS: routing.MIN_START_MS };

// ---- fake ffmpeg: what each stream URL does -------------------------------------
const stderr = (lines) => lines.map(l => `process.stderr.write(${JSON.stringify(l + '\n')});`).join(' ');
const PLAYLIST = `require('fs').writeFileSync('stream.m3u8', '#EXTM3U\\n#EXTINF:4,\\nseg0000.ts\\n');`;
const SCRIPTS = {
    ok: `${PLAYLIST} setInterval(() => {}, 1000);`,
    // Strong8K on 30 Sept: HTTP 502 on every channel.
    502: `${stderr(['[in#0 @ 0x1] Error opening input: Server returned 5XX Server Error reply'])} process.exitCode = 1;`,
    // Not the provider's fault: an argument ffmpeg does not know.
    argerr: `${stderr(["Unrecognized option 'nope'.", 'Error splitting the argument list: Option not found'])} process.exitCode = 1;`,
    // Plays, then the provider drops it.
    dies: `${PLAYLIST} setTimeout(() => { ${stderr(['[tcp @ 0x1] Connection reset by peer', 'Error during demuxing: Connection reset by peer'])} process.exit(1); }, 600);`,
    // Plays, then goes silent (the stall watchdog releases it).
    stalls: `${PLAYLIST} setInterval(() => {}, 1000);`,
    // Connects and never writes anything.
    hang: `setInterval(() => {}, 1000);`
};
const behaviour = new Map(); // url -> key of SCRIPTS (default ok)
const starts = new Map();    // url -> ffmpeg starts (retries included)
const startsOf = (url) => starts.get(url) || 0;

// ---- fake ffprobe: a valid probe, or the provider's 502 -------------------------
const probeFile = path.join(sandbox, 'probe-behaviour.json');
const writeProbe = (map) => fs.writeFileSync(probeFile, JSON.stringify(map));
const FFPROBE = path.join(sandbox, 'ffprobe-fake');
fs.writeFileSync(FFPROBE, `#!${process.execPath}
const url = process.argv[process.argv.length - 1];
const map = JSON.parse(require('fs').readFileSync(${JSON.stringify(probeFile)}, 'utf8'));
if (map[url] === '502') { process.stderr.write(url + ': Server returned 5XX Server Error reply\\n'); process.exit(1); }
process.stdout.write(JSON.stringify({ streams: [
  { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '25/1' },
  { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2 } ], format: { format_name: 'mpegts' } }));
`);
fs.chmodSync(FFPROBE, 0o755);
writeProbe({});

// ---- logs: kept, so no line this feature writes may carry a URL ------------------
const logLines = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logLines.push(a.join(' ')); if (process.env.DEBUG_FAILOVER) realConsole[k](...a); };

let A, B, C, server, base, userId;
const url = {
    A: (n) => `http://strong.invalid/live/u/p/${n}.ts`,
    B: (n) => `http://trex.invalid/live/u/p/${n}.ts`,
    C: (n) => `http://dream.invalid/live/u/p/${n}.ts`
};

function tokenFor(deviceId) {
    sqlite.getDb().prepare('INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(deviceId, String(userId), deviceId, 'test', Date.now(), Date.now());
    return jwt.sign({ id: userId, username: 'owner', role: 'admin', deviceId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
async function play(channelId, { device = 'tv', ...extra } = {}) {
    const response = await fetch(`${base}/api/playback/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(device)}` },
        body: JSON.stringify({ sourceId: A.id, channelId, capabilities: { segmentedDelivery: true }, ...extra })
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
}
const link = (key, backupId, streamId, method = 'exact') => sqlite.getDb().prepare(`
    INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, score, updated_at)
    VALUES (?, ?, ?, ?, ?, 'auto', 1, 100, ?)`).run(A.id, key, backupId, streamId, method, Date.now());
const sessionOn = async (providerId, owner) => {
    const s = await transcodeSession.createSession(`http://elsewhere.invalid/live/${Math.random()}.ts`, { owner, live: true, providerId });
    s.lastAccess = Date.now();
    return s;
};

before(async () => {
    userId = (await db.users.create({ username: 'owner', role: 'admin' })).id;
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://strong.invalid/get.php?username=u&password=p' });
    B = await db.sources.create({ type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'u', password: 'p', role: 'backup', priority: 1 });
    C = await db.sources.create({ type: 'm3u', name: 'Dream4K', url: 'http://dream.invalid/list.m3u', role: 'backup', priority: 2 });

    const d = sqlite.getDb();
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                            VALUES (?, ?, ?, 'live', ?, 'Sport', ?, ?, ?, ?)`);
    [['pos_1', 'Fox Sports 505', 's101', 101, 0], ['pos_2', 'Sky Sport 1', 's102', 102, 0], ['pos_3', 'ABC', 's103', 103, 0],
     ['pos_4', 'SBS', 's104', 104, 0], ['pos_9', 'Fox Sports 505 (Backup)', 's109', 109, 1]]
        .forEach(([id, name, stable, n, hidden], i) => item.run(`${A.id}:${id}`, A.id, id, name, hidden, i + 1, stable, url.A(n)));
    const bc = d.prepare('INSERT INTO backup_channels (source_id, stream_id, name, url_data) VALUES (?, ?, ?, ?)');
    for (const n of [5001, 5002, 5003, 5004]) bc.run(B.id, String(n), `Trex ${n}`, null);
    for (const n of [7001, 7002, 7003, 7004]) bc.run(C.id, String(n), `Dream ${n}`, url.C(n));

    recordingEngine.listActive = () => [];
    recordingEngine.stopForViewer = async () => {};
    const realCreate = transcodeSession.createSession;
    transcodeSession.createSession = async (u, o = {}) => {
        const kind = behaviour.get(u) || 'ok';
        const extra = kind === 'stalls' ? { stallMs: 800, startupMs: 5000, watchdogIntervalMs: 100 } : { stallMs: 60000, startupMs: 60000 };
        const s = await realCreate(u, { ...o, ffmpegPath: process.execPath, ...extra });
        s.buildFFmpegArgs = () => { starts.set(u, startsOf(u) + 1); return ['-e', SCRIPTS[kind]]; };
        return s;
    };

    const app = express();
    app.use(express.json());
    app.locals.ffprobePath = FFPROBE;
    app.use('/api/playback', load('routes/playback'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

function linkAll() {
    sqlite.getDb().prepare('DELETE FROM channel_links').run();
    link('s101', A.id, 's109', 'sibling');
    for (const [key, n] of [['s101', 1], ['s102', 2], ['s103', 3], ['s104', 4]]) {
        link(key, B.id, String(5000 + n));
        link(key, C.id, String(7000 + n));
    }
}

afterEach(async () => {
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id);
    routing.reset();
    Object.assign(routing, DEFAULTS);
    behaviour.clear();
    starts.clear();
    writeProbe({});
    playbackEvents.reset();
    for (const src of [B, C]) await db.sources.update(src.id, { enabled: true, subscription: null });
    linkAll();
});

after(() => {
    Object.assign(console, realConsole);
    server?.closeAllConnections?.(); server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

const noUrl = (text, label) => {
    assert.ok(!text.includes('://'), `${label}: carries a URL: ${text}`);
    assert.ok(!/\.invalid|\/u\/p\//.test(text), `${label}: leaks a stream address: ${text}`);
};

// ------------------------------------------------------------ failover on start --

test('502 on the primary (ffmpeg): plays on the backup, provider.via "backup", failover true (C-J)', async () => {
    linkAll();
    sqlite.getDb().prepare("DELETE FROM channel_links WHERE backup_source_id = ?").run(A.id); // no sibling here
    behaviour.set(url.A(101), '502');
    const r = await play('pos_1');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.provider, { id: B.id, name: 'Trex', role: 'backup', via: 'backup', failover: true });
    assert.equal(startsOf(url.A(101)), 2, 'an earlier candidate gets one retry (after 1 s), not two');
    assert.equal(startsOf(url.B(5001)), 1);
    noUrl(JSON.stringify(r.body.provider), 'provider');
    assert.ok(!r.text.includes('://'), 'no URL anywhere in the answer');
    const live = coordinator.activeStreams();
    assert.deepEqual(live.map(s => s.providerId), [B.id], 'the session counts in the backup\'s pool');

    // Health is the primary channel's, an ok start, served by the backup.
    const row = sqlite.getDb().prepare('SELECT source_id, channel_key, ok, provider_id FROM channel_health ORDER BY id DESC LIMIT 1').get();
    assert.deepEqual({ ...row }, { source_id: A.id, channel_key: 's101', ok: 1, provider_id: B.id });
    assert.equal(playbackEvents.lastResolveFor('device:tv').provider, 'Trex');

    // Quarantined on the primary: the next play of the channel goes straight to the backup.
    assert.equal(routing.isQuarantined(A.id, 's101'), true);
    const again = await play('pos_1');
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.provider, { id: B.id, name: 'Trex', role: 'backup', via: 'backup', failover: true });
    assert.equal(startsOf(url.A(101)), 2, 'the quarantined primary is not tried again');
    assert.equal(routing.providerState(A.id), 'up', 'one channel failing is not an outage');
});

test('a probe that gets the 502 fails over too', async () => {
    writeProbe({ [url.A(102)]: '502' });
    const r = await play('pos_2');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.provider.via, 'backup');
    assert.equal(r.body.provider.failover, true);
    assert.equal(startsOf(url.A(102)), 0, 'ffmpeg never ran on the primary');
});

test('a single failing channel: its sibling "(Backup)" feed is tried before the backups (D5)', async () => {
    behaviour.set(url.A(101), '502');
    const r = await play('pos_1');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.provider, { id: A.id, name: 'Strong8K', role: 'primary', via: 'sibling', failover: true });
    assert.equal(startsOf(url.A(109)), 1);
    assert.equal(startsOf(url.B(5001)), 0);
});

test('an expired backup is skipped', async () => {
    await db.sources.update(B.id, { subscription: { purchasedAt: null, termMonths: null, endsAt: '2020-01-31' } });
    behaviour.set(url.A(103), '502');
    const r = await play('pos_3');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.provider, { id: C.id, name: 'Dream4K', role: 'backup', via: 'backup', failover: true });
    assert.equal(startsOf(url.B(5003)), 0);
    assert.equal(startsOf(url.C(7003)), 1);
});

test('an error that is not the provider\'s (an ffmpeg argument error) is returned as today, without failover', async () => {
    behaviour.set(url.A(103), 'argerr');
    const r = await play('pos_3');
    assert.equal(r.status, 500);
    assert.match(r.body.error, /^This channel is not available right now: its stream could not be opened/);
    assert.equal(startsOf(url.A(103)), 1);
    assert.equal(startsOf(url.B(5003)) + startsOf(url.C(7003)), 0, 'no other provider was tried');
    assert.equal(routing.isQuarantined(A.id, 's103'), false);
    assert.equal(playbackEvents.recent()[0].provider, 'Strong8K');
});

test('retries: one (after 1 s) on every candidate but the last, which keeps 0143\'s two; the last reason is returned', async () => {
    behaviour.set(url.A(103), '502');
    behaviour.set(url.B(5003), '502');
    behaviour.set(url.C(7003), '502');
    const r = await play('pos_3');
    assert.equal(r.status, 500);
    assert.match(r.body.error, /^The provider refused this channel \(HTTP 5xx\)/);
    assert.deepEqual([startsOf(url.A(103)), startsOf(url.B(5003)), startsOf(url.C(7003))], [2, 2, 3]);
    assert.ok(!r.text.includes('://'));
    const row = sqlite.getDb().prepare('SELECT ok, provider_id, reason FROM channel_health ORDER BY id DESC LIMIT 1').get();
    assert.deepEqual({ ...row }, { ok: 0, provider_id: C.id, reason: 'refused' });
});

test('deadline: a candidate that hangs is cut so the next has time, and none starts with too little left', async () => {
    Object.assign(routing, { DEADLINE_MS: 6000, NEXT_RESERVE_MS: 3000, MIN_START_MS: 2000 });
    behaviour.set(url.A(104), 'hang');
    behaviour.set(url.B(5004), 'hang');
    const t0 = Date.now();
    const r = await play('pos_4');
    const took = Date.now() - t0;
    assert.equal(r.status, 500);
    assert.match(r.body.error, /^The provider did not respond in time/);
    assert.equal(startsOf(url.A(104)), 1);
    assert.equal(startsOf(url.B(5004)), 1, 'the second started with more than MIN_START left');
    assert.equal(startsOf(url.C(7004)), 0, 'the third would have had less than MIN_START left');
    assert.ok(took < 6500, `resolve took ${took} ms, past its 6 s deadline`);
    assert.ok(logLines.some(l => l.includes('[Playback] failover: stopped after Trex')));

    // With room, the hanging primary is cut NEXT_RESERVE before the deadline and the backup plays.
    starts.clear();
    behaviour.delete(url.B(5004));
    routing.reset();
    const ok = await play('pos_4');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.provider.id, B.id);
});

// -------------------------------------------------------------------- breaker --

test('breaker: failures on 2 channels within 5 min take the provider down; plays go straight to a backup; half-open after the cooldown', async () => {
    behaviour.set(url.A(102), '502');
    behaviour.set(url.A(103), '502');
    assert.equal((await play('pos_2')).body.provider.id, B.id);
    assert.equal(routing.providerState(A.id), 'up');
    assert.equal((await play('pos_3')).body.provider.id, B.id);
    assert.equal(routing.providerState(A.id), 'down');
    assert.ok(logLines.some(l => /\[Providers\] Strong8K is down \(failures on 2 channels within 5 min\); skipped for 3 min/.test(l)));

    // A third channel (which would play on the primary) and the sibling are skipped.
    const r = await play('pos_1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.provider, { id: B.id, name: 'Trex', role: 'backup', via: 'backup', failover: true });
    assert.equal(startsOf(url.A(101)) + startsOf(url.A(109)), 0, 'neither the primary nor its own backup feed was tried');

    // Cooldown over: half-open, the next play tries the primary first; it plays -> up.
    routing._breakers.get(A.id).until = Date.now() - 1;
    assert.equal(routing.providerState(A.id), 'half-open');
    const back = await play('pos_1');
    assert.deepEqual(back.body.provider, { id: A.id, name: 'Strong8K', role: 'primary', via: 'primary', failover: false });
    assert.equal(routing.providerState(A.id), 'up');
    assert.ok(logLines.some(l => l.includes('[Providers] Strong8K is up again')));
});

test('breaker: a half-open provider that fails again is down for twice the cooldown (capped at 15 min)', () => {
    const t = Date.now() - 60 * 60 * 1000;
    routing.noteProviderFailure(B.id, 'x', t);
    assert.equal(routing.noteProviderFailure(B.id, 'y', t + 1000), 'down');
    const b = routing._breakers.get(B.id);
    assert.equal(b.until - (t + 1000), routing.COOLDOWN_MS);
    assert.equal(routing.providerState(B.id), 'half-open');
    const now = Date.now();
    assert.equal(routing.noteProviderFailure(B.id, 'z', now), 'down');
    assert.equal(b.until - now, 2 * routing.COOLDOWN_MS);
    for (let i = 0; i < 5; i++) { b.until = Date.now() - 1; routing.noteProviderFailure(B.id, 'z'); }
    assert.equal(b.cooldownMs, routing.COOLDOWN_CAP_MS);
    // Two failures of one channel are not an outage.
    routing.noteProviderFailure(C.id, 'same');
    assert.equal(routing.noteProviderFailure(C.id, 'same'), 'up');
    assert.deepEqual(routing.snapshot().providers.map(p => [p.name, p.state]),
        [['Strong8K', 'up'], ['Trex', 'down'], ['Dream4K', 'up']]);
});

// ------------------------------------------------------------ mid-play failover --

test('a provider that drops a playing channel: quarantined there, so the player\'s re-resolve lands on the backup', async () => {
    behaviour.set(url.A(102), 'dies');
    const first = await play('pos_2');
    assert.deepEqual(first.body.provider, { id: A.id, name: 'Strong8K', role: 'primary', via: 'primary', failover: false });
    for (let i = 0; i < 50 && !routing.isQuarantined(A.id, 's102'); i++) await sleep(100);
    assert.equal(routing.isQuarantined(A.id, 's102'), true);
    const lost = logLines.find(l => l.includes('lost "Sky Sport 1" mid-play'));
    assert.ok(lost, 'logged');
    assert.match(lost, /Strong8K lost "Sky Sport 1" mid-play \(ffmpeg exited\)/);

    const again = await play('pos_2');
    assert.deepEqual(again.body.provider, { id: B.id, name: 'Trex', role: 'backup', via: 'backup', failover: true });
});

test('the stall watchdog releasing a playing session quarantines it too', async () => {
    behaviour.set(url.A(103), 'stalls');
    const first = await play('pos_3');
    assert.equal(first.body.provider.via, 'primary');
    for (let i = 0; i < 60 && !routing.isQuarantined(A.id, 's103'); i++) await sleep(100);
    assert.equal(routing.isQuarantined(A.id, 's103'), true);
    assert.equal((await play('pos_3')).body.provider.id, B.id);
});

test('a session we stop ourselves (DELETE, a replacement) quarantines nothing', async () => {
    const r = await play('pos_2');
    await fetch(`${base}/api/playback/${r.body.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenFor('tv')}` } });
    await play('pos_3');
    await play('pos_4'); // replaces pos_3's session
    await sleep(300);
    for (const key of ['s102', 's103', 's104']) assert.equal(routing.isQuarantined(A.id, key), false, key);
});

// ------------------------------------------------------------------ admission --

test('admission: the primary busy with another device -> the backup, without a 409', async () => {
    const theirs = await sessionOn(A.id, 'device:bedroom');
    const r = await play('pos_2');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.provider, { id: B.id, name: 'Trex', role: 'backup', via: 'backup', failover: false });
    assert.ok(transcodeSession.getAllSessions().some(s => s.id === theirs.id), 'the other device keeps watching');
    assert.equal(startsOf(url.A(102)), 0);
});

test('admission: every provider full -> the 409 for the first candidate, with the new message; force takes the first\'s', async () => {
    const onA = await sessionOn(A.id, 'device:bedroom');
    await sessionOn(B.id, 'device:kitchen');
    await sessionOn(C.id, 'device:lounge');
    const r = await play('pos_2');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'Provider stream is in use');
    assert.deepEqual(Object.keys(r.body.conflict).sort(), ['lastActiveSec', 'message', 'providerId', 'streamId', 'type']);
    assert.equal(r.body.conflict.type, 'viewer-in-progress');
    assert.equal(r.body.conflict.streamId, onA.id);
    assert.equal(r.body.conflict.providerId, A.id);
    assert.equal(r.body.conflict.message, 'Every provider that carries this channel is in use. Watching here will stop another device\'s stream.');

    const forced = await play('pos_2', { force: true });
    assert.equal(forced.status, 200, forced.text);
    assert.deepEqual(forced.body.provider, { id: A.id, name: 'Strong8K', role: 'primary', via: 'primary', failover: false });
    assert.ok(!transcodeSession.getAllSessions().some(s => s.id === onA.id), 'force acted on the first candidate\'s provider');
    assert.equal(coordinator.activeStreams().filter(s => s.providerId === B.id || s.providerId === C.id).length, 2, 'the backups\' viewers were left alone');
});

// -------------------------------------------------------- no backup configured --

test('with no backup configured: today\'s retries, timing line, errors and 409s', async () => {
    sqlite.getDb().prepare('DELETE FROM channel_links').run();
    await db.sources.update(B.id, { enabled: false });
    await db.sources.update(C.id, { enabled: false });
    const start = logLines.length;

    // A 502: 0143's two retries (1.5 s + 3 s), today's sentence, nothing else tried.
    behaviour.set(url.A(102), '502');
    const failed = await play('pos_2');
    assert.equal(failed.status, 500);
    assert.match(failed.body.error, /^The provider refused this channel \(HTTP 5xx\): its server had a problem/);
    assert.deepEqual(Object.keys(failed.body).sort(), ['error', 'info']);
    assert.equal(startsOf(url.A(102)), 3);
    assert.equal(startsOf(url.B(5002)) + startsOf(url.C(7002)), 0);
    assert.ok(!logLines.slice(start).some(l => l.includes('[Playback] failover')), 'no failover line');

    // Played again (quarantined, but there is nowhere else): tried again as today.
    behaviour.delete(url.A(102));
    const mark = logLines.length;
    const ok = await play('pos_2');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.provider, { id: A.id, name: 'Strong8K', role: 'primary', via: 'primary', failover: false });
    const timing = logLines.slice(mark).find(l => l.startsWith('[Playback] resolve timing'));
    assert.match(timing, /^\[Playback\] resolve timing: HLS session, probe (cached|[\d.]+s), first segment after [\d.]+s, source timing unknown - DTS kept, master playlist \(SDR, 25\.000 fps\)$/);

    // Another device watching: today's 409, word for word.
    await sessionOn(A.id, 'device:bedroom');
    const busy = await play('pos_3');
    assert.equal(busy.status, 409);
    assert.deepEqual(Object.keys(busy.body.conflict).sort(), ['lastActiveSec', 'message', 'streamId', 'type']);
    assert.equal(busy.body.conflict.message, 'Another device is watching. Your provider allows one stream at a time, so watching here will stop it.');
    assert.equal(busy.body.resolution, 'Repeat this request with "force": true to stop the other stream and watch.');
});

test('the channel list: primary, sibling, backups by priority; the primary skipped when quarantined, expired or down', async () => {
    const shape = (list) => list.map(c => [c.providerName, c.via]);
    assert.deepEqual(shape(await routing.candidatesFor(A.id, 'pos_1')),
        [['Strong8K', 'primary'], ['Strong8K', 'sibling'], ['Trex', 'backup'], ['Dream4K', 'backup']]);
    await db.sources.update(B.id, { priority: 3 });
    assert.deepEqual(shape(await routing.candidatesFor(A.id, 'pos_2')), [['Strong8K', 'primary'], ['Dream4K', 'backup'], ['Trex', 'backup']]);
    await db.sources.update(B.id, { priority: 1 });
    routing.quarantine(A.id, 's101');
    const plan = await routing.plan(A.id, 'pos_1');
    assert.deepEqual(shape(plan.candidates), [['Strong8K', 'sibling'], ['Trex', 'backup'], ['Dream4K', 'backup']]);
    assert.equal(plan.primarySkipped, true);
    await db.sources.update(A.id, { subscription: { purchasedAt: null, termMonths: null, endsAt: '2020-01-31' } });
    assert.deepEqual(shape(await routing.candidatesFor(A.id, 'pos_2')), [['Trex', 'backup'], ['Dream4K', 'backup']]);
    await db.sources.update(A.id, { subscription: null });
    await db.sources.update(C.id, { enabled: false });
    assert.deepEqual(shape(await routing.candidatesFor(A.id, 'pos_2')), [['Strong8K', 'primary'], ['Trex', 'backup']]);
    // The URLs are for playbackStrategy only; they are what the links name.
    routing.reset();
    const list = await routing.candidatesFor(A.id, 'pos_1');
    assert.deepEqual(list.map(c => c.url), [url.A(101), url.A(109), url.B(5001)]);
});

// ------------------------------------------------ 0180: a start stopped on request --

const failoverLines = () => logLines.filter(l => /\[Playback\] failover/.test(l));

test('0180: a start replaced by the same viewer\'s next play is not a provider failure', async () => {
    behaviour.set(url.A(103), 'hang');
    logLines.length = 0;
    const failedBefore = sqlite.getDb().prepare('SELECT COUNT(*) AS n FROM channel_health WHERE ok = 0').get().n;
    const first = play('pos_3');                 // starts ffmpeg, which never produces a playlist
    await sleep(500);
    assert.equal(startsOf(url.A(103)), 1);
    const second = await play('pos_4');          // the zap: the coordinator releases the first as a replacement
    const r = await first;
    assert.equal(second.status, 200, second.text);
    assert.equal(r.status, 499, r.text);
    assert.deepEqual(r.body, { error: 'Playback was replaced by a newer request', superseded: true });
    assert.deepEqual(failoverLines(), [], 'no failover line');
    assert.equal(startsOf(url.B(5003)) + startsOf(url.C(7003)) + startsOf(url.A(109)), 0, 'no later candidate was started');
    assert.equal(startsOf(url.A(103)), 1, 'and no retry');
    assert.equal(routing.isQuarantined(A.id, 's103'), false, 'not quarantined');
    assert.equal(routing.providerState(A.id), 'up');
    const failed = sqlite.getDb().prepare('SELECT COUNT(*) AS n FROM channel_health WHERE ok = 0').get().n;
    assert.equal(failed, failedBefore, 'no failed start in channel health');
    assert.equal(playbackEvents.recent().filter(e => e.type === 'failure').length, 0, 'no failure event');
    assert.equal(coordinator.activeStreams().length, 1, 'only the newer session exists');
    assert.ok(!logLines.some(l => /ended before producing a playlist/.test(l)), 'not logged as an ffmpeg failure');
});

test('0180: repeated zaps never trip the breaker', async () => {
    for (const [n, key] of [[101, 'pos_1'], [102, 'pos_2'], [103, 'pos_3']]) {
        behaviour.set(url.A(n), 'hang');
        const slow = play(key);
        await sleep(400);
        await play('pos_4');
        assert.equal((await slow).status, 499);
    }
    assert.equal(routing.providerState(A.id), 'up', 'three overtaken starts on three channels count for nothing');
    for (const k of ['s101', 's102', 's103']) assert.equal(routing.isQuarantined(A.id, k), false);
});

test('0180: a session stopped by DELETE mid-start ends the resolve without failover', async () => {
    behaviour.set(url.A(102), 'hang');
    logLines.length = 0;
    const slow = play('pos_2');
    await sleep(500);
    const [live] = transcodeSession.getAllSessions();
    await transcodeSession.getSession(live.id).stop();
    const r = await slow;
    assert.equal(r.status, 499, r.text);
    assert.deepEqual(failoverLines(), []);
    assert.equal(startsOf(url.B(5002)) + startsOf(url.C(7002)), 0);
    assert.equal(routing.providerState(A.id), 'up');
});

test('0180: a walk that the owner\'s newer request overtook starts no further candidate', async () => {
    behaviour.set(url.A(101), '502');
    behaviour.set(url.A(109), 'hang');
    logLines.length = 0;
    const walking = play('pos_1');               // primary 502 (retry 1 s), then the sibling
    await sleep(300);
    await play('pos_4');
    const r = await walking;
    assert.equal(r.status, 499, r.text);
    assert.equal(startsOf(url.B(5001)) + startsOf(url.C(7001)), 0, 'the backups were never started');
});

test('0180: a genuine provider failure still fails over exactly as before', async () => {
    behaviour.set(url.A(103), '502');
    const r = await play('pos_3');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.provider.failover, true);
    assert.equal(failoverLines().filter(l => /failed for/.test(l)).length >= 1, true);
});

test('0180: with no backup, a stopped start is also just superseded; a real failure is unchanged', async () => {
    await db.sources.update(B.id, { enabled: false });
    await db.sources.update(C.id, { enabled: false });
    sqlite.getDb().prepare('DELETE FROM channel_links').run();
    behaviour.set(url.A(104), 'hang');
    const slow = play('pos_4');
    await sleep(400);
    await play('pos_3');
    assert.equal((await slow).status, 499);
    behaviour.set(url.A(102), '502');
    const bad = await play('pos_2');
    assert.equal(bad.status, 500);
    assert.match(bad.body.error, /^The provider refused this channel/);
});

test('no line this feature logs carries a URL', () => {
    const ours = logLines.filter(l => /\[Playback\] failover|\[Providers\]|mid-play|\[Playback\] resolve timing/.test(l));
    assert.ok(ours.length > 0);
    for (const line of ours) noUrl(line, 'log');
});
