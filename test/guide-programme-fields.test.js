const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #56: guide programmes carry, additively, `live` (the guide's live flag or a live sport game's airing, never a
// replay), `new` (new/premiere true, previously shown false, else absent), `subtitle`, `episode` ("S2 E5") and `image`
// (/api/logo/<key>, never the provider's address). Before #56 they carried title, description and times only.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-progfields-'));
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
const { keyForUrl } = load('services/logoCache');

const H = 3600000;
const M = 60000;
const NOW = Date.now();
let server, base, token;

const PLAYLIST = '#EXTM3U\n'
    + '#EXTINF:-1 tvg-id="ent" group-title="Entertainment",Entertainment One\nhttp://provider.invalid/live/u/p/1.ts\n'
    + '#EXTINF:-1 tvg-id="espn" group-title="US Sports",ESPN\nhttp://provider.invalid/live/u/p/2.ts\n';

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken(admin);
    const source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'http://provider.invalid/list.m3u' });
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(PLAYLIST);
    try { await sync.syncSource(source.id); } finally { global.fetch = originalFetch; }

    const ins = sqlite.getDb().prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, description, categories, flags, data)
        VALUES (?, 99, ?, ?, ?, '', ?, ?, ?)`);
    const data = (o) => JSON.stringify(o);
    ins.run('ent', NOW - 10 * M, NOW + 20 * M, 'Doctor Who', null, 4, data({ sub: 'The Star Beast', ep: '1.4.0/1', img: 'https://images.provider.invalid/dw.jpg?user=secret' }));
    ins.run('ent', NOW + 20 * M, NOW + 80 * M, 'Doctor Who', null, 1, data({ sub: 'Wild Blue Yonder', ep: 'S2E5' }));
    ins.run('ent', NOW + 80 * M, NOW + 140 * M, 'News at Ten', null, 8, null);
    ins.run('ent', NOW + 140 * M, NOW + 200 * M, 'Late Film', null, null, data({ img: 'javascript:alert(1)' }));
    ins.run('espn', NOW - 10 * M, NOW + 2 * H, 'NBA: Lakers v Celtics', JSON.stringify(['Basketball']), null, null);
    ins.run('espn', NOW + 3 * H, NOW + 5 * H, 'Classic: Lakers v Celtics 2019', JSON.stringify(['Sport', 'Basketball']), null, null);
    const { LIVE_HOURS } = load('services/sportsClassify');
    for (const league of Object.keys(LIVE_HOURS)) delete LIVE_HOURS[league];

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

async function guide() {
    const r = await fetch(`${base}/api/library/guide?start=${NOW - H}&end=${NOW + 6 * H}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    return { body, raw: JSON.stringify(body), byName: Object.fromEntries(body.channels.map(c => [c.name, c.programmes])) };
}

test('#56: subtitle, episode, new and image where the guide knows them; absent where it does not', async () => {
    const { byName, raw } = await guide();
    const [dw1, dw2, news, film] = byName['Entertainment One'];
    assert.equal(dw1.subtitle, 'The Star Beast');
    assert.equal(dw1.episode, 'S2 E5', 'xmltv_ns 1.4.0/1 is season 2, episode 5');
    assert.equal(dw1.new, true);
    assert.equal(dw1.image, `/api/logo/${keyForUrl('https://images.provider.invalid/dw.jpg?user=secret')}`);
    assert.equal(dw2.episode, 'S2 E5');
    assert.equal(dw2.new, false, 'previously shown');
    assert.equal(dw2.image, undefined);
    assert.equal(news.live, true, 'the guide flags it live');
    for (const key of ['new', 'subtitle', 'episode', 'image']) assert.ok(!(key in news), `${key} absent when unknown`);
    assert.ok(!('live' in dw1), 'live absent when not known to be live');
    assert.ok(!('image' in film), 'only an http(s) image');
    assert.doesNotMatch(raw, /images\.provider\.invalid|secret/, 'never the provider address');
});

test('#56: a live sport game\'s airing is live, its replay is not (from the built event list, never building one)', async () => {
    const events = load('services/sportsEvents');
    events.reset();
    assert.equal(events.liveAirings?.(), null, 'nothing built: nothing known');
    let espn = (await guide()).byName.ESPN;
    assert.ok(!('live' in espn[0]), 'no event list: not marked');
    await events.eventsFor({ hours: 72 });
    espn = (await guide()).byName.ESPN;
    assert.equal(espn[0].title, 'NBA: Lakers v Celtics');
    assert.equal(espn[0].live, true);
    assert.equal(espn[1].title, 'Classic: Lakers v Celtics 2019');
    assert.ok(!('live' in espn[1]), 'a replay is not live');
});

test('#56: episode text from the forms <episode-num> takes', () => {
    const { episodeText } = load('services/programmeFields');
    assert.equal(episodeText('S02E05'), 'S2 E5');
    assert.equal(episodeText('S2 E5'), 'S2 E5');
    assert.equal(episodeText('Season 3 Episode 12'), 'S3 E12');
    assert.equal(episodeText('0.0.'), 'S1 E1');
    assert.equal(episodeText('.11/20.'), 'E12');
    assert.equal(episodeText('E7'), 'E7');
    assert.equal(episodeText('EP0123456'), null, 'a dd_progid is not an episode');
    assert.equal(episodeText('1.'), null, 'no episode number');
    assert.equal(episodeText(''), null);
    assert.equal(episodeText(null), null);
});
