const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const express = require('express');

// 0134 (roadmap S4.2): channels whose tvg-id has no programmes get EPG
// candidates by name (GET /api/epg/unmatched), and an admin mapping
// (PUT /api/epg/mapping) takes priority over the playlist's tvg-id in the guide,
// now/next and the logo fallback - and survives a playlist sync, which rewrites
// playlist_items.tvg_id every time. The old code has no /api/epg routes (404)
// and no override, so every assertion below fails on it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-epg-matching-'));
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

const HOUR = 60 * 60 * 1000;
let server, base, adminToken, viewerToken, source;

async function call(method, route, { token = adminToken, body } = {}) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* no body */ }
    return { status: response.status, body: json };
}
const get = async route => (await call('GET', route)).body;

// [stream id, name, tvg-id or null]
const PLAYLIST = [
    [101, 'AU: Seven HD', 'seven.wrong'],
    [102, 'Nine', 'nine.au'],
    [103, 'ABC News', null]
];
function playlist(channels) {
    return '#EXTM3U\n' + channels.map(([id, name, tvg]) =>
        `#EXTINF:-1 ${tvg ? `tvg-id="${tvg}" ` : ''}group-title="Australia",${name}\nhttp://provider.invalid/live/user/pass/${id}.ts`
    ).join('\n') + '\n';
}
async function syncWith(channels) {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(playlist(channels));
    try { await sync.syncSource(source.id); } finally { global.fetch = originalFetch; }
}

const EPG = [
    // tvg id, name, icon, has programmes
    ['seven.au', 'Seven', 'http://logos.invalid/seven.png', true],
    ['7mate.au', '7mate', null, true],
    ['sevenflix.au', 'Seven Flix', null, false],
    ['nine.au', 'Nine', null, true],
    ['abcnews.au', 'ABC News', null, true],
    ['abc.au', 'ABC', null, true]
];

const row = (rows, name) => rows.find(r => r.name === name);
const libraryRev = () => sqlite.getDb().prepare(`SELECT value FROM meta WHERE key = 'library_rev'`).get()?.value || '0';

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    adminToken = auth.generateToken(admin);
    viewerToken = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    await syncWith(PLAYLIST);

    const d = sqlite.getDb();
    const now = Date.now();
    const ch = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, stream_icon) VALUES (?, 99, ?, 'epg_channel', ?, ?)`);
    const prog = d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title) VALUES (?, 99, ?, ?, ?)`);
    for (const [id, name, icon, live] of EPG) {
        ch.run(`99:${id}`, id, name, icon);
        if (live) {
            prog.run(id, now - HOUR, now + HOUR, `${name} News`);
            prog.run(id, now + HOUR, now + 2 * HOUR, `${name} Later`);
        }
    }

    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth')); // configures the jwt strategy
    app.use('/api/library', load('routes/library'));
    app.use('/api/epg', load('routes/epg'));
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

test('names are normalised before matching: case, country prefix, quality tags, brackets, punctuation', () => {
    const { normaliseName, similarity } = load('services/epgMapping');
    assert.equal(normaliseName('AU: Seven HD'), 'seven');
    assert.equal(normaliseName('Fox Sports 505 (AU) FHD'), 'fox sports 505');
    assert.equal(normaliseName('UK | Sky News & Weather'), 'sky news and weather');
    assert.equal(normaliseName('Télé-Québec'), 'tele quebec');
    assert.equal(similarity('AU: Seven HD', 'Seven'), 1);
    assert.ok(similarity('Seven Flix', 'Seven') < 1 && similarity('Seven Flix', 'Seven') > similarity('Nine', 'Seven'));
});

test('admin only', async () => {
    assert.equal((await call('GET', '/api/epg/unmatched', { token: viewerToken })).status, 403);
    assert.equal((await call('PUT', '/api/epg/mapping', { token: viewerToken, body: { sourceId: source.id, channelId: 'pos_1', tvgId: 'x' } })).status, 403);
});

