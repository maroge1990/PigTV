const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

// #361 (0893): a guide page asked again in the same minute is the kept body (no query of the playlist or the guide),
// with a weak ETag (If-None-Match -> 304) and gzip made once. A new guide version, a measurement, the next minute or
// another request gives a new body. At most 8 answers and 40 MB are kept.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-guide-kept-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const { bumpLibraryRev } = load('services/libraryRev');
const measurements = load('services/channelMeasurements');
const guideAnswers = load('services/guideAnswers');
const library = load('routes/library');

let server, base, token, source;
const HOUR = 3600000, MINUTE = 60000;
let clockAt = Math.floor(Date.now() / MINUTE) * MINUTE + 5000;
const START = clockAt - HOUR, END = START + 6 * HOUR;
guideAnswers.clock.now = () => clockAt;

// node:http, not fetch: fetch adds Cache-Control: no-cache to a conditional request and decompresses gzip.
function get(route, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(`${base}${route}`, { headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity', ...headers } }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: { get: (h) => res.headers[h.toLowerCase()] ?? null }, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}
const page = (extra = '') => `/api/library/guide?start=${START}&end=${END}&limit=20${extra}`;

/** Statements that read the playlist or the guide while `fn` runs. */
async function countPageQueries(fn) {
    const d = sqlite.getDb();
    const prepare = d.prepare;
    let n = 0;
    d.prepare = function (sql) {
        const stmt = prepare.call(this, sql);
        if (!/playlist_items|epg_live|logo_cache|channel_health|FROM channel_measurements/.test(sql)) return stmt;
        for (const m of ['all', 'get', 'iterate', 'run']) {
            const orig = stmt[m];
            stmt[m] = function (...a) { n++; return orig.apply(this, a); };
        }
        return stmt;
    };
    try { await fn(); } finally { delete d.prepare; }
    return n;
}

before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken({ ...user, id: 1 });
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'https://provider.invalid/list.m3u' });
    const d = sqlite.getDb();
    const item = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, data, stable_id, tvg_id, stream_icon)
        VALUES (?, ?, ?, 'live', ?, 'A', ?, '{}', ?, ?, ?)`);
    const prog = d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, gen, data) VALUES (?, ?, ?, ?, ?, 0, ?)`);
    for (let i = 0; i < 60; i++) {
        item.run(`${source.id}:${i}`, source.id, String(i), `Channel ${i}`, i, `s${i}`, `t${i}.invalid`, `http://provider.invalid/logo/${i}.png`);
        for (let h = 0; h < 6; h++) {
            prog.run(`t${i}.invalid`, source.id, START + h * HOUR, START + (h + 1) * HOUR, `Show ${i}/${h} ${'x'.repeat(40)}`,
                h % 2 ? JSON.stringify({ img: `http://provider.invalid/art/${i}/${h}.jpg` }) : null);
        }
    }
    const app = express();
    app.use(express.json());
    app.use('/api/library', library);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    await get(page()); // the first build writes the logo keys
});

