const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #57 (C-Y): GET /api/library/search?q=&limit= answers channels, programmes (on now or later, soonest first, from an FTS5
// index over the active guide generation, rebuilt at the guide swap), sport events, teams and recordings. Before #57
// there was no such route (the generic 404), and /api/library/channels?search= took % and _ as wildcards.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-search-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
load('services/sportsEvents')._buildInline(true); // this thread's LIVE_HOURS change (below) must apply to the build
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

const H = 3600000;
const M = 60000;
const NOW = Date.now();
let server, base, token, viewerToken, owner;

const PLAYLIST = '#EXTM3U\n' + [
    ['ent', 'Entertainment', 'Entertainment One', 1],
    ['dc', 'Entertainment', 'Drama Channel SD', 2],
    ['dc', 'Entertainment', 'Drama Channel HD', 3],
    ['espn', 'US Sports', 'ESPN', 4],
    ['hid', 'Entertainment', 'Hidden HD', 5],
    ['pct', 'Music', '100% Hits', 6],
    ['ent', 'Music', 'Entertainment One', 1] // cross-listed: the same channel again
].map(([tvg, group, name, id]) => `#EXTINF:-1 tvg-id="${tvg}" group-title="${group}",${name}\nhttp://provider.invalid/live/u/p/${id}.ts`).join('\n') + '\n';

