const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

// 0178 (multi-provider P9): the raw-list bridge. Every provider is Xtream underneath, so a
// provider's own raw list (name, epg_channel_id, category per stream id) is stored for every
// source whatever its role, and the linker compares raw with raw: raw-name and raw-epg rank above
// the name rules. Fixtures are the real lists of 30 Sept / 1 Oct; the "providers" are fake servers.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-raw-bridge-'));
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
const rawChannels = load('services/rawChannels');
const links = load('services/channelLinks');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/providers', name), 'utf8'));
const S_EPG = fixture('strong8k-epgenius.json'), S_RAW = fixture('strong8k-xtream-raw.json');
const T_EPG = fixture('trex-epgenius.json'), T_RAW = fixture('trex-xtream-raw.json');
const D_EPG = fixture('dream4k-epgenius.json'), D_RAW = fixture('dream4k-xtream-raw.json');

const rawMap = r => {
    const cats = new Map(r.categories.map(c => [String(c.category_id), c.category_name]));
    return new Map(r.streams.map(s => [String(s.stream_id), { name: s.name, epg: s.epg_channel_id, category: cats.get(String(s.category_id)) }]));
};
const S_MAP = rawMap(S_RAW), T_MAP = rawMap(T_RAW), D_MAP = rawMap(D_RAW);
const T_OVERLAY = new Map(T_EPG.map(e => [String(e.streamId), e.tvgId]));
const D_OVERLAY = new Map(D_EPG.map(e => [String(e.streamId), e.tvgId]));

// A primary channel as the EPGenius list names it, with its raw row by stream id.
const primaryOf = (epg, map, streamId, group) => {
    const e = epg.find(x => x.streamId === String(streamId) && (!group || x.group === group));
    assert.ok(e, `fixture has ${streamId}`);
    return links.describe({ name: e.name, group: e.group, tvgId: e.tvgId, raw: map.get(String(streamId)) });
};
// A backup from its raw list (+ an EPGenius overlay), or from its EPGenius list with raw by stream id.
const backupFromRaw = (map, overlay) => [...map].map(([id, r]) => ({ streamId: id, name: r.name,
    f: links.describe({ name: r.name, group: r.category, tvgId: r.epg, overlayTvgId: overlay && overlay.get(id), raw: r }) }));
const backupFromEpg = (epg, map) => epg.map(e => ({ streamId: e.streamId, name: e.name,
    f: links.describe({ name: e.name, group: e.group, tvgId: e.tvgId, raw: map && map.get(e.streamId) }) }));
const best = (p, idx) => links.candidatesFor(p, idx)[0] || null;

// ---- the pure rules ---------------------------------------------------------------

test('rawNameKey: case, whitespace and the country-prefix separator only', () => {
    const k = links.rawNameKey;
    for (const same of ['AU: ABC SYDNEY', 'AU| ABC SYDNEY', '|AU| ABC SYDNEY', '||AU|| ABC SYDNEY', 'AU | abc   sydney', '|AU|  ABC SYDNEY']) {
        assert.equal(k(same), 'au|abc sydney', same);
    }
    assert.equal(k('AU: 9NOW CHANNEL 9 (SA) ᴿᴬᵂ'), k('AU| 9NOW CHANNEL 9 (SA) ᴿᴬᵂ'));
    assert.notEqual(k('AU: 9NOW CHANNEL 9 (SA) ᴿᴬᵂ'), k('AU: 9NOW CHANNEL 9 (SA)'), 'superscript tags are kept');
    assert.notEqual(k('UK: SKY SPORTS 1 ᵁᴴᴰ'), k('UK: SKY SPORTS 1 ᴴᴰ'), 'so is the quality');
    assert.notEqual(k('AU: ABC SYDNEY'), k('NZ: ABC SYDNEY'), 'the country stays in the key');
    assert.equal(k('Sky Sports 1'), 'sky sports 1', 'no prefix: nothing to normalise');
});

