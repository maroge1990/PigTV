const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// Real router, real files on disk. Copy the server so its relative data paths
// never touch real data (same approach as access.test.js; a junction so it
// works on Windows without admin rights).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-segments-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox); // transcode-cache lands in the sandbox, not the repo

const load = p => require(path.join(sandbox, 'server', p));
const transcodeSession = load('services/transcodeSession');
const router = load('routes/transcode');

let server, base, session;
const SECRET = 'top secret: must never be served';

before(async () => {
    session = await transcodeSession.createSession('http://provider.invalid/live/1.ts', {});
    fs.mkdirSync(session.dir, { recursive: true });
    fs.writeFileSync(path.join(session.dir, 'seg0001.ts'), 'ts-data');
    fs.writeFileSync(path.join(session.dir, 'seg0002.m4s'), 'm4s-data');
    fs.writeFileSync(path.join(session.dir, 'init.mp4'), 'init-data');
    // Files a traversal would reach: beside the session directory and above it.
    fs.writeFileSync(path.join(transcodeSession.CACHE_DIR, 'secret.ts'), SECRET);
    fs.writeFileSync(path.join(transcodeSession.CACHE_DIR, 'secret.mp4'), SECRET);
    fs.writeFileSync(path.join(sandbox, 'secret.ts'), SECRET);

    const app = express();
    app.use('/api/transcode', router);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    server.closeAllConnections?.();
    server.close();
    await transcodeSession.removeSession(session.id);
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const get = async (segment) => {
    const response = await fetch(`${base}/api/transcode/${session.id}/${segment}`);
    return { status: response.status, body: await response.text() };
};

test('the segments ffmpeg actually writes are served', async () => {
    assert.deepEqual(await get('seg0001.ts'), { status: 200, body: 'ts-data' });
    assert.deepEqual(await get('seg0002.m4s'), { status: 200, body: 'm4s-data' });
    assert.deepEqual(await get('init.mp4'), { status: 200, body: 'init-data' });
});

test('an encoded slash cannot walk out of the session directory', async () => {
    // Express URL-decodes params after routing, so these arrive as real paths.
    for (const evil of [
        '..%2Fsecret.ts',
        '..%2Fsecret.mp4',
        '..%2F..%2Fsecret.ts',
        '%2e%2e%2Fsecret.ts',
        `..%2F${session.id}%2Fseg0001.ts`,
        'sub%2Fseg0001.ts'
    ]) {
        const { status, body } = await get(evil);
        assert.equal(status, 404, `${evil} must be refused`);
        assert.ok(!body.includes(SECRET), `${evil} must not leak a file outside the session`);
    }
});

test('names ffmpeg never writes are refused, even inside the session directory', async () => {
    fs.writeFileSync(path.join(session.dir, 'session.json'), '{"secret":"metadata"}');
    fs.writeFileSync(path.join(session.dir, 'notes.mp4'), 'x');
    for (const name of ['notes.mp4', 'seg1.ts', 'seg0001.ts.bak', 'session.json', 'stream.m3u8.tmp']) {
        assert.equal((await get(name)).status, 404, `${name} must be refused`);
    }
});

test('getSegment itself refuses to leave the session directory', async () => {
    assert.equal(await session.getSegment('../secret.ts'), null);
    assert.equal(await session.getSegment('../../secret.ts'), null);
    assert.equal(await session.getSegment(path.join(sandbox, 'secret.ts')), null, 'an absolute path is not a segment name');
    assert.equal(await session.getSegment('seg0001.ts'), path.join(session.dir, 'seg0001.ts'));
});
