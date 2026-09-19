const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// Copy the server so its relative data paths never touch real data (same
// approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-logos-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const db = load('db');
const auth = load('auth');
const sync = load('services/syncService');
const libraryRouter = load('routes/library');

let server, base, token, source, epg;
const get = async (route) => (await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } })).json();
const byName = (channels) => Object.fromEntries(channels.map(c => [c.name, c.logo]));

before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken({ ...user, id: 1 });
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'https://provider.invalid/list.m3u' });
    epg = await db.sources.create({ type: 'epg', name: 'Guide', url: 'https://guide.invalid/x.xml' });

    const m3u = [
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="has.logo" tvg-logo="https://playlist.invalid/own.png" group-title="All",Has Own Logo',
        'https://provider.invalid/1.ts',
        '#EXTINF:-1 tvg-id="by.id" group-title="All",Matched By Id',
        'https://provider.invalid/2.ts',
        '#EXTINF:-1 group-title="All",  BBC   ONE  ',
        'https://provider.invalid/3.ts',
        '#EXTINF:-1 tvg-id="nothing" group-title="All",No Match Anywhere',
        'https://provider.invalid/4.ts',
        ''
    ].join('\n');
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(m3u);
    try { await sync.syncM3u(source); } finally { global.fetch = originalFetch; }

    // What an EPG sync stores: one epg_channel row per channel, icon in stream_icon.
    const ins = sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, stream_icon, data)
                                        VALUES (?, ?, ?, 'epg_channel', ?, ?, '{}')`);
    ins.run(`${epg.id}:has.logo`, epg.id, 'has.logo', 'Has Own Logo', 'https://epg.invalid/should-not-win.png');
    ins.run(`${epg.id}:by.id`, epg.id, 'by.id', 'Some Other Display Name', 'https://epg.invalid/by-id.png');
    ins.run(`${epg.id}:bbc1`, epg.id, 'bbc1', 'bbc one', 'https://epg.invalid/bbc-one.png');
    ins.run(`${epg.id}:blank`, epg.id, 'blank', 'No Match Anywhere Else', '');   // an EPG channel with no icon

    const app = express();
    app.use(auth.passport.initialize());
    app.use('/api/auth', load('routes/auth')); // registers the JWT strategy
    app.use('/api/library', libraryRouter);
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

test('a channel with no playlist logo gets the EPG icon for its tvg-id, else for its name', async () => {
    const logos = byName((await get('/api/library/channels')).channels);
    assert.equal(logos['Matched By Id'], 'https://epg.invalid/by-id.png', 'matched on tvg-id');
    // The playlist's name is "  BBC   ONE  " and the EPG's is "bbc one".
    assert.equal(logos['BBC   ONE'], 'https://epg.invalid/bbc-one.png', 'matched on name, ignoring case and spacing');
});

test('a logo the playlist supplied is never replaced', async () => {
    const logos = byName((await get('/api/library/channels')).channels);
    assert.equal(logos['Has Own Logo'], 'https://playlist.invalid/own.png');
});

test('with no match anywhere the logo stays null, and an icon-less EPG entry is not used', async () => {
    const logos = byName((await get('/api/library/channels')).channels);
    assert.equal(logos['No Match Anywhere'], null);
});

test('the guide gets the same fallback as the channel list', async () => {
    const logos = byName((await get('/api/library/guide?limit=10')).channels);
    assert.equal(logos['Matched By Id'], 'https://epg.invalid/by-id.png');
    assert.equal(logos['BBC   ONE'], 'https://epg.invalid/bbc-one.png');
    assert.equal(logos['Has Own Logo'], 'https://playlist.invalid/own.png');
});

test('the response shape is unchanged: every field the client reads is still there, and logo is a string or null', async () => {
    const channels = (await get('/api/library/channels')).channels;
    for (const ch of channels) {
        for (const field of ['id', 'sourceId', 'name', 'logo', 'category', 'tvgId', 'order', 'now', 'next', 'favourite']) {
            assert.ok(field in ch, `${field} must still be present`);
        }
        assert.ok(ch.logo === null || typeof ch.logo === 'string');
    }
    const guide = (await get('/api/library/guide?limit=10')).channels;
    for (const field of ['id', 'sourceId', 'name', 'logo', 'category', 'tvgId', 'programmes']) assert.ok(field in guide[0], `guide: ${field}`);
});

test('the icon index is reused, then rebuilt: a new EPG icon appears after a reset, not before', async () => {
    sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, stream_icon, data)
                            VALUES (?, ?, 'nothing', 'epg_channel', 'x', 'https://epg.invalid/late.png', '{}')`).run(`${epg.id}:nothing`, epg.id);
    assert.equal(byName((await get('/api/library/channels')).channels)['No Match Anywhere'], null, 'index still cached');
    libraryRouter._resetEpgIconIndex();
    assert.equal(byName((await get('/api/library/channels')).channels)['No Match Anywhere'], 'https://epg.invalid/late.png');
});
