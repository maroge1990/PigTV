const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer, stopServer } = require('./helpers/server');

// The helper every real-server test starts from (api-404, health, stream-auth): a port another
// process grabbed between freePort() and the child's listen must cost a retry, never a red run,
// and never a test that talks to somebody else's server.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-helper-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../public'), path.join(sandbox, 'public'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');

let impostor, server;

after(async () => {
    await stopServer(server);
    if (impostor) await new Promise(r => impostor.close(r));
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('a port taken by another server is retried on a new port, and the answer comes from our child', async () => {
    // Another "server" on the port, answering /api/version as ours would.
    impostor = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"impostor":true}'); });
    await new Promise(r => impostor.listen(0, r));
    const taken = impostor.address().port;

    server = await startServer({ cwd: sandbox, port: taken,
        env: { JWT_SECRET: 'test-only-signing-key-not-used-outside-fixtures-12345' } });

    assert.notEqual(new URL(server.base).port, String(taken));
    const body = await (await fetch(`${server.base}/api/version`)).json();
    assert.equal(body.impostor, undefined);
    assert.ok(body.build, 'the real /api/version');
});
