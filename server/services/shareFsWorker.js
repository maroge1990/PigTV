// #8: the child process that makes shareFs.js's file calls on the recordings share. Synchronous calls are fine
// here: if the share hangs, only this process waits, and the server kills it after its deadline.
const fs = require('fs');
const path = require('path');

// Tests only: any call under this folder waits (a hung share).
const HANG = process.env.PIGTV_TEST_SHARE_HANG || null;

function run(op, file) {
    if (HANG && (file === HANG || file.startsWith(HANG + path.sep))) {
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
        case 'mkdir': fs.mkdirSync(file); return true;
        case 'writeProbe': {
            const probe = path.join(file, `.pigtv-write-test-${process.pid}-${Date.now()}`);
            try { fs.writeFileSync(probe, 'pigtv'); fs.unlinkSync(probe); return true; } catch (e) { return false; }
        }
        default: throw new Error(`unknown call ${op}`);
    }
}

module.exports = { run };
if (require.main !== module || !process.send) return; // required in-process (tests), not forked

process.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    try {
        process.send({ id: msg.id, result: run(msg.op, String(msg.file)) });
    } catch (err) {
        process.send({ id: msg.id, error: err.message, code: err.code || 'SHARE_ERROR' });
    }
});
process.on('disconnect', () => process.exit(0));
