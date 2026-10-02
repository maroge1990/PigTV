const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// 0189: in-stream recovery and the hot standby (docs/STANDBY-BRIEF.md), with stand-in sessions:
// folders of files instead of ffmpeg. The real thing is exercised by scripts/relay-rig.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-relay-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const sessions = load('services/transcodeSession');
const coordinator = load('services/streamCoordinator');
const routing = load('services/providerRouting');
const strategy = load('services/playbackStrategy');
const interruptions = load('services/playbackInterruptions');
const relay = load('services/streamRelay');

const real = { getAll: sessions.getAllSessions, remove: sessions.removeSession, get: sessions.getSession,
    plan: routing.plan, resolve: strategy.resolve, noteFailure: routing.noteFailure, watch: routing.watchSession };
const registry = new Map();   // the stand-in session registry
let quarantined, started;

after(async () => {
    await relay.closeAll();
    Object.assign(sessions, { getAllSessions: real.getAll, removeSession: real.remove, getSession: real.get });
    Object.assign(routing, { plan: real.plan, noteFailure: real.noteFailure, watchSession: real.watch });
    strategy.resolve = real.resolve;
    try { load('db/sqlite').getDb().close(); } catch { /* never opened */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

let n = 0;
/** A stand-in for a TranscodeSession: a folder with a playlist and segment files. */
function fakeSession({ owner = 'device:tv', providerId = 1, segmentType = 'fmp4', videoRange = 'SDR', standby = false } = {}) {
    const s = new EventEmitter();
    s.id = `s${++n}`;
    s.dir = path.join(sandbox, 'cache', s.id);
    fs.mkdirSync(s.dir, { recursive: true });
    s.playlistPath = path.join(s.dir, 'stream.m3u8');
    s.options = { owner, providerId, segmentType, videoRange, standby, width: 1280, height: 720, fps: '25/1' };
    s.status = 'running';
    s.startTime = Date.now();
    s.lastAccess = Date.now();
    s.touch = () => { s.lastAccess = Date.now(); };
    s.getPlaylist = async () => { try { return fs.readFileSync(s.playlistPath, 'utf8'); } catch { return null; } };
    s.cleanup = async () => { s.stopRequested = true; s.status = 'stopped'; if (!s.retainDir) fs.rmSync(s.dir, { recursive: true, force: true }); };
    registry.set(s.id, s);
    return s;
}
/** Write segments first..last (and the init segment) and the playlist ffmpeg would have written. */
function write(s, first, last, { ended = false, duration = 4 } = {}) {
    const ext = s.options.segmentType === 'fmp4' ? 'm4s' : 'ts';
    const lines = ['#EXTM3U', `#EXT-X-VERSION:${ext === 'm4s' ? 7 : 6}`, `#EXT-X-TARGETDURATION:${duration}`, `#EXT-X-MEDIA-SEQUENCE:${first}`, '#EXT-X-INDEPENDENT-SEGMENTS'];
    if (ext === 'm4s') { lines.push('#EXT-X-MAP:URI="init.mp4"'); fs.writeFileSync(path.join(s.dir, 'init.mp4'), 'init'); }
    for (let i = first; i <= last; i++) {
        const name = `seg${String(i).padStart(4, '0')}.${ext}`;
        fs.writeFileSync(path.join(s.dir, name), `${s.id}:${i}`);
        lines.push(`#EXTINF:${duration.toFixed(6)},`, name);
    }
    if (ended) lines.push('#EXT-X-ENDLIST');
    fs.writeFileSync(s.playlistPath, lines.join('\n') + '\n');
}
const A = { providerId: 1, providerName: 'Strong8K', role: 'primary', via: 'primary', url: 'http://a.invalid/1.ts', channelKey: 'k' };
const B = { providerId: 2, providerName: 'Dream4K', role: 'backup', via: 'backup', url: 'http://b.invalid/9.ts', channelKey: '9' };
const ctx = (extra = {}) => ({ sourceId: 1, channelId: 'pos_1', capabilities: { fmp4: true }, settings: { maxProviderStreams: 5 }, ffprobePath: 'ffprobe',
    owner: 'device:tv', channelName: 'Fox Footy', primaryKey: 'k', candidate: A, ...extra });
const silently = async (fn) => { const log = console.log, warn = console.warn; console.log = console.warn = () => {}; try { return await fn(); } finally { console.log = log; console.warn = warn; } };
const segs = (text) => text.split('\n').filter(l => l && !l.startsWith('#'));

beforeEach(async () => {
    await silently(() => relay.closeAll());
    process.env.PIGTV_RELAY = '1';
    delete process.env.PIGTV_STANDBY;
    registry.clear();
    quarantined = []; started = [];
    interruptions.reset();
    sessions.getAllSessions = () => [...registry.values()].filter(s => s.status === 'running').map(s => ({ id: s.id, url: 'x', status: s.status, startTime: s.startTime,
        lastAccess: s.lastAccess, idleMs: Date.now() - s.lastAccess, owner: s.options.owner, providerId: s.options.providerId, standby: s.options.standby === true }));
    sessions.removeSession = async (id) => { const s = registry.get(id); if (s) { registry.delete(id); await s.cleanup(); } };
    sessions.getSession = (id) => registry.get(id) || null;
    routing.noteFailure = (candidate) => { quarantined.push(candidate.providerName); };
    routing.watchSession = () => {};
    routing.plan = async () => ({ candidates: [A, B].filter(c => !quarantined.includes(c.providerName)), primaryKey: 'k', channelName: 'Fox Footy' });
    // A leg "starts": a new stand-in session on that candidate's provider, with two segments.
    strategy.resolve = async (opts) => {
        started.push({ provider: opts.providerId, owner: opts.owner, standby: !!(opts.sessionOptions && opts.sessionOptions.standby) });
        const s = fakeSession({ owner: opts.owner, providerId: opts.providerId, standby: !!(opts.sessionOptions && opts.sessionOptions.standby) });
        write(s, 0, 1);
        return { strategy: 'transcode', sessionId: s.id };
    };
});

test('off by default: nothing is adopted, and the session routes see no relay', () => {
    delete process.env.PIGTV_RELAY;
    const s = fakeSession();
    assert.equal(relay.adopt(s, ctx()), null);
    assert.equal(relay.get(s.id), null);
    assert.equal(s.retainDir, undefined, 'the session is untouched');
    process.env.PIGTV_STANDBY = '1';
    assert.equal(relay.standbyEnabled(), false, 'the standby needs the relay');
    assert.equal(relay.adopt(s, { ...ctx(), sourceId: undefined }), null, 'a bare-url play is never adopted');
});

test('before anything goes wrong the playlist is ffmpeg\'s own file, less an ENDLIST', async () => {
    const s = fakeSession();
    write(s, 0, 2);
    const r = await silently(() => relay.adopt(s, ctx()));
    assert.equal(r.id, s.id);
    assert.equal(await r.getPlaylist(), fs.readFileSync(s.playlistPath, 'utf8'));
    write(s, 0, 3, { ended: true }); // the provider closed cleanly: ffmpeg ends the list
    const text = await r.getPlaylist();
    assert.ok(!text.includes('ENDLIST'));
    assert.deepEqual(segs(text), ['seg0000.m4s', 'seg0001.m4s', 'seg0002.m4s', 'seg0003.m4s']);
    assert.match(r.getMasterPlaylist(), /VIDEO-RANGE=SDR/);
    assert.equal(await r.getSegment('seg0001.m4s'), path.join(s.dir, 'seg0001.m4s'));
    assert.equal(await r.getSegment('../../etc/passwd'), null);
    assert.equal(await r.getSegment('L7-seg0001.m4s'), null, 'no such leg');
});

test('a cold switch: the lost leg is quarantined by its own listener, the next provider joins on after a discontinuity', async () => {
    const s = fakeSession();
    write(s, 0, 3);
    const r = await silently(() => relay.adopt(s, ctx()));
    await silently(() => r.tick());
    assert.equal(r.entries.length, 4);
    // ffmpeg exits by itself: the route's listeners record it (here: the quarantine and the row).
    quarantined.push('Strong8K');
    interruptions.noteLost({ owner: 'device:tv', channel: 'Fox Footy', provider: 'Strong8K', how: 'exit', providerReason: true });
    write(s, 0, 4, { ended: true, duration: 4 });
    s.emit('lost', { how: 'exit', providerReason: true });
    assert.ok(!(await r.getPlaylist()).includes('ENDLIST'), 'the relay\'s own list from the moment the leg is lost');
    await silently(() => r.tick());

    assert.deepEqual(started, [{ provider: 2, owner: 'device:tv', standby: false }]);
    assert.equal(registry.has(s.id), false, 'the lost leg\'s connection is freed');
    assert.ok(fs.existsSync(path.join(s.dir, 'seg0004.m4s')), 'its segments are kept while they are listed');
    const text = await r.getPlaylist();
    assert.equal(text, [
        '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4.000000,', 'seg0000.m4s', '#EXTINF:4.000000,', 'seg0001.m4s', '#EXTINF:4.000000,', 'seg0002.m4s',
        '#EXTINF:4.000000,', 'seg0003.m4s', '#EXTINF:4.000000,', 'seg0004.m4s',
        '#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="L1-init.mp4"',
        '#EXTINF:4.000000,', 'L1-seg0000.m4s', '#EXTINF:4.000000,', 'L1-seg0001.m4s', ''
    ].join('\n'));
    const leg1 = r.active.session;
    assert.equal(await r.getSegment('L1-seg0001.m4s'), path.join(leg1.dir, 'seg0001.m4s'));
    assert.equal(await r.getSegment('L1-init.mp4'), path.join(leg1.dir, 'init.mp4'));
    assert.equal(relay.playingSessionId(s.id), leg1.id, 'the coordinator knows the stream by its playing leg');
    const row = interruptions.summary().recent[0];
    assert.equal(row.recoveredProvider, 'Dream4K');
    assert.ok(row.recoverSec !== null);
    // The stream goes on growing from the new leg.
    write(leg1, 0, 3);
    assert.deepEqual(segs(await r.getPlaylist()).slice(-2), ['L1-seg0002.m4s', 'L1-seg0003.m4s']);
});

test('the window slides: media sequence continues, a join that leaves the list is counted, an unlisted leg\'s folder goes', async () => {
    const s = fakeSession();
    write(s, 0, 1);
    const r = await silently(() => relay.adopt(s, ctx()));
    await silently(() => r.tick());
    s.emit('lost', { how: 'stall', providerReason: true });
    quarantined.push('Strong8K');
    await silently(() => r.tick());
    const leg1 = r.active.session;
    write(leg1, 0, 95); // ffmpeg's own window is 90
    const text = await r.getPlaylist();
    assert.match(text, /#EXT-X-MEDIA-SEQUENCE:8\n/, '2 + 96 segments, the newest 90 listed');
    assert.match(text, /#EXT-X-DISCONTINUITY-SEQUENCE:1\n/);
    assert.ok(!text.includes('#EXT-X-DISCONTINUITY\n'), 'the join itself is no longer in the list');
    assert.equal(segs(text)[0], 'L1-seg0006.m4s');
    await new Promise(res => setTimeout(res, 50));
    assert.equal(fs.existsSync(s.dir), false, 'leg 0 has nothing listed: its folder is removed');
    assert.equal(await r.getSegment('seg0001.m4s'), null);
});

test('a feed that cannot join (another segment type or video range) is not used; with nothing left the relay ends', async () => {
    const s = fakeSession();
    write(s, 0, 1);
    const r = await silently(() => relay.adopt(s, ctx()));
    strategy.resolve = async (opts) => { const x = fakeSession({ providerId: opts.providerId, segmentType: 'mpegts' }); write(x, 0, 1); return { strategy: 'transcode', sessionId: x.id }; };
    quarantined.push('Strong8K');
    s.emit('lost', { how: 'exit', providerReason: true });
    await silently(() => r.tick());
    assert.equal(r.closed, true);
    assert.equal(relay.get(s.id), null, 'the playlist now answers 404 and the client re-resolves, as without a relay');
    assert.equal(registry.size, 0, 'no leg is left running');
    await new Promise(res => setTimeout(res, 50)); // folders are removed in the background
    assert.equal(fs.existsSync(s.dir), false);
});

test('the play ends with its stream: stopped on request, DELETE, or the viewer watching something else', async () => {
    const s = fakeSession();
    write(s, 0, 1);
    const r = await silently(() => relay.adopt(s, ctx()));
    await sessions.removeSession(s.id); // the coordinator released it (the viewer changed channel)
    await silently(() => r.tick());
    assert.equal(r.closed, true);
    assert.deepEqual(started, [], 'nothing is restarted');

    const s2 = fakeSession();
    write(s2, 0, 1);
    await silently(() => relay.adopt(s2, ctx()));
    assert.equal(await silently(() => relay.close(s2.id)), true);
    assert.equal(await relay.close(s2.id), false);
    assert.equal(registry.has(s2.id), false);

    // Lost, but by the time the relay acts the viewer has another stream: it must not be replaced.
    const s3 = fakeSession();
    write(s3, 0, 1);
    const r3 = await silently(() => relay.adopt(s3, ctx()));
    s3.emit('lost', { how: 'exit', providerReason: true });
    const other = fakeSession({ owner: 'device:tv', providerId: 2 });
    await silently(() => r3.tick());
    assert.equal(r3.closed, true);
    assert.equal(registry.has(other.id), true, 'the viewer\'s new stream is untouched');
    assert.deepEqual(started, []);
});

test('standby: started on another provider with a free connection, joined on at once when the playing leg goes quiet', async () => {
    process.env.PIGTV_STANDBY = '1';
    process.env.PIGTV_RELAY_SWITCH_MS = '3000';
    const samePool = coordinator.samePool, free = coordinator.hasFreeConnection;
    coordinator.samePool = (a, b) => a === b;
    coordinator.hasFreeConnection = (id) => ![...registry.values()].some(x => x.status === 'running' && x.options.providerId === id);
    try {
        const s = fakeSession();
        write(s, 0, 5);
        const r = await silently(() => relay.adopt(s, ctx()));
        await silently(() => r.tick());
        assert.equal(r.standby, null, 'not in the first 20 s of a play');
        r.standbyAt = 0;
        await silently(() => r.tick());
        await new Promise(res => setTimeout(res, 20));
        assert.deepEqual(started, [{ provider: 2, owner: `standby:${s.id}`, standby: true }]);
        const sb = r.standby.session;
        assert.equal(sb.options.standby, true);
        await silently(() => r.tick());
        assert.equal(r.standbyReady(), true);
        assert.equal(await r.getPlaylist(), fs.readFileSync(s.playlistPath, 'utf8'), 'the viewer still sees only the playing leg');

        // The playing leg writes nothing for longer than the switch time; the standby carries on.
        write(sb, 3, 7);
        r.lastProgressAt = Date.now() - 4000;
        await silently(() => r.tick());
        assert.equal(r.active.session, sb);
        assert.equal(sb.options.standby, false);
        assert.equal(sb.options.owner, 'device:tv', 'it is the viewer\'s stream now');
        assert.deepEqual(quarantined, ['Strong8K'], 'the provider that went quiet is quarantined for this channel');
        const text = await r.getPlaylist();
        assert.deepEqual(segs(text).slice(-3), ['seg0005.m4s', 'L1-seg0006.m4s', 'L1-seg0007.m4s'], 'joined on at its newest two segments');
        assert.match(text, /seg0005\.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="L1-init\.mp4"\n/);
        await new Promise(res => setTimeout(res, 20));
        assert.equal(registry.has(s.id), false, 'the old leg is stopped');
        const row = interruptions.summary().recent[0];
        assert.deepEqual([row.provider, row.how, row.recoveredProvider], ['Strong8K', 'stall', 'Dream4K']);
    } finally {
        coordinator.samePool = samePool; coordinator.hasFreeConnection = free;
        delete process.env.PIGTV_RELAY_SWITCH_MS;
    }
});

test('standby: when its connection is taken the relay carries on without it', async () => {
    process.env.PIGTV_STANDBY = '1';
    const samePool = coordinator.samePool, free = coordinator.hasFreeConnection;
    coordinator.samePool = (a, b) => a === b;
    coordinator.hasFreeConnection = () => true;
    try {
        const s = fakeSession();
        write(s, 0, 2);
        const r = await silently(() => relay.adopt(s, ctx()));
        r.standbyAt = 0;
        await silently(() => r.tick());
        await new Promise(res => setTimeout(res, 20));
        const sb = r.standby.session;
        await sessions.removeSession(sb.id); // a recording or a viewer took the connection
        await silently(() => r.tick());
        assert.equal(r.standby, null);
        assert.equal(r.closed, false);
        await new Promise(res => setTimeout(res, 50));
        assert.equal(fs.existsSync(sb.dir), false);
        assert.ok(r.standbyAt > Date.now() + 30000, 'tried again in a minute, not at once');
    } finally {
        coordinator.samePool = samePool; coordinator.hasFreeConnection = free;
    }
});

test('the coordinator treats a standby as abandoned: a viewer and a recording take its connection unasked', async () => {
    const settings = { maxProviderStreams: 1 };
    const sb = fakeSession({ owner: 'standby:s1', standby: true });
    assert.equal(coordinator.hasFreeConnection(null, settings, []), false, 'a standby holds the connection it runs on');
    assert.equal(coordinator.canRecordFreely(null, settings, []), true, 'but it does not stop a recording being placed there');
    const verdict = coordinator.requestForViewer({ settings, owner: 'device:ipad', activeRecordings: [] });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(verdict.release.map(x => [x.stream.id, x.cause]), [[sb.id, 'standby']]);
    coordinator.announceUpcoming({ id: 41, title: 'News', channel_name: 'ABC', program_start: Date.now() + 60000 }, settings);
    assert.equal(coordinator._prompts.has(41), false, 'nobody to warn: only a standby is on the provider');
    const rec = await silently(() => coordinator.requestForRecording({ id: 41, title: 'News' }, settings));
    assert.equal(rec.allowed, true);
    assert.equal(registry.has(sb.id), false, 'the standby was released');

    // A viewer and a standby on a provider with two connections: the recording takes the
    // standby's, and the viewer is not asked.
    const two = { maxProviderStreams: 2 };
    const viewer = fakeSession({ owner: 'device:tv' });
    const sb2 = fakeSession({ owner: 'standby:s9', standby: true });
    const rec2 = await silently(() => coordinator.requestForRecording({ id: 42, title: 'Match' }, two));
    assert.deepEqual([rec2.allowed, rec2.prompted], [true, undefined]);
    assert.equal(registry.has(sb2.id), false);
    assert.equal(registry.has(viewer.id), true);
    assert.equal(coordinator._prompts.has(42), false);
});

test('the session routes: a relay answers for its id, later legs\' names are allowed, DELETE ends it', () => {
    const route = fs.readFileSync(path.join(sandbox, 'server/routes/transcode.js'), 'utf8');
    assert.match(route, /return relay\.get\(sessionId\) \|\| transcodeSession\.getSession\(sessionId\);/);
    const allow = /^(L\d{1,3}-)?(seg\d{4,}\.(ts|m4s)|init\.mp4)$/;
    assert.ok(route.includes(String(allow).slice(1, -1)));
    for (const ok of ['seg0001.m4s', 'init.mp4', 'L1-seg0042.ts', 'L12-init.mp4']) assert.ok(allow.test(ok), ok);
    for (const bad of ['L1-../x.m4s', 'L-seg0001.ts', 'L1-stream.m3u8', '../seg0001.ts', 'L1234-seg0001.ts']) assert.ok(!allow.test(bad), bad);
    assert.match(route, /if \(!\(await relay\.close\(sessionId\)\)\) await transcodeSession\.removeSession\(sessionId\);/);
    const playback = fs.readFileSync(path.join(sandbox, 'server/routes/playback.js'), 'utf8');
    assert.match(playback, /require\('\.\.\/services\/streamRelay'\)\.adopt\(played, \{/);
    assert.match(playback, /playingSessionId\(req\.params\.sessionId\)/);
});
