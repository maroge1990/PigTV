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

// #290: a probe killed on a stalled share can still create its file later, and nothing removes it. After a probe that
// worked, the folder's earlier ones (not this one, and older than a minute, so one still being written is left) go.
const STALE_PROBE_MS = 60 * 1000;
function removeStaleProbes(dir, own) {
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!name.startsWith('.pigtv-write-test-')) continue;
            const old = path.join(dir, name);
            if (old === own) continue;
            try { if (Date.now() - fs.statSync(old).mtimeMs > STALE_PROBE_MS) fs.unlinkSync(old); } catch (e) { /* best effort */ }
        }
    } catch (e) { /* best effort */ }
}

const under = (f, dir) => f === dir || f.startsWith(dir + path.sep);

/** `extra`: a call's further arguments ({ to } for link and rename). */
function run(op, file, extra = {}) {
    if (HANG && (under(file, HANG) || (extra && extra.to && under(String(extra.to), HANG)))) {
        const view = new Int32Array(new SharedArrayBuffer(4));
        for (;;) Atomics.wait(view, 0, 0, 60000);
    }
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

module.exports = { run, identityOfStat };
if (require.main !== module || !process.send) return; // required in-process (tests), not forked

process.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    try {
        const { id, op, file, ...extra } = msg;
        process.send({ id, result: run(op, String(file), extra) });
    } catch (err) {
        process.send({ id: msg.id, error: err.message, code: err.code || 'SHARE_ERROR' });
    }
});
process.on('disconnect', () => process.exit(0));
