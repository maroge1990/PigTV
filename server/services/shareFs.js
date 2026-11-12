/**
 * #8: file calls on the recordings share, off the event loop that serves every stream.
 *
 * The share is a network mount (Unraid remote SMB). When its server hangs, a call such as statfs can block in the
 * kernel for minutes. A synchronous call there froze all of Node (every HLS playlist and segment, the API, recording
 * control); an asynchronous one only moves the wait into libuv's small thread pool, which then starves the file
 * reads that playback needs. So each call goes to one long-lived child process with a deadline. A call that misses
 * it rejects with code 'SHARE_UNRESPONSIVE', the child is killed (a new one starts on the next call) and the share
 * counts as unresponsive until a call succeeds again.
 *
 * Calls: exists, stat ({size, mtimeMs} or null), statfs ({freeBytes, totalBytes}), mkdir, writeProbe (write and
 * remove a small file: true or false), identity (which file is there, or null; #141), unlink (true, or false when
 * nothing was there; #141), link (a second name, never over an existing file: an errno answer such as EEXIST keeps its
 * code; #287), nlink (how many names a file has, or null; #287) and rename (a file moved to a new name, replacing one already
 * there: the publish of a remux, an adoption or a compression). Paths only; nothing here knows what the share holds.
 * `local` makes the same calls in this process, for a path on a local disk (appdata); `withOwnHelper` makes them on a
 * helper of their own (a path an admin typed in Settings).
 */
const { fork } = require('child_process');
const path = require('path');

// How long a call may take before the share counts as unresponsive (a test may shorten it).
const tuning = { timeoutMs: 5000 };

let child = null;
let nextId = 1;
// #142: helpers killed after a missed deadline that have not exited yet (stuck in the kernel on the hung mount).
// With MAX_STUCK of them, calls fail at once instead of forking another into the same mount.
const MAX_STUCK = 2;
const stuck = new Set();
const spawner = { fork: (file) => fork(file, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' }) };
const pending = new Map(); // id -> { resolve, reject, timer }
let unresponsiveSince = null;

function start() {
    child = spawner.fork(path.join(__dirname, 'shareFsWorker.js'));
    const mine = child;
    child.on('message', (msg) => {
        const call = pending.get(msg && msg.id);
        if (!call) return;
        pending.delete(msg.id);
        clearTimeout(call.timer);
        idle(mine);
        unresponsiveSince = null;
        if (msg.error) call.reject(Object.assign(new Error(msg.error), { code: msg.code || 'SHARE_ERROR', sent: true, settled: Promise.resolve() }));
        else call.resolve(msg.result);
    });
    // `exited`: on 'exit' it has; on 'error' (a failed kill, say) it may not have.
    const gone = (exited) => {
        stuck.delete(mine);
        if (child === mine) child = null;
        for (const [id, call] of pending) {
            if (call.child !== mine) continue;
            pending.delete(id);
            clearTimeout(call.timer);
            call.reject(unanswered('The recordings share helper stopped', exited ? Promise.resolve() : exitOf(mine)));
        }
    };
    child.on('exit', () => gone(true));
    child.on('error', () => gone(false));
    // Keeps the process alive only while a call waits (idle()), so a test or a shutdown is never held by it.
    child.unref();
    idle(child);
    return child;
}

function idle(which) {
    if ([...pending.values()].some(c => c.child === which)) return;
    try { which.channel?.unref?.(); } catch (e) { /* gone */ }
}

/**
 * #287: settles once `which` has exited: from then on no call it was sent can still take effect. Every rejection says
 * whether its call was `sent` to a helper; one that was carries `settled` (this, for the helper it was sent to), on every
 * path: its own deadline, the helper killed for another call's, the helper's exit or error, an errno answer (settled at
 * once). A call refused before it was sent (failing fast, or no helper to send it to) has sent: false and no `settled`.
 */
const unanswered = (message, settled) => Object.assign(new Error(message), settled
    ? { code: 'SHARE_UNRESPONSIVE', sent: true, settled }
    : { code: 'SHARE_UNRESPONSIVE', sent: false });

function exitOf(which) {
    if (which.exitCode !== null || which.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => { which.once('exit', () => resolve()); });
}

/** Kill the helper (it may be stuck in the kernel; it is left to the OS) so the next call gets a fresh one. */
function abandon(which) {
    if (child === which) child = null;
    if (which.exitCode === null && which.signalCode === null) stuck.add(which);
    try { which.kill('SIGKILL'); } catch (e) { /* gone */ }
}

// Tests that fake the filesystem in this process (a patched fs.statfsSync) run the calls here instead.
let inProcess = false;

/** `extra`: further arguments, sent with the call ({ to } for link and rename). */
function call(op, file, { timeoutMs = tuning.timeoutMs } = {}, extra = {}) {
    if (inProcess) return runHere(op, file, extra);
    if (!(child && child.connected) && stuck.size >= MAX_STUCK) {
        return Promise.reject(unanswered('The recordings share is not answering (earlier calls are still stuck)', null));
    }
    return new Promise((resolve, reject) => {
        const worker = child && child.connected ? child : start();
        const id = nextId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            idle(worker);
            if (!unresponsiveSince) unresponsiveSince = Date.now();
            const settled = exitOf(worker); // #287: the call may still land until its helper has exited
            abandon(worker);
            reject(unanswered(`The recordings share did not answer within ${Math.round(timeoutMs / 1000)} s`, settled));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, child: worker });
        try { worker.channel?.ref?.(); } catch (e) { /* gone */ }
        try {
            worker.send({ ...extra, id, op, file });
        } catch (err) {
            pending.delete(id);
            clearTimeout(timer);
            abandon(worker);
            reject(unanswered('The recordings share helper could not be reached', null)); // never sent
        }
    });
}

