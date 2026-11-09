const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #265 (C-X): one rule reads a channel's picture quality from its name, for the sport channels (C-I), the guide and
// channel rows, and the backup linker's classes. Before it, the guide and channel rows carried no quality, the sport
// rule counted FHD as HD and missed superscript tags ("SKY SPORTS F1 ᵁᴴᴰ"), and /api/info had no `channelQuality`.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-channel-quality-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');

let server, base, token;
const get = async route => (await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } })).json();

const channels = {
    'UK| SKY SPORTS F1 ᵁᴴᴰ': 'UHD',
    'Sky Sports F1 4K HDR': 'UHD',
    'UK| SKY SPORTS F1 FHD': 'FHD',
    'Sky Sports Main Event 1080p50': 'FHD',
    'Sky Sports F1 HD': 'HD',
    'ESPN (720p)': 'HD',
    'Sky Sports F1 SD': 'SD',
    'NESN (540p)': 'SD',
    'Sky Sports News': null,
    'HDTV Classics': null
};

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken(admin);
    const source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    const insert = sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url)
                                           VALUES (?, ?, ?, 'live', ?, 'Sport', 0, ?, ?, ?)`);
    Object.keys(channels).forEach((name, i) =>
        insert.run(`${source.id}:pos_${i}`, source.id, `pos_${i}`, name, i + 1, `s${i}`, `http://provider.invalid/live/u/p/${i}.ts`));
    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/info', load('routes/info'));
    app.use('/api/library', load('routes/library'));
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

test('the label from a name: UHD, FHD, HD, SD or null; superscripts fold; the highest tag wins', () => {
    const { qualityLabel } = load('services/channelQuality');
    for (const [name, want] of Object.entries(channels)) assert.equal(qualityLabel(name), want, name);
    assert.equal(qualityLabel('Sky Sports F1 UHD/HD'), 'UHD');
    assert.equal(qualityLabel(''), null);
    assert.equal(qualityLabel(null), null);
});

test('best first: UHD, FHD, HD, untagged, SD', () => {
    const { qualityRank } = load('services/channelQuality');
    const order = ['SD', null, 'HD', 'UHD', 'FHD'].sort((a, b) => qualityRank(a) - qualityRank(b));
    assert.deepEqual(order, ['UHD', 'FHD', 'HD', null, 'SD']);
});

test('the backup linker keeps its classes: FHD and HD are both hd', () => {
    const { qualityOf } = load('services/channelLinks');
    assert.equal(qualityOf('UK| SKY SPORTS F1 FHD'), 'hd');
    assert.equal(qualityOf('Sky Sports F1 HD'), 'hd');
    assert.equal(qualityOf('UK| SKY SPORTS F1 ᵁᴴᴰ'), 'uhd');
    assert.equal(qualityOf('Sky Sports F1 SD'), 'sd');
    assert.equal(qualityOf('Sky Sports News'), 'unknown');
});

test('/api/info advertises channelQuality', async () => {
    assert.equal((await get('/api/info')).features.channelQuality, true);
});

test('guide, channels and favourites rows carry quality, always present', async () => {
    const guide = await get('/api/library/guide?limit=50');
    const list = await get('/api/library/channels?limit=50');
    const byName = rows => Object.fromEntries(rows.map(r => [r.name, r.quality]));
    assert.deepEqual(byName(guide.channels), channels);
    assert.deepEqual(byName(list.channels), channels);
    for (const row of [...guide.channels, ...list.channels]) assert.ok('quality' in row, `${row.name}: the field is always present`);
});
