const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-adaptive-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'));
process.env.PIGTV_DB_BACKUPS = '0';
const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
after(() => { sqlite.getDb().close(); fs.rmSync(sandbox, { recursive: true, force: true }); });

// Pauses are advanced with Date only; actual HTTP reads and reconnects still happen over loopback.
const sleep = ms => new Promise(r => setTimeout(r, ms));
function packets(pcr = true, from = 0) {
    return Buffer.concat(Array.from({ length: 20 }, (_, n) => {
        const b = Buffer.alloc(188, 0xff);
        b[0] = 0x47; b[1] = 1; b[2] = 0; b[3] = pcr ? 0x30 : 0x10;
        if (pcr) { b[4] = 7; b[5] = 0x10; const base = Math.round((from + n / 20) * 90000);
            b[6] = Math.floor(base / 33554432) & 255; b[7] = Math.floor(base / 131072) & 255;
            b[8] = Math.floor(base / 512) & 255; b[9] = Math.floor(base / 2) & 255; b[10] = (base % 2) << 7; }
        return b;
    }));
}

test('a real shared feed raises only its channel/provider after a lag reconnect, and the next same pause is tolerated', async t => {
    const ingest = load('services/ingest');
    const adaptive = load('services/feedLagLimit');
    const downMs = adaptive.tuning.downMs;
    const server = http.createServer((req, res) => { res.writeHead(200); res.write(packets(req.url !== '/no-pcr')); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
        const sub = await ingest.subscribe({ pool: 'a', url, channelKey: 'stable:a', providerId: 8, purpose: 'viewer' });
        sub.resume(); const i = sub.ingest; clearInterval(i.stallTimer);
        t.mock.timers.tick(25000); i.checkStall();
        assert.equal(i.lagReconnects, 1);
        assert.equal(i.describe().limitSec, 26, 'open ingest changes immediately');
        for (let n = 0; n < 100 && i.state !== 'live'; n++) await sleep(20);
        assert.equal(i.state, 'live', 'the same HTTP feed reconnects');
        t.mock.timers.tick(25000); i.checkStall();
        assert.equal(i.lagReconnects, 1, 'the identical pause fits the new limit');
        ingest.closeAll();
        const again = await ingest.subscribe({ pool: 'a', url, channelKey: 'stable:a', providerId: 8 });
        again.resume(); clearInterval(again.ingest.stallTimer);
        assert.equal(again.ingest.describe().limitSec, 26, 'later ingests retain the level');
        adaptive.tuning.downMs = 3000; // same reading rule, accelerated window
        for (let n = 1; n <= 3; n++) {
            t.mock.timers.tick(1000); again.ingest.onData(packets(true, n)); again.ingest.checkStall();
        }
        assert.equal(again.ingest.describe().limitSec, 24, 'a clean measured run lowers the open feed');
        ingest.closeAll();
        const noPcr = await ingest.subscribe({ pool: 'a', url: url + '/no-pcr', channelKey: 'stable:a', providerId: 8 });
        noPcr.resume(); clearInterval(noPcr.ingest.stallTimer);
        t.mock.timers.tick(25000); noPcr.ingest.checkStall();
        assert.equal(noPcr.ingest.state, 'reconnecting', 'no PCR retains the default silence timeout');
        assert.equal(noPcr.ingest.lagReconnects, 0, 'unmeasured feeds do not train the limit');
    } finally { adaptive.tuning.downMs = downMs; ingest.closeAll(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('levels persist across a module reload, isolate provider and stable channel identity, and never exceed 28 s', () => {
    const adaptive = load('services/feedLagLimit');
    const a = adaptive.open('stable:ceiling', 8, 24000);
    for (let n = 0; n < 6; n++) adaptive.lag(a);
    assert.equal(a.limitMs, 28000);
    delete require.cache[require.resolve(path.join(sandbox, 'server/services/feedLagLimit'))];
    const reloaded = load('services/feedLagLimit');
    assert.equal(reloaded.open('stable:ceiling', 8, 24000).limitMs, 28000);
    assert.equal(reloaded.open('stable:other', 8, 24000).limitMs, 24000);
    assert.equal(reloaded.open('stable:ceiling', 7, 24000).limitMs, 24000);
    assert.equal(reloaded.open('stable:ceiling', 8, 99000).limitMs, 28000, 'configuration cannot exceed client headroom');
});

test('three measured reading hours with worst lag at least four seconds below the level lower it one step', () => {
    const a = load('services/feedLagLimit');
    let state = a.open('stable:clean', 8, 24000); a.lag(state); a.lag(state);
    a.observe(state, 2 * 3600000, 24);
    a.flush(state);
    a.release(state);
    state = a.open('stable:clean', 8, 24000);
    a.observe(state, 3600000, 24);
    assert.equal(state.limitMs, 26000, 'accumulates reading across restarts');
    a.observe(state, 2 * 3600000, 23); // too close to 26: breaks the clean window
    assert.equal(state.cleanMs, 0);
    a.observe(state, 2 * 3600000, 20);
    a.lag(state);
    assert.equal(state.cleanMs, 0, 'a lag reconnect also resets the window');
    a.observe(state, 3 * 3600000, 20);
    assert.equal(state.limitMs, 26000);
    a.observe(state, 3 * 3600000, 20);
    assert.equal(state.limitMs, 24000);
    a.observe(state, 9 * 3600000, 0);
    assert.equal(state.limitMs, 24000, 'never drops below default');
});

test('Feed lag shows the current level by identity, surviving renames and separating identically named channels', () => {
    const a = load('services/feedLagLimit');
    const feedLag = load('services/feedLag');
    const now = Date.now();
    const row = { channel: 'Same name', providerId: 8, providerName: 'Provider', startedAt: now - 120000,
        endedAt: now, worstBehindSec: 25 };
    a.lag(a.open('stable:one', 8, 24000));
    feedLag.record({ ...row, channelKey: 'stable:one' });
    feedLag.record({ ...row, channelKey: 'stable:two' });
    feedLag.record({ ...row, channelKey: 'stable:one', channel: 'Renamed', endedAt: now + 1 });
    const rows = feedLag.summary({ now: now + 1 });
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r.channelKey === 'stable:one').limitSec, 26);
    assert.equal(rows.find(r => r.channelKey === 'stable:one').reads, 2);
    assert.equal(rows.find(r => r.channelKey === 'stable:two').limitSec, 24);
});

test('failed persistence retains safe in-memory decisions and fixed warnings', () => {
    const a = load('services/feedLagLimit');
    const dbh = sqlite.getDb();
    const original = dbh.prepare;
    const warn = console.warn;
    const warnings = [];
    const state = a.open('stable:db-failure', 8, 24000);
    try {
        console.warn = s => warnings.push(s);
        dbh.prepare = function(sql) { if (sql.includes('feed_lag_limits')) throw new Error('private details'); return original.call(this, sql); };
        a.lag(state);
        assert.equal(state.limitMs, 26000, 'open reader still adapts');
        assert.equal(a.open('stable:db-failure', 8, 24000).limitMs, 26000, 'another active reader retains the in-memory raise');
        assert.equal(a.open('stable:new-db-failure', 8, 24000).limitMs, 24000, 'new identity read failure uses safe default');
        a.flush(state);
    } finally { dbh.prepare = original; console.warn = warn; }
    assert.ok(warnings.length >= 2);
    assert.ok(warnings.every(s => !s.includes('private details')));
});

test('two active readers share learned limits and cannot undo each other on flush or close', () => {
    const adaptive = load('services/feedLagLimit');
    const a = adaptive.open('stable:two-readers', 8, 24000);
    const b = adaptive.open('stable:two-readers', 8, 24000);
    adaptive.lag(a);
    adaptive.flush(b);
    assert.equal(adaptive.open('stable:two-readers', 8, 24000).limitMs, 26000, 'stale reader cannot overwrite the raise');
    assert.equal(b.limitMs, 26000, 'every active reader sees the raise immediately');
    adaptive.observe(a, 2 * 3600000, 10, 2 * 3600000);
    adaptive.observe(b, 2 * 3600000, 10, 2 * 3600000);
    assert.equal(a.limitMs, 26000, 'overlapping readers do not earn a reduction twice as fast');
    adaptive.observe(b, 3600000, 10, 3 * 3600000);
    assert.equal(a.limitMs, 24000, 'the same shared level lowers after three reading hours');
    adaptive.flush(a);
    adaptive.release(a); adaptive.release(b); adaptive.release(a); // three opens, three releases
    const next = adaptive.open('stable:two-readers', 8, 24000);
    assert.notEqual(next, a, 'last reader releases the in-memory state');
    assert.equal(next.limitMs, 24000, 'a fresh state reads the persisted reduction');
    adaptive.release(next);
});

test('two different URLs for one stable channel retain a raise when either ingest closes', async t => {
    const ingest = load('services/ingest');
    const adaptive = load('services/feedLagLimit');
    const server = http.createServer((req, res) => { res.writeHead(200); res.write(packets()); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
        const a = await ingest.subscribe({ pool: 'same-account', url: base + '/a', providerId: 8, channelKey: 'stable:duplicate' });
        const b = await ingest.subscribe({ pool: 'same-account', url: base + '/b', providerId: 8, channelKey: 'stable:duplicate' });
        a.resume(); b.resume(); clearInterval(a.ingest.stallTimer); clearInterval(b.ingest.stallTimer);
        t.mock.timers.tick(25000); a.ingest.checkStall();
        assert.equal(a.ingest.lagReconnects, 1);
        assert.equal(b.ingest.describe().limitSec, 26);
        b.ingest.close('other listing closed'); a.ingest.close('first listing closed');
        assert.equal(adaptive.current('stable:duplicate', 8, 24000).limitMs, 26000);
    } finally { ingest.closeAll(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
