'use strict';
// #325: the web Sport page fills the window (Mark, 15 Nov 2026). A width cap on the page's root (.sp) left a wide
// window half empty and cut the card rails off mid-card at the cap instead of at the window's edge.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'sport.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

function rulesFor(selector) {
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
        const sels = m[1].split(',').map(s => s.trim());
        if (sels.includes(selector)) out.push(m[2]);
    }
    return out;
}

test('#325: the Sport page root has no width cap', () => {
    const root = rulesFor('.sp');
    assert.ok(root.length > 0, 'found the .sp rule');
    for (const body of root) assert.doesNotMatch(body, /max-width/, `.sp must not cap its width: ${body.trim()}`);
});

test('#325: card rails still run into the right gutter, to the window edge', () => {
    const rail = rulesFor('.sp .rail').join(';');
    assert.match(rail, /margin:\s*0 calc\(-1 \* var\(--gutter\)\)/, 'the rail bleeds into the right gutter');
    assert.match(rail, /overflow-x:\s*auto/, 'the rail scrolls sideways');
});
