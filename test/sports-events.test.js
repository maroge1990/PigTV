const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0148 (contract C-I): sport is recognised per programme - (a) an EPG category in the sport
// vocabulary, (b) a followed keyword in the title or a category, (c) a C-H sport category's
// channel with a live-looking title - minus common non-events unless a keyword matches.
// Programmes with the same normalised title at overlapping times are one event; channels
// are ordered by quality, health, favourite, guide order. GET /api/sports/events (any user),
// GET/PUT /api/sports/follow and GET /api/sports/preview (admin), flag sportsEvents.
// The old code has none of it (no flag, and every route is a 404).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sports-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

let server, base, adminToken, viewerToken, viewer, source;
const H = 60 * 60 * 1000;
const M = 60 * 1000;
const NOW = Date.now();

// [stream id, name, group, tvg-id]
const PLAYLIST = [
    [301, 'Kayo 1', 'Sport', 'k1'],
    [302, 'Kayo 2 HD', 'Sport', 'k2'],
    [303, 'Seven', 'Entertainment', 'seven'],
    [304, 'Fox Sports 505 SD', 'US Sports', 'fs505'],
    [305, 'ESPN', 'US Sports', 'espn'],
    [306, 'ESPN 2 HD', 'US Sports', 'espn2'],
    [307, 'Sky Sports UHD', 'US Sports', 'sky'],
    [308, 'Hidden HD', 'US Sports', 'hidden'],
    [309, 'Secret', 'Adults', 'secret'],
    [301, 'Kayo 1', 'US Sports', 'k1'] // cross-listed: the same channel again
];
function playlist(channels) {
    return '#EXTM3U\n' + channels.map(([id, name, group, tvg]) =>
        `#EXTINF:-1 tvg-id="${tvg}" group-title="${group}",${name}\nhttp://provider.invalid/live/user/pass/${id}.ts`
    ).join('\n') + '\n';
}

// [tvg-id, title, start offset, end offset, categories]
const GUIDE = [
    // game A on three channels, titled three ways, live now
    ['fs505', 'NFL: Chiefs v Bills', -30 * M, 150 * M, ['Sport', 'American Football']],
    ['espn2', 'LIVE: NFL: Chiefs vs Bills (HD)', -30 * M, 150 * M, ['Sport', 'American Football']],
    ['sky', 'NFL Chiefs v Bills [Sky]', -45 * M, 150 * M, ['Sports', 'Football', 'American Football']],
    // a different game at the same time
    ['espn', 'NBA: Lakers v Celtics', -10 * M, 2 * H, ['Basketball']],
    // the same title again later, not overlapping: another event
    ['espn', 'NBA: Lakers v Celtics', 5 * H, 7 * H, ['Basketball']],
    // C-H: a sport category's channel with a live-looking title, no categories at all
    ['k1', 'Liverpool v Arsenal', -20 * M, 90 * M, []],
    ['k1', 'Fishing Show', 90 * M, 150 * M, []],
    ['seven', 'Liverpool v Arsenal', -20 * M, 90 * M, []],
    // non-events
    ['espn', 'NFL Highlights', 2 * H, 3 * H, ['Sport']],
    // 0150: a replay of an identifiable game (listed by default, after the events)
    ['espn2', 'Classic: Chiefs v Bills 2024', 3 * H, 5 * H, ['Sport', 'American Football']],
    ['fs505', 'Sports Tonight', 150 * M, 4 * H, ['Sport', 'News']],
    // ordering: four channels, two HD
    ['k2', 'Rugby: Wallabies v All Blacks', 3 * H, 5 * H, ['Sport', 'Rugby Union']],
    ['espn2', 'Rugby: Wallabies v All Blacks', 3 * H, 5 * H, ['Sport', 'Rugby Union']],
    ['seven', 'Rugby: Wallabies v All Blacks', 3 * H, 5 * H, ['Sport', 'Rugby Union']],
    ['espn', 'Rugby: Wallabies v All Blacks', 3 * H, 5 * H, ['Sport', 'Rugby Union']],
    // a keyword only
    ['seven', 'F1: Monaco Grand Prix', 5.5 * H, 7 * H, []],
    // hidden channel and hidden category
    ['hidden', 'Cricket: The Ashes', -1 * H, 5 * H, ['Cricket']],
    ['secret', 'Cricket: The Ashes', -1 * H, 5 * H, ['Cricket']],
    // for the hours window
    ['sky', 'Golf: The Open', 10 * H, 14 * H, ['Golf']],
    ['sky', 'Tennis: The Final', 30 * H, 33 * H, ['Tennis']]
];

