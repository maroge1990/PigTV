const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const express = require('express');

// 0138: the items carried over from the old blueprint ((a), /api/info surviving a throwing
// feature check, went with the last switchable flag that had one).
//   (b) the small-caps badge is stripped from names and titles stored before 0099, once,
//       and from channel names on the Xtream ingest path (the M3U parser already did).
//   (c) P2-8 tests not covered elsewhere: the EPG parser under bursty input; the token
//       carried onto the fMP4 init segment and .m4s segments of an ffmpeg-written
//       playlist; Range requests
//       on a recording. "A viewer that already holds the slot re-resolves" is covered by
//       playback-arbitration.test.js ("a device changing channel replaces its own old
//       stream without a prompt") and stream-coordinator.test.js, so is not repeated.
// On the old code: stored badges stay, an Xtream
// channel keeps its badge, and a suffix or over-long Range is a 416.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-0138-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const BADGE = 'ᴸɪᴠᴇ';
const load = p => require(path.join(sandbox, 'server', p));

// Rows stored before 0099, written straight into a database that has never been opened
// by this build: the clean-up must find them when the server first opens it.
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
{
    const Database = require('better-sqlite3');
    const raw = new Database(path.join(sandbox, 'data', 'content.db'));
    raw.exec(`CREATE TABLE playlist_items (id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, item_id TEXT NOT NULL, type TEXT NOT NULL,
                name TEXT NOT NULL, category_id TEXT, parent_id TEXT, stream_icon TEXT, stream_url TEXT, container_extension TEXT,
                rating REAL, year TEXT, added_at TEXT, is_hidden INTEGER DEFAULT 0, is_favorite INTEGER DEFAULT 0, data JSON);
              CREATE TABLE epg_programs (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, source_id INTEGER NOT NULL,
                start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, title TEXT, description TEXT, data JSON);`);
    raw.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name) VALUES ('1:pos_1', 1, 'pos_1', 'live', ?)`).run(`Fox Sports 505 ${BADGE}`);
    raw.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name) VALUES ('1:pos_2', 1, 'pos_2', 'live', 'Plain Channel')`).run();
    raw.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name) VALUES ('1:pos_3', 1, 'pos_3', 'live', ?)`).run(BADGE);
    raw.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, description) VALUES ('c', 1, 1, 2, ?, ?)`)
        .run(`NFL 16 ${BADGE}`, `Described ${BADGE}`);
    raw.close();
}

const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');

let server, base, token;