const exists = (file, opts) => call('exists', file, opts);
const stat = (file, opts) => call('stat', file, opts);
const statfs = (file, opts) => call('statfs', file, opts);
const mkdir = (file, opts) => call('mkdir', file, opts);
const writeProbe = (file, opts) => call('writeProbe', file, opts);
const identity = (file, opts) => call('identity', file, opts);
const unlink = (file, opts) => call('unlink', file, opts);
const link = (file, to, opts) => call('link', file, opts, { to: String(to) });
const nlink = (file, opts) => call('nlink', file, opts);
const rename = (file, to, opts) => call('rename', file, opts, { to: String(to) });
/**
 * The size of `file`: 0 when it is missing, null when the share does not say (#143: unknown, not 0, for a caller that
 * reports it). The stall watch of an ffmpeg job (recordingMedia.runFfmpegCollectingTail) counts null as no growth, so a
 * job writing to a share that stopped answering is stopped after its stall time.
 */
async function sizeOf(file, opts) {
    try { const s = await stat(file, opts); return s ? s.size : 0; } catch (e) { return null; }
}

function runHere(op, file, extra) {
    try { return Promise.resolve(require('./shareFsWorker').run(op, String(file), extra)); } catch (err) { return Promise.reject(err); }
}
/** #287: the same calls, made in this process: for a path on a local disk (appdata), which never hangs. */
const local = {
    exists: (f) => runHere('exists', f), stat: (f) => runHere('stat', f), statfs: (f) => runHere('statfs', f), identity: (f) => runHere('identity', f),
    unlink: (f) => runHere('unlink', f), link: (f, to) => runHere('link', f, { to: String(to) }), nlink: (f) => runHere('nlink', f),
    rename: (f, to) => runHere('rename', f, { to: String(to) }),
    async sizeOf(f) { try { const s = await runHere('stat', f); return s ? s.size : 0; } catch (e) { return null; } }
};

/**
 * M2 (review of 0568): `work(io)` with calls (exists, stat, statfs, writeProbe) on a helper of its own: a fresh one,
 * forked for it, each call with its own deadline, killed once `work` has settled. For a path an admin typed (Settings): it
 * never waits behind the shared helper's calls, nor counts toward its stuck set or its unresponsive state, so a local path
 * is answered while the share hangs. A missed deadline rejects with SHARE_UNRESPONSIVE (as `call`), and later calls fail at once.
 */
