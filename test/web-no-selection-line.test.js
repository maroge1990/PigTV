const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// #344 (owner, 18 Nov): a selected item (Settings tab and nav, pill, chip, row, tile) is shown by shading only: no pink
// line (border, underline, bar, inset or outer ring in the accent) on it. Forced-colors keeps its outline (shading
// vanishes there), so those rules are not counted.
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
function rules(css, media = []) {
    const out = [];
    let i = 0;
    while (i < css.length) {
        const open = css.indexOf('{', i);
        if (open < 0) break;
        const prelude = css.slice(i, open).replace(/^[\s;]*/, '').trim();
        let depth = 1, j = open + 1;
        while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
        const inner = css.slice(open + 1, j - 1);
        if (prelude.startsWith('@')) { if (/^@(media|supports)/.test(prelude)) out.push(...rules(inner, [...media, prelude])); }
        else out.push({ sel: prelude.replace(/\s+/g, ' '), body: inner, media });
        i = j;
    }
    return out;
}
const SELECTED = /\.(active|on|sel|selected|current|is-picked|is-current|is-selected)\b|aria-(selected|current|pressed|checked)/;
const ACCENT = /var\(--color-accent(-text)?\)|currentColor/;
const LINE = [/border(-(top|right|bottom|left))?(-color)?\s*:[^;]*var\(--color-accent(-text)?\)/, /box-shadow\s*:[^;]*var\(--color-accent(-text)?\)/];

for (const file of ['main.css', 'sport.css']) {
    test(`${file}: no accent line on a selected item`, () => {
        const css = noComments(fs.readFileSync(path.join(__dirname, '../public/css', file), 'utf8'));
        const bad = [];
        for (const r of rules(css)) {
            if (r.media.some((m) => /forced-colors/.test(m)) || !SELECTED.test(r.sel)) continue;
            // a switch's or radio's own glyph is a control, not a selection line; a filled button is shading
            if (/toggle-slider|rradio|first-run|\.btn-|favorite|volume|resize-handle|context-menu|navbar-menu|sidebar|mobile-menu/.test(r.sel)) continue;
            if (LINE.some((re) => re.test(r.body))) bad.push(r.sel);
            if (/::(before|after)/.test(r.sel) && /background\s*:\s*[^;]*(var\(--color-accent\)|currentColor)/.test(r.body) && /content\s*:/.test(r.body)) bad.push(r.sel);
        }
        assert.deepEqual(bad, [], `an accent line on a selected item: ${bad.join(' | ')}`);
    });
}
