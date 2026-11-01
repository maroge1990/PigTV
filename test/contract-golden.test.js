const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const express = require('express');
const jwt = require('jsonwebtoken');

// #52: golden answers from the real handlers, so the Apple client's contract checks decode what the server really
// emits (test/golden/README.md). The real routers on a sandboxed database, a real Xtream sync of the fake provider
// (scripts/fake-provider.js), and ESPN through the sport pages' fetcher seams with the stored samples in test/fixtures.
// GOLDEN_UPDATE=1 rewrites test/golden/; otherwise each answer's SHAPE (keys and value types, recursively; an array by
// the merged shape of its elements; a null fits the golden's type, but a field the golden only had as null takes no
// other type; an empty array fits any array) must equal the committed file's.
const UPDATE = process.env.GOLDEN_UPDATE === '1';
const GOLDEN = path.join(__dirname, 'golden');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-golden-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-golden-signing-key-at-least-32-characters';
process.env.PIGTV_DB_BACKUPS = '0';
delete process.env.PIGTV_SPORTS_DASHBOARD;
delete process.env.PIGTV_SPORT_FIXTURES;
delete process.env.PIGTV_BUILD; delete process.env.PIGTV_COMMIT; delete process.env.PIGTV_BUILT_AT;
// A zone where it is mid-morning now, so the front page's games (5 h before to 3 h after now) are all today (as sport-front).
const MIN = 60000, H = 60 * MIN;
let offset = 10 - new Date().getUTCHours();
if (offset < -12) offset += 24;
process.env.TZ = offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
process.chdir(sandbox);

// Nothing here may leave the machine: any request to a host other than this one fails, and is reported at the end.
const offHost = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { offHost.push(url.origin + url.pathname); return Promise.reject(new Error('golden: off-host request refused')); }
    return realFetch(input, init);
};

// The sport pages' samples were captured at fixed times: their routes run with the clock moved there (a Date that
// keeps ticking, shifted), everything else on the real clock.
const RealDate = Date;
let shift = 0;
class ShiftedDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + shift); else super(...a); }
    static now() { return RealDate.now() + shift; }
}
globalThis.Date = ShiftedDate;
async function atClock(ms, fn) { shift = ms - RealDate.now(); try { return await fn(); } finally { shift = 0; } }

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');
const sportsEvents = load('services/sportsEvents');
const dashboard = load('services/sportsDashboard');
const transcodeSession = load('services/transcodeSession');
const engine = load('services/recordingEngine');
const segments = load('services/recordingSegments');
const { recordings: recordingsDb } = load('db/recordingsDb');
sportsEvents._buildInline(true);
const { createFakeProvider } = require('../scripts/fake-provider');

const LOGIN = { user: 'golden-user', pass: 'golden-pass-5e2f' };
let fake, providerBase, source, server, base, owner, tokenA, tokenB, T0;

const fx = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', rel), 'utf8'));

