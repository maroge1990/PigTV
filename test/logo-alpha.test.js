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

// 0141: logos gained a solid background on the Apple TV and the web (Mark's test: ABC 546,
// 7 Mate Melbourne 550, 7two Sydney 551). 0112's downscale piped every logo through
// `scale='min(320,iw)':-1` into PNG with no pixel format: a palette PNG with transparency
// (pal8 + tRNS) came out in ffmpeg's fixed 3-3-2 palette with no transparency at all - its
// clear background became solid black (reproduced with ffmpeg 9.0; rgba, grey+alpha and
// 16-bit PNGs kept their alpha). The fix converts through rgba, stores small, SVG and
// unconvertible logos as they came, and a cache version makes every stored logo stale.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-logo-alpha-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const { registerLogo, keyForUrl, LOGO_CACHE_VERSION } = load('services/logoCache');

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = !haveFfmpeg && 'ffmpeg is not installed here';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-logo-alpha-run-'));

// ---- image fixtures, written by hand so the test needs no image library ----
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
}
function png(w, h, colorType, pixel, { plte, trns, depth = 8 } = {}) {
    const rows = [];
    for (let y = 0; y < h; y++) {
        rows.push(Buffer.from([0]));
        for (let x = 0; x < w; x++) rows.push(Buffer.from(pixel(x, y)));
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = depth; ihdr[9] = colorType;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        plte ? chunk('PLTE', Buffer.from(plte)) : Buffer.alloc(0),
        trns ? chunk('tRNS', Buffer.from(trns)) : Buffer.alloc(0),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
// A logo: an opaque block in the middle of a clear background.
const inside = (x, y, w, h) => Math.abs(x - w / 2) < w * 0.3 && Math.abs(y - h / 2) < h * 0.3;
const W = 640, H = 320;
const IMAGES = {
    palette: () => png(W, H, 3, (x, y) => [inside(x, y, W, H) ? 1 : 0],
        { plte: [0, 0, 0, 220, 30, 30], trns: [0, 255] }),
    rgba: () => png(W, H, 6, (x, y) => [240, 240, 240, inside(x, y, W, H) ? 255 : 0]),
    greyAlpha: () => png(W, H, 4, (x, y) => [250, inside(x, y, W, H) ? 255 : 0]),
    rgba16: () => png(W, H, 6, (x, y) => { const a = inside(x, y, W, H) ? 0xff : 0; return [0xea, 0x60, 0xea, 0x60, 0xea, 0x60, a, a]; }, { depth: 16 }),
};

/** Decode any image to { width, height, alpha(x, y) } with ffmpeg. */
function decode(buffer) {
    const file = path.join(work, crypto.randomBytes(6).toString('hex'));
    fs.writeFileSync(file, buffer);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
    const [width, height] = probe.stdout.toString().trim().split(',').map(Number);
    const raw = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 }).stdout;
    return { width, height, alpha: (x, y) => raw[(y * width + x) * 4 + 3] };
}

let server, base, imageServer, imageBase;
const served = new Map();   // path -> { type, body }
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

async function fetchLogo(name, type, body) {
    served.set(`/${name}`, { type, body });
    const res = await fetch(`${base}${registerLogo(`${imageBase}/${name}`)}`);
    assert.equal(res.status, 200);
    return { type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
}

for (const [kind, make] of Object.entries(IMAGES)) {
    test(`a large ${kind} PNG is downscaled with its transparency intact`, { skip }, async () => {
        const out = await fetchLogo(`${kind}.png`, 'image/png', make());
        assert.equal(out.type, 'image/png');
        const img = decode(out.body);
        assert.equal(img.width, 320, 'downscaled to 320 px wide');
        assert.equal(img.alpha(2, 2), 0, 'the clear background stays clear');
        assert.equal(img.alpha(img.width - 3, img.height - 3), 0, 'the clear background stays clear');
        assert.equal(img.alpha(img.width >> 1, img.height >> 1), 255, 'the logo itself stays opaque');
    });
}

test('a large JPEG is downscaled to an opaque PNG', { skip }, async () => {
    const jpeg = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x640', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']).stdout;
    const out = await fetchLogo('photo.jpg', 'image/jpeg', jpeg);
    assert.equal(out.type, 'image/png');
    const img = decode(out.body);
    assert.equal(img.width, 320);
    assert.equal(img.alpha(2, 2), 255);
});

test('a logo already 320 px wide or narrower is stored exactly as it came', { skip }, async () => {
    const small = png(200, 100, 3, (x, y) => [inside(x, y, 200, 100) ? 1 : 0], { plte: [0, 0, 0, 220, 30, 30], trns: [0, 255] });
    const out = await fetchLogo('small.png', 'image/png', small);
    assert.ok(out.body.equals(small), 'original bytes');
});

test('an SVG and an unreadable image are stored exactly as they came', { skip }, async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect width="10" height="10"/></svg>');
    const outSvg = await fetchLogo('logo.svg', 'image/svg+xml', svg);
    assert.ok(outSvg.body.equals(svg));
    assert.equal(outSvg.type, 'image/svg+xml');

    const junk = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(4000)]);
    const outJunk = await fetchLogo('junk.png', 'image/png', junk);
    assert.ok(outJunk.body.equals(junk));
});

test('the cache version is in the key, so clients get new logo paths', () => {
    assert.ok(LOGO_CACHE_VERSION >= 2);
    const url = 'http://logos.invalid/abc.png';
    const v1Key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
    assert.notEqual(keyForUrl(url), v1Key, 'a version 1 path would keep the Apple client\'s disk copy of the bad logo');
});

test('logos stored under an older cache version are dropped and fetched again', async () => {
    // A fresh copy of the route re-checks the version, as a restart would.
    const db = sqlite.getDb();
    const body = png(100, 50, 6, () => [1, 2, 3, 255]);
    served.set('/old.png', { type: 'image/png', body });
    const url = `${imageBase}/old.png`;
    const p = registerLogo(url);
    const key = keyForUrl(url);
    // What 0112 left behind: a fetched row, its (bad) file, and no version in meta.
    const logosDir = path.join(sandbox, 'data', 'logos');
    fs.writeFileSync(path.join(logosDir, key), Buffer.from('stale bytes from version 1'));
    db.prepare('UPDATE logo_cache SET content_type = ?, fetched_at = ?, bytes = ? WHERE key = ?').run('image/png', Date.now(), 26, key);
    db.prepare("DELETE FROM meta WHERE key = 'logo_cache_version'").run();

    delete require.cache[require.resolve(path.join(sandbox, 'server', 'routes', 'logo'))];
    const app = express();
    app.use('/api/logo', load('routes/logo'));
    const fresh = app.listen(0, '127.0.0.1');
    await once(fresh, 'listening');
    try {
        const before = fetches;
        const res = await fetch(`http://127.0.0.1:${fresh.address().port}${p}`);
        assert.equal(res.status, 200);
        assert.ok(Buffer.from(await res.arrayBuffer()).equals(body), 'the stale file is not served');
        assert.equal(fetches, before + 1, 'fetched again from the provider');
        assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'logo_cache_version'").get().value, String(LOGO_CACHE_VERSION));
    } finally {
        fresh.closeAllConnections?.(); fresh.close();
    }
});
