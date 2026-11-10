const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// #275: a var(--x) that nothing defines silently falls back to the browser's default (Canvas, CanvasText), and a
// fallback inside var() hides it. Every custom property the pages READ must be DEFINED by a stylesheet they load
// (main.css, pig-radiance.css, pig-glass.css) or set from JS.
const PUBLIC = path.join(__dirname, '../public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const jsFiles = (dir) => fs.readdirSync(path.join(PUBLIC, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    return d.isDirectory() ? jsFiles(rel) : d.name.endsWith('.js') ? [rel] : [];
});

const CSS = ['css/main.css', 'css/pig-radiance.css', 'css/pig-glass.css'];
// The three properties pig-glass.css's .pig-concentric expects the element that uses it to set.
const SET_BY_THE_USER_OF_THE_CLASS = new Set(['--pig-inset', '--pig-outer-radius', '--pig-radius-min']);

const sources = [...CSS, 'login.html', 'index.html', ...jsFiles('js')];
const text = (f) => (f.endsWith('.css') ? noComments(read(f)) : read(f));

const reads = (src) => [...src.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
const definitions = (src) => [...src.matchAll(/(?:^|[\s;{"'(])(--[\w-]+)\s*:/g)].map((m) => m[1])
    .concat([...src.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)].map((m) => m[1]));

test('every custom property a page reads is defined by a loaded stylesheet or set from JS', () => {
    const defined = new Set(SET_BY_THE_USER_OF_THE_CLASS);
    for (const f of sources) definitions(text(f)).forEach((d) => defined.add(d));
    const undefinedReads = [];
    for (const f of sources) {
        for (const name of new Set(reads(text(f)))) if (!defined.has(name)) undefinedReads.push(`${f}: ${name}`);
    }
    assert.deepEqual(undefinedReads, []);
});

test('the phone breakpoint that sets the navbar height is one block, and spin is keyframed once', () => {
    const css = noComments(read('css/main.css'));
    const phoneNavbar = css.split(/@media \(max-width: 480px\)/).slice(1).filter((b) => /--navbar-height\s*:/.test(b.split(/\n}\n/)[0]));
    assert.equal(phoneNavbar.length, 1);
    assert.equal((css.match(/@keyframes spin\b/g) || []).length, 1);
});
