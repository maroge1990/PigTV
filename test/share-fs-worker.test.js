const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../server/services/shareFsWorker');

// #290: a probe killed on a stalled share can create its file later; the next successful probe removes the old ones.
test('#290: a successful write probe removes stale probe files, and keeps a fresh one and any other file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-probe-'));
    try {
        const stale = path.join(dir, '.pigtv-write-test-111-1700000000000');
        const fresh = path.join(dir, '.pigtv-write-test-222-1700000000001');
        const other = path.join(dir, 'Recording.mp4');
        for (const f of [stale, fresh, other]) fs.writeFileSync(f, '');
        const old = new Date(Date.now() - 5 * 60 * 1000);
        fs.utimesSync(stale, old, old);
        assert.equal(run('writeProbe', dir), true);
        assert.equal(fs.existsSync(stale), false, 'the stale probe is gone');
        assert.equal(fs.existsSync(fresh), true, 'one under a minute old may still be in flight');
        assert.equal(fs.existsSync(other), true, 'no other file is touched');
        assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('.pigtv-write-test-') && n !== path.basename(fresh)), [], 'and its own is removed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('#290: a folder that cannot be listed or a probe that fails never throws', () => {
    assert.equal(run('writeProbe', path.join(os.tmpdir(), 'pigtv-no-such-folder-290')), false);
});

// #289, Opus review of Server 3: a copy flushes every `syncBytes`, and reports progress after each flush, so a slow
// share's flush happens between progress reports instead of all at the close (where it looked like a stall).
test('#289: a copy into the share is flushed every syncBytes and once at its end, each flush followed by progress', async () => {
    const { runLong, tuning } = require('../server/services/shareFsWorker');
    assert.equal(tuning.syncBytes, 32 * 1024 * 1024, 'every 32 MiB');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-copy-'));
    const realSync = fs.fdatasyncSync;
    const was = tuning.syncBytes;
    const events = [];
    try {
        const src = path.join(dir, 'source.ts');
        fs.writeFileSync(src, Buffer.alloc(7 * 1024 * 1024 + 5, 7)); // eight chunks
        tuning.syncBytes = 3 * 1024 * 1024;
        fs.fdatasyncSync = function (fd) { events.push(`sync ${fs.fstatSync(fd).size}`); return realSync.call(this, fd); };
        const to = path.join(dir, 'copy.ts.partial');
        const result = await runLong('copyInto', to, { sources: [src] }, (done) => events.push(`progress ${done}`));
        assert.equal(result.size, 7 * 1024 * 1024 + 5);
        const MiB = 1024 * 1024;
        const syncs = events.filter(e => e.startsWith('sync'));
        assert.deepEqual(syncs, [`sync ${3 * MiB}`, `sync ${6 * MiB}`, `sync ${7 * MiB + 5}`], 'at 3 and 6 MiB, and the rest at the end');
        for (const s of syncs) {
            const i = events.indexOf(s);
            assert.equal(events[i + 1], `progress ${s.slice(5)}`, `progress right after ${s}`);
        }
        assert.ok(fs.readFileSync(to).equals(fs.readFileSync(src)));
    } finally {
        fs.fdatasyncSync = realSync;
        tuning.syncBytes = was;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