test('Dream4K\'s raw prefix styles: region and name key see through |AU|, ||AU||, |AU||, double spaces, the star', () => {
    for (const n of ['|AU|  7 Mate', '||AU|| SBS FOOD', '|AU|| SEVEN MALBOURNE', '|AU|  Fox Sports 505', '|✪ AU| Fox 8']) {
        assert.equal(links.regionOf({ name: n }), 'AU', n);
        assert.ok(!links.nameKey(n).startsWith('au'), n);
    }
    assert.equal(links.nameKey('|AU|  7 Mate'), links.nameKey('7 Mate'));
    assert.equal(links.nameKey('||AU|| SBS FOOD'), 'sbsfood');
    assert.equal(links.nameKey('|AU|  Fox Sports 505'), links.nameKey('Fox Sports 505'));
    assert.equal(links.regionOf({ name: '|CA| SPORTSNET 360 ᴴᴰ' }), 'CA');
});

test('raw-name: equal raw names in the same region are linked automatically, above the name rules', () => {
    const p = primaryOf(S_EPG, S_MAP, '1537674', '🇦🇺 TV Guide (Australia)'); // Channel 9, raw "AU: 9NOW CHANNEL 9 (SA) ᴿᴬᵂ"
    const idx = links.indexBackup(backupFromRaw(T_MAP, T_OVERLAY));
    const c = best(p, idx);
    assert.equal(c.method, 'raw-name');
    assert.equal(c.status, 'auto');
    assert.equal(c.row.name, 'AU: 9NOW CHANNEL 9 (SA) ᴿᴬᵂ');
    assert.equal(c.streamId, '1921335');
    // Without the raw row it is today's behaviour: the other rules, no raw-name.
    const plain = links.describe({ name: 'Channel 9', group: '🇦🇺 TV Guide (Australia)', tvgId: 'Channel9Sydney.au' });
    assert.ok(links.candidatesFor(plain, idx).every(x => x.method !== 'raw-name'));
});

test('raw-name needs the same region and is never an event slot', () => {
    const at = (name, category) => ({ name, epg: null, category });
    const row = (id, r) => ({ streamId: id, name: r.name, f: links.describe({ name: r.name, group: r.category, raw: r }) });
    const idx = links.indexBackup([row('1', at('AU| ABC SYDNEY', 'AU| AUSTRALIA')), row('2', at('NZ| ABC SYDNEY', 'NZ| NEW ZEALAND'))]);
    const p = links.describe({ name: 'ABC', group: 'x', raw: at('AU: ABC SYDNEY', 'AU| AUSTRALIA') });
    assert.deepEqual(links.candidatesFor(p, idx).map(c => c.streamId), ['1']);
    const noRegion = links.describe({ name: 'Channel X', raw: at('CHANNEL X', 'Misc') });
    const idx2 = links.indexBackup([row('3', at('CHANNEL X', 'Misc'))]);
    assert.deepEqual(links.candidatesFor(noRegion, idx2).filter(c => c.method === 'raw-name'), [], 'an unknown region is not enough for a raw-name match');
    // An event slot on either side, by name or by the raw category.
    const ev = at('NBA 06 :', 'US| NBA TEAM PPV');
    const idx3 = links.indexBackup([row('4', at('US| NBA 06 :', 'US| NBA TEAM PPV'))]);
    assert.deepEqual(links.candidatesFor(links.describe({ name: 'NBA 06 :', raw: ev }), idx3), []);
    const idx4 = links.indexBackup([row('5', at('US| NFL Sunday Ticket 1', 'US| SPORT PPV'))]);
    assert.deepEqual(links.candidatesFor(links.describe({ name: 'NFL Sunday Ticket 1', raw: at('US: NFL Sunday Ticket 1', 'US| SPORT PPV') }), idx4), []);
});

