const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const express = require('express');

// #68, #67 (0346, C-P): the sport pages' spoiler-free switch and the followed driver are one household setting, the
// same on every device and account (D-30, D-37), kept apart from the web's settings object (#9 rewrites that whole).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sport-prefs-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.JWT_SECRET = 'test-only-sport-page-prefs-key-at-least-32-characters';
process.env.PIGTV_DB_BACKUPS = '0';
const auth = load('auth'), db = load('db');
let server, base, viewer, other;
before(async () => {
    viewer = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    other = auth.generateToken(await db.users.create({ username: 'other', role: 'viewer' }));
    const app = express(); app.use(express.json()); app.use('/api/sports', load('routes/sports'));
    server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', err => err ? reject(err) : resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    load('services/sportsEvents').shutdown();
    if (server?.listening) await new Promise(r => server.close(r));
    load('db/sqlite').getDb().close();
    fs.rmSync(sandbox, { recursive: true, force: true });
});
async function call(url, token = viewer, body) {
    const r = await fetch(base + url, { method: body ? 'PUT' : 'GET',
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, cache: r.headers.get('cache-control'), body: parsed };
}

test('the defaults: spoilers shown, nobody followed; signed out is refused', async () => {
    assert.equal((await call('/api/sports/pages/preferences', null)).status, 401);
    const r = await call('/api/sports/pages/preferences');
    assert.equal(r.status, 200);
    assert.match(r.cache, /no-store/);
    assert.deepEqual(r.body, { spoilerFree: false, sports: [], teams: {}, following: { F1: null, NFL: null } }); // 0381: sports, teams
});

test('one household setting: what one account saves, another reads, and it survives a restart of the cache', async () => {
    const saved = await call('/api/sports/pages/preferences', viewer, { spoilerFree: true, following: { F1: '  Oscar Piastri ' } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { spoilerFree: true, sports: ['F1'], teams: { F1: ['Oscar Piastri'] }, following: { F1: 'Oscar Piastri', NFL: null } });
    assert.deepEqual((await call('/api/sports/pages/preferences', other)).body, saved.body, 'the same for every account');
    // A change to one field keeps the other.
    const half = await call('/api/sports/pages/preferences', other, { spoilerFree: false });
    assert.deepEqual(half.body, { spoilerFree: false, sports: ['F1'], teams: { F1: ['Oscar Piastri'] }, following: { F1: 'Oscar Piastri', NFL: null } });
    const none = await call('/api/sports/pages/preferences', other, { following: { F1: null, NFL: null } });
    assert.deepEqual(none.body, { spoilerFree: false, sports: ['F1'], teams: {}, following: { F1: null, NFL: null } });
    const stored = load('db/sqlite').getDb().prepare("SELECT value FROM meta WHERE key = 'sport_page_prefs'").get();
    assert.ok(stored, 'kept in the database, not in the settings object the web rewrites (#9)');
});

test('anything else is refused with 400 and changes nothing', async () => {
    await call('/api/sports/pages/preferences', viewer, { spoilerFree: true, following: { F1: 'Lando Norris' } });
    for (const bad of [{}, { spoilerFree: 'yes' }, { spoilerFree: 1 }, { following: 'Lando' }, { following: { AFL: 'Cats' } },
        { following: { F1: 7 } }, { following: { F1: 'x'.repeat(81) } }, { extra: true }, []]) {
        const r = await call('/api/sports/pages/preferences', viewer, bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.deepEqual((await call('/api/sports/pages/preferences')).body, { spoilerFree: true, sports: ['F1'], teams: { F1: ['Lando Norris'] }, following: { F1: 'Lando Norris', NFL: null } });
});

test('a corrupt stored value reads as the defaults', async () => {
    load('db/sqlite').getDb().prepare("UPDATE meta SET value = '{not json' WHERE key = 'sport_page_prefs'").run();
    assert.deepEqual((await call('/api/sports/pages/preferences')).body, { spoilerFree: false, sports: [], teams: {}, following: { F1: null, NFL: null } });
});
