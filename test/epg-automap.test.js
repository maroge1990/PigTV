const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// R10 (Wave 4): EPG matching tune-ups. A suggestion in the channel's own country scores 0.15 more,
// one in another country 0.15 less; and "Auto-map" maps every clearly-matched channel at once
// (score >= 0.90 and 0.05 ahead of the next), previewed first, applied as one batch that can be
// undone, never over a mapping made by hand. The old code has neither (no /auto-map: 404).
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-epg-automap-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const epgMapping = load('services/epgMapping');

let server, base, token, source;
const NOW = Date.now();

async function call(method, route, body) {
    const res = await fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json };
}

before(async () => {
    source = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/list.m3u' });
    const d = sqlite.getDb();
    const live = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, tvg_id, is_hidden)
                            VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, 0)`);
    const epgCh = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name) VALUES (?, ?, ?, 'epg_channel', ?)`);
    const prog = d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title) VALUES (?, ?, ?, ?, ?)');
    [
        ['p1', 'AU: Seven Sydney', 'AU | General', null],
        ['p2', 'UK: BBC One', 'UK | General', null],
        ['p3', 'Fox Sports 503', 'AU | Sport', null],       // two look alike: left for a person
        ['p4', 'AU: Nine', 'AU | General', null],           // mapped by hand below
        ['p5', 'Discovery Science', 'Docs', null]           // no good match
    ].forEach(([id, name, cat, tvg], i) => live.run(`${source.id}:${id}`, source.id, id, name, cat, i, `s-${id}`, tvg));
    [
        ['SevenSydney.au', 'Seven Sydney'], ['SevenSydney.nz', 'Seven Sydney'],
        ['BBCOne.uk', 'BBC One'], ['BBCOne.au', 'BBC One'],
        ['FoxSports503.au', 'Fox Sports 503'], ['FoxSports503HD.au', 'Fox Sports 503 HD'],
        ['Nine.au', 'Nine'], ['NineSydney.au', 'Nine Sydney'],
        ['Science.us', 'Science Channel']
    ].forEach(([tvg, name]) => {
        epgCh.run(`epg:${tvg}`, source.id, tvg, name);
        prog.run(tvg, source.id, NOW - 3600e3, NOW + 3600e3, 'Something');
    });

    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken(user);
    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
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
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('the channel\'s country decides between two EPG channels of the same name', async () => {
    const { channels } = (await call('GET', '/api/epg/unmatched')).body;
    const seven = channels.find(c => c.id === 'p1');
    assert.deepEqual(seven.candidates.slice(0, 2).map(c => [c.tvgId, c.score]), [['SevenSydney.au', 1], ['SevenSydney.nz', 0.85]]);
    const bbc = channels.find(c => c.id === 'p2');
    assert.equal(bbc.candidates[0].tvgId, 'BBCOne.uk', 'a UK channel prefers the .uk id');
    assert.deepEqual([epgMapping.regionOfChannel({ name: 'ESPN' }), epgMapping.regionAdjusted(0.8, null, 'x.au')], [null, 0.8], 'unknown country: unchanged');
});

test('auto-map previews, applies as one batch, never over a hand mapping, and can be undone', async () => {
    assert.equal((await call('PUT', '/api/epg/mapping', { sourceId: source.id, channelId: 'p4', tvgId: 'NineSydney.au' })).status, 200);

    const preview = (await call('GET', '/api/epg/auto-map')).body;
    assert.equal(preview.threshold, 0.9);
    assert.deepEqual(preview.channels.map(c => [c.id, c.tvgId]).sort(), [['p1', 'SevenSydney.au'], ['p2', 'BBCOne.uk']],
        'Fox 503 has two near-equal suggestions, Nine is mapped by hand, Discovery has no good match');
    assert.equal(sqlite.getDb().prepare('SELECT COUNT(*) AS n FROM epg_mappings').get().n, 1, 'a preview stores nothing');

    const applied = (await call('POST', '/api/epg/auto-map', {})).body;
    assert.equal(applied.mapped, 2);
    assert.match(applied.batch, /^auto-\d+$/);
    assert.equal(epgMapping.overrideFor(source.id, 's-p1', 'p1'), 'SevenSydney.au');
    assert.equal(epgMapping.overrideFor(source.id, 's-p4', 'p4'), 'NineSydney.au', 'the hand mapping is untouched');
    assert.deepEqual((await call('GET', '/api/epg/auto-map')).body.batches.map(b => [b.batch, b.count]), [[applied.batch, 2]]);

    // One of them changed by hand afterwards is the admin's now: undo leaves it.
    await call('PUT', '/api/epg/mapping', { sourceId: source.id, channelId: 'p2', tvgId: 'BBCOne.au' });
    const undone = (await call('DELETE', `/api/epg/auto-map/${applied.batch}`)).body;
    assert.equal(undone.removed, 1);
    epgMapping.reset();
    assert.equal(epgMapping.overrideFor(source.id, 's-p1', 'p1'), null);
    assert.equal(epgMapping.overrideFor(source.id, 's-p2', 'p2'), 'BBCOne.au');
    assert.equal((await call('DELETE', '/api/epg/auto-map/../../x')).status, 404);
    assert.equal((await call('DELETE', '/api/epg/auto-map/nope')).status, 400);
});
