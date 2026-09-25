const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const express = require('express');

// 0154: full-resolution logos for the Apple TV Top Shelf. The logo cache (0112/0141) serves
// logos downscaled to <=320 px wide; GET /api/logo/:key?size=full answers the ORIGINAL fetched
// bytes (kept beside the resized copy), ?size=640 a copy at most 640 px wide. The default is
// unchanged. Same allow-list (a registered key, else 404), cache lifetime and cache-version
// handling; each size has its own ETag. The old code ignores `size` and always sends the 320 px copy.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-logo-sizes-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const { registerLogo, keyForUrl } = load('services/logoCache');

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = !haveFfmpeg && 'ffmpeg is not installed here';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-logo-sizes-run-'));
const logosDir = path.join(sandbox, 'data', 'logos');

function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
}
/** An RGBA PNG: an opaque block on a clear background. */
function png(w, h) {
    const rows = [];
    for (let y = 0; y < h; y++) {
        rows.push(Buffer.from([0]));
        for (let x = 0; x < w; x++) rows.push(Buffer.from([200, 40, 40, Math.abs(x - w / 2) < w * 0.3 && Math.abs(y - h / 2) < h * 0.3 ? 255 : 0]));
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function widthOf(buffer) {
    const file = path.join(work, crypto.randomBytes(6).toString('hex'));
    fs.writeFileSync(file, buffer);
    return Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', file]).stdout.toString().trim());
}

let server, base, imageServer, imageBase;
const served = new Map();
let fetches = 0;

before(async () => {
    imageServer = http.createServer((req, res) => {
        fetches++;
        const item = served.get(req.url);
        if (!item) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': item.type });
        res.end(item.body);
    });
    imageServer.listen(0, '127.0.0.1');
    await once(imageServer, 'listening');
    imageBase = `http://127.0.0.1:${imageServer.address().port}`;

    const app = express();
    app.locals.ffmpegPath = haveFfmpeg ? 'ffmpeg' : null;
    app.use('/api/logo', load('routes/logo'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.(); server?.close();
    imageServer?.closeAllConnections?.(); imageServer?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

function logo(name, body, type = 'image/png') {
    served.set(`/${name}`, { type, body });
    return registerLogo(`${imageBase}/${name}`);
}
async function get(p, headers = {}) {
    const res = await fetch(`${base}${p}`, { headers });
    return { status: res.status, type: res.headers.get('content-type'), etag: res.headers.get('etag'),
        cache: res.headers.get('cache-control'), body: Buffer.from(await res.arrayBuffer()) };
}

test('?size=full answers the original bytes; the default stays the <=320 px copy', { skip }, async () => {
    const original = png(1280, 640);
    const p = logo('wide.png', original);
    const small = await get(p);
    assert.equal(small.status, 200);
    assert.equal(widthOf(small.body), 320, 'the default is still downscaled');
    const before = fetches;
    const full = await get(`${p}?size=full`);
    assert.equal(full.status, 200);
    assert.ok(full.body.equals(original), 'exactly the fetched bytes');
    assert.equal(full.type, 'image/png');
    assert.equal(full.cache, 'public, max-age=604800');
    assert.equal(fetches, before, 'kept at the first fetch, not fetched again');
    assert.notEqual(full.etag, small.etag, 'each size has its own ETag');
    assert.equal((await get(`${p}?size=full`, { 'If-None-Match': full.etag })).status, 304);
    assert.ok((await get(p)).body.equals(small.body), 'the default is unchanged after a full request');
});

test('?size=640 is at most 640 px wide, made once from the original; a narrower logo is the original', { skip }, async () => {
    const original = png(1280, 640);
    const p = logo('big.png', original);
    const mid = await get(`${p}?size=640`);
    assert.equal(mid.status, 200);
    assert.equal(mid.type, 'image/png');
    assert.equal(widthOf(mid.body), 640);
    assert.ok(fs.existsSync(path.join(logosDir, `${keyForUrl(`${imageBase}/big.png`)}.640`)), 'stored');
    const again = await get(`${p}?size=640`);
    assert.ok(again.body.equals(mid.body));
    assert.equal((await get(`${p}?size=640`, { 'If-None-Match': mid.etag })).status, 304);

    const narrow = png(500, 250);
    const q = logo('narrow.png', narrow);
    assert.ok((await get(`${q}?size=640`)).body.equals(narrow), 'already <=640 px: as fetched');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="10"/>');
    const r = logo('mark.svg', svg, 'image/svg+xml');
    const out = await get(`${r}?size=640`);
    assert.ok(out.body.equals(svg));
    assert.equal(out.type, 'image/svg+xml', 'an SVG keeps its type');
});

test('without ffmpeg, every size is the original', async () => {
    const app = express();
    app.use('/api/logo', load('routes/logo'));
    const bare = app.listen(0, '127.0.0.1');
    await once(bare, 'listening');
    try {
        const original = png(700, 20);
        const p = logo('noffmpeg.png', original);
        for (const suffix of ['', '?size=full', '?size=640']) {
            const res = await fetch(`http://127.0.0.1:${bare.address().port}${p}${suffix}`);
            assert.equal(res.status, 200, suffix);
            assert.ok(Buffer.from(await res.arrayBuffer()).equals(original), suffix);
        }
    } finally {
        bare.closeAllConnections?.(); bare.close();
    }
});

test('unknown keys are 404 at every size; an unknown size is 400; nothing is fetched', async () => {
    const before = fetches;
    for (const suffix of ['', '?size=full', '?size=640', '?size=huge']) {
        assert.equal((await get(`/api/logo/0000000000000000000000000000dead${suffix}`)).status, 404, suffix);
    }
    assert.equal((await get(`/api/logo/${encodeURIComponent('../x')}?size=full`)).status, 404);
    const p = logo('any.png', png(10, 10));
    assert.equal((await get(`${p}?size=huge`)).status, 400);
    assert.equal((await get(`${p}?size=1280`)).status, 400);
    assert.equal((await get(`${p}?size=constructor`)).status, 400);
    assert.equal(fetches, before, 'an unknown key or size never reaches the network');
});

test('a logo stored before 0154 (no original kept) is fetched again for ?size=full', async () => {
    const db = sqlite.getDb();
    const original = png(40, 20);
    const p = logo('legacy.png', original);
    const key = keyForUrl(`${imageBase}/legacy.png`);
    await get(p); // make sure the version check has run and the logo is stored
    fs.rmSync(path.join(logosDir, `${key}.orig`), { force: true });
    db.prepare('UPDATE logo_cache SET original_type = NULL, original_bytes = NULL WHERE key = ?').run(key);
    const before = fetches;
    const full = await get(`${p}?size=full`);
    assert.equal(full.status, 200);
    assert.ok(full.body.equals(original));
    assert.equal(fetches, before + 1);
    assert.equal(db.prepare('SELECT original_bytes FROM logo_cache WHERE key = ?').get(key).original_bytes, original.length);
});

test('a cache-version change drops the originals and the 640 px copies with the rest', async () => {
    const db = sqlite.getDb();
    const p = logo('version.png', png(30, 30));
    const key = keyForUrl(`${imageBase}/version.png`);
    await get(`${p}?size=640`);
    assert.ok(fs.existsSync(path.join(logosDir, `${key}.orig`)) && fs.existsSync(path.join(logosDir, `${key}.640`)));
    db.prepare("DELETE FROM meta WHERE key = 'logo_cache_version'").run();
    delete require.cache[require.resolve(path.join(sandbox, 'server', 'routes', 'logo'))];
    const app = express();
    app.use('/api/logo', load('routes/logo'));
    const fresh = app.listen(0, '127.0.0.1');
    await once(fresh, 'listening');
    try {
        const before = fetches;
        const res = await fetch(`http://127.0.0.1:${fresh.address().port}${p}?size=full`);
        assert.equal(res.status, 200);
        assert.equal(fetches, before + 1, 'fetched again');
        assert.ok(!fs.existsSync(path.join(logosDir, `${key}.640`)), 'the old 640 px copy went');
    } finally {
        fresh.closeAllConnections?.(); fresh.close();
    }
});
