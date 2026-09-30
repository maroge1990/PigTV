const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

// 0168 (multi-provider P1): the account read from a provider's player_api.php, the effective
// expiry and connection limit, and the licence reminders (C-K). The "provider" is a local fake.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-provider-accounts-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const accounts = load('services/providerAccounts');
const m3uParser = load('services/m3uParser');
load('services/syncService').syncSource = async () => {};

const DAY = 24 * 60 * 60 * 1000;
const UTC = (y, m, d) => Date.UTC(y, m - 1, d, 23, 59, 59, 999);
let fake, fakeUrl, app, base, adminToken, viewerToken, reply, requests;
let server;

async function call(method, route, token = adminToken) {
    const response = await fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();
    let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: response.status, body, text };
}
const newSource = (fields = {}) => db.sources.create({ type: 'xtream', name: 'Trex', url: fakeUrl, username: 'trexuser', password: 'trexpass', ...fields });
const userInfo = (over = {}) => ({ user_info: { auth: 1, status: 'Active', exp_date: String(Math.floor((Date.now() + 40 * DAY) / 1000)),
    is_trial: '0', active_cons: '1', max_connections: '2', ...over }, server_info: {} });

before(async () => {
    fake = http.createServer((req, res) => {
        requests.push({ url: req.url, ua: req.headers['user-agent'] });
        if (reply.hang) return; // never answers
        res.statusCode = reply.status || 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(reply.raw ?? JSON.stringify(reply.body));
    }).listen(0, '127.0.0.1');
    await once(fake, 'listening');
    fakeUrl = `http://127.0.0.1:${fake.address().port}`;

    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    const viewer = await db.users.create({ username: 'viewer', role: 'viewer' });
    adminToken = auth.generateToken(admin);
    viewerToken = auth.generateToken(viewer);
    app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/sources', load('routes/sources'));
    app.use('/api/providers', load('routes/providers'));
    app.use('/api/info', load('routes/info'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.(); server?.close();
    fake?.closeAllConnections?.(); fake?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const reset = () => { requests = []; reply = { body: userInfo() }; };

test('effectiveExpiry: manual end date > purchase date + term > the account > unknown', () => {
    const account = { exp_date: UTC(2026, 6, 1) };
    assert.equal(accounts.effectiveExpiry({ subscription: { endsAt: '2026-12-25', purchasedAt: '2026-01-01', termMonths: 3 } }, account), UTC(2026, 12, 25));
    assert.equal(accounts.effectiveExpiry({ subscription: { endsAt: null, purchasedAt: '2026-01-01', termMonths: 3 } }, account), UTC(2026, 4, 1));
    assert.equal(accounts.effectiveExpiry({ subscription: { purchasedAt: '2026-01-01', termMonths: null } }, account), UTC(2026, 6, 1), 'no term: the account');
    assert.equal(accounts.effectiveExpiry({ subscription: { purchasedAt: null, termMonths: 3 } }, account), UTC(2026, 6, 1), 'no purchase date: the account');
    assert.equal(accounts.effectiveExpiry({}, account), UTC(2026, 6, 1));
    assert.equal(accounts.effectiveExpiry({}, { exp_date: null }), null, 'unlimited or never read');
    assert.equal(accounts.effectiveExpiry({}, null), null);
    assert.equal(accounts.expiryInfo({ subscription: { endsAt: '2026-12-25' } }, account).from, 'manual');
    assert.equal(accounts.expiryInfo({ subscription: { purchasedAt: '2026-01-01', termMonths: 1 } }, account).from, 'term');
    assert.equal(accounts.expiryInfo({}, account).from, 'account');
});

test('purchasedAt + termMonths: month arithmetic clamps the day and crosses years and leap years', () => {
    const at = (purchasedAt, termMonths) => accounts.effectiveExpiry({ subscription: { purchasedAt, termMonths } }, null);
    assert.equal(at('2026-01-31', 1), UTC(2026, 2, 28));
    assert.equal(at('2028-01-31', 1), UTC(2028, 2, 29), 'a leap year');
    assert.equal(at('2026-03-15', 12), UTC(2027, 3, 15));
    assert.equal(at('2026-11-30', 3), UTC(2027, 2, 28));
    assert.equal(at('2026-12-31', 2), UTC(2027, 2, 28));
    assert.equal(at('2026-09-30', 1), UTC(2026, 10, 30));
    assert.equal(at('2026-09-30', 24), UTC(2028, 9, 30));
});

test('effectiveLimit: the manual limit > the account\'s > 1; isExpired needs a past date', () => {
    assert.equal(accounts.effectiveLimit({ maxConnections: 4 }, { max_connections: 2 }), 4);
    assert.equal(accounts.effectiveLimit({ maxConnections: null }, { max_connections: 2 }), 2);
    assert.equal(accounts.effectiveLimit({}, { max_connections: 0 }), 1);
    assert.equal(accounts.effectiveLimit({}, null), 1);
    assert.equal(accounts.effectiveLimit(undefined, undefined), 1);
    const now = Date.now();
    assert.equal(accounts.isExpired({}, { exp_date: now - 1000 }, now), true);
    assert.equal(accounts.isExpired({}, { exp_date: now + 1000 }, now), false);
    assert.equal(accounts.isExpired({}, null, now), false, 'unknown is not expired');
    assert.equal(accounts.isExpired({ subscription: { endsAt: '2000-01-01' } }, { exp_date: now + DAY }, now), true, 'the manual date wins');
});

test('login: an xtream source\'s own; an M3U\'s from the header, else from its first /live/<u>/<p>/<id> URL', async () => {
    const x = await newSource({ url: 'http://x.invalid:8080/' });
    assert.deepEqual(accounts.deriveLogin(x), { url: 'http://x.invalid:8080', username: 'trexuser', password: 'trexpass' });

    const line = '#EXT-X-CREDENTIALS:[{"server":"trex.invalid:80","username":"hdruser","password":"hdrpass"}]';
    assert.deepEqual(accounts.parseCredentialsHeader(line), { url: 'http://trex.invalid:80', username: 'hdruser', password: 'hdrpass' });
    // The shape EPGenius actually writes (30 Sept), with a space after each colon.
    const epgenius = '#EXT-X-CREDENTIALS:[{"provider": "dream", "dns": "http://line.dream.invalid", "username": "du", "password": "dp"}]';
    assert.deepEqual(accounts.parseCredentialsHeader(epgenius), { url: 'http://line.dream.invalid', username: 'du', password: 'dp' });
    assert.equal(accounts.parseCredentialsHeader('#EXT-X-CREDENTIALS:not json'), null);
    assert.equal(accounts.parseCredentialsHeader('#EXTINF:-1,x'), null);

    const m = await db.sources.create({ type: 'm3u', name: 'Dream', url: 'http://epgenius.invalid/list.m3u?k=1' });
    assert.equal(accounts.deriveLogin(m), null, 'nothing to go on yet');
    const items = sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stream_url)
                                          VALUES (?, ?, ?, 'live', ?, 'News', 0, ?, ?)`);
    items.run(`${m.id}:pos_1`, m.id, 'pos_1', 'No login', 1, 'http://dream.invalid/other/path.ts');
    items.run(`${m.id}:pos_2`, m.id, 'pos_2', 'Alpha', 2, 'http://dream.invalid:8000/live/urluser/url%40pass/12345.ts');
    assert.deepEqual(accounts.deriveLogin(m), { url: 'http://dream.invalid:8000', username: 'urluser', password: 'url@pass' });

    assert.equal(accounts.noteM3uHeader(m.id, line), true);
    assert.equal(accounts.deriveLogin(m).username, 'hdruser', 'the header wins once the sync has seen it');
    assert.equal(accounts.getAccount(m.id).m3u_login, undefined, 'the stored login never comes back out');

    const g = await db.sources.create({ type: 'm3u', name: 'Get', url: 'http://get.invalid:81/get.php?username=gu&password=gp&type=m3u' });
    assert.deepEqual(accounts.deriveLogin(g), { url: 'http://get.invalid:81', username: 'gu', password: 'gp' });
    assert.equal(accounts.deriveLogin(await db.sources.create({ type: 'epg', name: 'G', url: 'http://g.invalid/x.xml' })), null);
});

test('the M3U parser hands the #EXT-X-CREDENTIALS line to the sync', async () => {
    const text = '#EXTM3U\n#EXT-X-CREDENTIALS:[{"server":"a.invalid","username":"u","password":"p"}]\n'
        + '#EXTINF:-1 tvg-id="a.au",A\nhttp://a.invalid/live/u/p/1.ts\n';
    const batches = [];
    for await (const b of m3uParser.parseStreaming(text)) batches.push(b);
    assert.equal(batches.at(-1).credentials, '#EXT-X-CREDENTIALS:[{"server":"a.invalid","username":"u","password":"p"}]');
    assert.equal(batches.at(-1).channels.length, 1);
    const plain = [];
    for await (const b of m3uParser.parseStreaming('#EXTM3U\n#EXTINF:-1,A\nhttp://a.invalid/1.ts\n')) plain.push(b);
    assert.equal(plain.at(-1).credentials, null);
});

test('a good read stores status, expiry (ms), connections, trial and time; the request carries the configured user agent', async () => {
    reset();
    const exp = Math.floor((Date.now() + 40 * DAY) / 1000);
    reply = { body: userInfo({ exp_date: String(exp), is_trial: '1', active_cons: '0', max_connections: '3' }) };
    await db.settings.update({ userAgentPreset: 'vlc' });
    const s = await newSource();
    const row = await accounts.refresh(s.id);
    assert.deepEqual({ ...row, checked_at: typeof row.checked_at }, {
        source_id: s.id, status: 'Active', exp_date: exp * 1000, max_connections: 3, active_cons: 0,
        is_trial: 1, checked_at: 'number', ok: 1, error: null
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^\/player_api\.php\?username=trexuser&password=trexpass$/);
    assert.equal(requests[0].ua, 'VLC/3.0.20 LibVLC/3.0.20');
    await db.settings.update({ userAgentPreset: 'chrome' });
});

test('a failed read keeps the last good values, records a plain error with no URL, and never marks the provider expired', async () => {
    reset();
    const s = await newSource();
    const good = await accounts.refresh(s.id);
    assert.equal(good.ok, 1);
    for (const failing of [{ status: 502, body: {} }, { raw: '<html>bad gateway</html>' }, { body: { nope: true } }, { body: { user_info: { auth: 0 } } }]) {
        reply = failing;
        const bad = await accounts.refresh(s.id);
        assert.equal(bad.ok, 0, JSON.stringify(failing));
        assert.ok(bad.error && !/https?:|127\.0\.0\.1|trexpass|player_api/.test(bad.error), bad.error);
        assert.equal(bad.exp_date, good.exp_date, 'the last good expiry is kept');
        assert.equal(bad.max_connections, good.max_connections);
        assert.equal(bad.status, 'Active');
        assert.equal(accounts.isExpired(s, bad), false);
    }
    // A provider that is simply unreachable.
    const dead = await newSource({ url: 'http://127.0.0.1:1' });
    const row = await accounts.refresh(dead.id);
    assert.equal(row.ok, 0);
    assert.equal(row.exp_date, null);
    assert.equal(row.error, 'Could not connect to the provider');
    // And a good read afterwards clears the error.
    reply = { body: userInfo() };
    const recovered = await accounts.refresh(s.id);
    assert.equal(recovered.ok, 1); assert.equal(recovered.error, null);
});

test('a provider with no derivable login is a plain error, and unlimited (exp_date null) reads as no expiry', async () => {
    reset();
    const m = await db.sources.create({ type: 'm3u', name: 'Lonely', url: 'http://lonely.invalid/list.m3u' });
    const row = await accounts.refresh(m.id);
    assert.equal(row.ok, 0);
    assert.match(row.error, /No login could be found/);
    const s = await newSource();
    reply = { body: userInfo({ exp_date: null }) };
    const ok = await accounts.refresh(s.id);
    assert.equal(ok.exp_date, null);
    assert.equal(accounts.effectiveExpiry(s, ok), null);
    assert.equal(await accounts.refresh(999999), null, 'no such source');
});

test('admin GET /api/sources/:id/account and POST .../account/check return the stored and effective values', async () => {
    reset();
    const exp = Math.floor((Date.now() + 40 * DAY) / 1000);
    reply = { body: userInfo({ exp_date: String(exp), max_connections: '2' }) };
    const s = await newSource({ maxConnections: 5 });
    assert.deepEqual((await call('GET', `/api/sources/${s.id}/account`)).body, {
        account: null, effective: { expiresAt: null, expirySource: null, limit: 5, expired: false }
    });
    const checked = (await call('POST', `/api/sources/${s.id}/account/check`)).body;
    assert.equal(checked.account.ok, true);
    assert.equal(checked.account.maxConnections, 2);
    assert.equal(checked.account.expiresAt, exp * 1000);
    assert.equal(checked.account.isTrial, false);
    assert.deepEqual(checked.effective, { expiresAt: exp * 1000, expirySource: 'account', limit: 5, expired: false });
    assert.deepEqual((await call('GET', `/api/sources/${s.id}/account`)).body, checked);
    const text = JSON.stringify(checked);
    assert.ok(!text.includes('trexpass') && !text.includes(fakeUrl));
    assert.equal((await call('GET', `/api/sources/${s.id}/account`, viewerToken)).status, 403);
    assert.equal((await call('GET', '/api/sources/99999/account')).status, 404);
    const epg = await db.sources.create({ type: 'epg', name: 'Guide', url: 'http://g.invalid/x.xml' });
    assert.equal((await call('POST', `/api/sources/${epg.id}/account/check`)).status, 404);
});

test('reminders: enabled providers ending within 7 days or past; soonest first; nothing else; any signed-in user', async () => {
    reset();
    for (const s of await db.sources.getAll()) { await db.sources.delete(s.id); accounts.remove(s.id); }
    const soon = await newSource({ name: 'Soon', subscription: { endsAt: new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10) } });
    const past = await newSource({ name: 'Past', role: 'backup', subscription: { endsAt: '2020-01-01' } });
    await newSource({ name: 'Far', subscription: { endsAt: new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10) } });
    const off = await newSource({ name: 'Off', subscription: { endsAt: '2020-01-01' } });
    await db.sources.toggleEnabled(off.id);
    await newSource({ name: 'Unknown' });
    await db.sources.create({ type: 'epg', name: 'Guide', url: 'http://g.invalid/x.xml', subscription: { endsAt: '2020-01-01' } });
    const viaAccount = await newSource({ name: 'ViaAccount' });
    sqlite.getDb().prepare(`INSERT INTO provider_accounts (source_id, exp_date, checked_at, ok) VALUES (?, ?, ?, 1)`)
        .run(viaAccount.id, Date.now() + 6 * DAY, Date.now());

    const r = await call('GET', '/api/providers/reminders', viewerToken);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(x => x.name), ['Past', 'Soon', 'ViaAccount']);
    assert.deepEqual(Object.keys(r.body[0]).sort(), ['daysLeft', 'expiresAt', 'id', 'name']);
    assert.equal(r.body[0].id, past.id);
    assert.ok(r.body[0].daysLeft < 0);
    assert.equal(r.body[1].id, soon.id);
    assert.ok(r.body[1].daysLeft >= 3 && r.body[1].daysLeft <= 4, `daysLeft ${r.body[1].daysLeft}`);
    assert.equal(r.body[2].daysLeft, 6);
    for (const secret of ['trexpass', 'trexuser', fakeUrl]) assert.ok(!r.text.includes(secret));
    assert.equal((await fetch(`${base}/api/providers/reminders`)).status, 401);
});

test('reminders are an empty list with no provider configured, and /api/info advertises providerReminders', async () => {
    for (const s of await db.sources.getAll()) await db.sources.delete(s.id);
    assert.deepEqual((await call('GET', '/api/providers/reminders')).body, []);
    assert.equal((await call('GET', '/api/info')).body.features.providerReminders, true);
});

test('the refresh timers start and stop without a network call of their own until due', async () => {
    reset();
    const stop = accounts.startTimers({ delayMs: 60000, everyMs: 60000 });
    assert.equal(typeof stop, 'function');
    stop();
    assert.equal(requests.length, 0);
});
