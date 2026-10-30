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
 * remove a small file: true or false), identity (which file is there, or null; #141) and unlink (true, or false when
 * nothing was there; #141). Paths only; nothing here knows what the share holds.
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
        if (msg.error) call.reject(Object.assign(new Error(msg.error), { code: msg.code || 'SHARE_ERROR' }));
        else call.resolve(msg.result);
    });
    const gone = () => {
        stuck.delete(mine);
        if (child === mine) child = null;
        for (const [id, call] of pending) {
            if (call.child !== mine) continue;
            pending.delete(id);
            clearTimeout(call.timer);
            call.reject(Object.assign(new Error('The recordings share helper stopped'), { code: 'SHARE_UNRESPONSIVE' }));
        }
    };
    child.on('exit', gone);
    child.on('error', gone);
    // Keeps the process alive only while a call waits (idle()), so a test or a shutdown is never held by it.
    child.unref();
    idle(child);
    return child;
}

function idle(which) {
    if ([...pending.values()].some(c => c.child === which)) return;
    try { which.channel?.unref?.(); } catch (e) { /* gone */ }
}

/** Kill the helper (it may be stuck in the kernel; it is left to the OS) so the next call gets a fresh one. */
function abandon(which) {
    if (child === which) child = null;
    if (which.exitCode === null && which.signalCode === null) stuck.add(which);
    try { which.kill('SIGKILL'); } catch (e) { /* gone */ }
}

// Tests that fake the filesystem in this process (a patched fs.statfsSync) run the calls here instead.
let inProcess = false;

function call(op, file, { timeoutMs = tuning.timeoutMs } = {}) {
    if (inProcess) {
        try { return Promise.resolve(require('./shareFsWorker').run(op, String(file))); } catch (err) { return Promise.reject(err); }
    }
    if (!(child && child.connected) && stuck.size >= MAX_STUCK) {
        return Promise.reject(Object.assign(new Error('The recordings share is not answering (earlier calls are still stuck)'), { code: 'SHARE_UNRESPONSIVE' }));
    }
    return new Promise((resolve, reject) => {
        const worker = child && child.connected ? child : start();
        const id = nextId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            idle(worker);
            if (!unresponsiveSince) unresponsiveSince = Date.now();
            abandon(worker);
            reject(Object.assign(new Error(`The recordings share did not answer within ${Math.round(timeoutMs / 1000)} s`), { code: 'SHARE_UNRESPONSIVE' }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, child: worker });
        try { worker.channel?.ref?.(); } catch (e) { /* gone */ }
        try {
            worker.send({ id, op, file });
        } catch (err) {
            pending.delete(id);
            clearTimeout(timer);
            abandon(worker);
            reject(Object.assign(new Error('The recordings share helper could not be reached'), { code: 'SHARE_UNRESPONSIVE' }));
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
/** The size of `file`: 0 when it is missing, null when the share does not say (#143: unknown is not "no growth"). */
async function sizeOf(file, opts) {
    try { const s = await stat(file, opts); return s ? s.size : 0; } catch (e) { return null; }
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

module.exports = { _inProcess, _spawner: spawner, _stuck: stuck, call, exists, stat, statfs, mkdir, writeProbe, identity, unlink, sizeOf, diskInfo, unresponsive, reset, tuning };
