'use strict';
// #295: the small layout and touch leftovers of the brand 1.8 pass. Static CSS checks (the widths themselves are
// checked on the rig): each asserts the rule that fixes one leftover is in main.css.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'main.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as { media, selectors, body }; `media` is the text of the enclosing @media query, or ''. */
function rules() {
    const out = [];
    let i = 0;
    const walk = (media, end) => {
        while (i < end) {
            const open = css.indexOf('{', i);
            if (open < 0 || open >= end) { i = end; return; }
            const head = css.slice(i, open).trim();
            if (head.startsWith('@media') || head.startsWith('@supports')) {
                i = open + 1;
                let depth = 1, j = i;
                while (depth && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
                const blockEnd = j - 1;
                walk(head.startsWith('@media') ? head : media, blockEnd);
                i = blockEnd + 1;
            } else if (head.startsWith('@')) {
                let depth = 1, j = open + 1;
                while (depth && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
                i = j;
            } else {
                const close = css.indexOf('}', open);
                out.push({ media, selectors: head.split(',').map(s => s.trim()), body: css.slice(open + 1, close) });
                i = close + 1;
            }
        }
    };
    walk('', css.length);
    return out;
}
const ALL = rules();
const find = (selector, mediaRe) => ALL.filter(r => r.selectors.includes(selector) && (mediaRe ? mediaRe.test(r.media) : true));

test('#295: the top bar fits from 481 to 560 px (tighter links and lockup)', () => {
    const links = find('.navbar-menu .nav-link', /min-width:\s*481px\)\s*and\s*\(max-width:\s*560px/);
    assert.ok(links.length, 'a nav-link rule for 481 to 560 px');
    assert.match(links[0].body, /padding-left:\s*var\(--space-xs\)/);
    const lockup = find('.brand-lockup', /min-width:\s*481px/);
    assert.ok(lockup.length && /width:\s*104px/.test(lockup[0].body), 'a smaller lockup in that range');
});