before(async () => {
    fake = createFakeProvider({ profile: 'a', ...LOGIN, channels: 1, quiet: true, maxConnections: 1, lingerMs: 500 });
    providerBase = await fake.listen(0, '127.0.0.1');
    T0 = Date.parse(fake.status().anchor) + 5 * MIN; // as fake-provider.test.js: the guide is anchored on this half hour
    source = await db.sources.create({ type: 'xtream', name: 'FakeTV', url: providerBase, username: LOGIN.user, password: LOGIN.pass });
    await sync.syncSource(source.id);
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    owner = user.id;
    const device = (id) => {
        sqlite.getDb().prepare('INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, String(owner), id, 'tvOS', Date.now(), Date.now());
        // No expiry: the sport pages run on a moved clock.
        return jwt.sign({ id: owner, username: 'owner', role: 'admin', deviceId: id }, process.env.JWT_SECRET);
    };
    tokenA = device('golden-apple-tv');
    tokenB = device('golden-ipad');
    load('db/recordingsDb').initSchema();
    await db.settings.update({ recordingsPath: path.join(sandbox, 'recordings'), minFreeSpaceGB: 0, maxConcurrentRecordings: 1 });
    segments._setWorkRoot(path.join(sandbox, 'work'));

    // The mounts index.js makes for these routes, in its order, with what index.js puts in front of them.
    const { streamAuth } = load('auth');
    const app = express();
    app.locals.ffmpegPath = 'ffmpeg';
    app.locals.ffprobePath = 'ffprobe';
    app.use(express.json({ limit: '2mb' }));
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    app.use('/api/playback', load('routes/playback'));
    app.use('/api/library', load('routes/library'));
    app.use('/api/sports', load('routes/sports'));
    app.use('/api/info', load('routes/info'));
    app.use('/api/recordings', streamAuth, load('routes/recordings'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    for (const s of transcodeSession.getAllSessions()) { try { await transcodeSession.removeSession(s.id); } catch { /* gone */ } }
    try { load('services/ingest').closeAll('test over'); } catch { /* none */ }
    server?.closeAllConnections?.();
    server?.close();
    await fake?.close();
    try { dashboard.stop(); } catch { /* not started */ }
    try { await sportsEvents.shutdown(); } catch { /* no worker */ }
    try { sqlite.getDb().close(); } catch { /* closed */ }
    globalThis.fetch = realFetch;
    globalThis.Date = RealDate;
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

async function call(method, route, { body, token = tokenA } = {}) {
    const r = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, text, body: json };
}

// ---- normalising ------------------------------------------------------------------------------------------------

const FIXED = Date.parse('2026-11-01T00:00:00Z');
const isTime = (v) => Number.isFinite(v) && v > 1.5e12 && v < 2.5e12;
const STRING_RULES = [
    [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>'],
    [/([?&]token=)[^&"\s]+/g, '$1<token>'],
    [/([?&]h=)[0-9a-f]{32}/g, '$1<handle>'],
    [/\/api\/logo\/[\w.-]+/g, '/api/logo/<key>'],
    [/\/api\/transcode\/[^/]+\//g, '/api/transcode/<session>/'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>']
];
/** Times moved by `delta` (a real-clock answer onto 1 Nov 2026 00:00 UTC), volatile ids and paths replaced. */
function normalise(value, delta, key = '') {
    if (Array.isArray(value)) return value.map(v => normalise(v, delta));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalise(value[k], delta, k)]));
    if (typeof value === 'number') return isTime(value) ? Math.round((value + delta) / MIN) * MIN : value;
    if (typeof value !== 'string') return value;
    if (['sessionId', 'id'].includes(key) && /^[0-9a-f-]{16,}$/i.test(value)) return '<session>';
    if (/^[0-9a-f]{16,}$/.test(value)) return '<hex>';
    if (['build', 'commit', 'display', 'version', 'timezone', 'builtAt'].includes(key)) return `<${key}>`;
    let s = value.split(sandbox).join('<sandbox>');
    for (const [re, to] of STRING_RULES) s = s.replace(re, to);
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s) && delta) { const t = RealDate.parse(s); if (Number.isFinite(t)) s = new RealDate(t + delta).toISOString(); }
    return s;
}

// ---- shapes -------------------------------------------------------------------------------------------------------

/** { t: Set of 'null'|'string'|'number'|'boolean'|'object'|'array', keys?: {k: shape}, items?: shape } */
function shapeOf(v) {
    if (v === null || v === undefined) return { t: new Set(['null']) };
    if (Array.isArray(v)) return { t: new Set(['array']), items: v.length ? v.map(shapeOf).reduce(merge) : null };
    if (typeof v === 'object') return { t: new Set(['object']), keys: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)])) };
    return { t: new Set([typeof v]) };
}
function merge(a, b) {
    if (!a) return b; if (!b) return a;
    const out = { t: new Set([...a.t, ...b.t]) };
    if (a.keys || b.keys) {
        out.keys = { ...(a.keys || {}) };
        for (const [k, s] of Object.entries(b.keys || {})) out.keys[k] = merge(out.keys[k], s);
    }
    if (a.items !== undefined || b.items !== undefined) out.items = merge(a.items || null, b.items || null);
    return out;
}
const typesOf = (s) => [...s.t].filter(t => t !== 'null').sort();
/** The differences between two shapes, as "path: what changed". */
function diff(golden, fresh, at = '$') {
    const out = [];
    const g = typesOf(golden), f = typesOf(fresh);
    if (g.length && f.length && g.join('|') !== f.join('|')) return [`${at}: was ${g.join('|')}, now ${f.join('|')}`];
    // A field the golden only ever had as null says nothing about its type: a value there must be in the golden first.
    if (!g.length && f.length) return [`${at}: was always null, now ${f.join('|')} (regenerate with a fixture that sends it)`];
    if (golden.keys && fresh.keys) {
        for (const k of Object.keys(golden.keys)) if (!(k in fresh.keys)) out.push(`${at}.${k}: no longer sent`);
        for (const k of Object.keys(fresh.keys)) if (!(k in golden.keys)) out.push(`${at}.${k}: new`);
        for (const k of Object.keys(golden.keys)) if (k in fresh.keys) out.push(...diff(golden.keys[k], fresh.keys[k], `${at}.${k}`));
    }
    if (golden.items && fresh.items) out.push(...diff(golden.items, fresh.items, `${at}[]`));
    return out;
}