test('unmatched lists the visible channels with no programmes in the next 24 h, with scored candidates', async () => {
    const { status, body } = await call('GET', '/api/epg/unmatched');
    assert.equal(status, 200);
    assert.deepEqual(body.channels.map(c => c.name).sort(), ['ABC News', 'AU: Seven HD'], 'Nine has programmes');
    assert.equal(body.total, 2);

    const seven = row(body.channels, 'AU: Seven HD');
    assert.equal(seven.tvgId, 'seven.wrong');
    assert.equal(seven.mapped, false);
    assert.ok(seven.candidates.length >= 1 && seven.candidates.length <= 5);
    assert.deepEqual(seven.candidates[0], { tvgId: 'seven.au', name: 'Seven', score: 1 });
    assert.ok(!seven.candidates.some(c => c.tvgId === 'sevenflix.au'), 'an EPG channel with no programmes is never offered');
    for (let i = 1; i < seven.candidates.length; i++) assert.ok(seven.candidates[i - 1].score >= seven.candidates[i].score, 'best first');

    const abc = row(body.channels, 'ABC News');
    assert.deepEqual(abc.candidates.slice(0, 2).map(c => c.tvgId), ['abcnews.au', 'abc.au']);

    const search = await get('/api/epg/unmatched?search=abc');
    assert.deepEqual(search.channels.map(c => c.name), ['ABC News']);
});

test('the EPG channel search finds by name or id', async () => {
    const found = await get('/api/epg/channels?search=7mate');
    assert.equal(found[0].tvgId, '7mate.au');
    assert.equal(found[0].hasProgrammes, true);
    const byName = await get('/api/epg/channels?search=seven');
    assert.ok(byName.some(c => c.tvgId === 'sevenflix.au' && c.hasProgrammes === false), 'the search shows every EPG channel');
});

test('a mapping bad request is a 400, an unknown channel a 404', async () => {
    assert.equal((await call('PUT', '/api/epg/mapping', { body: { channelId: 'pos_1', tvgId: 'x' } })).status, 400);
    assert.equal((await call('PUT', '/api/epg/mapping', { body: { sourceId: source.id, channelId: 'pos_1', tvgId: 42 } })).status, 400);
    assert.equal((await call('PUT', '/api/epg/mapping', { body: { sourceId: source.id, channelId: 'pos_404', tvgId: 'x' } })).status, 404);
});