async function call(method, route, { token = adminToken, body } = {}) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* no body */ }
    return { status: response.status, body: json };
}
// Direct database changes below do not move library_rev, so drop the cached list first.
const events = async (query = '', token = adminToken) => {
    load('services/sportsEvents').reset();
    const r = await call('GET', `/api/sports/events${query}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
};
const titles = (body) => body.events.map(e => e.title);
// 0150: an event's title is its cleanest form ("Chiefs v Bills"); the raw titles are its aliases.
const find = (body, prefix) => body.events.filter(e => [e.title, ...(e.aliases || [])].some(t => t.startsWith(prefix)));
const follow = (keywords) => call('PUT', '/api/sports/follow', { body: { keywords } });

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken(admin);
    viewer = await db.users.create({ username: 'viewer', role: 'viewer' });
    viewerToken = auth.generateToken(viewer);
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(playlist(PLAYLIST));
    try { await sync.syncSource(source.id); } finally { global.fetch = originalFetch; }

    const d = sqlite.getDb();
    const ins = d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories) VALUES (?, 99, ?, ?, ?, ?)');
    for (const [tvg, title, s, e, cats] of GUIDE) ins.run(tvg, NOW + s, NOW + e, title, cats.length ? JSON.stringify(cats) : null);
    d.prepare(`UPDATE playlist_items SET is_hidden = 1 WHERE name = 'Hidden HD'`).run();
    d.prepare(`UPDATE categories SET is_hidden = 1 WHERE name = 'Adults'`).run();
    load('services/sportCategories').setSport(source.id, 'Sport', true);
    // 0152: these tests use the wall clock, so the leagues' live hours (an NBA game "now" is a
    // replay when now is 7 am in New York) are switched off here; test/sports-live.test.js has them.
    const { LIVE_HOURS } = load('services/sportsClassify');
    for (const league of Object.keys(LIVE_HOURS)) delete LIVE_HOURS[league];

    const app = express();
    app.use(express.json());
    app.use('/api/info', load('routes/info'));
    app.use('/api/sports', load('routes/sports'));
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

test('/api/info advertises sportsEvents', async () => {
    assert.equal((await call('GET', '/api/info')).body.features.sportsEvents, true);
});

test('the same game on three channels is one event; a different game at the same time is another', async () => {
    const body = await events();
    assert.ok(Math.abs(body.now - Date.now()) < 5000);
    const nfl = find(body, 'NFL');
    assert.equal(nfl.length, 1, JSON.stringify(titles(body)));
    assert.deepEqual(nfl[0].channels.map(c => c.name).sort(), ['ESPN 2 HD', 'Fox Sports 505 SD', 'Sky Sports UHD']);
    assert.equal(nfl[0].title, 'Chiefs v Bills', 'the cleanest form names it (0150)');
    assert.deepEqual([...nfl[0].aliases].sort(), ['LIVE: NFL: Chiefs vs Bills (HD)', 'NFL Chiefs v Bills [Sky]', 'NFL: Chiefs v Bills']);
    assert.equal(nfl[0].kind, 'event');
    assert.equal(nfl[0].start, NOW - 45 * M);
    assert.equal(nfl[0].end, NOW + 150 * M);
    assert.equal(nfl[0].live, true);
    assert.equal(nfl[0].league, 'American Football', 'the most specific category');
    assert.match(nfl[0].id, /^[0-9a-f]{16}$/);
    const nba = find(body, 'NBA');
    assert.equal(nba.length, 2, 'the later, non-overlapping airing is its own item');
    assert.deepEqual(nba.map(e => e.live), [true, false]);
    assert.deepEqual(nba.map(e => e.kind), ['event', 'replay'], '0152: the same game 5 h later is a replay of the first airing');
});

test('(a) an EPG category in the sport vocabulary makes a programme sport', async () => {
    const body = await events('?hours=24');
    assert.equal(find(body, 'Rugby').length, 1);
    assert.equal(find(body, 'Rugby')[0].league, 'Rugby Union');
    assert.equal(find(body, 'Golf')[0].league, 'Golf');
});

test('(c) a C-H sport category channel with a live-looking title is sport; the same title elsewhere is not', async () => {
    const body = await events();
    const game = find(body, 'Liverpool');
    assert.equal(game.length, 1);
    assert.deepEqual(game[0].channels.map(c => c.name), ['Kayo 1'], 'once, though cross-listed; not Seven (not a sport category)');
    assert.equal(game[0].league, 'Sport');
    assert.equal(find(body, 'Fishing').length, 0, 'a sport channel\'s programme that does not read like an event');
});

test('non-events are excluded; hidden channels and categories never count', async () => {
    const body = await events('?hours=24');
    assert.equal(find(body, 'NFL Highlights').length, 0);
    assert.equal(find(body, 'Sports Tonight').length, 0, 'a News category');
    assert.equal(find(body, 'Cricket').length, 0);
    assert.equal(find(body, 'F1').length, 0, 'no category and not followed yet');
});

test('(b) a followed keyword makes a programme sport and names the league; highlights stay a show', async () => {
    assert.equal((await follow(['F1', 'NFL'])).status, 200);
    try {
        const body = await events('?hours=24');
        assert.equal(find(body, 'F1')[0].league, 'F1');
        assert.equal(find(body, 'F1')[0].title, 'Monaco Grand Prix');
        assert.equal(find(body, 'NFL Highlights').length, 0, 'NFL is followed, but highlights are a show (0150)');
        const all = await events('?hours=24&include=all');
        assert.deepEqual(find(all, 'NFL Highlights').map(e => [e.kind, e.league]), [['show', 'NFL']]);
        assert.equal(find(body, 'NFL Chiefs')[0].league, 'NFL', 'the keyword beats the category');
    } finally {
        await follow([]);
    }
    assert.equal(find(await events('?hours=24'), 'F1').length, 0, 'unfollowed again');
});

test('channels are ordered by quality, then health ok, then favourite, then guide order', async () => {
    const body = await events();
    assert.deepEqual(find(body, 'NFL')[0].channels.map(c => c.quality), ['UHD', 'HD', 'SD']);
    const nflSky = find(body, 'NFL')[0].channels[0];
    assert.deepEqual(Object.keys(nflSky).sort(), ['id', 'logo', 'name', 'number', 'quality', 'sourceId', 'stableId']);
    assert.equal(nflSky.sourceId, source.id);
    assert.equal(typeof nflSky.number, 'number');

    const rugby = async (token) => find(await events('?hours=24', token), 'Rugby')[0].channels.map(c => c.name);
    // Guide order alone: Kayo 2 HD before ESPN 2 HD, Seven before ESPN.
    assert.deepEqual(await rugby(), ['Kayo 2 HD', 'ESPN 2 HD', 'Seven', 'ESPN']);

    // A good start on ESPN 2 HD puts it ahead of the other HD channel.
    const d = sqlite.getDb();
    const espn2 = d.prepare(`SELECT stable_id FROM playlist_items WHERE name = 'ESPN 2 HD'`).get().stable_id;
    d.prepare('INSERT INTO channel_health (source_id, channel_key, name, at, ok) VALUES (?, ?, ?, ?, 1)').run(source.id, espn2, 'ESPN 2 HD', Date.now());
    load('services/channelHealth').reset();
    assert.deepEqual(await rugby(), ['ESPN 2 HD', 'Kayo 2 HD', 'Seven', 'ESPN']);

    // The viewer's favourite ESPN goes ahead of Seven for the viewer only.
    const espn = d.prepare(`SELECT item_id, stable_id FROM playlist_items WHERE name = 'ESPN'`).get();
    d.prepare(`INSERT INTO favorites (user_id, source_id, item_id, item_type, stable_id) VALUES (?, ?, ?, 'channel', ?)`)
        .run(String(viewer.id), source.id, espn.item_id, espn.stable_id);
    assert.deepEqual(await rugby(viewerToken), ['ESPN 2 HD', 'Kayo 2 HD', 'ESPN', 'Seven']);
    assert.deepEqual(await rugby(), ['ESPN 2 HD', 'Kayo 2 HD', 'Seven', 'ESPN']);
});

test('events are live first, then upcoming, each by start; then replays', async () => {
    const body = await events('?hours=24');
    const kinds = body.events.map(e => e.kind);
    assert.deepEqual([...new Set(kinds)], ['event', 'replay'], 'events, then replays (0150)');
    const list = body.events.filter(e => e.kind === 'event');
    const live = list.filter(e => e.live);
    assert.ok(live.length >= 3);
    assert.ok(list.slice(0, live.length).every(e => e.live), 'live ones first');
    for (let i = 1; i < list.length; i++) {
        const [a, b] = [list[i - 1], list[i]];
        if (a.live === b.live) assert.ok(a.start <= b.start, `${a.title} before ${b.title}`);
    }
});

test('0150: replays are listed by default with kind "replay"; shows and placeholders only with include=all', async () => {
    const body = await events('?hours=24');
    const replay = find(body, 'Classic: Chiefs');
    assert.deepEqual(replay.map(e => [e.kind, e.title]), [['replay', 'Chiefs v Bills']], 'not merged into the live game');
    assert.equal(find(body, 'NFL: Chiefs')[0].kind, 'event');
    assert.ok(body.events.every(e => e.kind === 'event' || e.kind === 'replay'));
    assert.equal(find(body, 'NFL Highlights').length, 0);
    assert.equal(find(body, 'Sports Tonight').length, 0);

    const all = await events('?hours=24&include=all');
    assert.deepEqual(find(all, 'NFL Highlights').map(e => e.kind), ['show']);
    assert.deepEqual(find(all, 'Sports Tonight').map(e => e.kind), ['show']);
    assert.ok(all.events.length > body.events.length);
    const order = { event: 0, replay: 1, show: 2, placeholder: 3 };
    assert.ok(all.events.every((e, i) => i === 0 || order[all.events[i - 1].kind] <= order[e.kind]), 'grouped by kind');
    assert.ok(!('kindRule' in all.events[0]), 'the rule is for the admin preview');
});

test('hours defaults to 6 and is clamped to 1-24', async () => {
    assert.equal(find(await events(), 'Golf').length, 0, 'starts in 10 h');
    assert.equal(find(await events('?hours=12'), 'Golf').length, 1);
    const all = await events('?hours=99');
    assert.equal(find(all, 'Golf').length, 1, '99 is 24');
    assert.equal(find(all, 'Tennis').length, 0, '30 h away is beyond 24');
    const one = await events('?hours=0');
    assert.equal(find(one, 'Rugby').length, 0, '0 is 1 hour: the rugby starts in 3');
    assert.ok(one.events.length >= 3 && one.events.every(e => e.live || e.start < Date.now() + H));
    assert.equal(find(await events('?hours=abc'), 'NBA').length, 2, 'not a number: the default 6 (the second NBA starts in 5 h)');
});

test('the follow list: admin only, trimmed and de-duplicated, at most 100', async () => {
    const saved = await follow([' NFL ', 'nfl', 'Chiefs', '', '  AFL  ']);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { keywords: ['NFL', 'Chiefs', 'AFL'] });
    assert.deepEqual((await call('GET', '/api/sports/follow')).body, { keywords: ['NFL', 'Chiefs', 'AFL'] });
    assert.equal((await call('PUT', '/api/sports/follow', { body: { keywords: 'NFL' } })).status, 400);
    assert.equal((await call('PUT', '/api/sports/follow', { body: { keywords: [3] } })).status, 400);
    assert.equal((await follow(Array.from({ length: 101 }, (_, i) => `k${i}`))).status, 400);
    assert.equal((await follow(Array.from({ length: 100 }, (_, i) => `k${i}`))).status, 200);
    assert.equal((await call('GET', '/api/sports/follow', { token: viewerToken })).status, 403);
    assert.equal((await call('PUT', '/api/sports/follow', { token: viewerToken, body: { keywords: [] } })).status, 403);
    await follow([]);
    assert.deepEqual((await call('GET', '/api/sports/follow')).body, { keywords: [] });
});

test('the preview is admin only and says which rule matched', async () => {
    await follow(['F1']);
    try {
        const { status, body } = await call('GET', '/api/sports/preview');
        assert.equal(status, 200);
        const rule = (prefix) => { const e = find(body, prefix)[0]; return e && [e.rule, e.match]; };
        assert.deepEqual(rule('F1'), ['keyword', 'F1']);
        assert.deepEqual(rule('Rugby'), ['category', 'Sport']);
        assert.deepEqual(rule('Liverpool'), ['sportChannel', 'Sport category + live title']);
        assert.equal(find(body, 'Golf').length, 1, 'the next 24 hours');
        // 0150: every kind, with why
        assert.equal(find(body, 'F1')[0].kindRule, 'event: a session (Race)');
        assert.deepEqual(find(body, 'NFL Highlights').map(e => [e.kind, e.kindRule]), [['show', 'show: highlights ("highlights")']]);
        assert.equal(find(body, 'Classic: Chiefs')[0].kindRule, 'replay: a game with "classic"');
    } finally {
        await follow([]);
    }
    assert.equal((await call('GET', '/api/sports/preview', { token: viewerToken })).status, 403);
});

test('events are for any signed-in user or device, not anonymous callers', async () => {
    assert.equal((await call('GET', '/api/sports/events', { token: viewerToken })).status, 200);
    assert.equal((await call('GET', '/api/sports/events', { token: null })).status, 401);
});

test('the list is built once per minute and guide version, not per request', async () => {
    const svc = load('services/sportsEvents');
    svc.reset();
    await call('GET', '/api/sports/events');
    const builds = svc.stats.builds;
    await call('GET', '/api/sports/events?hours=24');
    await call('GET', '/api/sports/events', { token: viewerToken });
    assert.equal(svc.stats.builds, builds, 'served from the cache');
    await follow(['Chiefs']);
    await call('GET', '/api/sports/events');
    assert.equal(svc.stats.builds, builds + 1, 'a new follow list rebuilds it');
    await follow([]);
});

test('normalisation: case, live, channel tags, quality markers, punctuation and vs', () => {
    const { normaliseTitle } = load('services/sportsEvents');
    assert.equal(normaliseTitle('LIVE: NFL: Chiefs vs. Bills (HD)'), 'nfl chiefs v bills');
    assert.equal(normaliseTitle('NFL - Chiefs v Bills [Kayo] 4K'), 'nfl chiefs v bills');
    assert.equal(normaliseTitle('ESPN: NFL Chiefs v Bills (Live)', 'ESPN HD'), 'nfl chiefs v bills', 'the channel\'s own name');
    assert.equal(normaliseTitle('Liverpool UHD'), 'liverpool');
    assert.equal(normaliseTitle('Deliverance'), 'deliverance', 'only whole words');
});

test('quality comes from the channel name', () => {
    const { qualityFromName } = load('services/sportsEvents');
    assert.deepEqual(['Sky Sports UHD', 'ESPN 4K', 'Fox 505 FHD', 'Kayo HD', 'ESPN SD', 'ESPN', 'HDTV'].map(qualityFromName),
        ['UHD', 'UHD', 'HD', 'HD', 'SD', null, null]);
});

// C-I asks for a request under ~100 ms warm on 1,000 channels x 30 programmes. Measured, and
// printed; the bounds asserted here are loose because CI runs every file at once on 2 vCPUs.
test('1,000 channels x 30 programmes: built once, then served from the cache', async () => {
    const d = sqlite.getDb();
    const svc = load('services/sportsEvents');
    const insItem = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, tvg_id, is_hidden)
                               VALUES (?, 500, ?, 'live', ?, 'Bulk', ?, ?, ?, 0)`);
    const insProg = d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories) VALUES (?, 500, ?, ?, ?, ?)');
    const cats = ['["Sport","Football"]', '["Movie"]', '["News"]', '["Sport","Tennis"]', null];
    d.transaction(() => {
        for (let c = 0; c < 1000; c++) {
            insItem.run(`500:b${c}`, `b${c}`, `Bulk ${c}${c % 3 === 0 ? ' HD' : ''}`, c, `sb${c}`, `bulk${c}`);
            for (let p = 0; p < 30; p++) {
                const start = NOW - 2 * H + p * H;
                insProg.run(`bulk${c}`, start, start + H, `Programme ${(c * 7 + p) % 400} v Team ${p % 11}`, cats[(c + p) % cats.length]);
            }
        }
    })();
    try {
        svc.reset();
        const t0 = performance.now();
        const cold = await call('GET', '/api/sports/events?hours=24');
        const coldMs = performance.now() - t0;
        const builds = svc.stats.builds;
        const warm = [];
        for (let i = 0; i < 5; i++) {
            const t = performance.now();
            await call('GET', '/api/sports/events?hours=24');
            warm.push(performance.now() - t);
        }
        warm.sort((a, b) => a - b);
        console.log(`# sports events, 1,000 channels x 30 programmes: ${cold.body.events.length} events; cold ${coldMs.toFixed(0)} ms (build ${svc.stats.lastBuildMs.toFixed(0)} ms), warm median ${warm[2].toFixed(1)} ms`);
        assert.equal(svc.stats.builds, builds, 'warm requests do not rebuild');
        assert.ok(cold.body.events.length > 100);
        assert.ok(warm[2] < 1000, `warm median ${warm[2]} ms`);
    } finally {
        d.prepare('DELETE FROM playlist_items WHERE source_id = 500').run();
        d.prepare('DELETE FROM epg_programs WHERE source_id = 500').run();
        svc.reset();
    }
});
