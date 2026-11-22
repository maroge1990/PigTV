const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// #41: a model-based test of the relay (services/streamRelay.js). Seeded random sequences of the events a relay meets
// (a leg writes, is lost, goes quiet; a start succeeds, fails or never yields a playlist; the standby is due, ready,
// lost or taken; the shared ingest reconnects (a planned renewal, setting ON here only) or is ended; the viewer pauses,
// leaves or plays something else) are run against the real relay, the real coordinator (admission, leases, pools) and
// the real provider-start walk, with stand-in sessions (folders of files) and stand-in shared ingests. After every
// step the invariants are checked, and the transition table in docs/architecture/playback.md › "The relay's
// transition table" is asserted for the step's event:
//   I1  at most one provider connection per pool at any moment (checked whenever a connection opens, and after each step)
//   I2  no renewal pin and no ingest subscriber of this play is left once it has ended
//   I3  the playlist the client reads is monotonic: the media sequence and the last segment never go back, a sequence
//       number never changes its segment, and an EXT-X-DISCONTINUITY stands exactly where the leg changes; no ENDLIST
//   I4  every leg started is stopped once the play has ended
//   I5  no relay timer is left once the play has ended, and nothing is started after it
// A failure prints the seed and the event sequence. Fixed seeds always; a few random ones too unless CI is set
// (PIGTV_MODEL_SEED=<n> runs one seed alone).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-relay-model-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sessions = load('services/transcodeSession');
const coordinator = load('services/streamCoordinator');
const routing = load('services/providerRouting');
const strategy = load('services/playbackStrategy');
const interruptions = load('services/playbackInterruptions');
const ingestModule = load('services/ingest');
const relay = load('services/streamRelay');
const { parseMediaPlaylist } = load('services/hlsPlaylist');

