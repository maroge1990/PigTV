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
                out.push({ media, selectors: head.split(/,(?![^(]*\))/).map(s => s.trim()), body: css.slice(open + 1, close) });
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

const phone = /max-width:\s*480px/;

test('#295: on a phone the backup links summary reads as blocks and the users table drops Created', () => {
    const block = ALL.filter(r => phone.test(r.media) && r.selectors.includes('#links-summary .status-table td'));
    assert.ok(block.length && /display:\s*flex/.test(block[block.length - 1].body), 'summary cells are label/value lines');
    assert.ok(ALL.some(r => phone.test(r.media) && r.selectors.includes('#links-summary .status-table td:nth-child(8)::before')), 'every count has its label');
    const created = ALL.find(r => phone.test(r.media) && r.selectors.some(s => /#user-list\) :is\(th, td\):nth-child\(3\)/.test(s)));
    assert.ok(created && /display:\s*none/.test(created.body), 'the Created column is dropped on a phone');
    const chan = ALL.find(r => phone.test(r.media) && r.selectors.includes('.links-table td.link-channel'));
    assert.ok(chan && /min-width:\s*140px/.test(chan.body), 'the backup links channel column is narrower on a phone');
});

const coarse = /pointer:\s*coarse/;

test('#295: the off switch has the control border, not the hairline', () => {
    const slider = find('.toggle-slider')[0];
    assert.match(slider.body, /border:\s*1px solid var\(--color-control-border\)/);
});

test('#295: on touch, <summary> toggles, guide cells and bare Settings fields are 44 px', () => {
    const summary = ALL.find(r => coarse.test(r.media) && r.selectors.includes('summary'));
    assert.ok(summary && /min-height:\s*44px/.test(summary.body), 'summary');
    const cell = ALL.find(r => coarse.test(r.media) && r.selectors.includes('.epg-program'));
    assert.ok(cell && /min-height:\s*44px/.test(cell.body), 'guide cell');
    const bare = ALL.find(r => coarse.test(r.media) && r.selectors.includes('.settings-section select:not([class])'));
    assert.ok(bare && /min-height:\s*44px/.test(bare.body), 'bare field');
});

test('#295: bare Settings fields have padding so the text does not touch the border', () => {
    const bare = find('.settings-section select:not([class])').find(r => !r.media);
    assert.ok(bare, 'a rule for fields with no class');
    assert.match(bare.body, /padding:\s*var\(--space-xs\) var\(--space-md\)/);
    assert.match(bare.body, /min-height:\s*36px/);
});

test('#295: Providers > Groups never imported keeps the tick box beside the name on a phone', () => {
    const row = ALL.find(r => phone.test(r.media) && r.selectors.includes('.setting-item.import-exclusion'));
    assert.ok(row && /display:\s*grid/.test(row.body) && /grid-template-columns:\s*auto 1fr/.test(row.body));
});
