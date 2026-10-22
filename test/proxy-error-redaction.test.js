const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

// PB4 (22 Oct review, 0236): the proxy logged a 403's body and the provider's reason phrase, sent
// the reason phrase to the client, and on a failed fetch logged and returned the error's own
// message. Each is provider- or URL-derived text that can carry the stream's credentials. A local
// "provider" answers 403 with the credential-bearing address in its reason and body, and a handle
// whose address has userinfo makes fetch itself reject quoting it. No real provider is contacted.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-proxy-redact-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const handles = require(path.join(sandbox, 'server/services/playbackHandles'));

const SECRET = 'hunter2secret';
const LEAK = `http://prov.invalid/get.php?username=bob&password=${SECRET} http://prov.invalid/live/bob/${SECRET}/123.ts`;
const logs = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let upstream, proxy, upstreamBase, proxyBase;

before(async () => {
    for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logs.push(a.join(' ')); };
    upstream = http.createServer((req, res) => {
        res.writeHead(403, `Denied ${LEAK}`.replace(/[^\t\x20-\x7e]/g, ''), { 'Content-Type': 'text/plain' });
        res.end(`Your account ${LEAK} is not allowed`);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
    const app = express();
    app.use('/api/proxy', require(path.join(sandbox, 'server/routes/proxy')));
    proxy = app.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    proxyBase = `http://127.0.0.1:${proxy.address().port}`;
});
after(() => {
    Object.assign(console, realConsole);
    for (const s of [upstream, proxy]) { s?.closeAllConnections?.(); s?.close(); }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('PB4: a 403 whose reason and body quote the credentials - neither reaches the log or the client', async () => {
    logs.length = 0;
    const response = await fetch(`${proxyBase}/api/proxy/stream?h=${handles.createHandle(`${upstreamBase}/live/bob/${SECRET}/1.ts`)}`);
    const text = await response.text();
    assert.equal(response.status, 403);
    assert.equal(text, 'Failed to fetch stream: Forbidden');
    for (const line of [text, ...logs]) assert.ok(!line.includes(SECRET), `leaks: ${line}`);
    assert.ok(logs.some(l => l.includes('403 Forbidden')), 'the status is still logged');
});

test('PB4: a fetch that fails quoting its address - the log and the JSON error carry no credentials', async () => {
    logs.length = 0;
    const response = await fetch(`${proxyBase}/api/proxy/stream?h=${handles.createHandle(`http://bob:${SECRET}@127.0.0.1:9/live.ts`)}`);
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: 'Stream proxy failed after retries' });
    for (const line of [JSON.stringify(body), ...logs]) assert.ok(!line.includes(SECRET), `leaks: ${line}`);
});