test('raw-epg: the raw epg ids match case-insensitively; the variant-word guard makes it pending', () => {
    const at = (name, epg, category = 'UK| SPORTS') => ({ name, epg, category });
    const row = (id, r) => ({ streamId: id, name: r.name, f: links.describe({ name: r.name, group: r.category, tvgId: r.epg, raw: r }) });
    const idx = links.indexBackup([row('1', at('UK| SKY SPORTS MAIN EVENT HD', 'SkySportsMainEvent.uk')), row('2', at('UK| SKY SPORTS +', 'skysportsmainevent.uk'))]);
    const p = links.describe({ name: 'Sky Sports Main Event', group: 'UK SKY', raw: at('UK: SKY SPORTS MAIN EVENT', 'skysportsmainevent.UK') });
    const byId = Object.fromEntries(links.candidatesFor(p, idx).map(c => [c.streamId, c]));
    assert.equal(byId['1'].method, 'raw-epg'); assert.equal(byId['1'].status, 'auto');
    assert.equal(byId['2'].status, 'pending', 'Plus is a different channel under the same id');
    // MSG vs MSG Plus, small numbers: Sky Sports 1 vs Sky Sports 2 under one raw id.
    const msg = links.describe({ name: 'MSG', raw: at('US: MSG HD', 'msg.us', 'US| SPORTS') });
    const idxM = links.indexBackup([row('7', at('US| MSG PLUS HD', 'MSG.us', 'US| SPORTS'))]);
    assert.equal(best(msg, idxM).status, 'pending');
    // A different region on either side never links; an unknown region does.
    const nz = links.indexBackup([row('9', at('NZ| SKY SPORT 1', 'skysport1.uk', 'NZ| NEW ZEALAND'))]);
    assert.deepEqual(links.candidatesFor(links.describe({ name: 'Sky Sport 1', raw: at('UK: SKY SPORT 1', 'skysport1.uk', 'UK| SPORTS') }), nz).filter(c => c.method === 'raw-epg'), []);
    const unknown = links.indexBackup([row('8', at('SKY SPORT 1 HD', 'skysport1.uk', 'Misc'))]);
    assert.equal(best(links.describe({ name: 'Sky Sport 1', raw: at('SKY SPORT ONE', 'skysport1.uk', 'Misc') }), unknown).method, 'raw-epg');
    assert.equal(links.candidatesFor(links.describe({ name: 'X', raw: at('X', 'dummy-123') }), links.indexBackup([row('6', at('Y', 'dummy-123'))])).length, 0, 'a dummy id is nothing');
});

test('fixtures: Strong8K raw against Trex raw links most of Australia exactly', () => {
    const P = S_EPG.filter(e => !links.isPlaceholder(e.name)).map(e => ({ e, p: primaryOf(S_EPG, S_MAP, e.streamId, e.group) }));
    const withRaw = links.indexBackup(backupFromRaw(T_MAP, T_OVERLAY));
    const tally = group => {
        const mine = P.filter(x => group(x.e) && !x.p.event);
        const auto = mine.filter(x => { const c = best(x.p, withRaw); return c && c.status === 'auto'; }).length;
        return { auto, total: mine.length };
    };
    const ent = tally(e => e.group === 'AU| Entertainment');
    assert.ok(ent.auto >= 55, `AU Entertainment: ${ent.auto}/${ent.total}`);
    const sports = tally(e => e.group === 'AU| Sports');
    assert.ok(sports.auto >= 35, `AU Sports: ${sports.auto}/${sports.total}`);
    const guide = tally(e => e.group.includes('TV Guide'));
    assert.ok(guide.auto >= 40, `AU TV Guide: ${guide.auto}/${guide.total}`);
    const sky = tally(e => e.group.startsWith('UK| Sky'));
    assert.ok(sky.auto >= 170, `UK Sky: ${sky.auto}/${sky.total}`);
    const methods = new Set(P.filter(x => !x.p.event).map(x => (best(x.p, withRaw) || {}).method));
    assert.ok(methods.has('raw-name') && methods.has('raw-epg'));
});

