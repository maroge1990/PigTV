const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// #238: the score collector fetched every 30 s day and night whether or not anyone looked (~1.9 GB a day on
// production). Now it keeps that pace only while someone looks (or a recording runs), else every 5 minutes. The
// collector's heartbeat is driven by hand here; each refresh asks the one feed league once, so its calls count fetches.
const dashboard = require('../server/services/sportsDashboard');
const { createStore } = require('../server/services/sportsDashboardStore');
const databases = [];
after(() => databases.forEach(db => db.close()));

function collector({ busy }) {
    const db = new Database(':memory:'); databases.push(db);
    const clock = { now: Date.parse('2026-11-07T00:00Z') };
    const fetches = [];
    let beat = null;
    const c = dashboard.createCollector({ store: createStore(db), clock: () => clock.now, enabled: () => true,
        leagues: () => new Set(['AFLW']), fetchJson: async () => ({ events: [] }),
        feedGames: async () => { fetches.push(clock.now); return { ok: true, observedAt: clock.now, games: [] }; },
        recordFeed: () => {}, busy, every: (fn) => { beat = fn; return null; } });
    /** Run the heartbeat for `minutes`, 30 s at a time, letting each refresh finish. */
    const run = async (minutes) => {
        for (let i = 0; i < minutes * 2; i++) { clock.now += 30000; beat(); await new Promise(r => setImmediate(r)); }
    };
    return { c, clock, fetches, run };
}

test('nobody looking: at most one fetch per 5 minutes', async () => {
    const { c, fetches, run } = collector({ busy: () => false });
    c.start(); await new Promise(r => setImmediate(r));
    assert.equal(fetches.length, 1, 'one at start');
    await run(30);
    c.stop();
    assert.equal(fetches.length, 7, `once at start, then every 5 min over 30 min: ${fetches.length}`);
    for (let i = 1; i < fetches.length; i++) assert.ok(fetches[i] - fetches[i - 1] >= 5 * 60000);
});

test('someone looking: every 30 s, as before', async () => {
    const { c, fetches, run } = collector({ busy: () => true });
    c.start(); await new Promise(r => setImmediate(r));
    await run(5);
    c.stop();
    assert.equal(fetches.length, 11);
});

// The module's own demand window and the routes that open it, in a sandbox with a database and real sign-in.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const express = require('express');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-collector-demand-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.JWT_SECRET = 'test-only-collector-demand-key-at-least-32-characters';
process.env.PIGTV_DB_BACKUPS = '0';
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); };
const settle = () => new Promise(r => setTimeout(r, 50)); // for "nothing happened": a false pass at worst, never a false failure
after(() => {
    try { load('services/sportsDashboard').stop(); } catch { /* not started */ }
    try { load('services/sportsEvents').shutdown(); } catch { /* not loaded */ }
    try { load('db/sqlite').getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

test('the score pages keep the busy pace for 5 minutes and, after a quiet spell, fetch at once; settings do not', async () => {
    const auth = load('auth'), db = load('db'), sandboxed = load('services/sportsDashboard');
    const token = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    const fetches = [];
    sandboxed.start({ leagues: () => new Set(['AFLW']), fetchJson: async () => ({ events: [] }), recordFeed: () => {},
        feedGames: async () => { fetches.push(Date.now()); return { ok: true, observedAt: Date.now(), games: [] }; },
        every: () => null });
    await until(() => fetches.length === 1);
    assert.equal(fetches.length, 1, 'the start-up fetch');
    assert.deepEqual(sandboxed.cadence(), { everySec: 300, why: 'nobody looking' });

    const app = express(); app.use(express.json()); app.use('/api/sports', load('routes/sports'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const get = (p) => fetch(`http://127.0.0.1:${server.address().port}/api/sports${p}`, { headers: { authorization: `Bearer ${token}` } });
    try {
        for (const p of ['/pages/preferences', '/follows', '/catalog']) await get(p);
        await settle();
        assert.equal(fetches.length, 1, 'settings and lists are not a look');
        assert.equal(sandboxed.cadence().why, 'nobody looking');
        await get('/pages/league/AFL');
        await until(() => fetches.length === 2);
        assert.equal(fetches.length, 2, 'the first score page after a quiet spell fetches at once');
        assert.deepEqual(sandboxed.cadence(), { everySec: 30, why: 'looking' });
        await get('/front');
        await settle();
        assert.equal(fetches.length, 2, 'inside the window: the 30 s heartbeat fetches, not every request');
        assert.deepEqual(sandboxed.cadence(Date.now() + 5 * 60000 + 1000), { everySec: 300, why: 'nobody looking' });
    } finally {
        server.closeAllConnections(); await new Promise(r => server.close(r));
    }
});

test('a recording running keeps the busy pace (its end can follow the game, #217)', async () => {
    const sandboxed = load('services/sportsDashboard');
    const { initSchema, scheduled } = load('db/recordingsDb');
    initSchema();
    const later = Date.now() + 60 * 60000;
    assert.equal(sandboxed.cadence(later).why, 'nobody looking');
    const row = scheduled.create({ title: 'Cats v Swans', description: null, source_id: 1, channel_item_id: 'x', channel_stable_id: null,
        channel_name: 'Fox', channel_logo: null, program_start: Date.now(), program_end: Date.now() + 3600e3,
        pre_buffer_min: 0, post_buffer_min: 0, created_by: 1, created_at: Date.now() });
    load('db/sqlite').getDb().prepare(`UPDATE scheduled_recordings SET status = 'recording' WHERE id = ?`).run(row.id ?? row.lastInsertRowid ?? row);
    assert.deepEqual(sandboxed.cadence(later), { everySec: 30, why: 'recording' });
});