/** Arrays cut to the elements that show every key and type the whole array has (at least two), so files stay small. */
const shapeKey = (s) => JSON.stringify(serialShape(s));
function trim(v) {
    if (Array.isArray(v)) {
        const full = shapeKey(v.length ? v.map(shapeOf).reduce(merge) : null);
        const kept = [];
        let seen = null;
        for (const x of v) {
            const next = merge(seen, shapeOf(x));
            if (kept.length < 2 || shapeKey(next) !== shapeKey(seen)) { kept.push(x); seen = next; }
            if (kept.length >= 2 && shapeKey(seen) === full) break;
        }
        return kept.map(trim);
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)]));
    return v;
}
function serialShape(s) {
    if (!s) return null;
    return { t: [...s.t].sort(), ...(s.keys ? { k: Object.fromEntries(Object.keys(s.keys).sort().map(k => [k, serialShape(s.keys[k])])) } : {}),
        ...(s.items !== undefined ? { i: serialShape(s.items) } : {}) };
}

// ---- the goldens ---------------------------------------------------------------------------------------------------

const index = {};
// Neither the provider's address nor its login may appear: channel logos go through the logo cache (/api/logo/<key>).
const SECRETS = () => [providerBase, new URL(providerBase).host, LOGIN.pass, LOGIN.user];

