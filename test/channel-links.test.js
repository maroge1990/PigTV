const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0171 (multi-provider P3): the channel linker. The primary is the real Strong8K EPGenius list
// (30 Sept), synced as an M3U; the backups are the real Dream4K EPGenius list and Trex's raw Xtream
// list with its EPGenius overlay. The old code had no channelLinks.js, no channel_links table
// and no /api/links: every test here fails against it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-channel-links-'));
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
const backupChannels = load('services/backupChannels');
const links = load('services/channelLinks');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/providers', name), 'utf8'));
const STRONG8K = fixture('strong8k-epgenius.json');
const DREAM4K = fixture('dream4k-epgenius.json');
const TREX_EPG = fixture('trex-epgenius.json');
const TREX_RAW = fixture('trex-xtream-raw.json');

// The same rows the linker is given, without a database: for the pure fixture tests.
const TREX_CATS = new Map(TREX_RAW.categories.map(c => [String(c.category_id), c.category_name]));
const TREX_OVERLAY = new Map(TREX_EPG.map(e => [String(e.streamId), e.tvgId]));
const rowsOf = {
    dream4k: () => DREAM4K.map(e => ({ streamId: e.streamId, name: e.name, group: e.group, tvgId: e.tvgId })),
    trexRaw: () => TREX_RAW.streams.map(s => ({ streamId: String(s.stream_id), name: s.name, group: TREX_CATS.get(String(s.category_id)),
        tvgId: s.epg_channel_id, overlayTvgId: TREX_OVERLAY.get(String(s.stream_id)) || null }))
};
const strong = streamId => {
    const e = STRONG8K.find(x => x.streamId === String(streamId));
    return links.describe({ name: e.name, group: e.group, tvgId: e.tvgId });
};

let server, base, adminToken, viewerToken, primary, trex, dream;

async function call(method, route, { token = adminToken, body } = {}) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* no body */ }
    return { status: response.status, body: json, text };
}

const quiet = async fn => {
    const saved = [console.log, console.warn];
    console.log = console.warn = () => {};
    try { return await fn(); } finally { [console.log, console.warn] = saved; }
};

const m3u = entries => '#EXTM3U\n' + entries.map(e =>
    `#EXTINF:-1 tvg-id="${e.tvgId ?? ''}" group-title="${e.group}",${e.name}\nhttp://primary.invalid/live/user/pass/${e.streamId}.ts`).join('\n') + '\n';

async function syncPrimary() {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(m3u(STRONG8K));
    try { await quiet(() => sync.syncSource(primary.id)); } finally { global.fetch = originalFetch; }
}

const dreamRows = () => DREAM4K.map(e => ({ streamId: e.streamId, name: e.name, categoryId: e.group, categoryName: e.group,
    tvgId: e.tvgId, logo: null, urlData: `http://dream.invalid/live/u/p/${e.streamId}.ts` }));
const trexRows = (drop = new Set()) => TREX_RAW.streams.filter(s => !drop.has(String(s.stream_id))).map(s => ({
    streamId: String(s.stream_id), name: s.name, categoryId: String(s.category_id), categoryName: TREX_CATS.get(String(s.category_id)),
    tvgId: s.epg_channel_id, logo: null, urlData: null }));

const rowsFor = (key, backupId) => sqlite.getDb().prepare(
    'SELECT * FROM channel_links WHERE primary_source_id = ? AND primary_key = ? AND backup_source_id = ? ORDER BY rank').all(primary.id, key, backupId);
