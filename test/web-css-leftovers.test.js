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

test('#295: the top bar fits from 481 px (tighter link sides up to 768 px)', () => {
    const links = find('.nav-link', /max-width:\s*768px/).filter(r => /flex-direction:\s*column/.test(r.body));
    assert.ok(links.length, 'the 768 px nav-link rule');
    assert.match(links[0].body, /padding:\s*var\(--space-sm\) var\(--space-xs\)/);
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

test('#295: the Sport bar link has an icon of its own like the others (the old glyph span was hidden when the labels are)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const sport = html.match(/<a href="#sports"[\s\S]*?<\/a>/)[0];
    assert.match(sport, /<span class="nav-icon"><svg/);
    assert.ok(!sport.includes('◉'), 'no text glyph');
});

test('#295: in the phone guide the channel name is not squeezed to a letter', () => {
    const logo = ALL.find(r => phone.test(r.media) && r.selectors.includes('.epg-channel-info .epg-channel-logo'));
    assert.ok(logo && /display:\s*none/.test(logo.body), 'the logo goes');
    const name = ALL.filter(r => phone.test(r.media) && r.selectors.includes('.epg-channel-name')).pop();
    assert.ok(name && /white-space:\s*normal/.test(name.body) && /-webkit-line-clamp:\s*2/.test(name.body), 'the name may take two lines');
});

// #295 point 2 (PigBrand 1.9.1): status words and tags use the text shades; icons, dots and fills keep the bright colours.
test('#295: the status text tokens carry the brand 1.9.1 values, light and dark', () => {
    const light = find('[data-theme="light"]').map(r => r.body).join(';');
    const dark = find(':root').map(r => r.body).join(';');
    for (const [name, l, d] of [['success', '#0B6948', '#10B981'], ['warning', '#884F0B', '#F59E0B'], ['error', '#A42E25', '#F37171']]) {
        assert.match(light, new RegExp(`--color-${name}-text:\\s*${l}`, 'i'), `light ${name}`);
        assert.match(dark, new RegExp(`--color-${name}-text:\\s*${d}`, 'i'), `dark ${name}`);
    }
});

test('#295: status tags and words are coloured with the text shades, never the bright colour', () => {
    const textOf = (sel) => find(sel).map(r => (r.body.match(/(?<![-\w])color:\s*[^;]+/g) || []).join(';')).join(';');
    const want = { '.rec-tag.is-ok': 'success', '.rec-tag.is-warn': 'warning', '.rec-tag.is-bad': 'error', '.rec-tag.is-live': 'error',
        '.rec-err': 'error', '.provider-soon': 'warning', '.provider-busy': 'warning', '.link-badge.warn': 'warning', '.link-badge.bad': 'error',
        '.status-failure': 'error', '.lineup-status.error': 'error', '.field-error': 'error' };
    for (const [sel, kind] of Object.entries(want)) {
        const c = textOf(sel);
        assert.ok(c.includes(`--color-${kind}-text`), `${sel} uses the ${kind} text shade: ${c}`);
    }
    // No text colour anywhere takes the bright status colour (icons and fills are background, border, fill or stroke).
    assert.deepEqual(css.match(/(?<![-\w])color:\s*var\(--color-(success|warning|error)\b(?!-)/g), ['color: var(--color-warning'], 'only the warning icon keeps a bright colour');
});

test('#295: Providers > Groups never imported keeps the tick box beside the name on a phone', () => {
    const row = ALL.find(r => phone.test(r.media) && r.selectors.includes('.setting-item.import-exclusion'));
    assert.ok(row && /display:\s*grid/.test(row.body) && /grid-template-columns:\s*auto 1fr/.test(row.body));
});

// Rig T3 of the web leftovers batch (15 Nov 2026): three things the static checks above missed.
test('rig: Recordings\' Delete selected is a neutral button with red text, never red on red', () => {
    const all = rules().filter(r => r.media === '' && r.selectors.some(s => s.replace(/\s+/g, ' ') === '.rec-tools .btn-danger'));
    const body = all.map(r => r.body).join(';');
    assert.match(body, /background:\s*var\(--color-bg-tertiary\)/, 'neutral background');
    assert.match(body, /color:\s*var\(--color-error-text\)/, 'status text red');
});
test('rig: the build label leaves the top bar below 768 px, so the nav fits from 481 px', () => {
    const r = rules().find(x => /max-width:\s*768px/.test(x.media) && x.selectors.includes('.version-badge'));
    assert.ok(r && /display:\s*none/.test(r.body), '.version-badge hidden at 768 px and below');
});
test('rig: bare Settings fields are 44 px on touch, after the 36 px base rule', () => {
    const idxBase = css.indexOf('min-height: 36px');
    const tail = css.slice(idxBase);
    assert.match(tail, /@media \(pointer: coarse\)\s*\{[^}]*\.settings-section select:not\(\[class\]\)[^{]*\{\s*min-height:\s*44px/, 'a coarse-pointer 44 px rule comes after the base');
});
