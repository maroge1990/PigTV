const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// R11 (Plan B1, 0215): one webhook for provider down, recording failed and licence expiring.
// The real settings route and services in a sandbox; the webhook is a local HTTP server.
// On 0214 there was no webhook: services/notify.js and the setting did not exist.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-notify-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const notify = load('services/notify');
const routing = load('services/providerRouting');

const received = [];
let hookStatus = 200;
const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { received.push({ url: req.url, headers: req.headers, body }); res.statusCode = hookStatus; res.end('ok'); });
});
const logs = [];
const realWarn = console.warn, realLog = console.log;
let api, apiBase, hookUrl, adminToken, viewerToken;

async function call(method, route, token, body) {
    const res = await fetch(`${apiBase}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
}
const waitFor = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail('timed out'); };

before(async () => {
    hook.listen(0, '127.0.0.1'); await once(hook, 'listening');
    hookUrl = `http://127.0.0.1:${hook.address().port}/pigtv-secret-topic`;
    const admin = await db.users.create({ username: 'owner', role: 'admin', passwordHash: await auth.hashPassword('owner-password') });
    const viewer = await db.users.create({ username: 'viewer', role: 'viewer' });
    adminToken = auth.generateToken(admin); viewerToken = auth.generateToken(viewer);
    const app = express(); app.use(express.json());
    app.use('/api/settings', load('routes/settings'));
    api = app.listen(0, '127.0.0.1'); await once(api, 'listening');
    apiBase = `http://127.0.0.1:${api.address().port}`;
    console.warn = (...a) => logs.push(a.join(' ')); console.log = (...a) => logs.push(a.join(' '));
});
beforeEach(() => { received.length = 0; hookStatus = 200; notify._reset(); });
after(async () => {
    console.warn = realWarn; console.log = realLog;
    api.closeAllConnections(); await new Promise(r => api.close(r));
    hook.closeAllConnections(); await new Promise(r => hook.close(r));
    try { sqlite.getDb().close(); } catch { /* closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

test('the setting: admins save a valid http(s) address; viewers never see it', async () => {
    assert.equal((await notify.send('test', { title: 't', message: 'm' })).skipped, 'no webhook');
    assert.equal((await call('PUT', '/api/settings', adminToken, { notifyWebhookUrl: 'ftp://x.invalid/a' })).status, 400);
    assert.equal((await call('PUT', '/api/settings', adminToken, { notifyWebhookFormat: 'xml' })).status, 400);
    assert.equal((await call('PUT', '/api/settings', viewerToken, { notifyWebhookUrl: hookUrl })).status, 403);
    assert.equal((await call('PUT', '/api/settings', adminToken, { notifyWebhookUrl: ` ${hookUrl} `, notifyWebhookFormat: 'json' })).status, 200);
    assert.equal((await call('GET', '/api/settings', adminToken)).data.notifyWebhookUrl, hookUrl);
    const seen = (await call('GET', '/api/settings', viewerToken)).data;
    assert.equal(seen.notifyWebhookUrl, undefined, 'the address can be a secret');
    assert.equal(seen.notifyWebhookSet, true);
});

test('JSON and text (ntfy) formats; the same event is sent once an hour; the test button always sends', async () => {
    await call('PUT', '/api/settings', adminToken, { notifyWebhookUrl: hookUrl, notifyWebhookFormat: 'json' });
    assert.equal((await notify.send('recording-failed', { title: 'PigTV: recording failed', message: '"News" failed.', key: 'k1' })).sent, true);
    assert.equal((await notify.send('recording-failed', { title: 'again', message: 'again', key: 'k1' })).skipped, 'duplicate');
    assert.equal(received.length, 1);
    const json = JSON.parse(received[0].body);
    assert.deepEqual([json.event, json.title, json.message, json.server], ['recording-failed', 'PigTV: recording failed', '"News" failed.', 'PigTV']);

    await call('PUT', '/api/settings', adminToken, { notifyWebhookFormat: 'text' });
    const r = await call('POST', '/api/settings/notify-test', adminToken);
    assert.equal(r.data.sent, true);
    assert.equal(received[1].headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(received[1].headers.title, 'PigTV test notification');
    assert.equal(received[1].body, 'Notifications from PigTV reach this address.');
    assert.equal((await call('POST', '/api/settings/notify-test', viewerToken)).status, 403);
});

test('a failing webhook is reported without its address, and messages never carry a provider URL', async () => {
    await call('PUT', '/api/settings', adminToken, { notifyWebhookUrl: hookUrl, notifyWebhookFormat: 'json' });
    hookStatus = 500;
    logs.length = 0;
    const r = await notify.send('recording-failed', { title: 't', message: 'Error opening http://provider.invalid/live/user/pass/1.ts', key: 'k2' });
    assert.deepEqual([r.sent, r.status], [false, 500]);
    assert.ok(logs.some(l => /\[Notify\].*HTTP 500/.test(l)));
    assert.ok(logs.every(l => !l.includes('pigtv-secret-topic')), 'the webhook address is never logged');
    assert.ok(!received.at(-1).body.includes('user/pass'), 'redacted');
});

test('a provider tripping its breaker sends "provider down"; recordings and licences are wired too', async () => {
    await call('PUT', '/api/settings', adminToken, { notifyWebhookUrl: hookUrl, notifyWebhookFormat: 'json' });
    const p = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://strong.invalid/get.php?username=u&password=p' });
    for (let i = 0; i < 10 && routing.providerState(p.id) !== 'down'; i++) routing.noteProviderFailure(p.id, `ch${i}`);
    assert.equal(routing.providerState(p.id), 'down');
    await waitFor(() => received.length === 1);
    const body = JSON.parse(received[0].body);
    assert.equal(body.event, 'provider-down');
    assert.match(body.title, /Strong8K is down/);

    const engine = fs.readFileSync(path.join(sandbox, 'server/services/recordingEngine.js'), 'utf8');
    assert.match(engine.slice(engine.indexOf('function setScheduleStatus')), /status === 'failed'[\s\S]{0,120}notify'\)\.recordingFailed/);
    const accounts = fs.readFileSync(path.join(sandbox, 'server/services/providerAccounts.js'), 'utf8');
    assert.match(accounts.slice(accounts.indexOf('async function refreshAll')), /notify'\)\.licencesExpiring\(reminders\(/);
});