const count = () => sqlite.getDb().prepare('SELECT COUNT(*) AS c FROM channel_links').get().c;

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken({ ...admin, id: 1 });
    const viewer = await db.users.create({ username: 'viewer', role: 'user' });
    viewerToken = auth.generateToken(viewer);
    primary = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://primary.invalid/list.m3u' });

    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth')); // configures the jwt strategy
    app.use('/api/links', load('routes/links'));
    app.use('/api/sources', load('routes/sources'));
    app.use('/api/library', load('routes/library'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.(); server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// ---- the pure normalisation ----------------------------------------------------

test('tvgKey: lower case, .alt and the state-city prefix removed, the country kept', () => {
    assert.equal(links.tvgKey('FoxSports503.alt.au'), 'foxsports503.au');
    assert.equal(links.tvgKey('NSW-SydneyFoxFooty.au'), 'foxfooty.au');
    assert.equal(links.tvgKey('nsw-sydneyfoxsports505.au'), 'foxsports505.au');
    assert.equal(links.tvgKey('FoxSports505.au'), links.tvgKey('foxsports505.au'));
    assert.equal(links.tvgKey('skysport1.nz'), 'skysport1.nz');
    assert.equal(links.tvgKey('TNT.Sports.1.HD.uk'), 'tntsports1.uk', 'a raw list\'s dotted form');
    assert.notEqual(links.tvgKey('FoxSports5.au'), links.tvgKey('foxsports505.au'), 'raw Trex ids differ: the number rule links those');
    for (const none of ['447013', 'dummy-857775', 'dummy.epg', 'ABC Kids', '', null]) assert.equal(links.tvgKey(none), null, String(none));
});

test('regionOf: name prefix, bracketed country, tvg suffix, then the group', () => {
    assert.equal(links.regionOf({ name: 'AU| ABC SYDNEY', group: 'AU| AUSTRALIA' }), 'AU');
    assert.equal(links.regionOf({ name: 'UK|SKY SPORTS ACTION HD' }), 'UK');
    assert.equal(links.regionOf({ name: '(AU) ESPN PLAY 12 (D)' }), 'AU');
    assert.equal(links.regionOf({ name: 'AU: 9NOW 9GEM (NSW)' }), 'AU');
    assert.equal(links.regionOf({ name: 'Sky Sports Cricket (UK)', group: '🇦🇺 TV Guide (Australia)' }), 'UK');
    assert.equal(links.regionOf({ name: 'Sky Sport 1', group: '🇦🇺 TV Guide (Australia)', tvgId: 'skysport1.nz' }), 'NZ',
        'the tvg-id beats the group: Strong8K files NZ Sky Sport under Australia');
    assert.equal(links.regionOf({ name: 'Sky Sports Main Event', group: 'UK SKY SPORTS' }), 'UK', 'Dream4K group form');
    assert.equal(links.regionOf({ name: 'ABC', group: '🇦🇺 TV Guide (Australia)' }), 'AU', 'the flag, last');
    assert.equal(links.regionOf({ name: 'beIN Sports 1', group: '🏈 Sport Networks', tvgId: '412167' }), null);
    assert.equal(links.regionOf({ name: 'x', tvgId: 'skysports.gb' }), 'UK', 'GB is UK');
    assert.equal(links.regionOf({ name: 'Stan', group: 'EN STAN EVENTS' }), null, 'EN is not a country');
});

test('nameKey: prefixes, brackets, tags, Kayo, AU cities and punctuation go; digits stay', () => {
    assert.equal(links.nameKey('AU| ABC SYDNEY'), links.nameKey('ABC'));
    assert.equal(links.nameKey('7 Flix Sydney'), links.nameKey('AU| 7FLIX SYDNEY'));
    assert.equal(links.nameKey('Sky Sports Main Event ᵁᴴᴰ ᴴᴰᴿ'), 'skysportsmainevent');
    assert.equal(links.nameKey('TNT Sports 1 (1080p50)'), links.nameKey('UK| TNT SPORTS 1 HEVC FHD'));
    assert.equal(links.nameKey('TSN 1 ⁽ᴮᴷ⁾ ᴿᴬᵂ'), 'tsn1');
    assert.equal(links.nameKey('AU| KAYO - ESPN 2'), links.nameKey('ESPN 2'));
    assert.equal(links.nameKey('Channel 9'), links.nameKey('AU: 9NOW CHANNEL 9 (VIC) ᴿᴬᵂ'));
    assert.equal(links.nameKey('9 Go!'), links.nameKey('AU: 9NOW 9GO! (NSW) ᴿᴬᵂ'));
    assert.equal(links.nameKey('Sky Sports +'), links.nameKey('Sky Sports+'));
    assert.notEqual(links.nameKey('Sky Sport 1'), links.nameKey('Sky Sport 2'));
});

test('qualityOf and isSibling', () => {
    assert.equal(links.qualityOf('Sky Sports Main Event ᵁᴴᴰ ᴴᴰᴿ'), 'uhd');
    assert.equal(links.qualityOf('UK| SKY SPORTS F1 UHD/4K'), 'uhd');
    assert.equal(links.qualityOf('Sky Sports Main Event 4K'), 'uhd');
    assert.equal(links.qualityOf('Sky Sports Main Event 1080p50'), 'hd');
    assert.equal(links.qualityOf('UK| SKY SPORTS F1 FHD'), 'hd');
    assert.equal(links.qualityOf('ESPN (720p)'), 'hd');
    assert.equal(links.qualityOf('Sky Sports Main Event 576p25'), 'sd');
    assert.equal(links.qualityOf('NESN (540p)'), 'sd');
    assert.equal(links.qualityOf('Sky Sports Main Event'), 'unknown');
    assert.ok(links.isSibling('Sky Sports Main Event (Backup)'));
    assert.ok(links.isSibling('NBA TV [Backup]'));
    assert.ok(links.isSibling('TSN 1 ⁽ᴮᴷ⁾ ᴿᴬᵂ'));
    assert.ok(!links.isSibling('Sky Sports Main Event'));
});

test('isEventSlot: PPV and event slots, and placeholders, never link; Main Event is a channel', () => {
    for (const [name, group] of [
        ['NBA 06 :', '🏀 NBA League Pass'], ['NBA 06 :', 'SPORTS'], ['ESPN+ 123', 'US'], ['AFL TV 01 | Port Adelaide vs Sydney 10:30', 'AU| AFL PPV'],
        ['- NO EVENT STREAMING - | 8K EXCLUSIVE | US: NBA PASS PPV 1', 'x'], ['NEXT | BAHRAIN: RACE | Sun 04 Oct', '🏎️ Formula 1 '],
        [':Sky Sports UK  12', 'UK SKY SPORTS + PPV'], ['TNT Sports | Event 3', 'UK TNT SPORTS'], ['NZ| SPARK SPORTS EVENT 1', 'NZ| NEW ZEALAND'],
        ['Rugby 2 :', 'AU| RUGBY'], ['AU (STAN 08) | Bath v Exeter  PREM Rugby (2026-10-03 04:40:29)', 'AU| STAN PPV'],
        ['Replay 3', 'x'], ['Fite Tv 24/7', 'x'], ['##### SKY SPORTS FHD #####', 'UK| SPORTS'], ['### LOCAL NETWORKS ###', 'x']
    ]) assert.ok(links.isEventSlot({ name, group }), `${name} / ${group}`);
    for (const [name, group] of [
        ['Sky Sports Main Event ᵁᴴᴰ ᴴᴰᴿ', '🏈 Sport Networks'], ['Fox Sports 505', 'AU| Sports'], ['NZ| SKY SPORT 1 HD', 'NZ| NEW ZEALAND'],
        ['UK| SKY SPORTS MAIN EVENT UHD/4K', 'UK| SPORTS'], ['Sky Sport 1', 'NZ SPORTS']
    ]) assert.ok(!links.isEventSlot({ name, group }), `${name} / ${group}`);
});

test('foxNumber: the AU Fox channel number', () => {
    assert.equal(links.foxNumber('Fox Cricket 501'), 501);
    assert.equal(links.foxNumber('AU| KAYO - FOX SPORTS 501 CRICKET'), 501);
    assert.equal(links.foxNumber('Fox Sports More+ 507'), 507);
    assert.equal(links.foxNumber('Fox Sports 1'), null);
    assert.equal(links.foxNumber('Channel 505'), null, 'fox or kayo is required');
});

// ---- the real lists, without a database ----------------------------------------

test('fixtures: Fox Footy 504 is Dream4K\'s Fox Sports 504, pending by number', () => {
    const c = links.candidatesFor(strong(441304), rowsOf.dream4k());
    assert.equal(c[0].streamId, '197188');
    assert.equal(c[0].method, 'number');
    assert.equal(c[0].status, 'pending');
});

test('fixtures: Sky Sport 1 (skysport1.nz) is Dream4K\'s, automatically', () => {
    const c = links.candidatesFor(strong(2006097), rowsOf.dream4k());
    assert.equal(c[0].streamId, '579826');
    assert.equal(c[0].method, 'exact');
    assert.equal(c[0].status, 'auto');
});

test('fixtures: the wrong country never links (ABC, beIN, ESPN, Sky Sport Premier League)', () => {
    const foreign = [
        { streamId: 'us-abc', name: 'US| ABC', group: 'US| NETWORKS', tvgId: 'abc.us' },
        { streamId: 'us-abc2', name: 'ABC', group: 'US| ENTERTAINMENT', tvgId: null },
        { streamId: 'fr-bein', name: 'FR| BEIN SPORTS 1', group: 'FR| SPORTS', tvgId: null },
        { streamId: 'fr-bein2', name: 'beIN Sports 1', group: 'FR| SPORT', tvgId: 'beinsports1.fr' },
        { streamId: 'us-espn', name: 'ESPN', group: 'US| SPORTS', tvgId: 'espn.us' },
        { streamId: 'de-sky', name: 'DE| SKY SPORT PREMIER LEAGUE', group: 'DE| SKY', tvgId: null }
    ];
    const idx = links.indexBackup([...foreign, ...rowsOf.trexRaw()]);
    const abc = links.candidatesFor(strong(441345), idx);
    assert.ok(!abc.some(c => c.streamId.startsWith('us-')), 'ABC never goes to US ABC');
    assert.equal(abc[0].row.name, 'AU| ABC SYDNEY', 'but finds AU| ABC SYDNEY');
    assert.equal(abc[0].method, 'name');
    assert.equal(abc[0].status, 'pending');
    for (const id of [1968698, 595835, 441313]) {
        assert.ok(!links.candidatesFor(strong(id), idx).some(c => c.streamId.startsWith('fr-')), `beIN ${id} never goes to French beIN`);
    }
    assert.ok(!links.candidatesFor(strong(441310), idx).some(c => c.streamId === 'us-espn'), 'AU ESPN never goes to US ESPN');
    assert.ok(!links.candidatesFor(strong(670268), idx).some(c => c.streamId === 'de-sky'), 'NZ Sky Sport Premier League never to German Sky');
});

test('fixtures: event slots never link, even with the same name on both sides', () => {
    const trexEpg = TREX_EPG.map(e => ({ streamId: e.streamId, name: e.name, group: e.group, tvgId: e.tvgId }));
    assert.ok(trexEpg.some(e => e.name === 'NBA 06 :'), 'the backup has the same slot name');
    for (const id of [607596, 1634335, 605904, 1899393]) {
        assert.deepEqual(links.candidatesFor(strong(id), trexEpg), [], STRONG8K.find(e => e.streamId === String(id)).name);
    }
    assert.ok(links.indexBackup(trexEpg).byName.get('US|nba06') === undefined, 'nor are they indexed');
});

test('fixtures: UHD pairs with UHD (Sky Sports Main Event)', () => {
    const uhd = strong(950402);
    assert.equal(uhd.quality, 'uhd');
    const d = links.candidatesFor(uhd, rowsOf.dream4k());
    assert.equal(d[0].row.name, 'Sky Sports Main Event 4K');
    const t = links.candidatesFor(uhd, rowsOf.trexRaw());
    assert.equal(t[0].row.name, 'UK| SKY SPORTS MAIN EVENT UHD/4K');
    const hd = links.candidatesFor(strong(1562535), rowsOf.trexRaw()); // "Sky Sports Main Event ᴴᴰ"
    assert.equal(hd[0].row.f.quality, 'hd', 'and HD with HD');
});

test('fixtures: the Trex raw list has AU Fox 501-507 and AU| ABC SYDNEY', () => {
    const idx = links.indexBackup(rowsOf.trexRaw());
    for (const [id, n] of [[441307, 501], [441306, 502], [441305, 503], [441304, 504], [441360, 505], [441302, 506], [441301, 507]]) {
        const c = links.candidatesFor(strong(id), idx);
        assert.ok(c.length, `Fox ${n} found`);
        assert.ok(c.slice(0, 3).some(x => x.row.name.includes(String(n))), `Fox ${n}: ${c.map(x => x.row.name).join(', ')}`);
    }
    const abc = links.candidatesFor(strong(441345), idx);
    assert.equal(abc[0].row.name, 'AU| ABC SYDNEY');
});

test('fixtures: two names under one tvg-id with different numbers are not linked automatically', () => {
    // Trex's EPGenius puts skysports1.uk on "SKY SPORTS + FHD".
    const trexEpg = TREX_EPG.map(e => ({ streamId: e.streamId, name: e.name, group: e.group, tvgId: e.tvgId }));
    const c = links.candidatesFor(strong(950400), trexEpg); // "Sky Sports 1 ᴴᴰᴿ"
    assert.ok(c.length && c.every(x => x.status === 'pending'), c.map(x => `${x.row.name} ${x.status}`).join(', '));
});

// ---- the store, the relink rules and the API -------------------------------------

test('with no backup configured nothing is linked and nothing changes', async () => {
    await syncPrimary();
    assert.ok(sqlite.getDb().prepare("SELECT COUNT(*) AS c FROM playlist_items WHERE source_id = ? AND type = 'live'").get(primary.id).c > 1000);
    assert.equal(count(), 0, 'a primary sync writes no links');
    assert.deepEqual(await quiet(() => links.relinkAll()), { skipped: true });
    assert.equal(count(), 0);
    assert.deepEqual(links.usableLinks(primary.id, 's2006097'), []);
});

test('a relink links the visible channels to each backup, fills region/quality/is_event, and finds siblings', async () => {
    trex = await db.sources.create({ type: 'xtream', name: 'Trex', url: 'http://trex.invalid', username: 'u', password: 'p', role: 'backup', priority: 1 });
    dream = await db.sources.create({ type: 'm3u', name: 'Dream4K', url: 'http://dream.invalid/list.m3u', role: 'backup', priority: 2 });
    backupChannels.replaceAll(trex.id, trexRows(), TREX_OVERLAY);
    backupChannels.replaceAll(dream.id, dreamRows(), null);
    const result = await quiet(() => links.relinkAll());
    assert.ok(result.channels > 1000);
    assert.ok(result.backups[trex.id].auto > 100 && result.backups[dream.id].auto > 100);

    const row = sqlite.getDb().prepare('SELECT region, quality, is_event FROM backup_channels WHERE source_id = ? AND stream_id = ?');
    assert.deepEqual({ ...row.get(trex.id, '1641636') }, { region: 'UK', quality: 'uhd', is_event: 0 });
    assert.deepEqual({ ...row.get(trex.id, '1395690') }, { region: 'AU', quality: 'unknown', is_event: 1 });

    const skySport1 = rowsFor('s2006097', dream.id);
    assert.equal(skySport1[0].backup_stream_id, '579826');
    assert.equal(skySport1[0].status, 'auto');
    const footy = rowsFor('s441304', dream.id);
    assert.equal(footy[0].backup_stream_id, '197188');
    assert.equal(footy[0].method, 'number');
    assert.equal(footy[0].status, 'pending');
    assert.ok(rowsFor('s441304', dream.id).length <= links.MAX_RANK);
    assert.equal(rowsFor('s607596', trex.id).length + rowsFor('s607596', dream.id).length, 0, 'NBA 06 : is never linked');

    const nhl = rowsFor('s604331', primary.id);
    assert.equal(nhl[0].backup_stream_id, 's1568686', 'NHL Network -> NHL Network (Backup), a sibling');
    assert.equal(nhl[0].method, 'sibling');
    assert.equal(nhl[0].status, 'auto');

    assert.deepEqual(links.usableLinks(primary.id, 's604331'), [{ backupSourceId: primary.id, streamId: 's1568686', method: 'sibling' }]);
    assert.deepEqual(links.usableLinks(primary.id, 's2006097').map(l => l.backupSourceId), [trex.id, dream.id], 'backups by priority');
    assert.deepEqual(links.usableLinks(primary.id, 's441304').map(l => l.backupSourceId), [], 'pending links are not used');
});

test('a linked "(Backup)" sibling is not listed: guide, channels and counts (simplification build)', async () => {
    // From the relink above: NHL Network (s604331) has NHL Network (Backup) (s1568686) as its sibling.
    const { VISIBLE_SQL } = load('services/channelNumbers');
    const visible = new Set(sqlite.getDb().prepare(`SELECT COALESCE(p.stable_id, p.item_id) AS k FROM playlist_items p WHERE ${VISIBLE_SQL}`).all().map(r => r.k));
    assert.ok(visible.has('s604331'), 'the main channel is listed');
    assert.ok(!visible.has('s1568686'), 'its linked backup feed is not');
    const ids = new Set();
    for (let cursor = null, page; ; cursor = page.nextCursor) {
        page = (await call('GET', `/api/library/guide?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).body;
        for (const c of page.channels) ids.add(c.stableId || c.id);
        if (!page.nextCursor) break;
    }
    assert.ok(ids.has('s604331') && !ids.has('s1568686'), 'the guide the clients page through agrees');
    const search = (await call('GET', '/api/library/channels?search=NHL%20Network&limit=200')).body;
    assert.ok(!search.channels.some(c => /\(backup\)/i.test(c.name)), 'and so does the channel list');
});

test('a sibling whose link is rejected is listed again, and the guide version moves only when that set changes', async () => {
    const { currentGuideVersion } = load('services/libraryRev');
    const { VISIBLE_SQL } = load('services/channelNumbers');
    const listed = (key) => sqlite.getDb().prepare(`SELECT 1 FROM playlist_items p WHERE ${VISIBLE_SQL} AND COALESCE(p.stable_id, p.item_id) = ?`).get(key) !== undefined;
    // The first relink after siblings were hidden may settle a few picks among identical feeds
    // (four "TSN 3 (BK) RAW"s); after that, a relink with nothing new changes nothing.
    await quiet(() => links.relinkAll());
    const before = currentGuideVersion();
    await quiet(() => links.relinkAll());
    assert.equal(currentGuideVersion(), before, 'nothing changed: no new version');
    sqlite.getDb().prepare("UPDATE channel_links SET status = 'rejected' WHERE primary_source_id = ? AND primary_key = 's604331' AND method = 'sibling'").run(primary.id);
    assert.ok(listed('s1568686'), 'unlinked, the backup feed is the only way to reach it: listed');
    sqlite.getDb().prepare("UPDATE channel_links SET status = 'auto' WHERE primary_source_id = ? AND primary_key = 's604331' AND method = 'sibling'").run(primary.id);
    assert.ok(!listed('s1568686'));
});

test('decisions are kept across relinks; a vanished stream breaks a kept link and comes back', async () => {
    const footy = rowsFor('s441304', dream.id)[0];
    let r = await call('PUT', `/api/links/${footy.id}`, { body: { status: 'approved' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'approved');
    await quiet(() => links.relinkAll());
    assert.equal(rowsFor('s441304', dream.id)[0].status, 'approved', 'approved survives a relink, at rank 1');
    assert.deepEqual(links.usableLinks(primary.id, 's441304'), [{ backupSourceId: dream.id, streamId: '197188', method: 'number' }]);

    const sky = rowsFor('s2006097', dream.id)[0];
    r = await call('PUT', `/api/links/${sky.id}`, { body: { status: 'rejected' } });
    assert.equal(r.body.status, 'rejected');
    await quiet(() => links.relinkAll());
    const after = rowsFor('s2006097', dream.id);
    assert.ok(after.some(x => x.backup_stream_id === '579826' && x.status === 'rejected'), 'rejected is kept');
    assert.ok(!after.some(x => x.rank === 1 && x.backup_stream_id === '579826'), 'and is not rank 1');
    assert.ok(!links.usableLinks(primary.id, 's2006097').some(l => l.backupSourceId === dream.id));

    // A manual link: AU ESPN has no automatic match at Trex (its raw name is "ESPN 1").
    r = await call('POST', '/api/links', { body: { primarySourceId: primary.id, primaryKey: 's441310', backupSourceId: trex.id, streamId: '646974' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'manual');
    assert.equal(r.body.rank, 1);
    await quiet(() => links.relinkAll());
    assert.equal(rowsFor('s441310', trex.id)[0].status, 'manual');

    backupChannels.replaceAll(trex.id, trexRows(new Set(['646974'])), TREX_OVERLAY);
    await quiet(() => links.relinkSource(trex.id));
    const broken = rowsFor('s441310', trex.id).find(x => x.backup_stream_id === '646974');
    assert.equal(broken.status, 'broken');
    assert.ok(!links.usableLinks(primary.id, 's441310').some(l => l.streamId === '646974'), 'a broken link is not used');

    backupChannels.replaceAll(trex.id, trexRows(), TREX_OVERLAY);
    await quiet(() => links.relinkSource(trex.id));
    const back = rowsFor('s441310', trex.id)[0];
    assert.equal(back.backup_stream_id, '646974');
    assert.equal(back.status, 'manual', 'the stream came back: so does the link');

    r = await call('PUT', `/api/links/${back.id}`, { body: { status: 'pending' } });
    assert.equal(r.status, 200);
    assert.ok(!rowsFor('s441310', trex.id).some(x => x.backup_stream_id === '646974'), 'undoing a manual link removes it');
});

test('manual links are validated', async () => {
    const body = { primarySourceId: primary.id, primaryKey: 's441310', backupSourceId: trex.id, streamId: '999999999' };
    assert.equal((await call('POST', '/api/links', { body })).status, 404, 'no such stream');
    assert.equal((await call('POST', '/api/links', { body: { ...body, streamId: '646974', primaryKey: 's0' } })).status, 404, 'no such channel');
    assert.equal((await call('POST', '/api/links', { body: { ...body, streamId: '646974', backupSourceId: primary.id } })).status, 400, 'not a backup');
    assert.equal((await call('POST', '/api/links', { body: { primarySourceId: primary.id } })).status, 400);
    assert.equal((await call('PUT', '/api/links/99999999', { body: { status: 'approved' } })).status, 404);
    assert.equal((await call('PUT', '/api/links/1', { body: { status: 'auto' } })).status, 400);
});

test('bulk approve approves the rank-1 pending links of a category', async () => {
    const cat = sqlite.getDb().prepare("SELECT category_id FROM categories WHERE source_id = ? AND type = 'live' AND name = 'AU| Sports'").get(primary.id).category_id;
    const r = await call('POST', '/api/links/approve-pending', { body: { categoryId: cat, backupSourceId: trex.id } });
    assert.equal(r.status, 200);
    assert.ok(r.body.approved >= 7, `approved ${r.body.approved}`);
    const fox = rowsFor('s441305', trex.id)[0]; // Fox Sports 503
    assert.equal(fox.status, 'approved');
    assert.ok(links.usableLinks(primary.id, 's441305').some(l => l.backupSourceId === trex.id));
    const pending = await call('GET', `/api/links?status=pending&backupSourceId=${trex.id}&categoryId=${encodeURIComponent(cat)}`);
    assert.ok(pending.body.channels.every(c => !c.links.some(l => l.rank === 1 && l.status === 'pending')));
    assert.equal((await call('POST', '/api/links/approve-pending', { body: {} })).status, 400);
});

test('the list, its filters and the summary; admin only, and never a URL', async () => {
    const all = await call('GET', '/api/links?limit=500');
    assert.equal(all.status, 200);
    assert.ok(all.body.total > 1000);
    assert.equal(all.body.channels.length, 500);
    const sky = (await call('GET', '/api/links?search=sky%20sport%201&limit=500')).body.channels.find(c => c.key === 's2006097');
    assert.equal(sky.name, 'Sky Sport 1');
    assert.ok(sky.links.some(l => l.provider === 'Trex' && l.name && l.status === 'auto'));

    const unlinked = (await call('GET', `/api/links?unlinked=1&backupSourceId=${trex.id}&limit=500`)).body;
    assert.ok(unlinked.total > 0);
    assert.ok(unlinked.channels.every(c => !c.event && !c.links.some(l => l.rank === 1 && ['auto', 'approved', 'manual', 'pending'].includes(l.status))));
    assert.ok(!unlinked.channels.some(c => c.key === 's2006097'));

    const rejected = (await call('GET', '/api/links?status=rejected')).body;
    assert.deepEqual(rejected.channels.map(c => c.key), ['s2006097']);
    assert.equal((await call('GET', '/api/links?status=nonsense')).status, 400);

    const summary = (await call('GET', '/api/links/summary')).body;
    const t = summary.providers.find(p => p.backupSourceId === trex.id);
    assert.equal(t.role, 'backup');
    assert.ok(t.counts.auto > 0 && t.counts.approved > 0 && t.linked > 0 && t.unlinked > 0);
    assert.ok(summary.providers.some(p => p.role === 'sibling' && p.counts.auto > 0));

    for (const route of ['/api/links', '/api/links/summary']) {
        assert.equal((await call('GET', route, { token: viewerToken })).status, 403, `${route} is admin only`);
    }
    assert.equal((await call('POST', '/api/links/relink', { token: viewerToken })).status, 403);
    for (const text of [all.text, JSON.stringify(summary)]) {
        assert.ok(!/https?:\/\/|\/live\/|url_data|password/i.test(text), 'no URL, login or url_data');
    }
});

test('a primary sync relinks, and keeps the decisions', async () => {
    sqlite.getDb().prepare("DELETE FROM channel_links WHERE status IN ('auto', 'pending')").run();
    const kept = count();
    await syncPrimary();
    assert.ok(count() > kept + 500, 'the hook relinked after the primary sync');
    assert.equal(rowsFor('s441304', dream.id)[0].status, 'approved');
    assert.ok(rowsFor('s2006097', dream.id).some(x => x.status === 'rejected'));
});

test('deleting a backup removes its links; with no backup left a relink does nothing', async () => {
    assert.equal((await call('DELETE', `/api/sources/${dream.id}`)).status, 200);
    assert.equal(sqlite.getDb().prepare('SELECT COUNT(*) AS c FROM channel_links WHERE backup_source_id = ?').get(dream.id).c, 0);
    assert.equal((await call('DELETE', `/api/sources/${trex.id}`)).status, 200);
    assert.deepEqual(await quiet(() => links.relinkAll()), { skipped: true });
    assert.ok(!links.usableLinks(primary.id, 's2006097').length);
});
