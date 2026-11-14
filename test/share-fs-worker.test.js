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
