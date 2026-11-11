const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, stopServer } = require('./helpers/server');

// #275: the web app needs no internet at run time. The font and the player library are bundled, the pages load
// nothing from another host, and the bundled player is the exact file the page loaded from the CDN.
const PUBLIC = path.join(__dirname, '../public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

const HLS_FILE = 'js/vendor/hls-1.5.7.min.js';
// hls.js 1.5.7 dist/hls.min.js: identical from npm and from cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js.
const HLS_SHA256 = 'a78b3603d762428caba2ef21674e4d47fbc4e7496292b28f845ba7372849360b';
const FONT_FILE = 'css/fonts/Inter-latin-wght-normal.woff2';
const FONT_EXT_FILE = 'css/fonts/Inter-latin-ext-wght-normal.woff2';

const OFF_HOST = /^\s*(?:https?:)?\/\//i;

test('no page or stylesheet loads anything from another host', () => {
    const files = ['index.html', 'login.html', ...fs.readdirSync(path.join(PUBLIC, 'css')).filter((f) => f.endsWith('.css')).map((f) => `css/${f}`)];
    const loads = [];
    for (const f of files) {
        const src = read(f);
        for (const m of src.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi)) loads.push([f, m[1]]);
        for (const m of src.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) loads.push([f, m[1]]);
        for (const m of src.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/gi)) loads.push([f, m[1]]);
        for (const m of src.matchAll(/url\(\s*["']?([^"')]+)/gi)) loads.push([f, m[1]]);
    }
    assert.ok(loads.length > 10, 'the scan found the pages\' loads');
    assert.deepEqual(loads.filter(([, u]) => OFF_HOST.test(u)).map(([f, u]) => `${f}: ${u}`), []);
});

test('the bundled player is byte-identical to hls.js 1.5.7, and index.html loads it', () => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, HLS_FILE))).digest('hex');
    assert.equal(sha, HLS_SHA256);
    assert.match(read('index.html'), /<script src="\/js\/vendor\/hls-1\.5\.7\.min\.js"><\/script>/);
    assert.ok(fs.existsSync(path.join(PUBLIC, 'js/vendor/hls.js-LICENSE')));
});

test('Inter is bundled with its licence, and main.css (which both pages load) declares it', () => {
    assert.ok(fs.existsSync(path.join(PUBLIC, 'css/fonts/OFL.txt')));
    assert.match(read('css/fonts/OFL.txt'), /SIL Open Font License, Version 1\.1/);
    const css = read('css/main.css');
    for (const [file, range] of [['Inter-latin-wght-normal', 'U\\+0000-00FF'], ['Inter-latin-ext-wght-normal', 'U\\+0100-02BA']]) {
        assert.match(css, new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*'Inter'[^}]*font-weight:\\s*400 700[^}]*font-display:\\s*swap[^}]*url\\('fonts/${file}\\.woff2'\\)[^}]*unicode-range:\\s*${range}`));
    }
    assert.match(read('login.html'), /href="css\/main\.css(\?v=\d+)?"/);
    assert.doesNotMatch(read('css/main.css') + read('index.html') + read('login.html'), /Outfit/);
});

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-vendored-'));
let server;
after(async () => {
    if (server) await stopServer(server);
    try { fs.rmSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* the OS temp cleaner */ }
});

test('the server serves the font and the player with a 200 and a script / font content type', async () => {
    fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
    fs.cpSync(PUBLIC, path.join(sandbox, 'public'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
    server = await startServer({ cwd: sandbox });
    const js = await fetch(`${server.base}/${HLS_FILE}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const font = await fetch(`${server.base}/${FONT_FILE}`);
    assert.equal(font.status, 200);
    assert.match(font.headers.get('content-type'), /font\/woff2|application\/(?:x-)?font-woff2/);
    assert.equal((await font.arrayBuffer()).byteLength, fs.statSync(path.join(PUBLIC, FONT_FILE)).size);
    const ext = await fetch(`${server.base}/${FONT_EXT_FILE}`);
    assert.equal(ext.status, 200);
    assert.match(ext.headers.get('content-type'), /font\/woff2|application\/(?:x-)?font-woff2/);
});