test('fixtures: Strong8K channels reach Dream4K\'s raw |AU| rows; Kayo event slots never link', () => {
    const idx = links.indexBackup(backupFromRaw(D_MAP, D_OVERLAY));
    const fox = best(primaryOf(S_EPG, S_MAP, '441360', 'AU| Sports'), idx);        // Fox Sports 505, raw "AU: FOX SPORTS 505 HD"
    assert.ok(fox, 'Fox Sports 505 finds Dream4K\'s |AU|  Fox Sports 505');
    assert.match(fox.row.name, /Fox Sports 505/);
    assert.ok(['auto', 'pending'].includes(fox.status));
    const mate = links.candidatesFor(primaryOf(S_EPG, S_MAP, '441367', '🇦🇺 TV Guide (Australia)'), idx);   // 7 Mate Melbourne
    assert.ok(mate.some(c => /7 mate/i.test(c.row.name) && c.status === 'pending'), '7 Mate pending by region + name');
    // No primary channel ever links to a Dream4K event slot, whatever its name.
    const events = new Set(D_RAW.streams.filter(s => /:Kayo\s+\d+$|@/.test(s.name)).map(s => String(s.stream_id)));
    assert.ok(events.size > 10);
    for (const e of S_EPG) {
        for (const c of links.candidatesFor(primaryOf(S_EPG, S_MAP, e.streamId, e.group), idx)) assert.ok(!events.has(c.streamId), `${e.name} -> ${c.row.name}`);
    }
    // The EPGenius-only Dream4K list reaches the same channel through the same bridge (stream ids agree).
    const epgOnly = links.indexBackup(backupFromEpg(D_EPG, D_MAP));
    assert.ok(best(primaryOf(S_EPG, S_MAP, '441360', 'AU| Sports'), epgOnly));
});

test('both ways: Dream4K as the primary, Strong8K and Trex raw as the backups', () => {
    // The primary side is Dream4K's own list (EPGenius names + raw by stream id); nothing is keyed on a provider.
    const pd = id => primaryOf(D_EPG, D_MAP, id);
    const ids = D_EPG.filter(e => D_MAP.has(e.streamId)).map(e => e.streamId);
    const strong = links.indexBackup(backupFromRaw(S_MAP, null));
    const trex = links.indexBackup(backupFromRaw(T_MAP, T_OVERLAY));
    let linked = 0, bridged = 0;
    for (const id of ids) {
        for (const idx of [strong, trex]) {
            const c = best(pd(id), idx);
            if (c) linked++;
            if (c && (c.method === 'raw-name' || c.method === 'raw-epg')) bridged++;
        }
    }
    assert.ok(linked > 30, `${linked} links`);
    assert.ok(bridged > 10, `${bridged} by the raw bridge`);
    // A concrete pair both ways: Dream4K "|AU|  Fox Sports 505" <-> Trex "AU| FOX SPORTS 505 HD".
    const fromDream = best(pd(D_EPG.find(e => /fox sports 505/i.test(D_MAP.get(e.streamId)?.name || ''))?.streamId), trex);
    assert.ok(fromDream && /FOX SPORTS 505/.test(fromDream.row.name));
    // Raw-name is symmetric: swap primary and backup and the same stream pair comes back.
    const a = S_EPG.find(e => e.streamId === '1537674');
    const fwd = best(primaryOf(S_EPG, S_MAP, '1537674', a.group), links.indexBackup(backupFromRaw(T_MAP, T_OVERLAY)));
    const t = T_EPG.find(e => e.streamId === fwd.streamId) || { name: fwd.row.name, group: T_MAP.get(fwd.streamId).category, tvgId: T_MAP.get(fwd.streamId).epg };
    const back = best(links.describe({ name: fwd.row.name, group: T_MAP.get(fwd.streamId).category, tvgId: t.tvgId, raw: T_MAP.get(fwd.streamId) }),
        links.indexBackup(backupFromRaw(S_MAP, null)));
    assert.equal(back.method, 'raw-name');
    assert.equal(S_MAP.get(back.streamId).name, 'AU: 9NOW CHANNEL 9 (SA) ᴿᴬᵂ');
});