async function withOwnHelper(work, { timeoutMs = tuning.timeoutMs } = {}) {
    let helper = null;
    let lost = null; // why later calls fail at once
    const waiting = new Map(); // id -> { resolve, reject, timer }
    let next = 1;
    const fail = (err) => { for (const [id, w] of waiting) { waiting.delete(id); clearTimeout(w.timer); w.reject(err); } };
    const ask = (op, file) => {
        if (inProcess) return runHere(op, file, {});
        if (lost) return Promise.reject(unanswered(lost, null));
        if (!helper) {
            helper = spawner.fork(path.join(__dirname, 'shareFsWorker.js'));
            const mine = helper;
            mine.on('message', (msg) => {
                const w = waiting.get(msg && msg.id);
                if (!w) return;
                waiting.delete(msg.id);
                clearTimeout(w.timer);
                if (msg.error) w.reject(Object.assign(new Error(msg.error), { code: msg.code || 'SHARE_ERROR', sent: true, settled: Promise.resolve() }));
                else w.resolve(msg.result);
            });
            const gone = () => { lost = lost || 'The folder check stopped'; fail(unanswered(lost, exitOf(mine))); };
            mine.on('exit', gone);
            mine.on('error', gone);
        }
        const mine = helper;
        return new Promise((resolve, reject) => {
            const id = next++;
            const timer = setTimeout(() => {
                waiting.delete(id);
                lost = `The folder did not answer within ${Math.round(timeoutMs / 1000)} s`;
                const settled = exitOf(mine);
                try { mine.kill('SIGKILL'); } catch (e) { /* gone */ }
                reject(unanswered(lost, settled));
            }, timeoutMs);
            waiting.set(id, { resolve, reject, timer });
            try { mine.send({ id, op, file: String(file) }); } catch (err) {
                waiting.delete(id);
                clearTimeout(timer);
                lost = 'The folder check could not be started';
                reject(unanswered(lost, null));
            }
        });
    };
    const io = { exists: (f) => ask('exists', f), stat: (f) => ask('stat', f), statfs: (f) => ask('statfs', f), writeProbe: (f) => ask('writeProbe', f) };
    try {
        return await work(io);
    } finally {
        if (helper) { try { helper.kill('SIGKILL'); } catch (e) { /* gone */ } }
    }
}

// ---- the Status page's disk line: cached, refreshed in the background, never awaited by a request ----
const DISK_MAX_AGE_MS = 30 * 1000;
const disks = new Map(); // dir -> { value, at, refreshing }

/**
 * The last known free/total space of `dir` ({available, freeBytes, totalBytes} or {available: false}), at once;
 * a refresh starts in the background when it is older than 30 s. Unknown until the first refresh answers.
 */
function diskInfo(dir) {
    if (!dir) return { available: false };
    let entry = disks.get(dir);
    if (!entry) { entry = { value: { available: false, pending: true }, at: 0, refreshing: null }; disks.set(dir, entry); }
    if (!entry.refreshing && Date.now() - entry.at > DISK_MAX_AGE_MS) {
        entry.refreshing = (async () => {
            try {
                const there = await exists(dir);
                const s = there ? await statfs(dir) : null;
                entry.value = s ? { available: true, freeBytes: s.freeBytes, totalBytes: s.totalBytes } : { available: false };
            } catch (err) {
                entry.value = { available: false, unresponsive: err.code === 'SHARE_UNRESPONSIVE' };
            } finally {
                entry.at = Date.now();
                entry.refreshing = null;
            }
        })();
    }
    return entry.value;
}

/** When the share last stopped answering (ms), or null while it answers. */
function unresponsive() {
    return unresponsiveSince;
}

/** Tests: stop the helper and forget cached disks. */
function reset() {
    if (child) abandon(child);
    stuck.clear();
    disks.clear();
    unresponsiveSince = null;
}

/** Tests: run calls in this process (true) or in the helper (false). */
function _inProcess(on) { inProcess = !!on; }

module.exports = { _inProcess, _spawner: spawner, _stuck: stuck, call, exists, stat, statfs, mkdir, writeProbe, identity, unlink, link, nlink, rename, sizeOf, local, withOwnHelper, diskInfo, unresponsive, reset, tuning };
