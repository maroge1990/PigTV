const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0133 (roadmap S4.1, contract C-G): every start attempt is kept per channel
// identity for 30 days; library/guide and library/channels rows carry `health`
// ("ok" | "flaky" | null over the last 7 days); /api/info advertises
// `channelHealth`; the Status page lists the least reliable channels. The old
// code kept nothing: no table, no `health` field, no flag, no status list.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-channel-health-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const strategy = load('services/playbackStrategy');
const recordingEngine = load('services/recordingEngine');
recordingEngine.listActive = () => [];

const DAY = 24 * 60 * 60 * 1000;
let server, base, adminToken, admin, source, health;

async function call(method, route, body) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: { Authorization: `Bearer ${adminToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* no body */ }
    return { status: response.status, body: json };
}
const get = async route => (await call('GET', route)).body;

const channels = [
    // item_id, name, stable_id
    ['pos_1', 'Alpha', 's1001'],
    ['pos_2', 'Bravo', 's1002'],
    ['pos_3', 'Charlie', 's1003'],
    ['pos_4', 'Delta', null]
];

function insertAttempt(key, { ago = 0, ok = true, name = null, fps = null } = {}) {
    sqlite.getDb().prepare(`INSERT INTO channel_health (source_id, channel_key, name, at, ok, first_picture_sec, reason)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(source.id, key, name, Date.now() - ago, ok ? 1 : 0, fps, ok ? null : 'refused');
}
const attempts = () => sqlite.getDb().prepare('SELECT * FROM channel_health ORDER BY id').all();
const clear = () => { sqlite.getDb().prepare('DELETE FROM channel_health').run(); health.reset(); };

