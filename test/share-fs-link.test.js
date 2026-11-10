const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #287: shareFs's link and nlink, the two calls a finished recording needs to be published on the share without a
// synchronous call there: through the helper process, with its deadline, and with the errno answer kept (EEXIST).
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-share-fs-link-')));
const hung = path.join(dir, 'hung');
fs.mkdirSync(hung);
process.env.PIGTV_TEST_SHARE_HANG = hung; // read by each helper when it starts
const shareFs = require('../server/services/shareFs');

after(() => {
    shareFs.reset();
    fs.rmSync(dir, { recursive: true, force: true });
});

for (const [label, io] of [['through the helper', shareFs], ['in this process (local)', shareFs.local]]) {
    test(`#287: link and nlink ${label}`, async () => {
        const sub = fs.mkdtempSync(path.join(dir, 'x-'));
        const a = path.join(sub, 'a.partial');
        const b = path.join(sub, 'b.mp4');
        fs.writeFileSync(a, 'finished');
        assert.equal(await io.nlink(a), 1);
        assert.equal(await io.link(a, b), true);
        assert.equal(fs.readFileSync(b, 'utf8'), 'finished');
        assert.equal(await io.nlink(a), 2, 'one file, two names');
        assert.equal(await io.identity(a), await io.identity(b), 'the same identity under both names');
        await assert.rejects(() => io.link(a, b), { code: 'EEXIST' }, 'never over an existing name; the errno is kept');
        await assert.rejects(() => io.link(path.join(sub, 'missing'), path.join(sub, 'c.mp4')), { code: 'ENOENT' });
        assert.equal(await io.nlink(path.join(sub, 'missing')), null);
    });
}

test('#287: a link or nlink the share does not answer misses its deadline as SHARE_UNRESPONSIVE', async () => {
    shareFs.reset();
    const was = shareFs.tuning.timeoutMs;
    shareFs.tuning.timeoutMs = 1000;
    const ok = path.join(dir, 'ok.partial');
    fs.writeFileSync(ok, 'finished');
    try {
        await assert.rejects(() => shareFs.link(ok, path.join(hung, 'to.mp4')), { code: 'SHARE_UNRESPONSIVE' }, 'its destination on the hung share');
        shareFs.reset();
        await assert.rejects(() => shareFs.nlink(path.join(hung, 'x')), { code: 'SHARE_UNRESPONSIVE' });
    } finally {
        shareFs.reset();
        shareFs.tuning.timeoutMs = was;
    }
    assert.equal(fs.existsSync(path.join(hung, 'to.mp4')), false, 'nothing was linked');
});