beforeEach(() => guideAnswers._reset());

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('a repeat in the same minute is the kept body: no query of the playlist or the guide, same bytes and ETag', async () => {
    const first = await get(page());
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    assert.match(first.headers.get('etag') || '', /^W\/"/);
    assert.equal(first.headers.get('vary'), 'Accept-Encoding');
    const json = JSON.parse(first.body);
    assert.equal(json.now, Math.floor(clockAt / MINUTE) * MINUTE, '`now` is the minute\'s start');
    let again;
    const queries = await countPageQueries(async () => { again = await get(page()); });
    assert.equal(queries, 0, 'no query of playlist_items, epg_live, logo_cache, channel_health or the measurements');
    assert.deepEqual(again.body, first.body);
    assert.equal(again.headers.get('etag'), first.headers.get('etag'));
});

test('If-None-Match with the ETag is a 304 with no body', async () => {
    const first = await get(page());
    const second = await get(page(), { 'If-None-Match': first.headers.get('etag') });
    assert.equal(second.status, 304);
    assert.equal(second.body.length, 0);
});

test('gzip is the same body, compressed once', async () => {
    const plain = await get(page());
    const zipped = await get(page(), { 'Accept-Encoding': 'gzip' });
    assert.equal(zipped.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(zlib.gunzipSync(zipped.body), plain.body);
    assert.equal(zipped.headers.get('etag'), plain.headers.get('etag'));
});

test('a guide version change, a measurement, the next minute and another request each give a new answer', async () => {
    const first = await get(page());
    const firstJson = JSON.parse(first.body);

    sqlite.getDb().prepare("UPDATE playlist_items SET name = 'Renamed' WHERE item_id = '0'").run();
    bumpLibraryRev();
    const renamed = await get(page());
    assert.notEqual(renamed.headers.get('etag'), first.headers.get('etag'));
    assert.equal(JSON.parse(renamed.body).channels[0].name, 'Renamed');

    measurements.record({ sourceId: source.id, key: 's1', height: 2160, fps: 50, measuredAt: Date.now(), source: 'audit' });
    const measured = await get(page());
    assert.notEqual(measured.headers.get('etag'), renamed.headers.get('etag'));
    assert.deepEqual(JSON.parse(measured.body).channels[1].measured, { label: '4K', fps: 50 });

    clockAt += MINUTE;
    const later = await get(page());
    assert.notEqual(later.headers.get('etag'), measured.headers.get('etag'));
    assert.equal(JSON.parse(later.body).now, firstJson.now + MINUTE);

    const other = await get(page('&offset=5'));
    assert.notEqual(other.headers.get('etag'), later.headers.get('etag'));
    assert.equal(JSON.parse(other.body).offset, 5);
});

test('a request without its own start is not kept: its window starts at its own millisecond', async () => {
    const a = await get('/api/library/guide?limit=5');
    assert.equal(a.status, 200);
    assert.notEqual(a.headers.get('cache-control'), 'private, no-cache');
    const json = JSON.parse(a.body);
    assert.equal(json.start, json.now);
    assert.equal(guideAnswers._stats().entries, 0);
});

test('at most 8 answers and the byte cap are kept, the oldest dropped first', async () => {
    for (let i = 0; i < 12; i++) await get(page(`&offset=${i}`), { 'Accept-Encoding': 'gzip' });
    const stats = guideAnswers._stats();
    assert.equal(stats.entries, guideAnswers.MAX_ENTRIES);
    assert.ok(stats.bytes <= guideAnswers.MAX_BYTES, `${stats.bytes} bytes kept`);
    // the newest is a hit, the oldest is built again
    const newest = await countPageQueries(() => get(page('&offset=11')));
    assert.equal(newest, 0);
    const oldest = await countPageQueries(() => get(page('&offset=0')));
    assert.ok(oldest > 0);
});

// #361 (0894): the ETag names the body; the lineup revision moves the key; gzip is negotiated.
test('an answer rebuilt differently under the same key does not validate the old ETag', async () => {
    const first = await get(page());
    guideAnswers._reset(); // evicted
    // A decoration that has no revision of its own changes (here a logo, written with no version bump).
    sqlite.getDb().prepare("UPDATE playlist_items SET stream_icon = 'http://provider.invalid/logo/new.png' WHERE item_id = '2'").run();
    const second = await get(page(), { 'If-None-Match': first.headers.get('etag') });
    assert.equal(second.status, 200, 'the old ETag names the old body');
    assert.notEqual(second.headers.get('etag'), first.headers.get('etag'));
    assert.notDeepEqual(second.body, first.body);
});

test('a committed sync batch gives a new answer in the same minute, with no library_rev bump', async () => {
    const first = JSON.parse((await get(page())).body);
    const r = sqlite.getDb().prepare("SELECT item_id, name, category_id, sort_order, tvg_id FROM playlist_items WHERE item_id = '4'").get();
    await load('services/syncService').saveStreams(source.id, 'live',
        [{ stream_id: 4, name: 'Batch renamed', category_id: r.category_id, sort_order: r.sort_order, tvgId: r.tvg_id }], { skipPurge: true });
    const second = JSON.parse((await get(page())).body);
    assert.notEqual(first.channels[4].name, 'Batch renamed');
    assert.equal(second.channels[4].name, 'Batch renamed');
});

test('gzip is negotiated: q=0 and no header get identity, gzip gets gzip, one ETag, Vary always', async () => {
    const cases = [['gzip;q=0, identity;q=1', null], [undefined, null], ['gzip', 'gzip'], ['gzip, deflate, br', 'gzip'], ['identity', null]];
    const etags = new Set();
    let plain = null;
    for (const [ae, want] of cases) {
        const headers = {};
        if (ae !== undefined) headers['Accept-Encoding'] = ae;
        const r = await new Promise((resolve, reject) => {
            const h = { Authorization: `Bearer ${token}`, ...headers };
            http.get(`${base}${page()}`, { headers: h }, res => {
                const chunks = []; res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
            }).on('error', reject);
        });
        assert.equal(r.headers['content-encoding'] || null, want, `Accept-Encoding: ${ae}`);
        assert.equal(r.headers.vary, 'Accept-Encoding', `Accept-Encoding: ${ae}`);
        etags.add(r.headers.etag);
        const raw = want ? zlib.gunzipSync(r.body) : r.body;
        if (plain) assert.deepEqual(raw, plain); else plain = raw;
    }
    assert.equal(etags.size, 1, 'one ETag for every encoding');
});