test('after mapping, guide rows pick up the programmes, channel rows now/next, and the EPG logo', async () => {
    const before = await get('/api/library/guide?limit=50');
    const sevenBefore = row(before.channels, 'AU: Seven HD');
    assert.deepEqual(sevenBefore.programmes, []);
    assert.equal(sevenBefore.logo, null);
    const rev = libraryRev();

    const put = await call('PUT', '/api/epg/mapping', { body: { sourceId: source.id, channelId: sevenBefore.id, tvgId: 'seven.au' } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, { success: true, tvgId: 'seven.au' });
    assert.notEqual(libraryRev(), rev, 'the guide version moves');

    const guide = await get('/api/library/guide?limit=50');
    const seven = row(guide.channels, 'AU: Seven HD');
    assert.equal(seven.tvgId, 'seven.au');
    assert.deepEqual(seven.programmes.map(p => p.title), ['Seven News', 'Seven Later']);
    assert.match(seven.logo || '', /^\/api\/logo\//, 'the EPG channel\'s logo fills the gap');

    const channels = await get('/api/library/channels?limit=50');
    assert.equal(row(channels.channels, 'AU: Seven HD').now.title, 'Seven News');

    const unmatched = await get('/api/epg/unmatched');
    assert.deepEqual(unmatched.channels.map(c => c.name), ['ABC News']);
    assert.deepEqual((await get('/api/epg/mappings')).map(m => [m.name, m.tvgId]), [['AU: Seven HD', 'seven.au']]);
});

test('the mapping survives a playlist sync that reorders the channels and rewrites tvg_id', async () => {
    await syncWith([PLAYLIST[2], PLAYLIST[1], PLAYLIST[0]]);
    const stored = sqlite.getDb().prepare(`SELECT item_id, tvg_id FROM playlist_items WHERE name = 'AU: Seven HD'`).get();
    assert.equal(stored.tvg_id, 'seven.wrong', 'the sync rewrote the playlist\'s own tvg-id');
    assert.equal(stored.item_id, 'pos_3', 'and the channel moved');

    const seven = row((await get('/api/library/guide?limit=50')).channels, 'AU: Seven HD');
    assert.equal(seven.tvgId, 'seven.au');
    assert.deepEqual(seven.programmes.map(p => p.title), ['Seven News', 'Seven Later']);
});

test('removing the mapping returns the channel to the playlist\'s tvg-id', async () => {
    const put = await call('PUT', '/api/epg/mapping', { body: { sourceId: source.id, channelId: 'pos_3', tvgId: null } });
    assert.deepEqual(put.body, { success: true, tvgId: null });
    const seven = row((await get('/api/library/guide?limit=50')).channels, 'AU: Seven HD');
    assert.equal(seven.tvgId, 'seven.wrong');
    assert.deepEqual(seven.programmes, []);
    assert.deepEqual(await get('/api/epg/mappings'), []);
});

test('the web Settings panel lists unmatched channels with candidate buttons and maps one with PUT /api/epg/mapping', async () => {
    const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
    const requests = [];
    const el = () => ({ innerHTML: '', textContent: '', value: '', classList: { toggle() {} }, addEventListener() {} });
    const elements = Object.fromEntries(['epg-match-list', 'epg-mapping-list', 'epg-match-status', 'epg-match-search-panel',
        'epg-match-search-for', 'epg-match-search-results', 'epg-match-search', 'epg-match-filter'].map(id => [id, el()]));
    const replies = {
        'GET /api/epg/unmatched': { total: 1, channels: [{ sourceId: 1, id: 'pos_1', name: 'AU: <Seven> HD', tvgId: 'seven.wrong', mapped: false,
            candidates: [{ tvgId: 'seven.au', name: 'Seven', score: 1 }, { tvgId: '7mate.au', name: '7mate', score: 0.4 }] }] },
        'GET /api/epg/mappings': [],
        'PUT /api/epg/mapping': { success: true, tvgId: 'seven.au' },
        'GET /api/epg/channels?search=Seven': [{ tvgId: 'sevenflix.au', name: 'Seven Flix', score: 0.7 }]
    };
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
        document: { getElementById: (id) => elements[id] || null, querySelectorAll: () => [] },
        setTimeout, clearTimeout,
        fetch: async (url, opts = {}) => {
            const key = `${opts.method || 'GET'} ${url}`;
            requests.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined });
            const body = replies[key];
            const status = body === undefined ? 404 : 200;
            return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
        }
    });
    context.window = context;
    vm.runInContext(js('api.js'), context);
    vm.runInContext(js('pages/Settings.js'), context);
    const settings = Object.create(context.SettingsPage.prototype);
    Object.assign(settings, { epgUnmatched: [], epgMappings: [], epgFilter: '', epgSelected: null, epgSearchResults: [] });

    assert.equal(typeof settings.loadEpgMatching, 'function', 'the panel exists');
    await settings.loadEpgMatching();
    const html = elements['epg-match-list'].innerHTML;
    assert.ok(html.includes('AU: &lt;Seven&gt; HD'), 'escaped');
    assert.match(html, /data-epg-action="map" data-key="1:pos_1"\s+data-tvg="seven.au"/);
    assert.ok(html.includes('100%'));
    assert.match(elements['epg-match-status'].textContent, /^1 channel without/);

    settings.selectEpgRow('1:pos_1');
    await new Promise(r => setImmediate(r));
    assert.equal(elements['epg-match-search'].value, 'AU: <Seven> HD');

    await settings.mapEpgChannel('1:pos_1', 'seven.au');
    const put = requests.find(r => r.key === 'PUT /api/epg/mapping');
    assert.deepEqual(JSON.parse(JSON.stringify(put.body)), { sourceId: 1, channelId: 'pos_1', tvgId: 'seven.au' });
    assert.equal(elements['epg-match-status'].textContent, 'Mapped to seven.au');
});