before(async () => {
    const admin = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken(admin);
    load('db/recordingsDb').initSchema();
    const app = express();
    app.use(express.json());
    app.use('/api/info', load('routes/info'));
    app.use('/api/transcode', auth.streamAuth, load('routes/transcode'));
    app.use('/api/recordings', load('routes/recordings'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    const transcodeSession = load('services/transcodeSession');
    for (const s of transcodeSession.getAllSessions()) await transcodeSession.removeSession(s.id).catch(() => {});
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// ---------------------------------------------------------------- (b) --

test('(b) names and titles stored before 0099 lose the badge when the database is first opened, once', () => {
    const d = sqlite.getDb();
    const names = d.prepare(`SELECT item_id, name FROM playlist_items WHERE source_id = 1 ORDER BY item_id`).all();
    assert.deepEqual(names.map(r => r.name), ['Fox Sports 505', 'Plain Channel', BADGE], 'a name that is only a badge is kept');
    const prog = d.prepare(`SELECT title, description FROM epg_programs`).get();
    assert.equal(prog.title, 'NFL 16');
    assert.equal(prog.description, `Described ${BADGE}`, 'descriptions were never stripped at ingest either');
    assert.ok(d.prepare(`SELECT value FROM meta WHERE key = 'badge_cleanup'`).get(), 'recorded as done');

    d.prepare(`UPDATE playlist_items SET name = ? WHERE item_id = 'pos_2'`).run(`Plain Channel ${BADGE}`);
    assert.equal(sqlite.stripStoredBadges(), 0, 'it does not run again');
});

test('(b) the Xtream ingest path strips the badge from channel names', async () => {
    const sync = load('services/syncService');
    await sync.saveStreams(7, 'live', [{ stream_id: 441360, name: `Sky Sports ${BADGE}`, category_id: '1' }], { skipPurge: true });
    assert.equal(sqlite.getDb().prepare(`SELECT name FROM playlist_items WHERE id = '7:441360'`).get().name, 'Sky Sports');
});

// ---------------------------------------------------------------- (c) --

test('(c) the EPG parser loses nothing under bursty input: split chunks, a slow consumer, back-pressure', async () => {
    const epgParser = load('services/epgParser');
    const N = 2500;
    let xml = '<?xml version="1.0" encoding="UTF-8"?><tv>';
    xml += `<channel id="c1"><display-name>Télé Québec ${BADGE}</display-name></channel>`;
    for (let i = 0; i < N; i++) {
        const t = 1700000000 + i * 60;
        const stamp = (s) => new Date(s * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
        xml += `<programme channel="c1" start="${stamp(t)}" stop="${stamp(t + 60)}"><title>Émission ${i} ${BADGE}</title><desc>d${i}</desc></programme>`;
    }
    xml += '</tv>';

    // The whole document in awkward pieces: 1 to 97 bytes, which splits tags, attributes
    // and multi-byte characters, all available at once (a burst from a gzip stream).
    const bytes = Buffer.from(xml, 'utf8');
    const chunks = [];
    for (let at = 0, k = 0; at < bytes.length; k++) {
        const size = 1 + ((k * 37) % 97);
        chunks.push(bytes.subarray(at, at + size));
        at += size;
    }
    const input = Readable.from(chunks);
    let pauses = 0;
    const realPause = input.pause.bind(input);
    input.pause = () => { pauses++; return realPause(); };

    const programmes = [];
    let channels = null;
    for await (const batch of epgParser.parseStreaming(input, 100)) {
        if (batch.channels) channels = batch.channels;
        programmes.push(...batch.programmes);
        await new Promise(r => setTimeout(r, 2)); // a consumer slower than the parser
    }
    assert.equal(programmes.length, N, 'every programme arrives');
    assert.deepEqual(programmes.map(p => p.description), Array.from({ length: N }, (_, i) => `d${i}`), 'in order, none twice');
    assert.equal(programmes[1234].title, 'Émission 1234', 'multi-byte characters split across chunks survive; the badge is gone');
    assert.equal(channels.length, 1);
    assert.equal(channels[0].name, 'Télé Québec');
    assert.ok(pauses > 0, 'the parser paused its input while batches queued');
});

test('(c) an ffmpeg-written fMP4 playlist carries the token onto init.mp4 and every .m4s, and they play with it', async () => {
    const transcodeSession = load('services/transcodeSession');
    const session = await transcodeSession.createSession('http://provider.invalid/live/u/p/1.ts', {
        ffmpegPath: process.execPath, owner: 'user:1', live: true, videoMode: 'copy', segmentType: 'fmp4',
        stallMs: 60000, startupMs: 60000
    });
    // "ffmpeg" writes what the real one does for an fMP4 session, then idles.
    session.buildFFmpegArgs = () => ['-e', `
        const fs = require('fs');
        fs.writeFileSync('init.mp4', 'init');
        fs.writeFileSync('seg0000.m4s', 'zero');
        fs.writeFileSync('seg0001.m4s', 'one');
        fs.writeFileSync('stream.m3u8', '#EXTM3U\\n#EXT-X-VERSION:7\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-MAP:URI="init.mp4"\\n#EXTINF:4.0,\\nseg0000.m4s\\n#EXTINF:4.0,\\nseg0001.m4s\\n');
        setTimeout(() => {}, 30000);`];
    await session.start();
    for (let i = 0; i < 100 && !fs.existsSync(path.join(session.dir, 'stream.m3u8')); i++) await new Promise(r => setTimeout(r, 50));

    const q = `token=${encodeURIComponent(token)}`;
    const playlist = await (await fetch(`${base}/api/transcode/${session.id}/stream.m3u8?${q}`)).text();
    assert.ok(playlist.includes(`#EXT-X-MAP:URI="init.mp4?${q}"`), 'the init segment, inside its tag');
    const uris = playlist.split('\n').filter(l => l && !l.startsWith('#'));
    assert.deepEqual(uris, [`seg0000.m4s?${q}`, `seg0001.m4s?${q}`]);

    for (const [uri, body] of [[`init.mp4?${q}`, 'init'], [uris[0], 'zero'], [uris[1], 'one']]) {
        const r = await fetch(`${base}/api/transcode/${session.id}/${uri}`);
        assert.equal(r.status, 200, uri);
        assert.equal(await r.text(), body);
    }
    assert.equal((await fetch(`${base}/api/transcode/${session.id}/init.mp4`)).status, 401, 'and without the token they are refused');
    await transcodeSession.removeSession(session.id);
});

test('(c) a recording answers Range requests: a slice, an open end, a suffix, a last byte past the end, and 416', async () => {
    const { recordings } = load('db/recordingsDb');
    const file = path.join(sandbox, 'recording.mkv');
    const content = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    fs.writeFileSync(file, content);
    const rec = recordings.create({ scheduled_id: 1, title: 'Show', channel_name: 'ABC', channel_logo: null,
        source_id: 1, channel_item_id: 'pos_1', file_path: file, started_at: Date.now() });

    const get = async (range) => {
        const r = await fetch(`${base}/api/recordings/${rec.id}/stream`, { headers: range ? { Range: range } : {} });
        return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
    };

    let r = await get(null);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.body.length, 1000);

    const cases = [
        ['bytes=0-99', 0, 99],
        ['bytes=900-', 900, 999],
        ['bytes=-100', 900, 999],       // suffix: the last 100 bytes
        ['bytes=950-5000', 950, 999],   // a last byte past the end means "to the end"
        ['bytes=0-0', 0, 0],
        ['bytes=10-19, 30-39', 10, 19]  // several ranges: the first is served
    ];
    for (const [range, start, end] of cases) {
        r = await get(range);
        assert.equal(r.status, 206, range);
        assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/1000`, range);
        assert.equal(Number(r.headers.get('content-length')), end - start + 1, range);
        assert.deepEqual(r.body, content.subarray(start, end + 1), range);
    }

    for (const range of ['bytes=1000-1100', 'bytes=500-100', 'bytes=abc', 'bytes=-0']) {
        r = await get(range);
        assert.equal(r.status, 416, range);
        assert.equal(r.headers.get('content-range'), 'bytes */1000', range);
    }
});
