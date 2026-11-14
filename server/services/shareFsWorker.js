// #8: the child process that makes shareFs.js's file calls on the recordings share. Synchronous calls are fine
// here: if the share hangs, only this process waits, and the server kills it after its deadline.
const fs = require('fs');
const path = require('path');

/**
 * Which file is at a path: device, inode, size, modification and creation time (a bigint stat). The one format for
 * recording_cleanup's identity column (recordingOwners.js), wherever the stat is made.
 */
const identityOfStat = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.birthtimeNs}`;

// Tests only: any call under this folder waits (a hung share).
const HANG = process.env.PIGTV_TEST_SHARE_HANG || null;
// Tests only (#289): a long call waits forever once it has done this many bytes (a share that stalls mid-copy), and
// waits this long after each chunk (a slow share that still makes progress).
const STALL_AFTER = Number(process.env.PIGTV_TEST_SHARE_STALL_AFTER) || 0;
const SLOW_CHUNK_MS = Number(process.env.PIGTV_TEST_SHARE_SLOW_CHUNK_MS) || 0;

// #290: a probe killed on a stalled share can still create its file later, and nothing removes it. After a probe that
// worked, the folder's earlier ones (not this one, and a minute or more older, so one still being written is left) go.
// Their age is the time in their names (".pigtv-write-test-<pid>-<ms>", this server's clock) against this probe's own,
// never the share's file times (a NAS clock that is behind would make a fresh probe look old); one listing, no stat.
const STALE_PROBE_MS = 60 * 1000;
const PROBE_NAME = /^\.pigtv-write-test-\d+-(\d+)$/;
function removeStaleProbes(dir, own) {
    const mine = PROBE_NAME.exec(path.basename(own));
    if (!mine) return;
    const at = Number(mine[1]);
    try {
        for (const name of fs.readdirSync(dir)) {
            const probe = PROBE_NAME.exec(name);
            if (!probe || name === path.basename(own)) continue;
            if (at - Number(probe[1]) < STALE_PROBE_MS) continue;
            try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* best effort */ }
        }
    } catch (e) { /* best effort */ }
}

const under = (f, dir) => f === dir || f.startsWith(dir + path.sep);
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const forever = () => { for (;;) wait(60000); };

function trap(file, extra) {
    if (HANG && (under(file, HANG) || (extra && extra.to && under(String(extra.to), HANG)))) forever();
}

// #289: the long calls, as generators that yield the bytes done so far after each chunk (the parent's stall timer
// restarts on each). `sources`: files in appdata, in order.
const CHUNK = 1024 * 1024;
// Opus review of Server 3: a write lands in the page cache, and an SMB share flushes it at close with no progress to
// report; a big file on a slow share then looks stalled. Flushed every `syncBytes` (progress follows each flush), so
// the close has little left to write.
const tuning = { syncBytes: 32 * 1024 * 1024 };

/** `to` created exclusively (never over a file), then each source appended in turn: { size }. */
function* copyInto(to, sources) {
    const out = fs.openSync(to, 'wx');
    const buf = Buffer.allocUnsafe(CHUNK);
    let size = 0;
    let unsynced = 0;
    try {
        for (const src of sources) {
            const fd = fs.openSync(String(src), 'r');
            try {
                for (;;) {
                    const n = fs.readSync(fd, buf, 0, CHUNK, null);
                    if (n === 0) break;
                    for (let off = 0; off < n;) off += fs.writeSync(out, buf, off, n - off);
                    size += n;
                    unsynced += n;
                    if (unsynced >= tuning.syncBytes) { fs.fdatasyncSync(out); unsynced = 0; }
                    yield size;
                }
            } finally { fs.closeSync(fd); }
        }
        if (unsynced > 0) { fs.fdatasyncSync(out); yield size; }
    } finally { fs.closeSync(out); }
    return { size };
}

/** Is `file` byte for byte the sources, joined? Sizes first; a missing file is false. */
function* sameBytes(file, sources) {
    let total = 0;
    for (const src of sources) total += fs.statSync(String(src)).size;
    let st;
    try { st = fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    if (st.size !== total) return false;
    const fh = fs.openSync(file, 'r');
    const mine = Buffer.allocUnsafe(CHUNK);
    const theirs = Buffer.allocUnsafe(CHUNK);
    let at = 0;
    try {
        for (const src of sources) {
            const fd = fs.openSync(String(src), 'r');
            try {
                for (;;) {
                    const n = fs.readSync(fd, mine, 0, CHUNK, null);
                    if (n === 0) break;
                    let got = 0;
                    while (got < n) { const r = fs.readSync(fh, theirs, got, n - got, at + got); if (r === 0) break; got += r; }
                    if (got !== n || !theirs.subarray(0, n).equals(mine.subarray(0, n))) return false;
                    at += n;
                    yield at;
                }
            } finally { fs.closeSync(fd); }
        }
    } finally { fs.closeSync(fh); }
    return true;
}

const LONG = {
    copyInto: (file, extra) => copyInto(file, extra.sources || []),
    sameBytes: (file, extra) => sameBytes(file, extra.sources || [])
};

/** A long call made here, in one go (the in-process test mode, a stand-in helper). */
function drain(gen) { for (;;) { const r = gen.next(); if (r.done) return r.value; } }

/**
 * A long call in the helper: `progress(bytes)` after each chunk, and a turn of this process's event loop between chunks
 * so each progress message goes out at once.
 */
async function runLong(op, file, extra, progress) {
    trap(file, extra);
    const gen = LONG[op](file, extra);
    for (;;) {
        const r = gen.next();
        if (r.done) return r.value;
        progress(r.value);
        if (STALL_AFTER && r.value >= STALL_AFTER) forever();
        if (SLOW_CHUNK_MS) wait(SLOW_CHUNK_MS);
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/** `extra`: a call's further arguments ({ to } for link and rename, { sources } for copyInto and sameBytes). */
function run(op, file, extra = {}) {
    trap(file, extra);
    if (LONG[op]) return drain(LONG[op](file, extra));
    switch (op) {
        case 'exists': return fs.existsSync(file);
        case 'stat': {
            try { const s = fs.statSync(file); return { size: s.size, mtimeMs: s.mtimeMs }; } catch (e) { return null; }
        }
        case 'statfs': {
            if (typeof fs.statfsSync !== 'function') return null;
            const s = fs.statfsSync(file);
            return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
        }
        case 'identity': {
            // #141: null when nothing is there; any other error is the caller's to see.
            try { return identityOfStat(fs.statSync(file, { bigint: true })); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
        }
        case 'unlink': {
            // #141: true when removed, false when it was not there.
            try { fs.unlinkSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
        }
        case 'nlink': {
            // #287: how many names the file has (a hard link made), or null when nothing is there.
            try { return Number(fs.statSync(file).nlink); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
        }
        // #287: a second name for `file`, never over an existing one (EEXIST is the caller's to see).
        case 'link': fs.linkSync(file, String(extra.to)); return true;
        // A file moved to a new name beside it, replacing a file already there (renameSync's own rule); an errno answer keeps its code.
        case 'rename': fs.renameSync(file, String(extra.to)); return true;
        case 'readdir': {
            // #289: the names in a folder, or null when it is not there.
            try { return fs.readdirSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
        }
        case 'mkdir': fs.mkdirSync(file); return true;
        case 'writeProbe': {
            const probe = path.join(file, `.pigtv-write-test-${process.pid}-${Date.now()}`);
            try { fs.writeFileSync(probe, 'pigtv'); fs.unlinkSync(probe); } catch (e) { return false; }
            removeStaleProbes(file, probe);
            return true;
        }
        default: throw new Error(`unknown call ${op}`);
    }
}

module.exports = { run, runLong, identityOfStat, tuning, LONG_OPS: Object.keys(LONG) };
if (require.main !== module || !process.send) return; // required in-process (tests), not forked

process.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    const { id, op, file, ...extra } = msg;
    if (LONG[op]) {
        // #289: on a helper of its own (shareFs.long); the parent kills it when its progress stops.
        runLong(op, String(file), extra, (done) => process.send({ id, progress: done })).then(
            (result) => process.send({ id, result }),
            (err) => process.send({ id, error: err.message, code: err.code || 'SHARE_ERROR' }));
        return;
    }
    try {
        process.send({ id, result: run(op, String(file), extra) });
    } catch (err) {
        process.send({ id: msg.id, error: err.message, code: err.code || 'SHARE_ERROR' });
    }
});
process.on('disconnect', () => process.exit(0));