const call = async (route, t = token) => {
    const r = await fetch(`${base}${route}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const search = async (q, extra = '') => {
    const r = await call(`/api/library/search?q=${encodeURIComponent(q)}${extra}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
};
const ins = () => sqlite.getDb().prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories, flags, data, gen)
    VALUES (?, 99, ?, ?, ?, ?, ?, ?, ?)`);

before(async () => {
    owner = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken(owner);
    const viewer = await db.users.create({ username: 'viewer', role: 'viewer' });
    viewerToken = auth.generateToken(viewer);
    const source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(PLAYLIST);
    try { await sync.syncSource(source.id); } finally { global.fetch = originalFetch; }
    const d = sqlite.getDb();
    d.prepare(`UPDATE playlist_items SET is_hidden = 1 WHERE name = 'Hidden HD'`).run();

    const add = ins();
    const data = (o) => JSON.stringify(o);
    add.run('ent', NOW - 3 * H, NOW - 2 * H, 'Doctor Who', null, null, null, 0);
    add.run('ent', NOW - 10 * M, NOW + 20 * M, 'Doctor Who', null, 4, data({ sub: 'The Star Beast', ep: '1.4.0/1', img: 'https://images.provider.invalid/dw.jpg?token=secret' }), 0);
    add.run('ent', NOW + 5 * H, NOW + 6 * H, 'Doctor Who', null, 1, data({ sub: 'Wild Blue Yonder', ep: 'S2E6' }), 0);
    add.run('ent', NOW + 2 * H, NOW + 3 * H, 'Doctors', null, null, null, 0);
    add.run('ent', NOW + 4 * H, NOW + 5 * H, 'Who Do You Think You Are?', null, null, null, 0);
    add.run('ent', NOW + 7 * H, NOW + 8 * H, 'Gardening', null, null, data({ sub: 'Doctor of the Roses' }), 0);
    add.run('dc', NOW + 1 * H, NOW + 2 * H, 'Doctor Foster', null, null, null, 0);
    add.run('hid', NOW + 1 * H, NOW + 2 * H, 'Doctor Who: Hidden', null, null, null, 0);
    add.run('espn', NOW - 10 * M, NOW + 2 * H, 'NBA: Lakers v Celtics', JSON.stringify(['Basketball']), null, null, 0);
    add.run('pct', NOW + 1 * H, NOW + 2 * H, 'Top 100% Hits', null, null, null, 0);
    add.run('pct', NOW + 3 * H, NOW + 4 * H, '?! Quiz', null, null, null, 0);
    const { LIVE_HOURS } = load('services/sportsClassify');
    for (const league of Object.keys(LIVE_HOURS)) delete LIVE_HOURS[league];

    d.prepare(`INSERT INTO sport_fixture_teams (league, data, updated_at) VALUES ('NBA', ?, ?)`).run(JSON.stringify([
        { id: '13', displayName: 'Los Angeles Lakers', shortDisplayName: 'Lakers', name: 'Lakers', logo: 'https://a.espncdn.com/i/teamlogos/nba/500/lal.png' },
        { id: '2', displayName: 'Boston Celtics', shortDisplayName: 'Celtics', name: 'Celtics', logo: 'https://a.espncdn.com/i/teamlogos/nba/500/bos.png' },
        { id: '5', displayName: 'Cleveland Cavaliers', shortDisplayName: 'Cavaliers', name: 'Cavaliers' },
        { id: '9', displayName: 'Adelaide 36ers', shortDisplayName: '36ers', name: '36ers' }
    ]), NOW);
    load('services/sportPagePrefs').setFollows(owner.id, { sports: [{ sport: 'Basketball', leagues: ['NBA'], teams: ['Boston Celtics'] }] });

    const recDb = load('db/recordingsDb');
    recDb.initSchema();
    const rec = d.prepare(`INSERT INTO recordings (title, channel_name, source_id, channel_item_id, file_path, started_at, status) VALUES (?, 'Entertainment One', ?, '1', ?, ?, ?)`);
    rec.run('Doctor Who', source.id, '/rec/a.ts', NOW - 30 * H, 'completed');
    rec.run('Doctor Who', source.id, '/rec/b.ts', NOW - 5 * M, 'recording');
    rec.run('Doctor Who', source.id, '/rec/c.ts', NOW - 50 * H, 'failed');
    rec.run('Gardening', source.id, '/rec/d.ts', NOW - 60 * H, 'completed');

    const app = express();
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/library', load('routes/library'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    try { load('services/sportsEvents').shutdown(); } catch { /* never loaded */ }
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('#57: a token is required; q is trimmed and must be 2-100 characters', async () => {
    assert.equal((await call('/api/library/search?q=doctor', null)).status, 401);
    for (const q of ['', 'd', '  d  ', 'x'.repeat(101)]) {
        const r = await call(`/api/library/search?q=${encodeURIComponent(q)}`);
        assert.equal(r.status, 400, `q=${JSON.stringify(q)}`);
        assert.equal(typeof r.body.error, 'string');
    }
    assert.equal((await call('/api/library/search')).status, 400);
    assert.equal((await call(`/api/library/search?q=${'x'.repeat(100)}`)).status, 200);
    assert.equal((await call('/api/library/search?q=doctor', viewerToken)).status, 200, 'any signed-in user');
    assert.equal((await search('  doctor  ')).q, 'doctor');
});

test('#57: programmes on now or later, soonest first, by title or subtitle word prefixes, on a visible channel', async () => {
    const body = await search('doc');
    assert.deepEqual(Object.keys(body), ['q', 'channels', 'programmes', 'events', 'teams', 'recordings']);
    assert.deepEqual(body.programmes.map(p => [p.title, p.channel.name]), [
        ['Doctor Who', 'Entertainment One'], // on now
        ['Doctor Foster', 'Drama Channel HD'], // the HD copy of the two that share the guide id
        ['Doctors', 'Entertainment One'],
        ['Doctor Who', 'Entertainment One'],
        ['Gardening', 'Entertainment One'] // its subtitle
    ], 'the ended airing and the hidden channel\'s are left out');
    const [now, , , later] = body.programmes;
    assert.equal(now.start, NOW - 10 * M);
    assert.equal(now.end, NOW + 20 * M);
    assert.equal(now.subtitle, 'The Star Beast');
    assert.equal(now.episode, 'S2 E5');
    assert.equal(now.new, true);
    assert.match(now.image, /^\/api\/logo\/[0-9a-f]{32}$/);
    assert.equal(later.new, false);
    assert.equal(later.episode, 'S2 E6');
    assert.ok(!('image' in later) && !('live' in later));
    assert.deepEqual((await search('doctor who')).programmes.map(p => p.start), [NOW - 10 * M, NOW + 5 * H], 'every word required');
    assert.deepEqual((await search('doc', '&limit=2')).programmes.length, 2);
    assert.deepEqual((await search('DÓCTOR wh')).programmes.length, 2, 'case and accents aside');
    const ch = now.channel;
    for (const key of ['id', 'sourceId', 'name', 'logo', 'category', 'tvgId', 'stableId', 'number', 'quality']) assert.ok(key in ch, key);
    assert.ok(!('programmes' in ch));
});

test('#57: a live game\'s airing is live; events, teams (followed first) and recordings match by title', async () => {
    const body = await search('lakers');
    assert.deepEqual(body.programmes.map(p => [p.title, p.live]), [['NBA: Lakers v Celtics', true]]);
    assert.deepEqual(body.events.map(e => e.title), ['Lakers v Celtics']);
    const ev = body.events[0];
    for (const key of ['id', 'kind', 'title', 'aliases', 'league', 'start', 'end', 'live', 'channels']) assert.ok(key in ev, key);
    assert.equal(ev.channels[0].name, 'ESPN');
    assert.deepEqual(body.teams, [{ id: '13', name: 'Los Angeles Lakers', league: 'NBA', followed: false, logo: body.teams[0].logo }]);
    assert.match(body.teams[0].logo, /^\/api\/logo\/[0-9a-f]{32}$/);
    const both = await search('celtics');
    assert.deepEqual(both.teams.map(t => [t.name, t.followed]), [['Boston Celtics', true]]);
    assert.deepEqual((await search('el')).teams.map(t => t.name), ['Boston Celtics', 'Adelaide 36ers', 'Cleveland Cavaliers', 'Los Angeles Lakers'], 'followed first, then by name');
    assert.deepEqual((await search('cavaliers')).teams, [{ id: '5', name: 'Cleveland Cavaliers', league: 'NBA', followed: false }], 'no logo: no key');

    const rec = await search('doctor who');
    assert.deepEqual(rec.recordings.map(r => r.status).sort(), ['completed', 'recording'], 'failed is left out');
    for (const key of ['id', 'title', 'status', 'image', 'watch_live', 'position_sec', 'watched']) assert.ok(key in rec.recordings[0], key);
    assert.deepEqual((await search('garden')).recordings.map(r => r.title), ['Gardening']);
});

test('#57: channels by name in guide order, once each; % and _ are literal', async () => {
    assert.deepEqual((await search('drama')).channels.map(c => c.name), ['Drama Channel SD', 'Drama Channel HD']);
    assert.deepEqual((await search('entertainment')).channels.map(c => c.name), ['Entertainment One'], 'cross-listed: once');
    assert.deepEqual((await search('hidden')).channels, []);
    assert.deepEqual((await search('100%')).channels.map(c => c.name), ['100% Hits']);
    const pct = await search('%%');
    assert.deepEqual([pct.channels, pct.programmes], [[], []], 'no wildcard: nothing has %%');
    assert.deepEqual((await search('__')).programmes, []);
    assert.deepEqual((await search('?!')).programmes.map(p => p.title), ['?! Quiz'], 'no word in q: a LIKE on the title');
    const r = await call('/api/library/channels?search=%25');
    assert.deepEqual(r.body.channels.map(c => c.name), ['100% Hits'], '/channels: % is itself');
    assert.deepEqual((await call('/api/library/channels?search=_')).body.channels, []);
});

test('#57: no provider address in any image or logo', async () => {
    for (const q of ['doctor', 'lakers', 'celtics']) {
        const raw = JSON.stringify(await search(q));
        assert.doesNotMatch(raw, /https?:\/\//, q);
        assert.doesNotMatch(raw, /secret/, q);
    }
});

test('#57: the index is built on the first search, and rebuilt when a guide swap lands', async () => {
    const ps = load('services/programmeSearch');
    assert.ok(ps.isCurrent(), 'built by the searches above');
    const builds = ps.stats.builds;
    await search('doctor');
    assert.equal(ps.stats.builds, builds, 'a current index is not rebuilt');

    // A sync of source 99 writes generation 1 and swaps it in; the index follows it.
    const epgParser = load('services/epgParser');
    const feedCheck = load('services/feedCheck');
    feedCheck.fetchFeed = async () => ({ unchanged: false, file: null, contentType: '', commit() {}, discard() {} });
    epgParser.parseFileStreaming = async function* () {
        yield { channels: [], programmes: [
            { channelId: 'ent', start: new Date(NOW + 3 * H), stop: new Date(NOW + 4 * H), title: 'Zebra Crossing', subtitle: 'Stripes' },
            { channelId: 'ent', start: new Date(NOW - 10 * M), stop: new Date(NOW + 20 * M), title: 'Doctor Who' }
        ] };
    };
    await sync.syncEpgFromUrl(99, 'http://guide.invalid/x.xml', { acceptSmaller: true });
    await ps._building();
    assert.ok(ps.isCurrent(), 'rebuilt at the swap');
    assert.ok(ps.stats.builds > builds);
    assert.deepEqual((await search('zebra')).programmes.map(p => p.title), ['Zebra Crossing']);
    assert.deepEqual((await search('stripes')).programmes.map(p => p.title), ['Zebra Crossing'], 'subtitle');
    assert.deepEqual((await search('doctor')).programmes.map(p => p.title), ['Doctor Who'], 'the old generation is gone');

    // Missing (a restart before any search): built on the first search.
    sqlite.getDb().exec('DROP TABLE epg_search');
    assert.equal(ps.isCurrent(), false);
    assert.deepEqual((await search('zebra')).programmes.length, 1);
    assert.ok(ps.isCurrent());
});