before(async () => {
    admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken(admin);
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    const d = sqlite.getDb();
    const insert = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                              VALUES (?, ?, ?, 'live', ?, 'News', 0, ?, ?, ?)`);
    channels.forEach(([item, name, stable], i) =>
        insert.run(`${source.id}:${item}`, source.id, item, name, i + 1, stable, `http://provider.invalid/live/u/p/${1001 + i}.ts`));
    health = load('services/channelHealth');
    load('db/recordingsDb').initSchema(); // the status route reads the recording tables

    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth')); // configures the jwt strategy
    app.use('/api/info', load('routes/info'));
    app.use('/api/library', load('routes/library'));
    app.use('/api/playback', load('routes/playback'));
    app.use('/api/status', load('routes/status'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('/api/info advertises channelHealth', async () => {
    assert.equal((await get('/api/info')).features.channelHealth, true);
});

test('the thresholds: flaky at 2 failed starts, or more than 30% failed with at least 3 attempts', () => {
    const cases = [
        // attempts, failures, expected
        [0, 0, null],
        [1, 0, 'ok'],
        [1, 1, 'ok'],      // one failure, too few attempts for the rate rule
        [2, 1, 'ok'],      // 50%, but fewer than 3 attempts
        [3, 1, 'flaky'],   // 33% of 3
        [4, 1, 'ok'],      // 25%
        [10, 3, 'flaky'],  // count rule
        [2, 2, 'flaky'],
        [100, 2, 'flaky']  // 2% but two failed starts
    ];
    for (const [a, f, want] of cases) assert.equal(health.classify(a, f), want, `${a} attempts, ${f} failures`);
});

test('guide and channels rows carry health: flaky, ok, or null with no data; only the last 7 days count', async () => {
    clear();
    insertAttempt('s1001', { ok: false });
    insertAttempt('s1001', { ok: false, ago: DAY });          // Alpha: 2 failures -> flaky
    insertAttempt('s1002', { ok: true });
    insertAttempt('s1002', { ok: false, ago: 8 * DAY });      // Bravo: the failure is too old -> ok
    insertAttempt('s1002', { ok: false, ago: 9 * DAY });
    insertAttempt('pos_4', { ok: true });                     // Delta: no stable id, keyed by item_id
    insertAttempt('pos_4', { ok: true });
    insertAttempt('pos_4', { ok: false });                    // 1 of 3 = 33% -> flaky
    // Charlie: nothing -> null

    const guide = await get('/api/library/guide?limit=50');
    const byName = rows => Object.fromEntries(rows.map(r => [r.name, r.health]));
    assert.deepEqual(byName(guide.channels), { Alpha: 'flaky', Bravo: 'ok', Charlie: null, Delta: 'flaky' });
    const list = await get('/api/library/channels?limit=50');
    assert.deepEqual(byName(list.channels), { Alpha: 'flaky', Bravo: 'ok', Charlie: null, Delta: 'flaky' });
    for (const row of [...guide.channels, ...list.channels]) assert.ok('health' in row, 'the field is always present');
});

test('pruning removes attempts older than 30 days and keeps the rest', () => {
    clear();
    insertAttempt('s1001', { ago: 31 * DAY });
    insertAttempt('s1001', { ago: 29 * DAY });
    insertAttempt('s1001', { ago: 0 });
    assert.equal(health.prune(), 1);
    assert.equal(attempts().length, 2);
    assert.ok(attempts().every(r => r.at > Date.now() - 30 * DAY));
});

test('the resolve route records a failed start with its reason category, and a started one as ok', async () => {
    clear();
    const real = strategy.resolve;
    try {
        strategy.resolve = async () => { throw Object.assign(new Error('The provider refused this channel (HTTP 403). It may be offline.'), { status: 502 }); };
        const failed = await call('POST', '/api/playback/resolve', { sourceId: source.id, channelId: 'pos_3', capabilities: {} });
        assert.equal(failed.status, 502);

        strategy.resolve = async () => ({ strategy: 'transcode', reason: 'test', sessionId: 'abc', url: '/api/transcode/abc/stream.m3u8' });
        const ok = await call('POST', '/api/playback/resolve', { sourceId: source.id, channelId: `m3u_${source.id}_pos_3`, capabilities: {} });
        assert.equal(ok.status, 200);
    } finally { strategy.resolve = real; }

    const rows = attempts();
    assert.deepEqual(rows.map(r => [r.channel_key, r.ok, r.reason, r.name]), [
        ['s1003', 0, 'refused', 'Charlie'],
        ['s1003', 1, null, 'Charlie']
    ], 'keyed by identity, whichever id form the client sent');

    // A channel that is not in the playlist is not an attempt on any channel.
    await call('POST', '/api/playback/resolve', { sourceId: source.id, channelId: 'pos_404', capabilities: {} });
    assert.equal(attempts().length, 2);
});

test('client events: play-start sets the first-picture time; an error before it is a failed start, after it is not', async () => {
    clear();
    const real = strategy.resolve;
    strategy.resolve = async () => ({ strategy: 'transcode', reason: 'test', sessionId: 'abc', url: '/api/transcode/abc/stream.m3u8' });
    try {
        // 1: starts, then the picture arrives after 4.2 s; a later media error is a stall, not a failed start.
        await call('POST', '/api/playback/resolve', { sourceId: source.id, channelId: 'pos_1', capabilities: {} });
        assert.equal((await call('POST', '/api/playback/client-event', { event: 'play-start', strategy: 'transcode', totalMs: 4200 })).status, 204);
        await call('POST', '/api/playback/client-event', { event: 'media-error', strategy: 'transcode', code: 3, codeName: 'DECODE' });
        // 2: resolves, then the player gives up before any picture.
        await call('POST', '/api/playback/resolve', { sourceId: source.id, channelId: 'pos_2', capabilities: {} });
        await call('POST', '/api/playback/client-event', { event: 'start-timeout', strategy: 'transcode', waitedSec: 20 });
    } finally { strategy.resolve = real; }

    assert.deepEqual(attempts().map(r => [r.channel_key, r.ok, r.first_picture_sec, r.reason]), [
        ['s1001', 1, 4.2, null],
        ['s1002', 0, null, 'player']
    ]);
});

test('library_rev moves when a channel\'s health changes, not on every play', async () => {
    clear();
    const rev = () => sqlite.getDb().prepare(`SELECT value FROM meta WHERE key = 'library_rev'`).get()?.value || '0';
    const r0 = rev();
    health.recordResolve({ sourceId: source.id, channelId: 'pos_1', ok: true });          // null -> ok
    const r1 = rev();
    assert.notEqual(r1, r0);
    health.recordResolve({ sourceId: source.id, channelId: 'pos_1', ok: true });          // ok -> ok
    assert.equal(rev(), r1);
    health.recordResolve({ sourceId: source.id, channelId: 'pos_1', ok: false, reason: 'x' });
    health.recordResolve({ sourceId: source.id, channelId: 'pos_1', ok: false, reason: 'x' }); // -> flaky
    assert.notEqual(rev(), r1);
});

test('the status document lists the least reliable channels with attempts, failures and median first picture', async () => {
    clear();
    insertAttempt('s1001', { ok: true, fps: 4 , name: 'Alpha' });
    insertAttempt('s1001', { ok: true, fps: 6, name: 'Alpha' });
    insertAttempt('s1001', { ok: true, fps: 9, name: 'Alpha' });
    insertAttempt('s1001', { ok: false, name: 'Alpha' });
    insertAttempt('s1002', { ok: false, name: 'Bravo' });
    insertAttempt('s1002', { ok: false, name: 'Bravo' });
    insertAttempt('s1003', { ok: true, fps: 3, name: 'Charlie' }); // never failed: not listed

    const { status, body } = await call('GET', '/api/status');
    assert.equal(status, 200);
    assert.deepEqual(body.leastReliable, [
        { name: 'Bravo', attempts: 2, failures: 2, medianFirstPictureSec: null, health: 'flaky' },
        { name: 'Alpha', attempts: 4, failures: 1, medianFirstPictureSec: 6, health: 'ok' }
    ]);
});

test('the web Status page shows the least reliable channels', () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/js/pages/StatusPage.js'), 'utf8');
    const vm = require('node:vm');
    const context = vm.createContext({ console, document: { getElementById: () => null } });
    context.window = context;
    vm.runInContext(js, context);
    const page = new context.StatusPage({});
    const html = page.render({ leastReliable: [{ name: 'Seven <Flix>', attempts: 5, failures: 3, medianFirstPictureSec: 8.25, health: 'flaky' }] });
    assert.ok(html.includes('Least reliable channels'));
    assert.ok(html.includes('Seven &lt;Flix&gt;'), 'escaped');
    assert.ok(html.includes('8.3s') || html.includes('8.2s'));
    assert.ok(html.includes('Flaky'));
    assert.ok(page.render({}).includes('No failed starts in the last 7 days'));
});
