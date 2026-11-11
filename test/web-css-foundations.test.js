const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// #276: the web app's CSS foundations against brand guide 1.8 (16 px text, one focus ring, disabled states, touch
// targets, colour roles, no hand-made glass, the accessibility settings, motion tokens, the vendored kit files).
// Static checks over the stylesheets and pages; the screenshots and keyboard pass are in the batch's evidence.
const PUBLIC = path.join(__dirname, '../public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const CSS = noComments(read('css/main.css'));
const LOGIN = read('login.html');
const LOGIN_CSS = noComments((LOGIN.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1]);

/** Every rule as { sel, body, media } (media: the enclosing @-rule preludes, outermost first). */
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
        if (prelude.startsWith('@media') || prelude.startsWith('@supports') || prelude.startsWith('@starting-style')) {
            out.push(...rules(inner, [...media, prelude]));
        } else if (!prelude.startsWith('@')) {
            out.push({ sel: prelude.replace(/\s+/g, ' '), body: inner, media });
        }
        i = j;
    }
    return out;
}
const ALL = rules(CSS);
const decls = (body, prop) => [...body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1].trim());
const inMedia = (r, re) => r.media.some((m) => re.test(m));
const TOKEN_PX = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, '2xl': 32 };

test('B9: text starts at 16 px (the rem root) in both places, and nothing is set under 12 px', () => {
    const base = ALL.find((r) => r.sel === 'html, body' && !r.media.length);
    assert.deepEqual(decls(base.body, 'font-size'), ['var(--text-md)'], 'html, body is the 16 px root the --text-* rems resolve against');
    const phone = ALL.filter((r) => r.sel === 'body' && inMedia(r, /max-width: 480px/));
    assert.equal(phone.length, 1);
    assert.deepEqual(decls(phone[0].body, 'font-size'), ['var(--text-md)']);
    assert.match(CSS, /--text-xs:\s*0\.75rem/);
    const under = [];
    for (const r of ALL) for (const v of decls(r.body, 'font-size')) {
        const t = v.match(/^var\(--text-([a-z0-9]+)\)$/);
        if (t ? TOKEN_PX[t[1]] < 12 : !/^(inherit|0|initial)$/.test(v)) under.push(`${r.sel}: ${v}`);
    }
    assert.deepEqual(under, []);
    for (const m of LOGIN_CSS.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(+m[1] >= 12 || +m[1] === 0, `login.html font-size ${m[1]}px`);
});

test('B9: form controls are at least 16 px; the phone breakpoint no longer shrinks buttons, tabs or the guide buttons', () => {
    const controls = ALL.find((r) => r.sel === 'button, input, select, textarea' && !r.media.length);
    assert.ok(controls, 'one element rule gives controls the page font');
    assert.deepEqual(decls(controls.body, 'font-size'), ['var(--text-md)']);
    const field = /(^|[\s,])(input|select|textarea)\b|\.(form-input|search-input|source-select|rec-input)\b/;
    const small = ALL.filter((r) => r.sel.split(',').some((s) => field.test(s) && !/::?placeholder|label/.test(s)))
        .flatMap((r) => decls(r.body, 'font-size').filter((v) => /--text-(xs|sm)\)/.test(v)).map((v) => `${r.sel}: ${v}`));
    assert.deepEqual(small, []);
    assert.match(LOGIN_CSS, /\.form-group input\s*\{[^}]*font-size:\s*16px/);
    const phoneDrops = ALL.filter((r) => inMedia(r, /max-width: 480px/) && /^(\.btn|\.btn-sm|\.tab|\.guide-controls \.btn)$/.test(r.sel))
        .filter((r) => decls(r.body, 'font-size').length);
    assert.deepEqual(phoneDrops.map((r) => r.sel), []);
});

