const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const express = require('express');

// #68, #67 (0346, C-P): the sport pages' spoiler-free switch and followed names, kept apart from the web's settings object
// (#9 rewrites that whole). #193 (0391, D-41): each account's own (they were the household's), grouped by sport (C-U).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sport-prefs-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.JWT_SECRET = 'test-only-sport-page-prefs-key-at-least-32-characters';
process.env.PIGTV_DB_BACKUPS = '0';
const auth = load('auth'), db = load('db');
let server, base, owner, viewer, other;
before(async () => {
    owner = auth.generateToken(await db.users.create({ username: 'owner', role: 'admin' }));
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
    assert.equal((await call('/api/sports/follows', null)).status, 401);
    const r = await call('/api/sports/pages/preferences');
    assert.equal(r.status, 200);
    assert.match(r.cache, /no-store/);
    assert.deepEqual(r.body, { spoilerFree: false, sports: [], teams: {}, following: { F1: null, NFL: null } }); // 0381: sports, teams
    assert.deepEqual((await call('/api/sports/follows')).body, { spoilerFree: false, sports: [] });
});

test('each account its own: what one saves, another does not see, and it survives a restart of the cache', async () => {
    const saved = await call('/api/sports/pages/preferences', viewer, { spoilerFree: true, following: { F1: '  Oscar Piastri ' } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { spoilerFree: true, sports: ['F1'], teams: { F1: ['Oscar Piastri'] }, following: { F1: 'Oscar Piastri', NFL: null } });
    assert.deepEqual((await call('/api/sports/pages/preferences', other)).body,
        { spoilerFree: false, sports: [], teams: {}, following: { F1: null, NFL: null } }, 'another account is untouched');
    // A change to one field keeps the other.
    const half = await call('/api/sports/pages/preferences', viewer, { spoilerFree: false });
    assert.deepEqual(half.body, { spoilerFree: false, sports: ['F1'], teams: { F1: ['Oscar Piastri'] }, following: { F1: 'Oscar Piastri', NFL: null } });
    const none = await call('/api/sports/pages/preferences', viewer, { following: { F1: null, NFL: null } });
    assert.deepEqual(none.body, { spoilerFree: false, sports: ['F1'], teams: {}, following: { F1: null, NFL: null } });
    const rows = load('db/sqlite').getDb().prepare('SELECT user_id FROM sport_follows').all();
    assert.equal(rows.length, 1, 'kept per account in the database, not in the settings object the web rewrites (#9)');
});

test('anything else is refused with 400 and changes nothing', async () => {
    await call('/api/sports/pages/preferences', viewer, { spoilerFree: true, following: { F1: 'Lando Norris' } });
    for (const bad of [{}, { spoilerFree: 'yes' }, { spoilerFree: 1 }, { following: 'Lando' }, { following: { AFL: 'Cats' } },
        { following: { F1: 7 } }, { following: { F1: 'x'.repeat(81) } }, { extra: true }, [], { sports: ['AFLW Reserves'] }]) {
        const r = await call('/api/sports/pages/preferences', viewer, bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
    }
    for (const bad of [{}, { sports: 'Football' }, { sports: [{ sport: 'Curling' }] }, { sports: [{ sport: 'Football' }] },
        { sports: [{ sport: 'Football', leagues: [] }] }, { sports: [{ sport: 'Football', leagues: ['NFL'] }] },
        { sports: [{ sport: 'Basketball', leagues: ['NBA'] }, { sport: 'basketball', leagues: ['NBL'] }] },
        { sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['x'.repeat(81)] }] }, { sports: [{ sport: 'Football', leagues: ['EPL'], extra: 1 }] },
        { sports: [{ sport: 'Football', leagues: ['EPL'], teams: Array.from({ length: 21 }, (_, i) => `Team ${i}`) }] }, { following: {} }]) {
        const r = await call('/api/sports/follows', viewer, bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.deepEqual((await call('/api/sports/pages/preferences')).body, { spoilerFree: true, sports: ['F1'], teams: { F1: ['Lando Norris'] }, following: { F1: 'Lando Norris', NFL: null } });
});

test('C-U: sports hold their leagues and one list of teams, shown under every league in the older view', async () => {
    const put = await call('/api/sports/follows', other, { sports: [
        { sport: 'football', leagues: ['UEFA', 'epl'], teams: ['Arsenal', ' arsenal '] },
        { sport: 'American football', teams: ['Green Bay Packers'] }] });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body, { spoilerFree: false, sports: [
        { sport: 'Football', leagues: ['Champions League', 'Europa League', 'EPL'], teams: ['Arsenal'] },
        { sport: 'American football', leagues: ['NFL'], teams: ['Green Bay Packers'] }] }, 'a one-league sport picks it; "UEFA" is both its leagues (#195)');
    assert.deepEqual((await call('/api/sports/pages/preferences', other)).body, { spoilerFree: false, sports: ['Champions League', 'Europa League', 'EPL', 'NFL'],
        teams: { 'Champions League': ['Arsenal'], 'Europa League': ['Arsenal'], EPL: ['Arsenal'], NFL: ['Green Bay Packers'] },
        following: { F1: null, NFL: 'Green Bay Packers' } });
    // The older apps write through the view: dropping a league keeps the sport's teams while one of its leagues stays.
    const older = await call('/api/sports/pages/preferences', other, { sports: ['EPL', 'NFL', 'NBA'] });
    assert.deepEqual(older.body.teams, { EPL: ['Arsenal'], NFL: ['Green Bay Packers'] });
    assert.deepEqual((await call('/api/sports/follows', other)).body.sports.map(s => [s.sport, s.leagues]),
        [['Football', ['EPL']], ['American football', ['NFL']], ['Basketball', ['NBA']]]);
    const catalog = (await call('/api/sports/catalog', other)).body;
    assert.deepEqual(catalog.sports.find(s => s.sport === 'Football').leagues.slice(0, 2), [{ league: 'EPL', label: 'EPL', heading: 'Domestic leagues' },
        { league: 'Championship', label: 'Championship', heading: 'Domestic leagues' }]);
    // #195: the curated catalogue's headings and labels (PRODUCT.md › Sport › Following).
    const cricket = catalog.sports.find(s => s.sport === 'Cricket').leagues;
    assert.deepEqual(cricket.slice(0, 3), [{ league: 'Cricket', label: 'International (men)', heading: 'International' },
        { league: "Women's Cricket", label: 'International (women)', heading: 'International' }, { league: 'IPL', label: 'IPL', heading: 'Franchise' }]);
    assert.deepEqual(catalog.sports.find(s => s.sport === 'American football').leagues, [{ league: 'NFL', label: 'NFL', heading: null }]);
    assert.equal(catalog.sports.flatMap(s => s.leagues).length, 61, 'every league with a fixture source (#197: tennis, golf, UFC, IndyCar, NASCAR)');
    assert.deepEqual(catalog.sports.find(s => s.sport === 'Netball').leagues.map(l => l.league), ['Super Netball'], '#196');
    assert.ok(load('services/sportsFixtures').neededLeagues().has('NBA'), 'any account\'s leagues are fetched');
});

test('the owner takes over the household\'s follows once; a corrupt stored value reads as the defaults', async () => {
    const d = load('db/sqlite').getDb();
    // neededLeagues() above already read the owner, who then took over an empty household; start the owner afresh.
    d.prepare('DELETE FROM sport_follows WHERE user_id = (SELECT MIN(id) FROM app_users)').run();
    d.prepare("INSERT INTO meta (key, value) VALUES ('sport_page_prefs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify({ spoilerFree: true, sports: ['EPL', 'NFL', 'UEFA', 'VFLW'], teams: { EPL: ['Arsenal'], UEFA: ['Arsenal', 'Celtic'], NFL: ['Green Bay Packers'] } }));
    assert.deepEqual((await call('/api/sports/follows', owner)).body, { spoilerFree: true, sports: [
        { sport: 'Football', leagues: ['EPL', 'Champions League', 'Europa League'], teams: ['Arsenal', 'Celtic'] },
        { sport: 'American football', leagues: ['NFL'], teams: ['Green Bay Packers'] }] }, 'a league the catalogue does not offer is dropped');
    d.prepare("DELETE FROM meta WHERE key = 'sport_page_prefs'").run();
    assert.equal((await call('/api/sports/follows', owner)).body.sports.length, 2, 'taken over once, then the owner\'s own');
    d.prepare('UPDATE sport_follows SET value = \'{not json\' WHERE user_id = (SELECT MIN(id) FROM app_users)').run();
    assert.deepEqual((await call('/api/sports/follows', owner)).body, { spoilerFree: false, sports: [] });
});

// #199 (0418, C-U): the names Settings › Sport can follow in a league: its roster and whoever the collector's cards list.
test('#199: GET /api/sports/names lists a league\'s teams or people for following; a league outside the catalogue is 400', async () => {
    const store = load('services/sportsDashboard').store();
    const snapshot = { state: 'scheduled', progress: {}, scores: null, situation: null };
    const side = (name) => ({ id: name, name, aliases: [name], logo: null });
    const T = Date.now() + 3600000;
    store.ingest([
        { id: 'aflw:1', league: 'AFLW', start: T, end: null, title: 'Carlton v Richmond', session: null, circuit: null, format: null,
            competitors: [side('Richmond'), side('Carlton')], snapshot },
        { id: 'espn:tennis/atp:1', league: 'ATP Tour', start: T, end: T + 86400000, title: 'Paris Masters', session: null, circuit: null, format: null,
            competitors: [], players: ['Jannik Sinner', 'Alex de Minaur', 'TBD'], snapshot }], Date.now());
    assert.deepEqual((await call('/api/sports/names?league=AFLW')).body, { league: 'AFLW', kind: 'team', names: ['Carlton', 'Richmond'] });
    assert.deepEqual((await call('/api/sports/names?league=ATP%20Tour')).body, { league: 'ATP Tour', kind: 'person', names: ['Alex de Minaur', 'Jannik Sinner'] });
    assert.equal((await call('/api/sports/names?league=Quidditch')).status, 400);
    assert.equal((await call('/api/sports/names?league=AFLW', null)).status, 401, 'signed in only');
});

// 0420 (0419 Codex round 1, medium): an empty or failed roster was asked of ESPN again on every request.
test('0420: a league\'s roster is asked once at a time, and an empty answer is not asked again for an hour', async () => {
    const fixtures = load('services/sportsFixtures');
    const real = fixtures.rosterFor;
    let asked = 0;
    fixtures.rosterFor = async () => { asked++; await new Promise(r => setTimeout(r, 50)); return []; };
    try {
        await Promise.all([call('/api/sports/names?league=NBA'), call('/api/sports/names?league=NBA'), call('/api/sports/names?league=NBA')]);
        assert.equal(asked, 1, 'one request for three at once');
        assert.equal((await call('/api/sports/names?league=NBA')).status, 200);
        assert.equal(asked, 1, 'an empty answer is kept a while');
    } finally { fixtures.rosterFor = real; }
});