/** Check (or, with GOLDEN_UPDATE=1, write) one answer. `delta` moves its times (real-clock answers). */
function golden(name, method, route, r, { status, delta = FIXED - T0 } = {}) {
    if (status !== undefined) assert.equal(r.status, status, `${name}: ${method} ${route} answered ${r.status}: ${r.text.slice(0, 300)}`);
    assert.ok(r.body !== undefined, `${name}: not JSON`);
    for (const s of SECRETS()) assert.ok(!r.text.includes(s), `${name}: the answer carries the provider's address or login (${s})`);
    for (const t of [tokenA, tokenB]) assert.ok(!r.text.includes(t), `${name}: the answer carries the bearer token`);
    const body = trim(normalise(r.body, delta));
    const file = path.join(GOLDEN, `${name}.json`);
    index[name] = { method, route, status: r.status };
    if (UPDATE) {
        fs.mkdirSync(GOLDEN, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
        return body;
    }
    assert.ok(fs.existsSync(file), `${name}: no golden (test/golden/${name}.json); run GOLDEN_UPDATE=1 node --test test/contract-golden.test.js`);
    const changes = diff(shapeOf(JSON.parse(fs.readFileSync(file, 'utf8'))), shapeOf(body));
    assert.deepEqual(changes, [], `${method} ${route} (test/golden/${name}.json) changed shape:\n  ${changes.join('\n  ')}\n` +
        'If this is intended: regenerate with GOLDEN_UPDATE=1, write it into docs/CLIENT-CONTRACT.md, and let the Apple side decode it.');
    return body;
}
const get = async (name, route, opts = {}) => golden(name, 'GET', route, await call('GET', route, opts), { status: 200, ...opts });

// ---- /api/info --------------------------------------------------------------------------------------------------

test('info, and the fallback a client gets when a feature check throws', async () => {
    await get('info', '/api/info', { token: null });
    const realCheck = dashboard.dashboardEnabled;
    dashboard.dashboardEnabled = () => { throw new Error('a feature check failed'); };
    try { await get('info-fallback', '/api/info', { token: null }); } finally { dashboard.dashboardEnabled = realCheck; }
});

// ---- the guide and C-I -----------------------------------------------------------------------------------------

test('a guide page and the sport events from a real sync of the fake provider', async () => {
    const page = await get('library-guide', '/api/library/guide?limit=4');
    assert.ok(page.channels.length && page.channels.some(c => c.programmes.length), 'channels with their programmes');
    // The first answer after the sync comes from the build the sync started, before any request passed its logo step.
    const events = await get('sports-events', '/api/sports/events?hours=72');
    assert.ok(events.events.length > 0);
    const logos = events.events.flatMap(e => e.channels.map(c => c.logo));
    assert.ok(logos.some(Boolean), 'the fake provider serves channel logos');
    assert.deepEqual(logos.filter(l => l !== null && !l.startsWith('/api/logo/')), [], 'every channel logo through the logo cache');
});

// ---- recordings (C-L, C-M, C-N, #12) ----------------------------------------------------------------------------

const channelOf = (name) => sqlite.getDb().prepare(`SELECT item_id, stable_id, name FROM playlist_items WHERE source_id = ? AND name = ?`).get(source.id, name);
let clashFirst, clashLater, footy;

test('recordings: a finished and a recording-in-progress row; the schedule list with a clash (conflictsWith, beatenBy); rules', async () => {
    // Two schedules three hours out on different channels with the recording limit at one: the first made wins.
    const start = T0 + 3 * H, end = start + H;
    footy = channelOf('AU| FOX FOOTY HD');
    const cricket = channelOf('AU| FOX CRICKET HD');
    const schedule = (ch, title) => call('POST', '/api/recordings/schedule', { body: { sourceId: source.id, channelItemId: ch.item_id,
        channelName: ch.name, title, programStart: start, programEnd: end } });
    const first = await schedule(footy, 'AFL: Collingwood v Carlton (golden)');
    assert.equal(first.status, 201);
    clashFirst = first.body;

    // C-N: a guide programme with its artwork (the fake guide's <icon>), scheduled anew; then one stored with its
    // artwork's address by an earlier server, asked for again (the duplicate answer) and cancelled. Each answer gives
    // `image` as /api/logo/<key>, never the address itself (golden() asserts the provider's host is in none).
    const programme = (ch, after) => {
        const tvg = sqlite.getDb().prepare('SELECT tvg_id FROM playlist_items WHERE source_id = ? AND item_id = ?').get(source.id, ch.item_id).tvg_id;
        return sqlite.getDb().prepare(`SELECT title, start_time, end_time, data FROM epg_live WHERE channel_id = ? AND start_time > ?
            AND data LIKE '%"img"%' ORDER BY start_time LIMIT 1`).get(tvg, after);
    };
    const art = programme(footy, T0 + 20 * H);
    assert.ok(art && JSON.parse(art.data).img.startsWith(providerBase), 'the fake guide gives sport programmes artwork');
    const scheduleProgramme = (ch, p) => call('POST', '/api/recordings/schedule', { body: { sourceId: source.id, channelItemId: ch.item_id,
        channelName: ch.name, title: p.title, programStart: p.start_time, programEnd: p.end_time } });
    const fresh = await scheduleProgramme(footy, art);
    golden('recordings-schedule', 'POST', '/api/recordings/schedule', fresh, { status: 201 });
    assert.match(fresh.body.image, /^\/api\/logo\//);
    assert.equal('image_url' in fresh.body, false);
    const older = programme(cricket, T0 + 20 * H);
    const earlier = load('db/recordingsDb').scheduled.create({ title: older.title, description: null, source_id: source.id, channel_item_id: cricket.item_id,
        channel_name: cricket.name, channel_logo: null, program_start: older.start_time, program_end: older.end_time, pre_buffer_min: 0, post_buffer_min: 0,
        created_by: owner, created_at: Date.now() });
    sqlite.getDb().prepare('UPDATE scheduled_recordings SET image_url = ? WHERE id = ?').run(JSON.parse(older.data).img, earlier.id);
    const again = await scheduleProgramme(cricket, older);
    golden('recordings-schedule-existing', 'POST', '/api/recordings/schedule', again, { status: 201 });
    assert.deepEqual([again.body.id, 'image_url' in again.body], [earlier.id, false], 'the stored schedule, without its address');
    assert.match(again.body.image, /^\/api\/logo\//);
    const cancelled = await call('DELETE', `/api/recordings/scheduled/${earlier.id}`);
    golden('recordings-scheduled-cancel', 'DELETE', '/api/recordings/scheduled/:id', cancelled, { status: 200 });
    assert.deepEqual([cancelled.body.status, 'image_url' in cancelled.body], ['cancelled', false]);
    assert.match(cancelled.body.image, /^\/api\/logo\//);
    const later = await schedule(cricket, 'Australia v India - golden');
    golden('recordings-schedule-clash', 'POST', '/api/recordings/schedule', later, { status: 201 });
    clashLater = later.body;
    assert.deepEqual(later.body.conflictsWith, [clashFirst.id]);

    // Rules: a series on a channel, a sport keyword, a followed team (0414).
    const series = await call('POST', '/api/recordings/rules', { body: { kind: 'series', match: 'AFL 360', sourceId: source.id, channelId: footy.item_id } });
    golden('recordings-rule-series', 'POST', '/api/recordings/rules', series, { status: 201 });
    assert.equal((await call('POST', '/api/recordings/rules', { body: { kind: 'sport', match: 'AFL' } })).status, 201);
    assert.equal((await call('POST', '/api/recordings/rules', { body: { kind: 'team', match: 'Green Bay Packers', sport: 'American football' } })).status, 201);
    const made = (await call('GET', '/api/recordings/scheduled')).body.filter(r => r.rule_id === series.body.id);
    assert.ok(made.length && made.every(r => typeof r.channel_logo === 'string' && r.channel_logo.startsWith('/api/logo/')),
        `a rule-made schedule's channel logo through the logo cache: ${JSON.stringify(made.map(r => r.channel_logo))}`);
    const stored = sqlite.getDb().prepare('SELECT channel_logo FROM scheduled_recordings WHERE id = ?').get(made[0].id).channel_logo;
    assert.match(stored, /^\/api\/logo\//, 'and stored that way, so the recording made from it carries it too');
    const rules = await get('recordings-rules', '/api/recordings/rules');
    assert.deepEqual(rules.map(r => r.kind).sort(), ['series', 'sport', 'team']);

    const listed = await get('recordings-scheduled', '/api/recordings/scheduled?include=recent');
    const byId = new Map((await call('GET', '/api/recordings/scheduled')).body.map(r => [r.id, r]));
    assert.deepEqual(byId.get(clashLater.id).beatenBy, [clashFirst.id], 'the later one loses its clash');
    assert.ok(listed.some(r => r.beatenBy) && listed.some(r => r.conflictsWith), 'both fields are in the golden');

    // Recorded files: one finished (the usual .ts), one segmented recording in progress that can be watched from the
    // start (C-L), one whose watch copy is still being made, as the engine leaves them.
    const now = Date.now();
    const row = (title, extra = {}) => recordingsDb.create({ scheduled_id: null, title, channel_name: footy.name, channel_logo: null, source_id: source.id,
        channel_item_id: footy.item_id, file_path: path.join(sandbox, 'recordings', 'Fox Footy', `${title}.ts`), started_at: now - 2 * H, ...extra });
    const done = row('Finished golden');
    recordingsDb.finish(done.id, { status: 'completed', ended_at: now - H, file_size_bytes: 123456789, duration_sec: 3600, error: null });
    recordingsDb.setSegmentFields(done.id, { image_url: JSON.parse(art.data).img }); // its programme's artwork (C-N)
    const live = row('Recording golden');
    const work = (id, { view }) => {
        const dir = path.join(sandbox, 'work', `rec-${id}`), e1 = path.join(dir, 'e1');
        fs.mkdirSync(e1, { recursive: true });
        fs.writeFileSync(path.join(e1, 'a000000.ts'), Buffer.alloc(188 * 10));
        fs.writeFileSync(path.join(e1, 'archive.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXTINF:4.000,\na000000.ts\n');
        if (view) {
            fs.writeFileSync(path.join(e1, 'init.mp4'), Buffer.alloc(16));
            fs.writeFileSync(path.join(e1, 'v000000.m4s'), Buffer.alloc(16));
            fs.writeFileSync(path.join(e1, 'view.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:5\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000,\nv000000.m4s\n#EXT-X-ENDLIST\n');
        }
        recordingsDb.setSegmentFields(id, { work_dir: dir, segment_state: 'capturing', segment_folder: 'Fox Footy' });
    };
    work(live.id, { view: true });
    const preparing = row('Preparing golden');
    work(preparing.id, { view: false });
    const recs = await get('recordings', '/api/recordings');
    assert.equal(recs.find(r => r.title === 'Recording golden').watch_live, true);

    await get('recordings-watch-200', `/api/recordings/${live.id}/watch`);
    golden('recordings-watch-202', 'GET', `/api/recordings/${preparing.id}/watch`, await call('GET', `/api/recordings/${preparing.id}/watch`), { status: 202 });
    golden('recordings-watch-409', 'GET', `/api/recordings/${done.id}/watch`, await call('GET', `/api/recordings/${done.id}/watch`), { status: 409 });
    segments.stopFollowers(preparing.id);
});

// ---- C-R, C-U ------------------------------------------------------------------------------------------------------

const team = (id, name, aliases = [name]) => ({ id, name, aliases, logo: null });
const game = (id, league, start, competitors, snapshot, extra = {}) => ({ id, league, title: competitors.map(c => c.name).join(' v ') || 'Grand Prix',
    start, end: null, session: league === 'F1' ? 'Race' : null, circuit: null, competitors, snapshot, ...extra });
const liveSnap = (scores = ['7', '3']) => ({ state: 'live', progress: { clock: '5:00', period: 2 }, scores, situation: { down: 3 } });
const scheduledSnap = { state: 'scheduled', progress: {}, scores: null, situation: null };

test('follows, catalog, names, suggestions and the front page (sports, follows, onAir, a recording that loses its clash)', async () => {
    const follows = { sports: [
        { sport: 'American football', leagues: ['NFL'], teams: ['Green Bay Packers'] },
        { sport: 'Australian football', leagues: ['AFL'], teams: ['Collingwood'] },
        { sport: 'Motorsport', leagues: ['F1'], teams: ['Oscar Piastri'] },
        { sport: 'Rugby union', leagues: ['Six Nations'], teams: ['Ireland'] },
        { sport: 'Cricket', leagues: ['Cricket'], teams: ['Australia'] }] };
    golden('sports-follows-put', 'PUT', '/api/sports/follows', await call('PUT', '/api/sports/follows', { body: follows }), { status: 200 });
    await get('sports-follows', '/api/sports/follows');
    await get('sports-catalog', '/api/sports/catalog');
    await get('sports-pages-preferences', '/api/sports/pages/preferences');

    // The collector's cards (as sport-front.test.js ingests them) and the guide's events for them (C-I's seam).
    const now = Date.now();
    const packers = team('9', 'Packers', ['Green Bay Packers', 'Packers', 'GB']);
    const pies = team('1', 'Collingwood', ['Collingwood', 'Magpies']);
    dashboard.store().ingest([
        game('espn:football/nfl:401', 'NFL', now - H, [packers, team('3', 'Bears')], liveSnap()),
        game('espn:australian-football/afl:1', 'AFL', clashFirst.program_start, [pies, team('2', 'Carlton')], scheduledSnap),
        game('espn:football/nfl:406', 'NFL', now + 10 * MIN, [team('12', 'Kansas City Chiefs', ['Kansas City Chiefs', 'Chiefs', 'KC']),
            team('2', 'Buffalo Bills', ['Buffalo Bills', 'Bills', 'BUF'])], scheduledSnap),
        game('espn:racing/f1:1', 'F1', now + 26 * H, [], scheduledSnap),
        game('espn:rugby/180659:2', 'Rugby World Cup', now + 30 * H, [team('3', 'Ireland'), team('8', 'New Zealand')], scheduledSnap)
    ], now - 100000);
    const final = s => game('espn:football/nfl:405', 'NFL', now - 5 * H, [packers, team('16', 'Vikings')], s);
    dashboard.store().ingest([final(liveSnap(['14', '10']))], now - 4 * H);
    dashboard.store().ingest([final({ state: 'finished', progress: { clock: '0:00', period: 4 }, scores: ['27', '20'], situation: null })], now - 3 * H);
    const nfln = channelOf('US| NFL NETWORK HD');
    const guideEvents = [
        { id: 'ev-afl', league: 'AFL', title: 'Collingwood v Carlton', kind: 'event', start: clashFirst.program_start, end: clashFirst.program_end, live: false,
            channels: [{ sourceId: source.id, id: footy.item_id, stableId: footy.stable_id, name: footy.name, number: 9, logo: null, quality: 'HD',
                start: clashFirst.program_start, end: clashFirst.program_end }] },
        // The game's coverage began 20 min before its start, 10 min away (#203): onAir
        { id: 'ev-kc', league: 'NFL', title: 'Chiefs v Bills', kind: 'event', start: now - 20 * MIN, end: now + 4 * H, live: false,
            channels: [{ sourceId: source.id, id: nfln.item_id, stableId: nfln.stable_id, name: nfln.name, number: 12, logo: null, quality: 'HD', start: now - 20 * MIN, end: now + 4 * H }] }
    ];
    // The losing schedule is the card's recording: put the AFL airing on the later schedule's channel instead.
    const cricket = channelOf('AU| FOX CRICKET HD');
    Object.assign(guideEvents[0].channels[0], { id: cricket.item_id, stableId: cricket.stable_id, name: cricket.name });
    const realEvents = sportsEvents.eventsResponse;
    sportsEvents.eventsResponse = async () => ({ body: Buffer.from(JSON.stringify({ now, events: guideEvents })) });
    try {
        const front = await get('sports-front', '/api/sports/front');
        const byId = Object.fromEntries(front.games.map(g => [g.id, g]));
        assert.equal(byId['espn:football/nfl:406']?.onAir, true, `onAir: ${JSON.stringify(byId['espn:football/nfl:406'])}`);
        assert.deepEqual(byId['espn:australian-football/afl:1']?.recording?.clashesWith, [clashFirst.title], JSON.stringify(byId['espn:australian-football/afl:1']));
        assert.ok(front.sports.length && front.follows.length && front.rails.length);
    } finally { sportsEvents.eventsResponse = realEvents; }

    // Names: the AFL's stored roster (no ESPN asked) and the cards' sides.
    sqlite.getDb().prepare('INSERT OR REPLACE INTO sport_fixture_teams (league, data, updated_at) VALUES (?, ?, ?)')
        .run('AFL', JSON.stringify((fx('espn/teams-afl.json').sports?.[0]?.leagues?.[0]?.teams || []).map(t => t.team || t)), Date.now());
    const names = await get('sports-names', '/api/sports/names?league=AFL');
    assert.ok(names.names.length > 1, JSON.stringify(names));
    const suggestions = await get('sports-suggestions', '/api/sports/suggestions');
    assert.ok(suggestions.suggestions.some(s => s.league === 'Rugby World Cup'), JSON.stringify(suggestions));
});

// ---- the sport pages (C-P, C-Q, C-S, C-T, C-V), on ESPN's stored samples ---------------------------------------------

const pages = {
    f1: load('services/sportPageF1'), nfl: load('services/sportPageNFL'), cricket: load('services/sportPageCricket'),
    league: load('services/sportPageLeague'), events: load('services/sportPageEvents')
};
const answer = (json) => ({ ok: true, json: JSON.parse(JSON.stringify(json)) });
const MISSING = { ok: false, error: 'HTTP 404' };

test('the Formula 1 page (drivers, map and mapDark) at 30 Oct 2026 12:00 UTC', async () => {
    const { answers } = fx('sport-page-f1.json');
    pages.f1.reset();
    pages.f1.fetcher.get = async (url) => {
        const u = new URL(url), p = u.pathname;
        const key = p.endsWith('/racing/f1/scoreboard') ? (u.searchParams.get('dates') ? `/scoreboard?dates=${u.searchParams.get('dates')}` : '/scoreboard')
            : p.endsWith('/racing/f1/standings') ? 'standings' : `core${p.split('/leagues/f1')[1]}`;
        return key in answers ? answer(answers[key]) : MISSING;
    };
    const at = Date.parse('2026-10-30T12:00:00Z');
    const page = await atClock(at, () => get('sports-page-f1', '/api/sports/pages/f1', { delta: 0 }));
    assert.equal(page.available, true);
    assert.ok(page.drivers?.length && page.weekend.info.map && page.weekend.info.mapDark, 'drivers, map, mapDark');
});

test('the NFL page at 30 Oct 2026 21:42 UTC', async () => {
    const nfl = (n) => fx(`espn/nfl/${n}`);
    pages.nfl.reset();
    pages.nfl.fetcher.get = async (url) => /standings/.test(url) ? answer(nfl('standings.json')) : /week=7/.test(url) ? answer(nfl('scoreboard-week7.json'))
        : /scoreboard$/.test(url) ? answer(nfl('scoreboard-week8.json')) : MISSING;
    const page = await atClock(Date.parse('2026-10-30T21:42:00Z'), () => get('sports-page-nfl', '/api/sports/pages/nfl', { delta: 0 }));
    assert.equal(page.available, true);
});

test('the Cricket page at 31 Oct 2026 01:56 UTC, following Australia', async () => {
    const dir = 'sport-page-cricket';
    const days = fx(`${dir}/scoreboard-24203.json`);
    pages.cricket.reset();
    pages.cricket.fetcher.get = async (url) => {
        const u = new URL(url), d = u.searchParams.get('dates');
        if (u.pathname.endsWith('/cricket/scorepanel') && fs.existsSync(path.join(__dirname, 'fixtures', dir, `scorepanel-${d}.json`))) return answer(fx(`${dir}/scorepanel-${d}.json`));
        if (u.pathname.endsWith('/cricket/24203/scoreboard') && days[d]) return answer(days[d]);
        if (u.pathname.endsWith('/cricket/24203/summary') && u.searchParams.get('event') === '1525661') return answer(fx(`${dir}/summary-1525661.json`));
        return MISSING;
    };
    const page = await atClock(Date.parse('2026-10-31T01:56:00Z'), () => get('sports-page-cricket', '/api/sports/pages/cricket', { delta: 0 }));
    assert.equal(page.available, true);
});

test('a team league page (AFL, round mode) at 31 Oct 2026 07:40 UTC', async () => {
    const ROUTES = [[/afl\/scoreboard$/, 'afl-scoreboard'], [/afl\/scoreboard\?seasontype=3&week=4&dates=2026$/, 'afl-week4'], [/afl\/standings$/, 'afl-standings']];
    pages.league.reset();
    pages.league.fetcher.get = async (url) => { for (const [re, n] of ROUTES) if (re.test(url)) return answer(fx(`espn/league/${n}.json`)); return { ok: false, error: 'HTTP 400' }; };
    const page = await atClock(Date.parse('2026-10-31T07:40:00Z'), () => get('sports-page-league-afl', '/api/sports/pages/league/AFL', { delta: 0 }));
    assert.equal(page.available, true);
});

test('the events pages (tennis, golf, UFC, NASCAR) at 1 Nov 2026 09:30 UTC', async () => {
    const ROUTES = [
        [/tennis\/wta\/scoreboard$/, 'tennis-wta-2026-11-01'], [/tennis\/atp\/scoreboard$/, 'tennis-atp-2026-11-01'],
        [/golf\/pga\/scoreboard$/, 'golf-pga-scoreboard-2026-11-01'], [/golf\/leaderboard\?league=pga$/, 'golf-pga-leaderboard-2026-11-01'],
        [/mma\/ufc\/scoreboard\?dates=20261029-20261108$/, 'ufc-2026-10-29-2026-11-08'],
        [/nascar-premier\/scoreboard$/, 'nascar-scoreboard-2026-11-01'], [/nascar-premier\/scoreboard\?dates=20261029-20261108$/, 'nascar-2026-10-29-2026-11-08'],
        [/nascar-premier\/scoreboard\?dates=20261024-20261026$/, 'nascar-2026-10-25'], [/nascar-premier\/scoreboard\?dates=20261107-20261109$/, 'nascar-2026-11-08']
    ];
    pages.events.reset();
    pages.events.fetcher.get = async (url) => { for (const [re, n] of ROUTES) if (re.test(url)) return answer(fx(`espn-events/${n}.json`)); return { ok: false, error: 'HTTP 400' }; };
    const at = Date.parse('2026-11-01T09:30:00Z');
    for (const [name, league] of [['atp-tour', 'ATP Tour'], ['wta-tour', 'WTA Tour'], ['majors', 'Majors'], ['pga-tour', 'PGA Tour'], ['ufc', 'UFC'], ['nascar', 'NASCAR']]) {
        const page = await atClock(at, () => get(`sports-page-events-${name}`, `/api/sports/pages/events?league=${encodeURIComponent(league)}`, { delta: 0 }));
        assert.equal(page.available, true, league);
    }
    golden('sports-page-events-400', 'GET', '/api/sports/pages/events?league=Quidditch', await call('GET', '/api/sports/pages/events?league=Quidditch'), { status: 400 });
});

// ---- resolve (C-B, C-D, C-J, viewer-in-progress) -------------------------------------------------------------------

test('resolve: a C-B error for a channel not in the playlist', async () => {
    const r = await call('POST', '/api/playback/resolve', { body: { sourceId: 999, channelId: 'pos_1', capabilities: { segmentedDelivery: true, heaac: true } } });
    golden('playback-resolve-404', 'POST', '/api/playback/resolve', r, { status: 404 });
    assert.match(r.body.error, /^This channel is not available/);
});

test('resolve: 200 on the fake provider, a C-B provider error, and the 409 another device gets while it plays', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
    const caps = { segmentedDelivery: true, heaac: true };
    const offline = channelOf('UK| TEST OFFLINE 404');
    const failed = await call('POST', '/api/playback/resolve', { body: { sourceId: source.id, channelId: offline.item_id, capabilities: caps } });
    golden('playback-resolve-error', 'POST', '/api/playback/resolve', failed);
    assert.ok(failed.status >= 400 && /^(The provider refused this channel|The provider did not respond|This channel is not available)/.test(failed.body.error), failed.text);
    const hd = channelOf('UK| SKY SPORTS F1 HD');
    const ok = await call('POST', '/api/playback/resolve', { body: { sourceId: source.id, channelId: hd.item_id, capabilities: caps } });
    golden('playback-resolve-200', 'POST', '/api/playback/resolve', ok, { status: 200 });
    const busy = await call('POST', '/api/playback/resolve', { token: tokenB, body: { sourceId: source.id, channelId: channelOf('UK| SKY SPORTS CRICKET HD').item_id, capabilities: caps } });
    golden('playback-resolve-409', 'POST', '/api/playback/resolve', busy, { status: 409 });
    assert.equal(busy.body.conflict?.type, 'viewer-in-progress');
});

test('every golden was produced, nothing asked a host other than this one', () => {
    assert.deepEqual(offHost, [], 'no request leaves the machine');
    const routes = path.join(GOLDEN, 'routes.json');
    if (UPDATE) { fs.writeFileSync(routes, JSON.stringify(Object.fromEntries(Object.keys(index).sort().map(k => [k, index[k]])), null, 2) + '\n'); return; }
    const committed = JSON.parse(fs.readFileSync(routes, 'utf8'));
    const expected = Object.keys(committed).filter(k => hasFfmpeg || !/^playback-resolve-(200|409|error)$/.test(k)).sort();
    assert.deepEqual(Object.keys(index).sort(), expected, 'the goldens test/golden/routes.json lists');
});