test('B9/C11: the TV Guide density is a named exception; headings are tight and large ones tracked in', () => {
    assert.match(read('css/main.css'), /EPG Guide\s+The TV Guide grid[\s\S]{0,160}exception \(Mark, 10 Nov 2026/);
    assert.match(fs.readFileSync(path.join(__dirname, '../docs/DESIGN.md'), 'utf8'), /Two recorded exceptions[\s\S]{0,80}TV Guide grid \(Mark, 10 Nov/);
    const h = ALL.find((r) => r.sel === 'h1, h2, h3, h4, h5, h6');
    assert.deepEqual(decls(h.body, 'line-height'), ['1.2']);
    assert.deepEqual(decls(ALL.find((r) => r.sel === 'h2' && !r.media.length).body, 'letter-spacing'), ['-0.01em']);
    assert.match(CSS, /font-family:\s*'Inter',/);
});

test('B9: only the named exceptions are denser than 16 px: the Guide grid, the Live TV channel list, the admin tables', () => {
    const raw = read('css/main.css');
    assert.match(raw, /Text-size exception \(Mark, 11 Nov 2026; docs\/DESIGN\.md\): the Live TV channel list/);
    assert.match(raw, /Text-size exception \(Mark, 11 Nov 2026; docs\/DESIGN\.md\): the admin tables/);
    assert.match(fs.readFileSync(path.join(__dirname, '../docs/DESIGN.md'), 'utf8'), /Live TV channel list and admin tables at 14 px[\s\S]{0,80}Mark, 11 Nov 2026/);
    const EXCEPTIONS = {
        '.channel-list .group-name, .channel-list .channel-name': 'var(--text-sm)',
        '.channel-list .channel-program': 'var(--text-xs)',
        '.user-table th': 'var(--text-sm)',
        '.user-table td': 'var(--text-sm)',
        '.status-table td': 'var(--text-sm)',
        '.links-table td': 'var(--text-sm)',
        '#links-summary .user-table th, #links-summary .user-table td': 'var(--text-sm)',
    };
    for (const [sel, size] of Object.entries(EXCEPTIONS)) {
        const r = ALL.find((x) => x.sel === sel && !x.media.length);
        assert.ok(r, `${sel} exists`);
        assert.deepEqual(decls(r.body, 'font-size'), [size], sel);
    }
    // Nothing else in the channel list or a table cell is set under 16 px (the Guide grid's .epg-* rules are its own).
    const scoped = /(^|[\s,])(td|th)\b|\.channel-list\b|\.group-name\b|\.channel-name\b|\.channel-program\b/;
    const extra = ALL.filter((r) => scoped.test(r.sel) && !(r.sel in EXCEPTIONS) && !/\.epg-|now-playing|checkbox-label/.test(r.sel))
        .flatMap((r) => decls(r.body, 'font-size').filter((v) => /--text-(xs|sm)\)/.test(v)).map((v) => `${r.sel}: ${v}`));
    assert.deepEqual(extra, []);
    // Body-like controls and rows stay at 16 px.
    for (const sel of ['.btn', '.tab', '.subtab', '.form-input', '.search-input', '.source-select', '.context-item', '.overflow-menu-item', '.captions-option', '.checkbox-label.channel-item']) {
        const r = ALL.find((x) => x.sel === sel && !x.media.length && decls(x.body, 'font-size').length);
        assert.deepEqual(decls(r.body, 'font-size'), ['var(--text-md)'], sel);
    }
});

test('range inputs keep a visible track: the Control boundary on Raised rows, the media white on the player, system drawing in forced colours', () => {
    const slider = ALL.find((r) => r.sel === '.volume-slider' && !r.media.length);
    assert.deepEqual(decls(slider.body, 'background'), ['var(--color-control-border)']);
    const coarse = ALL.find((r) => r.sel === '.volume-slider' && inMedia(r, /pointer: coarse/));
    assert.match(coarse.body, /linear-gradient\(var\(--color-control-border\), var\(--color-control-border\)\)/);
    assert.match(ALL.find((r) => r.sel === '.watch-volume' && !r.media.length).body, /background:\s*rgba\(255, 255, 255, 0\.3\)/);
    assert.ok(ALL.some((r) => inMedia(r, /forced-colors/) && r.sel === '.volume-slider, .watch-volume' && /appearance:\s*auto/.test(r.body)));
});

test('B7: one focus ring (the kit\'s 3 px / 4 px), one inset variant for clipping boxes, and no ring removed', () => {
    assert.match(CSS, /--focus-ring:\s*3px solid var\(--color-accent\)/);
    assert.match(CSS, /--focus-offset:\s*4px/);
    const outlines = ALL.filter((r) => !inMedia(r, /forced-colors/)).flatMap((r) => decls(r.body, 'outline').map((v) => `${r.sel}: ${v}`));
    assert.deepEqual(outlines.filter((o) => !/: var\(--focus-ring\)$/.test(o)), [], 'every outline is the one ring');
    assert.equal(outlines.length, 3, 'the global ring, the inset variant and the toggle switch slider');
    const insets = ALL.filter((r) => decls(r.body, 'outline-offset').includes('var(--focus-offset-inset)'));
    assert.equal(insets.length, 1);
    for (const s of ['.nav-link:focus-visible', '.captions-option:focus-visible', '.overflow-menu-item:focus-visible', '.ui-menu-item:focus-visible', '.context-item:focus-visible']) {
        assert.ok(insets[0].sel.includes(s), `${s} uses the inset variant`);
    }
    const global = ALL.find((r) => r.sel.startsWith(':where(') && r.sel.endsWith(':focus-visible') && !r.media.length);
    for (const el of ['button', 'a', 'input', 'select', 'textarea', 'summary', '[role="button"]', '[role="tab"]', '[tabindex]']) {
        assert.ok(global.sel.includes(el), `the global ring covers ${el}`);
    }
    assert.ok(ALL.some((r) => r.sel === '.setting-toggle input:focus-visible+.toggle-slider' && decls(r.body, 'outline')[0] === 'var(--focus-ring)'), 'the 14 switches show the ring');
    assert.ok(ALL.some((r) => r.sel.includes('.favorite-btn:focus-visible') && decls(r.body, 'opacity')[0] === '1'), 'a focused heart is visible');
    assert.doesNotMatch(CSS, /outline:\s*(none|0)\b/);
    assert.ok(!ALL.some((r) => /:focus/.test(r.sel) && decls(r.body, 'box-shadow').length), 'no box-shadow ring');
    assert.doesNotMatch(LOGIN_CSS, /outline:/, 'the sign-in page uses main.css\'s ring');
});

test('B7: disabled buttons, fields and switches look disabled and have no hover', () => {
    const btn = ALL.find((r) => r.sel === '.btn:disabled, .btn[aria-disabled="true"]');
    assert.ok(btn && decls(btn.body, 'opacity').length && decls(btn.body, 'cursor')[0] === 'default');
    assert.ok(ALL.some((r) => r.sel === 'input:disabled, select:disabled, textarea:disabled'));
    assert.ok(ALL.some((r) => r.sel === '.setting-toggle input:disabled+.toggle-slider'));
    for (const v of ['primary', 'secondary', 'ghost', 'danger']) {
        assert.ok(ALL.some((r) => r.sel === `.btn-${v}:hover:not(:disabled, [aria-disabled="true"])`), `.btn-${v} hover skips disabled`);
        assert.ok(!ALL.some((r) => r.sel === `.btn-${v}:hover`), `no bare .btn-${v}:hover`);
    }
});

test('B7: the Settings tab strips are ARIA tablists with selected state and arrow keys', () => {
    const html = read('index.html');
    assert.match(html, /<div class="tabs" role="tablist" aria-label="Settings">/);
    assert.match(html, /<div class="subtabs hidden" id="subtabs-channels" role="tablist" aria-label="Channels">/);
    const js = read('js/pages/Settings.js');
    assert.match(js, /setAttribute\('role', 'tab'\)/);
    assert.match(js, /setAttribute\('aria-selected', String\(on\)\)/);
    assert.match(js, /ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last'/);
});

test('B10: on a coarse pointer every control in the audit is at least 44 x 44 px', () => {
    const coarse = ALL.filter((r) => inMedia(r, /\(pointer: coarse\)/));
    const sized = (sel) => coarse.some((r) => r.sel.split(',').map((s) => s.trim()).includes(sel)
        && /(min-height|height):\s*44px/.test(r.body));
    const hit = (sel) => coarse.some((r) => r.sel.split(',').map((s) => s.trim()).includes(`${sel}::after`) && /width:\s*44px/.test(r.body) && /height:\s*44px/.test(r.body));
    const MIN44 = ['.btn', '.tab', '.subtab', '.btn-close', '.sidebar-collapse-btn', '.sidebar-expand-btn', '.recording-player-close',
        '.ui-toast-action', '.ui-toast-close', '.mobile-menu-toggle', '.group-header', '.context-item', '.overflow-menu-item',
        '.captions-option', '.ui-menu-item', '.checkbox-label', '.search-input', '.form-input', '.source-select',
        '.settings-section select', '.volume-slider', '.watch-volume'];
    assert.deepEqual(MIN44.filter((s) => !sized(s)), []);
    assert.deepEqual(['.favorite-btn', '.search-clear', '.setting-toggle'].filter((s) => !hit(s)), []);
    const widths = coarse.find((r) => r.sel.split(',').map((s) => s.trim()).includes('.btn') && /min-width:\s*44px/.test(r.body));
    assert.ok(widths, 'width too, not only height');
});

test('B2: colours come from the roles: no hex outside the token blocks, no retired token, normal states not red or purple', () => {
    const hex = ALL.filter((r) => !/^(:root|\[data-theme="(light|dark)"\])$/.test(r.sel))
        .filter((r) => !(r.sel === ':root' && r.media.length))
        .flatMap((r) => (r.body.match(/#[0-9a-f]{3,8}\b/gi) || []).map((h) => `${r.sel}: ${h}`));
    assert.deepEqual(hex, []);
    const retired = /--color-bg-hover|--color-bg-active|--color-border-light|--glass-bg|--color-surface-active/;
    const jsFiles = (dir) => fs.readdirSync(path.join(PUBLIC, dir), { withFileTypes: true })
        .flatMap((d) => (d.isDirectory() ? jsFiles(`${dir}/${d.name}`) : d.name.endsWith('.js') ? [`${dir}/${d.name}`] : []));
    for (const f of ['css/main.css', 'login.html', 'index.html', ...jsFiles('js')]) assert.doesNotMatch(read(f), retired, f);
    assert.doesNotMatch(CSS, /156,\s*39,\s*176|158,\s*158,\s*158/, 'no purple Upscaling or grey quality badge');
    assert.ok(!ALL.some((r) => /\.transcode-status\.(transcoding|upscaling)/.test(r.sel)), 'Transcoding and Upscaling are the neutral badge');
    const badge = ALL.find((r) => r.sel === '.version-badge');
    assert.doesNotMatch(badge.body, /background|--color-accent|border-radius/, 'B4: the build number is text, not a rose pill');
    assert.deepEqual(decls(badge.body, 'color'), ['var(--color-text-secondary)']);
});

test('B8: no hand-made glass; settings and status sections are the shared opaque Surface card', () => {
    assert.deepEqual(ALL.filter((r) => /backdrop-filter/.test(r.body)).map((r) => r.sel), [], 'glass is only pig-glass.css\'s .pig-glass');
    const card = ALL.find((r) => r.sel === '.rec-card, .settings-section');
    assert.ok(card, 'one Surface card rule shared with Recordings');
    assert.deepEqual(decls(card.body, 'background'), ['var(--color-surface)']);
    const media = ALL.find((r) => r.sel.includes('.now-playing-overlay') && /--color-text-primary:\s*var\(--media-text\)/.test(r.body));
    assert.ok(media && media.sel.includes('.watch-captions-menu') && media.sel.includes('.player-overflow-menu'), 'player panels keep the protected dark palette');
    assert.match(CSS, /--media-panel:\s*rgba\(30, 25, 37, 0\.(8[2-9]|9\d)\)/, 'player panels are at least 82 % opaque');
});

test('B11: Reduce Motion, Reduce Transparency, Increase Contrast and forced colours are handled; text can be selected', () => {
    const block = (q) => ALL.filter((r) => inMedia(r, q));
    const motion = block(/prefers-reduced-motion: reduce/);
    assert.ok(motion.some((r) => r.sel === '*, *::before, *::after' && /animation-iteration-count:\s*1 !important/.test(r.body) && /transition-property:\s*opacity !important/.test(r.body)));
    assert.ok(motion.some((r) => r.sel === 'html' && /scroll-behavior:\s*auto/.test(r.body)));
    assert.ok(motion.some((r) => r.sel.includes('.favorite-btn:hover') && /transform:\s*none/.test(r.body)), 'hover scaling off');
    const transparency = block(/prefers-reduced-transparency: reduce/);
    for (const s of ['.ui-dialog::backdrop', '.channel-sidebar-overlay', '.recording-player-overlay', '.player-overlay']) {
        assert.ok(transparency.some((r) => r.sel.includes(s)), `${s} is solid with Reduce Transparency`);
    }
    assert.ok(transparency.some((r) => /--media-panel:\s*var\(--media-raised\)/.test(r.body)));
    const contrast = block(/prefers-contrast: more/);
    assert.ok(contrast.some((r) => /--color-border:\s*var\(--color-control-border\)/.test(r.body) && /--color-text-secondary:\s*var\(--color-text-primary\)/.test(r.body)));
    const forced = block(/forced-colors: active/);
    assert.ok(forced.some((r) => r.sel.includes(':focus-visible') && /Highlight/.test(r.body)));
    assert.ok(forced.some((r) => r.sel.includes('.tab.active') && /Highlight/.test(r.body)));
    assert.ok(!ALL.some((r) => r.sel.split(',').map((s) => s.trim()).includes('*') && /user-select:\s*none/.test(r.body)), 'no user-select: none on *');
    const ui = read('js/ui.js');
    assert.match(ui, /scrollBehavior\(\) \{[\s\S]*prefers-reduced-motion: reduce/);
    for (const f of ['js/components/ChannelList.js', 'js/pages/RecordingsPage.js', 'js/pages/SportsPage.js', 'js/components/EpgGuide.js']) {
        assert.doesNotMatch(read(f), /behavior:\s*'smooth'/, `${f} asks UI.scrollBehavior()`);
    }
});

test('C1/C4/C5/C6/C8: motion tokens, named transitions, pressed states, two-way menus, no layout animation or hard line', () => {
    assert.match(CSS, /--transition-fast:\s*var\(--duration-fast\) var\(--ease-out\)/);
    assert.match(CSS, /--transition-move:\s*var\(--duration-move\) var\(--ease-out\)/);
    assert.match(CSS, /--duration-fast:\s*150ms/);
    assert.match(CSS, /--duration-move:\s*250ms/);
    for (const [name, css] of [['main.css', CSS], ['login.html', LOGIN_CSS]]) {
        assert.doesNotMatch(css, /transition:\s*all\b/, `${name}: no transition: all`);
        const literal = [...css.matchAll(/(?<![-\w])transition(?:-duration)?\s*:\s*([^;]+)/g)].map((m) => m[1])
            .filter((v) => /(?<![\w-])(?!0s\b)\d*\.?\d+m?s\b/.test(v));
        assert.deepEqual(literal, [], `${name}: transition durations come from the tokens`);
    }
    assert.ok(!ALL.some((r) => /transition:[^;]*\b(width|min-width|max-height)\b/.test(r.body)), 'no width or max-height animation');
    assert.ok(ALL.some((r) => r.sel.includes('.btn:active') && inMedia(r, /no-preference/) && /scale\(0\.97\)/.test(r.body)));
    assert.ok(ALL.some((r) => r.sel.includes('.channel-item:active')));
    assert.ok(ALL.some((r) => r.sel.includes('.nav-link:active')));
    assert.ok(ALL.some((r) => inMedia(r, /@starting-style/) && r.sel.includes('.watch-captions-menu')));
    assert.ok(ALL.some((r) => r.sel.includes('.context-menu') && /allow-discrete/.test(r.body)));
    const menu = ALL.find((r) => r.sel === '.navbar-menu' && inMedia(r, /max-width: 480px/));
    assert.match(menu.body, /visibility 0s linear var\(--duration-move\)/, 'the phone menu animates closed too');
    assert.doesNotMatch(menu.body, /border-bottom/);
    assert.deepEqual(decls(ALL.find((r) => r.sel === '#app .navbar.pig-glass').body, 'border-width'), ['0']);
});

// pig-glass.css and pig-radiance.css are the kit's tokens/ files byte for byte (PigBrand origin/main, 11 Nov 2026).
const KIT = {
    'css/pig-glass.css': 'c3662d38d8903706bf603f8abeb2e801079a966a3fd4eb6904dfb5f2056335fa',
    'css/pig-radiance.css': '1a74a19168689dd30f58695fd9bc2e0e9b4a685a8f3bfa8d4410f65d818ea16e',
};
test('the vendored brand CSS is the kit\'s files, byte for byte', () => {
    for (const [f, sha] of Object.entries(KIT)) {
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, f))).digest('hex'), sha, f);
    }
});

// #276 review (rig pass): what the batch changed by accident.
test('review: a locked switch is grey and dashed, a locked field dashed; never the look of one that can be used', () => {
    const on = ALL.find((r) => r.sel === '.setting-toggle input:disabled:checked+.toggle-slider');
    assert.ok(on && /var\(--color-text-muted\)/.test(decls(on.body, 'background')[0] || ''), 'a locked switch that is on is not the accent');
    const sw = ALL.find((r) => r.sel === '.setting-toggle input:disabled+.toggle-slider');
    assert.equal(decls(sw.body, 'border-style')[0], 'dashed');
    const field = ALL.find((r) => r.sel === 'input:disabled, select:disabled, textarea:disabled');
    assert.equal(decls(field.body, 'border-style')[0], 'dashed');
    assert.ok(ALL.some((r) => r.sel === '.volume-slider:disabled::-webkit-slider-thumb'), 'a locked slider\'s handle is not the accent');
});

test('review: provider facts use the card width with one label column; the player menu keeps a label on one line; the rule example fits a phone', () => {
    assert.ok(ALL.some((r) => r.sel === '.provider-body:not(:has(.provider-form))' && /minmax\(0, 1fr\)/.test(r.body)));
    const dt = ALL.find((r) => r.sel === '.provider-facts dt');
    assert.ok(decls(dt.body, 'min-width').length, 'every card the same label column');
    const item = ALL.find((r) => r.sel === '.overflow-menu-item');
    assert.equal(decls(item.body, 'white-space')[0], 'nowrap');
    const placeholder = read('index.html').match(/id="rule-add-match"[^>]*placeholder="([^"]+)"/)[1];
    assert.ok(placeholder.length <= 30, `"${placeholder}" fits the 390 px field`);
});
