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
        const now = Date.now();
        const stale = path.join(dir, `.pigtv-write-test-111-${now - 5 * 60 * 1000}`);
        const fresh = path.join(dir, `.pigtv-write-test-222-${now}`);
        const other = path.join(dir, 'Recording.mp4');
        const oddName = path.join(dir, '.pigtv-write-test-notes');
        for (const f of [stale, fresh, other, oddName]) fs.writeFileSync(f, '');
        assert.equal(run('writeProbe', dir), true);
        assert.equal(fs.existsSync(stale), false, 'the stale probe is gone');
        assert.equal(fs.existsSync(fresh), true, 'one under a minute old may still be in flight');
        assert.equal(fs.existsSync(other), true, 'no other file is touched');
        assert.equal(fs.existsSync(oddName), true, 'nor a name that is not a probe\'s');
        assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('.pigtv-write-test-') && ![fresh, oddName].map(f => path.basename(f)).includes(n)), [], 'and its own is removed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Opus review of Server 3: a probe's age is the time in its name (this server's clock), not the share's file time.
test('#290: a NAS clock behind or ahead never decides which probe is stale', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-probe-'));
    try {
        const now = Date.now();
        // Made a moment ago by another server's probe, on a NAS whose clock is ten minutes behind.
        const fresh = path.join(dir, `.pigtv-write-test-333-${now - 1000}`);
        // Left by a probe five minutes ago, its file time set by a NAS whose clock is ahead.
        const stale = path.join(dir, `.pigtv-write-test-444-${now - 5 * 60 * 1000}`);
        fs.writeFileSync(fresh, '');
        fs.writeFileSync(stale, '');
        const behind = new Date(now - 10 * 60 * 1000);
        const ahead = new Date(now + 10 * 60 * 1000);
        fs.utimesSync(fresh, behind, behind);
        fs.utimesSync(stale, ahead, ahead);
        assert.equal(run('writeProbe', dir), true);
        assert.equal(fs.existsSync(fresh), true, 'a fresh probe stays, whatever its file time');
        assert.equal(fs.existsSync(stale), false, 'a stale one goes, whatever its file time');
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

// #289, Opus review of Server 3: in the in-process test mode a long call still honours its abort signal.
test('#289: in-process long calls reject with an AbortError for a signal aborted before or while they run', async () => {
    const shareFs = require('../server/services/shareFs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-inproc-'));
    const realOpen = fs.openSync;
    shareFs._inProcess(true);
    try {
        const src = path.join(dir, 'source.ts');
        fs.writeFileSync(src, Buffer.alloc(1000, 1));
        const before = new AbortController();
        before.abort();
        await assert.rejects(() => shareFs.copyInto(path.join(dir, 'a.partial'), [src], { signal: before.signal }), { name: 'AbortError' });
        assert.equal(fs.existsSync(path.join(dir, 'a.partial')), false, 'nothing was made');
        // A deletion that lands while the copy runs (here, as it opens its destination).
        const during = new AbortController();
        fs.openSync = function (p, ...rest) { if (String(p).endsWith('b.partial')) during.abort(); return realOpen.call(this, p, ...rest); };
        await assert.rejects(() => shareFs.copyInto(path.join(dir, 'b.partial'), [src], { signal: during.signal }), { name: 'AbortError' });
        fs.openSync = realOpen;
        const compare = new AbortController();
        fs.openSync = function (p, ...rest) { if (String(p) === src) compare.abort(); return realOpen.call(this, p, ...rest); };
        await assert.rejects(() => shareFs.sameBytes(path.join(dir, 'b.partial'), [src], { signal: compare.signal }), { name: 'AbortError' });
        fs.openSync = realOpen;
        assert.equal(await shareFs.sameBytes(path.join(dir, 'b.partial'), [src]), true, 'without an abort it answers');
    } finally {
        fs.openSync = realOpen;
        shareFs._inProcess(false);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