test('no code path names a provider or needs the primary to be an M3U', () => {
    for (const f of ['services/channelLinks.js', 'services/rawChannels.js']) {
        const src = fs.readFileSync(path.join(sandbox, 'server', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/strong8k|trex|dream4k|epgenius/i.test(src), f);
    }
});

// ---- storing the raw rows ------------------------------------------------------------

let fake, fakeUrl, hits, mode, server, base, adminToken;
const quiet = async fn => {
    const saved = [console.log, console.warn, console.error];
    const seen = [];
    console.log = console.warn = console.error = (...a) => seen.push(a.join(' '));
    try { await fn(); } finally { [console.log, console.warn, console.error] = saved; }
    return seen;
};
const SUB = S_EPG.filter(e => !links.isPlaceholder(e.name) && S_MAP.has(e.streamId)).slice(0, 400);
const liveUrl = (user, id) => `${fakeUrl}/live/${user}/pw${user}/${id}.ts`;
const primaryM3u = () => `#EXTM3U\n#EXT-X-CREDENTIALS:[{"provider": "p", "dns": "${fakeUrl}", "username": "pu", "password": "pwpu"}]\n` + SUB.map(e =>
    `#EXTINF:-1 tvg-id="${e.tvgId}" group-title="${e.group}",${e.name}\n${liveUrl('pu', e.streamId)}\n`).join('');
const listing = user => {
    const r = user === 'pu' ? S_RAW : T_RAW;
    if (user === 'pu') {
        const keep = new Set(SUB.map(e => e.streamId));
        return { categories: r.categories, streams: r.streams.filter(s => keep.has(String(s.stream_id))) };
    }
    return r;
};
const apiHits = () => hits.filter(h => h.startsWith('/player_api.php?get_live')).length;
const rawCount = id => sqlite.getDb().prepare('SELECT COUNT(*) c FROM provider_raw_channels WHERE source_id = ?').get(id).c;
const linkRows = (pid, bid) => sqlite.getDb().prepare('SELECT * FROM channel_links WHERE primary_source_id = ? AND backup_source_id = ?').all(pid, bid);

before(async () => {
    fake = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const a = u.searchParams.get('action');
        if (u.pathname === '/player_api.php') hits.push(`${u.pathname}?${a || ''}`);
        const json = v => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
        if (u.pathname === '/player_api.php') {
            const user = u.searchParams.get('username');
            if (mode.fail && (mode.fail === true || mode.fail === user)) { res.statusCode = 502; return res.end('bad gateway'); }
            if (a === 'get_live_categories') return json(listing(user).categories);
            if (a === 'get_live_streams') return json(listing(user).streams);
            return json({ user_info: { auth: 1, status: 'Active', max_connections: '1' }, server_info: {} });
        }
        if (u.pathname === '/list.m3u') return res.end(primaryM3u());
        res.statusCode = 404; res.end('');
    }).listen(0, '127.0.0.1');
    await once(fake, 'listening');
    fakeUrl = `http://127.0.0.1:${fake.address().port}`;
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken({ ...admin, id: 1 });
    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/sources', load('routes/sources'));
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

beforeEach(() => { hits = []; mode = {}; });

let primary, trex;

test('with no backup nothing is fetched beyond what a sync fetched before', async () => {
    primary = await db.sources.create({ type: 'm3u', name: 'Primary', url: `${fakeUrl}/list.m3u` });
    await quiet(() => sync.syncSource(primary.id));
    assert.equal(apiHits(), 0, 'no get_live_* call');
    assert.equal(rawCount(primary.id), 0);
});

test('the first backup brings the raw rows of every provider, from one fetch each, and relinks by them', async () => {
    trex = await db.sources.create({ type: 'xtream', name: 'Backup', url: fakeUrl, username: 'bk', password: 'pwbk', role: 'backup', priority: 1 });
    await quiet(() => sync.syncSource(trex.id));
    assert.equal(hits.filter(h => h === '/player_api.php?get_live_streams').length, 2, 'one per provider: the backup\'s fetch is shared, the primary is fetched once');
    assert.equal(rawCount(trex.id), T_RAW.streams.length);
    assert.equal(rawCount(primary.id), SUB.length);
    const row = sqlite.getDb().prepare('SELECT * FROM provider_raw_channels WHERE source_id = ? AND stream_id = ?').get(primary.id, '1537674');
    assert.equal(row.name, 'AU: 9NOW CHANNEL 9 (SA) ᴿᴬᵂ');
    assert.equal(row.category_name, S_MAP.get('1537674').category);
    const rows = linkRows(primary.id, trex.id);
    assert.ok(rows.some(r => r.method === 'raw-name' && r.status === 'auto'), 'raw-name links exist');
    const c9 = rows.find(r => r.primary_key === 's1537674' && r.rank === 1);
    assert.equal(c9.method, 'raw-name');
    assert.equal(c9.backup_stream_id, '1921335');
    assert.equal(links.usableLinks(primary.id, 's1537674')[0].streamId, '1921335');
});

test('a primary sync refreshes its raw rows with one fetch; a failure keeps the old rows and leaks nothing', async () => {
    mode.fail = 'pu';
    const seen = await quiet(() => sync.syncSource(primary.id));
    assert.equal(rawCount(primary.id), SUB.length, 'previous rows stay');
    const text = seen.join('\n');
    assert.match(text, /could not be read/);
    assert.ok(!/pwpu|pwbk|127\.0\.0\.1|username=/.test(text), 'no login, no URL in the log');
    assert.equal(sqlite.getDb().prepare('SELECT status FROM sync_status WHERE source_id = ?').get(primary.id).status, 'success', 'the sync itself did not fail');
    mode = {};
    await quiet(() => sync.syncSource(primary.id));
    assert.equal(hits.filter(h => h === '/player_api.php?get_live_streams').length, 1, 'one extra call per sync');
});

test('an empty reply keeps the previous rows; replacement is one transaction', async () => {
    const before = rawCount(trex.id);
    await quiet(async () => { assert.equal(await rawChannels.fetchFor({ ...trex, url: 'http://127.0.0.1:1' }), false); });
    assert.equal(rawCount(trex.id), before);
    assert.throws(() => rawChannels.replaceAll(trex.id, [{ streamId: 'x', name: 'a', epg: null, category: null }, null]));
    assert.equal(rawCount(trex.id), before, 'a throw leaves the old rows');
});

test('kept decisions still win over the raw rules', async () => {
    const d = sqlite.getDb();
    const top = d.prepare("SELECT * FROM channel_links WHERE primary_source_id = ? AND backup_source_id = ? AND primary_key = 's1537674' AND rank = 1").get(primary.id, trex.id);
    d.prepare("UPDATE channel_links SET status = 'rejected' WHERE id = ?").run(top.id);
    await quiet(() => links.relinkAll());
    const after = d.prepare("SELECT * FROM channel_links WHERE primary_source_id = ? AND backup_source_id = ? AND primary_key = 's1537674' AND backup_stream_id = ?").get(primary.id, trex.id, top.backup_stream_id);
    assert.equal(after.status, 'rejected', 'a rejection is not undone by a raw match');
    assert.notEqual(linkRows(primary.id, trex.id).find(r => r.primary_key === 's1537674' && r.rank === 1)?.backup_stream_id, top.backup_stream_id);
});

test('deleting a source removes its raw rows', async () => {
    const r = await fetch(`${base}/api/sources/${trex.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
    assert.ok(r.status < 300, String(r.status));
    assert.equal(rawCount(trex.id), 0);
    assert.equal(rawCount(primary.id), SUB.length);
    const r2 = await fetch(`${base}/api/sources/${primary.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
    assert.ok(r2.status < 300);
    assert.equal(rawCount(primary.id), 0);
});
