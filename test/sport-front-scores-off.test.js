const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const express = require('express');

// 0503 (D-54): with the score collector off (PIGTV_SPORTS_DASHBOARD=0, or ESPN fixtures off with PIGTV_SPORT_FIXTURES=0)
// GET /api/sports/front still answers, in its usual shape, with the account's follows and leagues and no game cards: it
// never reads the collector's (possibly frozen) catalogue and never makes an outbound request. /api/info's
// features.sportFront still reports whether scores are collected.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sport-front-off-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.JWT_SECRET = 'test-only-sport-front-off-key-at-least-32-chars';
process.env.PIGTV_DB_BACKUPS = '0';
delete process.env.PIGTV_SPORTS_DASHBOARD;
delete process.env.PIGTV_SPORT_FIXTURES;
const H = 3600000;
const auth = load('auth'), db = load('db'), dashboard = load('services/sportsDashboard');
let server, base, token;
const outbound = [], realFetch = globalThis.fetch;

before(async () => {
    // Every request that leaves this machine is recorded and refused (ESPN's scores and fixtures go through fetch).
    globalThis.fetch = async (url, opts) => {
        const u = new URL(String(url instanceof Request ? url.url : url));
        if (u.hostname !== '127.0.0.1') { outbound.push(u.href); throw new Error('no network in this test'); }
        return realFetch(url, opts);
    };
    token = auth.generateToken(await db.users.create({ username: 'owner', role: 'admin' }));
    load('services/sportsEvents').eventsResponse = async () => ({ body: Buffer.from(JSON.stringify({ events: [] })) });
    load('db/recordingsDb').initSchema();
    const app = express(); app.use(express.json());
    app.use('/api/info', load('routes/info'));
    app.use('/api/sports', load('routes/sports'));
    server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', err => err ? reject(err) : resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    globalThis.fetch = realFetch;
    dashboard.stop();
    load('services/sportsEvents').shutdown();
    if (server?.listening) await new Promise(r => server.close(r));
    load('db/sqlite').getDb().close();
    fs.rmSync(sandbox, { recursive: true, force: true });
    delete process.env.PIGTV_SPORTS_DASHBOARD;
    delete process.env.PIGTV_SPORT_FIXTURES;
});
async function call(url, body) {
    const r = await fetch(base + url, { method: body ? 'PUT' : 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
}
const ID = 'espn:football/nfl:900';
const KEYS = ['now', 'timezone', 'spoilerFree', 'scores', 'sports', 'follows', 'hero', 'rails', 'games'];

async function scoresOffFront(label) {
    dashboard.start(); // as the server's start-up does: with the collector off it must start nothing
    const r = await call('/api/sports/front');
    assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
    const f = r.body;
    assert.deepEqual(Object.keys(f).sort(), [...KEYS].sort(), `${label}: the usual shape`);
    assert.equal(f.scores, 'unavailable');
    assert.deepEqual(f.games, [], `${label}: no card, so the frozen catalogue's final (and its score) is not served`);
    assert.deepEqual(f.rails, []);
    assert.deepEqual(f.hero, { reason: 'none', followIndex: null, gameId: null });
    assert.deepEqual(f.sports.map(s => [s.league, s.live, s.next, s.line]), [['NFL', 0, null, 'quiet']]);
    assert.equal(typeof f.sports[0].sport, 'string');
    assert.deepEqual(f.follows.map(x => [x.league, x.name, x.state, x.gameId, x.start]), [['NFL', 'Green Bay Packers', 'none', null, null]]);
    assert.ok(!JSON.stringify(f).includes('"scores":['), `${label}: no score anywhere`);
    assert.equal((await call('/api/info')).body.features.sportFront, false, `${label}: features.sportFront still reports scores off`);
    assert.equal(dashboard.cadence().why, 'off');
    assert.deepEqual(outbound, [], `${label}: no outbound request`);
}

test('front with scores off: 200, follows and leagues, no cards, no frozen score, no network; collector on is unchanged', async () => {
    // What a household that had the collector on before has: a followed team and a final with its score from today.
    assert.equal((await call('/api/sports/pages/preferences', { sports: ['NFL'], teams: { NFL: ['Green Bay Packers'] } })).status, 200);
    const now = Date.now();
    const final = { id: ID, league: 'NFL', title: 'Packers v Lions', start: now - 4 * H, end: null, session: null, circuit: null,
        competitors: [{ id: '9', name: 'Packers', aliases: ['Green Bay Packers', 'Packers'], logo: null }, { id: '8', name: 'Lions', aliases: ['Lions'], logo: null }] };
    dashboard.store().ingest([{ ...final, snapshot: { state: 'live', progress: {}, scores: ['7', '3'], situation: null } }], now - 3 * H);
    dashboard.store().ingest([{ ...final, snapshot: { state: 'finished', progress: {}, scores: ['24', '17'], situation: null } }], now - H);

    // Collector on: unchanged (the stored final is a card with its result).
    const on = await call('/api/sports/front');
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.games.find(g => g.id === ID)?.scores, ['24', '17']);
    assert.equal((await call('/api/info')).body.features.sportFront, true);

    process.env.PIGTV_SPORTS_DASHBOARD = '0'; // (a) scores off, fixtures on
    await scoresOffFront('scores off');
    // Follow settings still save with scores off.
    assert.equal((await call('/api/sports/pages/preferences', { sports: ['NFL'], teams: { NFL: ['Green Bay Packers'] } })).status, 200);
    assert.equal((await call('/api/sports/follows')).status, 200);

    delete process.env.PIGTV_SPORTS_DASHBOARD;
    process.env.PIGTV_SPORT_FIXTURES = '0'; // (b) ESPN fixtures off
    await scoresOffFront('fixtures off');
    delete process.env.PIGTV_SPORT_FIXTURES;
});