const realTimers = { setInterval: global.setInterval, clearInterval: global.clearInterval };
after(async () => {
    Object.assign(global, realTimers);
    try { await relay.closeAll(); } catch { /* model over */ }
    try { load('db/sqlite').getDb().close(); } catch { /* never opened */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

// ---- a seeded PRNG ------------------------------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- the relay's own clock: captured, driven by the model ----------------------------------------------------------
// The relay's 1 s tick is taken over while a relay is made (adopt), so the model decides when it ticks; clearing it
// is recorded (I5). Every other timer is the real one.
const relayTimers = new Set();
function captureRelayTimer(fn) {
    global.setInterval = (cb, ms) => { const t = { fake: true, cb, ms, cleared: false, unref() { return t; } }; relayTimers.add(t); return t; };
    global.clearInterval = (t) => { if (t && t.fake) { t.cleared = true; return; } return realTimers.clearInterval(t); };
    try { return fn(); } finally { global.setInterval = realTimers.setInterval; }
}
// clearInterval stays wrapped (a relay clears its timer at close, long after adopt).

// ---- the world: providers, stand-in ingests and sessions -----------------------------------------------------------
const OWNER = 'device:model';
const A = { providerId: 1, providerName: 'ProvA', role: 'primary', via: 'primary', url: 'http://a.invalid/1.ts', channelKey: 'a1' };
const A2 = { providerId: 1, providerName: 'ProvA', role: 'primary', via: 'sibling', url: 'http://a.invalid/2.ts', channelKey: 'a2' };
const B = { providerId: 2, providerName: 'ProvB', role: 'backup', via: 'backup', url: 'http://b.invalid/9.ts', channelKey: 'b9' };
const CANDIDATES = [A, A2, B];
const SETTINGS = { maxProviderStreams: 1, relayEnabled: true, standbyEnabled: true, sharedIngestEnabled: true, ingestReconnectRenewal: true };

let world;
const registry = new Map();

class FakeIngest {
    constructor(source) {
        this.id = ++world.ingestSeq;
        this.key = source.key;
        this.pool = source.pool;
        this.url = source.url;
        this.providerId = source.providerId;
        this.state = 'live';
        this.startedAt = Date.now();
        this.lastByteAt = Date.now();
        this.reconnectedAt = Date.now() - 60000;
        this.waiters = 0;
        this.closed = false;
        this.subs = new Set();
        // I1, at the moment a connection opens: no other open connection in this pool.
        const others = [...ingestModule._registry.values()].filter(i => !i.closed && i.pool === this.pool);
        if (others.length) world.violation(`I1: a second connection opened in pool ${this.pool} (${this.url.split('/').pop()}) beside ${others.map(o => o.url.split('/').pop())}`);
        ingestModule._registry.set(this.key, this);
        world.ingests.push(this);
    }
    subscribe(info = {}) {
        if (this.closed) throw Object.assign(new Error('ingest closed'), { ingestCancelled: true });
        const sub = { info, ingest: this, endReason: null, resume() {}, unpipe() {}, pipe() {}, loopFilter: null,
            leave: () => { if (!this.subs.delete(sub)) return; if (!this.subs.size) this.close('idle'); } };
        this.subs.add(sub);
        return sub;
    }
    /** Ended (a reconnect failed, the coordinator needed it, idle): every reader's stream ends. */
    close(why, providerReason = false) {
        if (this.closed) return;
        this.closed = true;
        if (ingestModule._registry.get(this.key) === this) ingestModule._registry.delete(this.key);
        for (const sub of [...this.subs]) {
            sub.endReason = { reason: why, providerReason };
            if (sub.session) sub.session.feedEnded(providerReason);
        }
        this.subs.clear();
    }
    /** The provider's connection dropped and came back: a planned boundary for relay legs that opted in. */
    reconnect() {
        this.reconnectedAt = Date.now() - 60000; // settled already: the model's renewal does not wait on the clock
        for (const sub of [...this.subs]) if (sub.session) sub.session.emit('reconnected-feed', { forLag: false, gapSec: 1 });
    }
}

const ingestFor = (source) => {
    const live = ingestModule._registry.get(source.key);
    return live && !live.closed ? live : new FakeIngest(source);
};

let seq = 0;
/** A stand-in TranscodeSession: a folder with a playlist and segments, reading a stand-in ingest. */
function fakeSession(candidate, opts) {
    const s = new EventEmitter();
    s.id = `m${++seq}`;
    s.dir = path.join(sandbox, 'cache', s.id);
    fs.mkdirSync(s.dir, { recursive: true });
    s.playlistPath = path.join(s.dir, 'stream.m3u8');
    s.url = candidate.url;
    s.candidate = candidate;
    s.options = { owner: opts.owner, providerId: candidate.providerId, segmentType: 'fmp4', videoRange: 'SDR', width: 1280, height: 720, fps: '25/1',
        videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, ...(opts.sessionOptions || {}) };
    s.status = 'running';
    s.startTime = Date.now();
    s.lastAccess = Date.now();
    s.timings = { playlistReady: null };
    s.first = 0; s.next = 0; s.stalled = false; s.ended = false;
    s.touch = () => { s.lastAccess = Date.now(); };
    s.getPlaylist = async () => { try { return fs.readFileSync(s.playlistPath, 'utf8'); } catch { return null; } };
    s.process = { stdin: { end() { s.write(0, { ended: true }); s.exit(); } } };
    s.stopWatchdog = () => {};
    s.exit = () => { s.ended = true; if (s.feed) { const f = s.feed; s.feed = null; f.leave(); } };
    s.stop = async () => { s.stopRequested = true; s.status = 'stopped'; s.exit(); };
    s.cleanup = async () => { s.stopRequested = true; s.status = 'stopped'; s.exit(); s.cleaned = true; if (!s.retainDir) fs.rmSync(s.dir, { recursive: true, force: true }); };
    /** ffmpeg wrote `n` more segments (it keeps every one: the window is far larger than a model run). */
    s.write = (n = 1, { ended = false } = {}) => {
        s.next += n;
        const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', `#EXT-X-MEDIA-SEQUENCE:${s.first}`, '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"'];
        fs.writeFileSync(path.join(s.dir, 'init.mp4'), 'init');
        for (let i = s.first; i < s.next; i++) {
            const name = `seg${String(i).padStart(4, '0')}.m4s`;
            if (!fs.existsSync(path.join(s.dir, name))) fs.writeFileSync(path.join(s.dir, name), `${s.id}:${i}`);
            lines.push('#EXTINF:4.000000,', name);
        }
        if (ended) lines.push('#EXT-X-ENDLIST');
        fs.writeFileSync(s.playlistPath, lines.join('\n') + '\n');
    };
    /** The ingest ended under it: ffmpeg's input closed, so it ends; unrequested, that is a lost leg. */
    s.feedEnded = (providerReason) => {
        s.feed = null;
        if (s.stopRequested || s.ended) return;
        s.ended = true;
        s.status = 'error';
        s.emit('lost', { how: 'exit', providerReason });
    };
    // The real session's reconnect handling, on this stand-in (FR-22: a relay viewer leg renews its timeline).
    s.on('reconnected-feed', (info) => sessions.TranscodeSession.prototype.handleIngestReconnect.call(s, info));
    if (opts.ingestSource) {
        const ingest = ingestFor(opts.ingestSource);
        s.feed = ingest.subscribe({ purpose: opts.sessionOptions?.standby ? 'standby' : 'viewer', owner: opts.owner });
        s.feed.session = s;
        s.ingestKey = ingest.key;
    }
    registry.set(s.id, s);
    world.sessions.push(s);
    return s;
}

/** The stand-in for playbackStrategy.resolve: what this provider's start does is the model's to say. */
async function fakeResolve(opts) {
    const candidate = CANDIDATES.find(c => c.url === opts.url);
    world.resolves++;
    if (world.ended) world.violation('I5: a leg was started after the play ended');
    const mode = world.startMode.get(candidate.url) || 'ok';
    world.trace.push(`  start ${candidate.channelKey}${opts.sessionOptions?.standby ? ' (standby)' : ''}${opts.sessionOptions?.relayTimeline ? ' (renewal on)' : ''}: ${mode}`);
    // The probe takes a while: other events (a switch, a takeover) can happen meanwhile.
    for (let n = Math.floor(world.rand() * 4); n > 0; n--) await new Promise(r => setTimeout(r, 0));
    if (mode === 'fail') throw new Error('Server returned 5XX Server Error reply');
    // As the real resolve (R11): a lease given up meanwhile is a superseded start; the session binds it as it registers.
    if (opts.lease && !coordinator.leaseAlive(opts.lease)) throw Object.assign(new Error('superseded'), { superseded: true });
    const s = fakeSession(candidate, opts);
    if (opts.lease && !coordinator.bindLease(opts.lease, s.id)) { await sessions.removeSession(s.id); throw Object.assign(new Error('superseded'), { superseded: true }); }
    await new Promise(r => setImmediate(r));
    if (mode === 'noPlaylist') {
        // Connected, but no first segment by the deadline: the resolve gives the session up (and its connection).
        await new Promise(r => setTimeout(r, 2));
        await sessions.removeSession(s.id);
        throw new Error('FFmpeg ended before producing a playlist');
    }
    s.write(2);
    s.timings.playlistReady = Date.now();
    return { strategy: 'transcode', sessionId: s.id };
}

function installStubs() {
    sessions.getAllSessions = () => [...registry.values()].map(s => ({ id: s.id, url: s.url, status: s.status, startTime: s.startTime, lastAccess: s.lastAccess,
        idleMs: Date.now() - s.lastAccess, paused: s.pausedUntil > Date.now(), owner: s.options.owner || null, providerId: s.options.providerId ?? null,
        standby: s.options.standby === true, warm: false, ...(s.ingestKey ? { ingestKey: s.ingestKey } : {}) }));
    sessions.removeSession = async (id) => { const s = registry.get(id); if (s) { registry.delete(id); await s.cleanup(); } };
    sessions.getSession = (id) => registry.get(id) || null;
    sessions.peekSession = (id) => registry.get(id) || null;
    strategy.resolve = fakeResolve;
    routing.noteFailure = (candidate) => { routing.quarantine(candidate.providerId, candidate.channelKey); };
    routing.noteStartFailure = () => {};
    routing.watchSession = (session, candidate) => {
        // As the real one: a leg lost for the provider's reason is quarantined for this channel.
        session.once('lost', (info) => { if (info && info.providerReason) routing.quarantine(candidate.providerId, candidate.channelKey); });
    };
    routing.plan = async () => ({ candidates: CANDIDATES.filter(c => !routing.isQuarantined(c.providerId, c.channelKey)), primaryKey: 'a1', channelName: 'Model' });
    coordinator.setRecordingsSource(() => []);
}

// ---- the invariants ------------------------------------------------------------------------------------------------

function connectionsByPool() {
    const out = new Map();
    for (const i of ingestModule._registry.values()) if (!i.closed && i.subs.size) out.set(i.pool, (out.get(i.pool) || 0) + 1);
    return out;
}

/** I3: what the client reads, compared with everything it read before. */
async function checkPlaylist(r) {
    if (r.closed) return;
    const text = await r.getPlaylist();
    if (!text) return;
    if (/#EXT-X-ENDLIST/.test(text)) world.violation('I3: the client was handed an ENDLIST');
    const parsed = parseMediaPlaylist(text);
    const ms = parsed.mediaSequence ?? 0;
    const lines = text.split('\n');
    const segs = [];
    let disc = false;
    for (const l of lines) {
        if (l === '#EXT-X-DISCONTINUITY') disc = true;
        else if (l && !l.startsWith('#')) { segs.push({ name: l, disc }); disc = false; }
    }
    const legOf = (name) => (/^L(\d+)-/.exec(name) || [null, '0'])[1];
    const p = world.playlist;
    if (p.ms !== null && ms < p.ms) world.violation(`I3: media sequence went back ${p.ms} -> ${ms}`);
    const dseq = Number((/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(text) || [null, 0])[1]);
    if (dseq < p.dseq) world.violation(`I3: discontinuity sequence went back ${p.dseq} -> ${dseq}`);
    segs.forEach((seg, i) => {
        const n = ms + i;
        if (p.seen.has(n) && p.seen.get(n) !== seg.name) world.violation(`I3: sequence ${n} was ${p.seen.get(n)}, now ${seg.name}`);
        p.seen.set(n, seg.name);
        if (i > 0) {
            const changed = legOf(seg.name) !== legOf(segs[i - 1].name);
            if (changed && !seg.disc) world.violation(`I3: the leg changes at ${seg.name} without a discontinuity`);
            if (!changed && seg.disc) world.violation(`I3: a discontinuity at ${seg.name} where the leg does not change`);
        }
    });
    const last = ms + segs.length - 1;
    if (p.last !== null && segs.length && last < p.last) world.violation(`I3: the newest segment went back ${p.last} -> ${last}`);
    p.ms = ms; p.dseq = dseq; if (segs.length) p.last = Math.max(p.last ?? -1, last);
}

function checkConnections() {
    for (const [pool, n] of connectionsByPool()) if (n > 1) world.violation(`I1: ${n} connections held in pool ${pool}`);
}

/** Once the play has ended: I2, I4, I5. */
function checkEnded(r) {
    for (const i of world.ingests) {
        if (i.closed) continue;
        const pins = [...i.subs].filter(s => s.info.purpose === 'renewal-pin');
        if (pins.length) world.violation(`I2: ${pins.length} renewal pin(s) left on ${i.url.split('/').pop()} after the play ended`);
        else if (i.subs.size) world.violation(`I2: ${i.subs.size} reader(s) left on ${i.url.split('/').pop()} after the play ended`);
    }
    for (const s of world.sessions) if (!s.stopRequested || registry.has(s.id)) world.violation(`I4: leg ${s.id} (${s.candidate.channelKey}) still running after the play ended`);
    for (const t of world.timers) if (!t.cleared) world.violation('I5: the relay\'s timer still runs after the play ended');
    const leases = coordinator.listLeases().filter(l => l.owner === OWNER || String(l.owner).startsWith('standby:'));
    if (leases.length) world.violation(`I4: ${leases.length} connection lease(s) left after the play ended (${leases.map(l => l.purpose)})`);
}

// ---- settling: let the relay's background work finish ----------------------------------------------------------------

async function settle(r) {
    const end = Date.now() + 3000;
    let quiet = 0;
    while (quiet < 4) {
        await new Promise(res => setImmediate(res));
        await new Promise(res => setTimeout(res, 0));
        quiet = (r.switching || r.startingStandby) ? 0 : quiet + 1;
        if (Date.now() > end) { world.violation('the relay did not settle within 3 s (a hang)'); return; }
    }
}

// ---- the transition table (docs/architecture/playback.md › The relay's transition table) ----------------------------

/** What the relay looked like before an event, for the table's checks. */
const snapshot = (r) => ({ closed: r.closed, reason: r.lastReason ? r.lastReason.code : null, reasons: [...(world.notes || [])], failed: r.failed, switches: r.switches, state: r.closed ? (r.failed ? 'failed' : 'ended') : r.state,
    leg: r.active, candidate: r.active.candidate, standby: r.standby, // Ready by its files (the relay reads them at its next tick): two segments written, not lost or stopped.
    standbyReady: !r.closed && !!r.standby && !r.standby.lost && !r.standby.session.stopRequested && r.standby.session.next >= relay.STANDBY_TAIL,
    legQuiet: r.active.session.stalled === true,
    renewalBlocked: r.renewalBlocked,
    renewalBudget: !r.renewalBlocked && r.renewalTimes.filter(t => Date.now() - t < 60000).length < 3,
    renewable: !r.closed && r.active.session.options.relayTimeline === true && !!r.active.session.timings.playlistReady && !r.active.session.stopRequested
        && !r.active.lost && !!r.active.session.feed });

/** A quiet playing leg (it wrote nothing for the switch time) handed to a standby that is ready: the one switch any tick may make. */
const quietSwitch = (b, a) => b.legQuiet && !!b.standby && a.leg === b.standby && a.switches === b.switches + 1;
/** The rows of the table, as checks of (before, event, after). A row that does not hold is a violation. */
const TABLE = {
    write: (b, a) => (b.closed === a.closed && a.switches === b.switches) || quietSwitch(b, a) || 'a leg writing changes nothing but the shown state',
    tick: (b, a) => a.switches === b.switches || quietSwitch(b, a) || 'a tick with nothing lost switches nothing',
    lost: (b, a) => (a.closed && (a.failed || a.state === 'ended')) || (a.switches === b.switches + 1 && a.leg !== b.leg && !a.leg.lost)
        || 'a lost leg is replaced by a new one (one switch) or the play ends',
    quiet: (b, a) => (b.standbyReady ? (a.switches === b.switches + 1 && a.leg === b.standby) || a.closed : a.switches === b.switches)
        || 'a quiet leg switches to a ready standby, and only to one',
    renewal: (b, a) => {
        if (!b.renewable) return a.switches === b.switches || a.closed || 'a reconnect on a leg that has not opted in changes nothing';
        // #4: a renewal that cannot land (no playlist, or its feed stuck to the deadline) is recovered from as a stall of
        // the leg: standby, provider walk, the same provider without renewal; renewal is then off for the play. The play
        // ends only when that ordinary path finds nothing (no-candidate), or the ingest itself ended under the pin.
        if (a.closed) {
            if (a.reason === 'renewal-timeout') return 'a renewal that timed out ended the play (#4)';
            // "nothing could take over" after a renewal is the ordinary path's verdict only once that path was tried.
            if (a.reason === 'no-candidate' && b.renewalBudget && !a.reasons.includes('renewal-failed') && !a.reasons.includes('renewal-budget'))
                return 'a renewal that could not land ended the play without the ordinary recovery (#4)';
            return true;
        }
        if (a.switches < b.switches + 1) return 'a renewal is a switch';
        if (a.renewalBlocked && !b.renewalBlocked && a.reasons.includes('renewal-failed')) return true; // the ordinary recovery
        // Within its budget a renewal is planned: the same feed, never the standby promoted, never another provider.
        // Over budget it is ordinary failover (renewal-budget), which may promote or re-plan.
        if (!b.renewalBudget) return true;
        if (a.leg.candidate !== b.candidate) return 'a planned renewal stays on the same feed (no re-plan, no standby)';
        return (a.standby === b.standby || !b.standby || b.standby.lost || b.standby.session.stopRequested) || 'a planned renewal leaves the standby as it was';
    },
    standbyDue: (b, a) => a.switches === b.switches || quietSwitch(b, a) || 'starting a standby switches nothing',
    standbyReady: (b, a) => a.switches === b.switches || quietSwitch(b, a) || 'a standby writing switches nothing, unless the playing leg is quiet',
    standbyLost: (b, a) => (a.switches === b.switches && (b.closed || a.closed || a.standby !== b.standby || !b.standby)) || 'a lost standby is dropped, the play goes on',
    standbyTaken: (b, a) => (a.switches === b.switches && (a.closed || !a.standby || a.standby !== b.standby || !b.standby)) || 'a taken standby is dropped, the play goes on',
    ingestEnded: (b, a) => a.closed || a.switches >= b.switches || 'an ended feed is a lost leg',
    pause: (b, a) => a.switches === b.switches || quietSwitch(b, a) || 'a pause switches nothing',
    resume: (b, a) => a.switches === b.switches || quietSwitch(b, a) || 'a resume switches nothing',
    startModes: () => true,
    quarantineLifted: () => true,
    viewerElsewhere: (b, a) => true, // checked at the next cold start: the relay ends rather than take the viewer's connection
    viewerLeaves: (b, a) => a.closed || 'the viewer leaving ends the play',
    // 0905 (Codex high): the device asks for something else while a failed renewal's fallback is in flight (its lease is
    // held during the switch): this play ends and nothing of it is promoted or started.
    budgetSuperseded: (b, a) => !world.supersededTaken || (a.closed && !a.failed) || 'a newer play of the device during a budget failover ends this one',
    renewalSuperseded: (b, a) => !world.supersededTaken || (a.closed && !a.failed) || 'a newer play of the device during the fallback ends this one',
    stopped: (b, a) => a.closed || 'a leg stopped on request (a DELETE, a takeover, the idle sweep) ends the play'
};

// ---- one run ---------------------------------------------------------------------------------------------------------

async function runSeed(seed, steps = 30) {
    const rand = mulberry32(seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    world = { seed, rand, notes: [], stuck: [], foreignLeases: [], supersedeOnRead: false, supersededTaken: false, sessions: [], ingests: [], ingestSeq: 0, resolves: 0, ended: false, violations: [], trace: [], timers: [], outcomes: [],
        startMode: new Map(), playlist: { ms: null, dseq: 0, last: null, seen: new Map() },
        violation(text) { this.violations.push(text); } };
    registry.clear();
    ingestModule._registry.clear();
    routing.reset();
    interruptions.reset();
    coordinator._leases.clear();
    relayTimers.clear();

    // The play: leg 0 on A, through the shared ingest, as the resolve would have started it.
    const logs = [];
    const log = console.log, warn = console.warn;
    console.log = console.warn = (...a) => logs.push(a.join(' '));
    const front = fakeSession(A, { owner: OWNER, ingestSource: ingestModule.sourceFor(A, SETTINGS) });
    front.write(2);
    front.timings.playlistReady = Date.now();
    front.options.relayTimeline = false; // the relay decides (addLeg)
    const r = captureRelayTimer(() => relay.adopt(front, { sourceId: 1, channelId: 'pos_1', capabilities: { fmp4: true }, settings: SETTINGS,
        ffprobePath: 'ffprobe', owner: OWNER, channelName: 'Model', primaryKey: 'a1', candidate: A }));
    world.timers = [...relayTimers];
    // A newer request of the same device, arriving while the relay reads a playlist mid-switch (renewalSuperseded).
    const read = r.readPlaylist.bind(r);
    r.readPlaylist = async (leg) => {
        if (world.supersedeOnRead && r.switching && (r.renewalBlocked || world.supersedeAnyRead)) {
            world.supersedeOnRead = false;
            world.supersededTaken = true;
            supersededHits++;
            world.foreignLeases.push(coordinator.takeLease(1, 'viewer', { owner: OWNER }));
        }
        return read(leg);
    };
    const note = r.note.bind(r);
    r.note = (code, ...rest) => { world.notes.push(code); return note(code, ...rest); };
    routing.watchSession(front, A);
    try {
        await r.tick();
        await settle(r);
        await checkPlaylist(r);
        for (let i = 0; i < steps && !r.closed; i++) {
            world.notes = [];
            const before = snapshot(r);
            // Terminal events are rare, so a sequence lives long enough to meet the others in many orders.
            const ev = rand() < 0.03 ? pick(['viewerLeaves', 'stopped', 'viewerElsewhere'])
                : pick(['write', 'write', 'write', 'tick', 'lost', 'quiet', 'renewal', 'renewal', 'renewal', 'standbyDue', 'standbyDue', 'standbyReady',
                    'standbyReady', 'standbyLost', 'standbyTaken', 'ingestEnded', 'pause', 'resume', 'startModes', 'quarantineLifted', 'quarantineLifted',
                    'renewalSuperseded', 'budgetSuperseded']);
            let detail = '';
            const leg = r.active.session;
            switch (ev) {
                case 'write': for (const s of registry.values()) if (!s.ended && !s.stalled) s.write(1); await r.tick(); break;
                case 'tick': await r.tick(); break;
                case 'lost': {
                    const how = pick(['stall', 'exit', 'timestamps']);
                    detail = how;
                    if (!leg.ended) { leg.ended = true; leg.status = 'error'; leg.emit('lost', { how, providerReason: true }); if (leg.feed) { const f = leg.feed; leg.feed = null; f.leave(); } }
                    await r.tick();
                    break;
                }
                case 'quiet': leg.stalled = true; r.lastProgressAt = Date.now() - 11000; await r.tick(); break;
                case 'renewal': {
                    // The provider's connection drops and comes back on the playing leg's ingest; the next start on it may
                    // never yield a playlist (#4), fail, or start.
                    // ... or its feed may be stuck reconnecting until the renewal deadline (#4).
                    const mode = rand() < 0.08 ? 'stuck' : pick(['ok', 'ok', 'noPlaylist', 'noPlaylist', 'fail']);
                    detail = mode;
                    world.startMode.set(r.active.candidate.url, mode === 'stuck' ? 'ok' : mode);
                    if (leg.feed) {
                        const ingest = leg.feed.ingest;
                        ingest.reconnect();
                        if (mode === 'stuck') { ingest.state = 'reconnecting'; world.stuck.push(ingest); }
                    }
                    break;
                }
                case 'standbyDue': r.standbyAt = 0; await r.tick(); break;
                case 'standbyReady': if (r.standby) { r.standby.session.write(2); } await r.tick(); break;
                case 'standbyLost': if (r.standby && !r.standby.session.ended) { const s = r.standby.session; s.ended = true; s.emit('lost', { how: pick(['stall', 'exit']), providerReason: true }); if (s.feed) { const f = s.feed; s.feed = null; f.leave(); } } await r.tick(); break;
                case 'standbyTaken': if (r.standby) await sessions.removeSession(r.standby.session.id); await r.tick(); break;
                case 'ingestEnded': if (leg.feed) leg.feed.ingest.close('upstream-lost', true); await r.tick(); break;
                case 'pause': leg.pausedUntil = Date.now() + 60000; await r.tick(); break;
                case 'resume': leg.pausedUntil = 0; await r.tick(); break;
                case 'startModes': for (const c of CANDIDATES) world.startMode.set(c.url, pick(['ok', 'ok', 'ok', 'fail', 'noPlaylist'])); detail = CANDIDATES.map(c => `${c.channelKey}=${world.startMode.get(c.url)}`).join(','); break;
                case 'quarantineLifted': routing.reset(); break;
                case 'viewerElsewhere': {
                    // The same device plays another channel on B (only when B has room, as admission would allow).
                    if (coordinator.hasFreeConnection(B.providerId, SETTINGS)) { const other = fakeSession(B, { owner: OWNER }); other.write(1); world.sessions.push(other); detail = 'on B'; }
                    break;
                }
                case 'viewerLeaves': await relay.close(r.id); break;
                case 'budgetSuperseded': {
                    // 0906: the reconnect that exhausts the renewal budget (ordinary failover), with a newer request of the
                    // device admitted while the relay reads the playlist.
                    r.renewalTimes = [Date.now(), Date.now(), Date.now()];
                    world.supersedeOnRead = true;
                    world.supersedeAnyRead = true;
                    world.supersededTaken = false;
                    if (leg.feed) leg.feed.ingest.reconnect();
                    break;
                }
                case 'renewalSuperseded': {
                    world.startMode.set(r.active.candidate.url, 'noPlaylist');
                    world.supersedeOnRead = true;
                    world.supersededTaken = false;
                    if (leg.feed) leg.feed.ingest.reconnect();
                    break;
                }
                case 'stopped': await sessions.removeSession(leg.id); await r.tick(); break;
            }
            // Some steps do not wait for the relay to finish: the next event arrives while a start, a switch or a standby
            // is still in flight. The table is checked only between settled steps; the invariants after every step.
            const hurried = rand() < 0.3;
            world.trace.push(`${i}: ${ev}${detail ? ` (${detail})` : ''}${hurried ? ' [next event while in flight]' : ''}`);
            if (hurried && ev !== 'renewalSuperseded' && ev !== 'budgetSuperseded') { await new Promise(res => setImmediate(res)); checkConnections(); await checkPlaylist(r); world.unsettled = true; continue; }
            await settle(r);
            for (const ingest of world.stuck.splice(0)) if (!ingest.closed) ingest.state = 'live';
            const wasUnsettled = world.unsettled;
            world.unsettled = false;
            const after = snapshot(r);
            const outcome = wasUnsettled ? null : after.closed && !before.closed ? `ended:${r.lastReason ? r.lastReason.code : 'stopped'}`
                : after.switches > before.switches ? (r.lastReason ? r.lastReason.code : 'switch') : null;
            if (outcome) world.outcomes.push(`${ev}->${outcome}`);
            world.trace.push(`   -> ${after.state}, switches ${after.switches}, on ${after.candidate.channelKey}${r.standby ? `, standby ${r.standby.candidate.channelKey}` : ''}`);
            const row = wasUnsettled ? true : TABLE[ev](before, after);
            if (row !== true) world.violation(`table: ${ev} from ${before.state}: ${row}`);
            world.supersedeOnRead = false;
            world.supersedeAnyRead = false;
            world.supersededTaken = false;
            // The newer play moves on (its own start is not this play's to account for).
            for (const l of world.foreignLeases.splice(0)) coordinator.releaseUnbound(l);
            checkConnections();
            await checkPlaylist(r);
            if (world.violations.length) break;
        }
        // The end of the play: the viewer leaves (if it has not ended already), then everything must be gone.
        if (!r.closed) await relay.close(r.id, 'model over');
        await settle(r);
        world.ended = true;
        // Anything the viewer's other play held is theirs, not this play's.
        for (const s of world.sessions.filter(x => x.options.owner === OWNER && !x.candidate.relayed && !r.legs.some(l => l.session === x))) await sessions.removeSession(s.id);
        await new Promise(res => setTimeout(res, 5));
        checkEnded(r);
    } finally {
        console.log = log; console.warn = warn;
    }
    return { violations: world.violations, trace: world.trace, logs, outcomes: world.outcomes };
}

let supersededHits = 0;
const FIXED_SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);
// A few random seeds locally (PIGTV_MODEL_SEEDS=<n> for more: an exploration run); none on CI, which keeps the fixed list.
const extra = process.env.CI ? [] : Array.from({ length: Number(process.env.PIGTV_MODEL_SEEDS) || 5 }, () => Math.floor(Math.random() * 2 ** 31));
const seeds = process.env.PIGTV_MODEL_SEED ? [Number(process.env.PIGTV_MODEL_SEED)] : [...FIXED_SEEDS, ...extra];

test('#41: the relay keeps its invariants over random event sequences (renewal on)', { timeout: 60000 }, async () => {
    // Real pools: A primary, B a backup (its own pool); one connection each.
    await db.sources.create({ type: 'm3u', name: 'ProvA', role: 'primary', url: 'http://a.invalid/list.m3u' });
    await db.sources.create({ type: 'm3u', name: 'ProvB', role: 'backup', url: 'http://b.invalid/list.m3u' });
    installStubs();
    relay.tuning.reconnectSettleMs = 0;
    relay.tuning.reconnectWaitMaxMs = 20;
    relay.tuning.reconnectTotalMaxMs = 60;
    assert.equal(coordinator.samePool(1, 2), false, 'A and B are separate pools');
    const started = Date.now();
    const coverage = new Map();
    const outcomes = new Map();
    for (const seed of seeds) {
        const run = await runSeed(seed);
        const { violations, trace } = run;
        for (const line of trace) { const m = /^\d+: (\w+)/.exec(line); if (m) coverage.set(m[1], (coverage.get(m[1]) || 0) + 1); }
        for (const line of trace) for (const kind of ['noPlaylist', 'stuck']) if (line.includes(`renewal (${kind})`)) coverage.set(`renewal-${kind}`, (coverage.get(`renewal-${kind}`) || 0) + 1);
        for (const o of run.outcomes) outcomes.set(o, (outcomes.get(o) || 0) + 1);
        if (violations.length) {
            assert.fail(`seed ${seed} (rerun alone: PIGTV_MODEL_SEED=${seed} node --test test/stream-relay-model.test.js)\n` +
                `violations:\n  ${violations.join('\n  ')}\nsequence:\n${trace.join('\n')}`);
        }
    }
    const ms = Date.now() - started;
    console.log(`MODEL ${seeds.length} seeds in ${ms} ms; events ${JSON.stringify(Object.fromEntries(coverage))}`);
    console.log(`MODEL outcomes ${JSON.stringify(Object.fromEntries([...outcomes].sort()))}`);
    for (const ev of Object.keys(TABLE)) assert.ok(coverage.get(ev) > 0, `the event ${ev} was exercised`);
    // #4: a renewal whose new leg produces no playlist, and one whose feed is stuck to the deadline.
    assert.ok(supersededHits > 0, 'a newer play arrived during a failed renewal\'s fallback');
    for (const ev of ['renewal-noPlaylist', 'renewal-stuck']) assert.ok(coverage.get(ev) > 0, `${ev} was exercised`);
    // The paths that matter were taken, not only the events sent: a planned renewal that landed, a renewal that never
    // got a playlist, a standby promoted, a cold switch.
    const seen = (re) => [...outcomes.keys()].some(k => re.test(k));
    assert.ok(seen(/^renewal->reconnected$/), 'a planned renewal landed');
    assert.ok(seen(/^renewal->(ended:|renewal-budget)/), 'a renewal that could not land was met');
    assert.ok(seen(/->promoted$/), 'a standby was promoted');
    assert.ok(seen(/^renewal->(renewal-failed|promoted|renewal-primary-fallback)$/), '#4: a failed renewal recovered and the play went on');
    assert.ok(seen(/^lost->(stalled|lost|timestamps)$/), 'a cold switch');
    // About 3 s for the fixed seeds on a quiet machine; the bound is loose for a busy CI runner, and catches a hang.
    assert.ok(ms < 15000 * Math.max(1, seeds.length / FIXED_SEEDS.length), `bounded: ${ms} ms`);
});

test('#41: renewal is off by default (server/db.js); the model turns it on for itself only', async () => {
    const text = fs.readFileSync(path.join(sandbox, 'server/db.js'), 'utf8');
    assert.match(text, /ingestReconnectRenewal: false,/);
    assert.equal((await db.settings.get()).ingestReconnectRenewal, false);
    assert.equal(db.getDefaultSettings ? db.getDefaultSettings().ingestReconnectRenewal ?? false : false, false);
});
