// Pig family 1.6.0: every brand file the pages and CSS point at exists, the manifest is real,
// and the retired family-pig rasters stay gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');

test('files referenced from index.html, login.html and main.css exist', () => {
    const sources = ['index.html', 'login.html', 'css/main.css'].map(read).join('\n');
    const refs = new Set([...sources.matchAll(/(?:href=|url\()["']?(\/(?:img|css)\/[^"')\s?]+|\/site\.webmanifest)/g)].map(m => m[1]));
    assert.ok([...refs].some(r => r.startsWith('/img/brand/')), 'brand assets are referenced');
    for (const ref of refs) assert.ok(fs.existsSync(path.join(pub, ref)), `${ref} exists`);
});

test('both pages carry the bloom, the vendored CSS, the favicons and the manifest link', () => {
    for (const page of ['index.html', 'login.html']) {
        const html = read(page);
        assert.match(html, /<body class="pig-canvas-bloom">/, page);
        assert.match(html, /css\/pig-radiance\.css/, page);
        assert.match(html, /rel="icon"[^>]*web-small-light\.svg[^>]*prefers-color-scheme: light/, page);
        assert.match(html, /rel="icon"[^>]*web-small-dark\.svg[^>]*prefers-color-scheme: dark/, page);
        assert.match(html, /rel="apple-touch-icon" href="\/img\/brand\/web-light-180\.png"/, page);
        assert.match(html, /rel="manifest" href="\/site\.webmanifest"/, page);
    }
});

test('the navbar is glass with one accessible PigTV lockup; the player is not glass', () => {
    const html = read('index.html');
    assert.match(html, /<nav class="navbar pig-glass"/);
    assert.equal((html.match(/aria-label="PigTV"/g) || []).length, 1);
    assert.match(html, /class="pig-splash page-splash"/);
    const css = read('css/main.css');
    assert.match(css, /\.brand-lockup[\s\S]*lockup-horizontal-dark\.svg/);
    assert.match(css, /\[data-theme="light"\] \.brand-lockup[^}]*lockup-horizontal-light\.svg/);
    for (const cls of ['watch-captions-menu', 'player-overflow-menu']) assert.ok(!html.includes(`${cls} pig-glass`));
});

test('the web manifest is complete and the retired rasters are gone', () => {
    const m = JSON.parse(read('site.webmanifest'));
    assert.equal(m.name, 'PigTV');
    assert.equal(m.short_name, 'PigTV');
    assert.equal(m.start_url, '/');
    assert.equal(m.scope, '/');
    assert.equal(m.display, 'standalone');
    assert.deepEqual(m.icons.map(i => i.sizes), ['192x192', '512x512']);
    for (const i of m.icons) assert.ok(fs.existsSync(path.join(pub, i.src)), i.src);
    for (const f of ['img/pigtv-logo.png', 'img/pigtv-logo-master.png', 'img/logo-banner.png', 'favicon.svg']) {
        assert.ok(!fs.existsSync(path.join(pub, f)), `${f} is removed`);
    }
});
