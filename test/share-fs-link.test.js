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

// #287: every rejection says whether its call reached a helper (`sent`); one that did carries `settled`, which resolves once
// that helper has exited (nothing it was sent can land after that).
const settles = (p, ms) => Promise.race([p.then(() => true), new Promise(r => setTimeout(() => r(false), ms))]);

test('#287: sent and settled on each way a call can fail', async () => {
    const was = shareFs.tuning.timeoutMs;
    const ok = path.join(dir, 'answered.partial');
    fs.writeFileSync(ok, 'x');
    try {
        // An errno answer: sent, settled at once.
        shareFs.reset();
        fs.writeFileSync(path.join(dir, 'taken.mp4'), 'y');
        const eexist = await shareFs.link(ok, path.join(dir, 'taken.mp4')).catch(e => e);
        assert.deepEqual([eexist.code, eexist.sent], ['EEXIST', true]);
        assert.equal(await settles(eexist.settled, 1000), true);

        // Its own deadline: sent; settled once the killed helper has exited.
        shareFs.reset();
        shareFs.tuning.timeoutMs = 1000;
        const own = await shareFs.unlink(path.join(hung, 'a')).catch(e => e);
        assert.deepEqual([own.code, own.sent], ['SHARE_UNRESPONSIVE', true]);
        assert.equal(await settles(own.settled, 5000), true, 'the killed helper exits');

        // Two calls on one helper: the other's deadline kills it, this one is rejected as the helper stops: sent, settled.
        shareFs.reset();
        shareFs.tuning.timeoutMs = 20000;
        const mine = shareFs.unlink(path.join(hung, 'b')).catch(e => e);
        const other = shareFs.exists(path.join(hung, 'c'), { timeoutMs: 1000 }).catch(e => e);
        assert.equal((await other).sent, true);
        const stopped = await mine;
        assert.deepEqual([stopped.code, stopped.sent], ['SHARE_UNRESPONSIVE', true], stopped.message);
        assert.equal(await settles(stopped.settled, 1000), true, 'its helper has exited');

        // Failing fast (two helpers stuck): never sent, nothing to wait for.
        shareFs.reset();
        shareFs._stuck.add({ stuck: 1 });
        shareFs._stuck.add({ stuck: 2 });
        const fast = await shareFs.unlink(path.join(hung, 'd')).catch(e => e);
        assert.deepEqual([fast.code, fast.sent, fast.settled], ['SHARE_UNRESPONSIVE', false, undefined]);

        // A helper that cannot be reached: never sent.
        shareFs.reset();
        const realFork = shareFs._spawner.fork;
        const { EventEmitter } = require('node:events');
        shareFs._spawner.fork = () => Object.assign(new EventEmitter(), { connected: true, exitCode: null, signalCode: null, unref() {},
            channel: { ref() {}, unref() {} }, kill() {}, send() { throw new Error('channel closed'); } });
        try {
            const unreached = await shareFs.unlink(path.join(dir, 'e')).catch(e => e);
            assert.deepEqual([unreached.code, unreached.sent, unreached.settled], ['SHARE_UNRESPONSIVE', false, undefined]);
        } finally {
            shareFs._spawner.fork = realFork;
        }
    } finally {
        shareFs.reset();
        shareFs.tuning.timeoutMs = was;
    }
});
