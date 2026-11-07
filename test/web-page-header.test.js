const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// #241 (0484): the web pages had five headers: a bar on Guide and Recordings (.guide-header, .recordings-header: padding,
// a background, a border), a baseline row on Status, a bare h2 on Settings, .section-header on Home, and an h1 on Sport
// where every other page has an h2. One .page-header now: the h2 title, the page's controls beside it, no bar.
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const html = read('public/index.html');
const css = read('public/css/main.css').replace(/\/\*[\s\S]*?\*\//g, '');

function page(id) {
    const start = html.indexOf(`id="page-${id}"`);
    assert.ok(start > 0, `#page-${id}`);
    const next = html.indexOf('id="page-', start + 10);
    return html.slice(start, next > 0 ? next : undefined);
}

test('Guide, Recordings, Status and Settings open with the one page header and an h2 title', () => {
    for (const [id, title] of [['guide', 'TV Guide'], ['recordings', 'Recordings'], ['status', 'Status'], ['settings', 'Settings']]) {
        const markup = page(id);
        const header = markup.match(/<div class="page-header[^"]*">\s*<h2>([^<]+)<\/h2>/);
        assert.ok(header, `#page-${id} has a .page-header with an h2`);
        assert.equal(header[1], title);
        assert.ok(markup.indexOf('page-header') < markup.indexOf('<h3') || !markup.includes('<h3'), `${id}: the header comes first`);
    }
});

test('Sport and Home draw the same header; no page title is an h1', () => {
    const sports = read('public/js/pages/SportsPage.js');
    assert.match(sports, /<div class="page-header"><h2>Sport<\/h2><\/div>/);
    assert.doesNotMatch(sports, /<h1>/);
    assert.match(read('public/js/pages/HomePage.js'), /<div class="page-header">\s*<h2>Favourite channels<\/h2>/);
});

test('the header has no bar, and the old per-page header rules are gone', () => {
    const rule = (selector) => {
        const m = css.match(new RegExp(`(^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`));
        return m ? m[2] : null;
    };
    const header = rule('.page-header');
    assert.ok(header, '.page-header is defined');
    assert.doesNotMatch(header, /background|border-bottom/);
    for (const old of ['.guide-header', '.recordings-header', '.status-header', '.section-header']) {
        const body = rule(old);
        assert.ok(body === null || !/background|border-bottom/.test(body), `${old} draws no bar`);
    }
});
