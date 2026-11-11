const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument } = require('./helpers/fakeDom');

// #276 (owner's decision of 11 Nov 2026, Sport page option A): compact cards in shelves, a "⋯" options button in the
// card's corner, sentence-case statuses, the league filter as chips, no empty shelves, and page-level loading, empty and
// error states drawn by UI.stateBlock. Behaviour (fetching, polling, spoiler rules, Watch/Record) is unchanged.
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/pages/SportsPage.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');

function browser(extra = {}) {
    const document = createDocument();
    const context = vm.createContext({ console: { ...console, log() {}, warn() {}, error() {} }, document, setTimeout, clearTimeout,
        performance: { now: () => 0 }, localStorage: { getItem: () => 'tok' }, API: { sports: {} }, ...extra });
    context.window = context;
    loadUi(context);
    vm.runInContext(source, context);
    return { context, document, UI: vm.runInContext('UI', context) };
}
const game = (extra = {}) => ({ id: 'g', league: 'NBA', title: 'A v B', status: 'live', freshness: 'fresh',
    progress: { period: 2, clock: '1:20' }, scores: ['99', '98'], availability: 'matched', canWatch: true,
    competitors: [{ name: 'Alpha Club' }, { name: 'Beta' }],
    channels: [{ sourceId: 1, stableId: 'stable', id: 'pos_1', name: 'TV One' }],
    events: [{ id: 'e', start: 100, end: 1000 }], ...extra });

function page(b, extra = {}) {
    const p = Object.create(b.context.window.SportsPage.prototype);
    const el = b.document.createElement('div'); b.document.body.appendChild(el);
    Object.assign(p, { root: el, app: { currentUser: { role: 'admin' } }, cards: new Map(), shelves: new Map(), orders: new Map(),
        recordings: [], recordingsVisit: 0, dialog: null, selection: null, waiting: null, timer: null,
        state: new b.context.window.SportsDashboardState(b.context.API.sports, () => 'tok', () => 0) }, extra);
    p.state.changed = () => p.render();
    return p;
}

test('statuses are sentence case words; no ALL-CAPS status is left', () => {
    const p = browser().context.window.SportsDashboardPolicy;
    const cases = [[{}, 'Live'], [{ status: 'scheduled' }, 'Upcoming'], [{ status: 'finished' }, 'Final'],
        [{ status: 'cancelled' }, 'Cancelled'], [{ status: 'postponed' }, 'Postponed'], [{ status: 'suspended' }, 'Suspended'],
        [{ status: 'break' }, 'Break'], [{ status: 'break', breakLabel: 'Stumps' }, 'Stumps'],
        [{ status: 'unknown', broadcastStatus: 'on-tv' }, 'On TV now'], [{ status: 'unknown', freshness: 'buffering' }, 'Buffering'],
        [{ status: 'unknown', freshness: 'stale' }, 'Status unavailable']];
    for (const [extra, word] of cases) assert.equal(p.status(game(extra)), word);
    assert.doesNotMatch(source, /'(LIVE|FINAL|UPCOMING|CANCELLED|POSTPONED|SUSPENDED|BREAK|ON TV NOW|BUFFERING|STATUS UNAVAILABLE)'/);
    const live = p.card(game(), { avoidSpoilers: true }, 'UTC');
    assert.match(live, /<span class="sports-status is-live">Live<\/span>/, 'Live carries the dot class');
    assert.match(p.card(game({ status: 'scheduled' }), {}, 'UTC'), /<span class="sports-status">Upcoming<\/span>/);
});

test('the card: badges or the fallback disc, scores and clocks as amounts, the channel row, words for availability and recording', () => {
    const p = browser().context.window.SportsDashboardPolicy;
    const shown = p.card(game({ competitors: [{ name: 'Alpha Club', logo: '/api/logo/a' }, { name: 'Beta' }] }), { avoidSpoilers: false }, 'UTC', true);
    assert.match(shown, /<img class="sports-badge" src="\/api\/logo\/a"/);
    assert.match(shown, /<span class="sports-badge is-fallback" aria-hidden="true">B<\/span>/);
    assert.match(shown, /<strong class="sports-score pig-amount">99<\/strong>/);
    assert.match(shown, /<span class="pig-amount">1:20<\/span>/);
    assert.match(shown, /class="sports-channel"[^>]*>[\s\S]*TV One/);
    assert.match(shown, /<span class="sports-recording">Recording<\/span>/);
    const hidden = p.card(game(), { avoidSpoilers: true }, 'UTC');
    assert.match(hidden, /<span class="sports-hidden-tag">Scores hidden<\/span>/);
    assert.doesNotMatch(hidden, /99|98|sports-score/);
    const unmatched = p.card(game({ availability: 'unmatched' }), {}, 'UTC');
    assert.match(unmatched, /class="sports-availability unmatched"[^>]*>[\s\S]*No channel found<\/span>/);
    assert.doesNotMatch(unmatched, /TV One/);
    assert.match(p.card(game({ availability: 'unavailable' }), {}, 'UTC'), /class="sports-availability unavailable"[^>]*>[\s\S]*Channel unavailable/);
    assert.match(p.card(game({ status: 'scheduled', start: Date.UTC(2026, 10, 14, 15, 0) }), {}, 'UTC'),
        /Sat,? (14 Nov|Nov 14), <span class="pig-amount">3:00\s?(PM|pm)<\/span>/, 'weekday, day, month and time without a leading zero');
});

test('the options button is a 44 x 44 "⋯" labelled for its game: a sibling of the card button, never inside it', () => {
    const p = browser().context.window.SportsDashboardPolicy;
    const item = p.item('A v B');
    assert.match(item, /^<button type="button" class="sports-card"><\/button><button type="button" class="sports-more" aria-label="More options for A v B" title="More options">/);
    assert.equal(item.indexOf('<button', 1), item.indexOf('</button>') + '</button>'.length, 'the ⋯ starts after the card closes');
    assert.doesNotMatch(source, />More options</, 'no full-width "More options" button');
    assert.match(css, /\.sports-more\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/);
});

test('Sport CSS: no fixed 22rem card, no outline selection on the chips, its own scroll, no Sport-only focus recipe', () => {
    assert.doesNotMatch(css, /height:\s*22rem/);
    assert.doesNotMatch(css, /\.sports-filters \[aria-pressed="true"\]\s*\{\s*outline/);
    assert.match(css, /\.sports-filter\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--color-accent-dim\)/);
    assert.match(css, /#page-sports\s*\{[^}]*overflow-y:\s*auto/);
    assert.doesNotMatch(css, /#page-sports button:focus-visible/);
    assert.match(css, /\.sports-message\s*\{/); assert.doesNotMatch(css, /\.sports-empty\s*\{/);
    assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.sports-row[^{]*\{\s*scroll-behavior:\s*auto/);
});

test('a league with no games draws no shelf and is named in one line; with none at all, the quiet block', () => {
    const p = browser().context.window.SportsDashboardPolicy;
    const r = { scope: 'today', hours: null, leagues: ['AFL', 'NBA'], games: [game({ league: 'AFL' })] };
    const lay = p.layout(r, null, false);
    assert.deepEqual([...lay.shelves], ['AFL']);
    assert.deepEqual([...lay.quiet], ['NBA']);
    assert.equal(p.quietNote(lay.quiet, p.span(r)), 'Also followed: NBA. Nothing on today.');
    assert.equal(p.quietNote(['NBA', 'NFL', 'AFL'], p.span({ scope: 'league', hours: 48 })), 'Also followed: NBA, NFL and AFL. Nothing on in the next 48 hours.');
    assert.equal(p.quietNote(['NBA'], p.span({})), 'Also followed: NBA. Nothing on.', 'no scope, no hours: nothing claimed');
    assert.doesNotMatch(source, /next 72 hours\.|Nothing on in the next 72/, 'the horizon comes from the response');
    const none = p.layout({ leagues: ['AFL', 'NBA'], games: [] }, null, false);
    assert.equal(none.followed, true); assert.equal(none.shelves.length, 0);
    const { UI } = browser();
    const block = (s) => UI.stateBlock(s.kind, s.text, s.action && { ...s.action, run() {} }, s.options);
    const today = block(p.pageState('quiet', { names: none.quiet, admin: true, span: 'today' }));
    assert.match(today, /Nothing on today for the leagues you follow/);
    assert.match(today, /AFL or NBA/);
    assert.match(today, /class="btn btn-secondary state-block-action"[^>]*>Change what you follow</);
    assert.match(block(p.pageState('quiet', { names: ['NBA'], admin: true, span: 'in the next 72 hours' })), /state-block-title">Nothing on in the next 72 hours</);
    const viewer = block(p.pageState('quiet', { names: none.quiet, admin: false, span: 'today' }));
    assert.doesNotMatch(viewer, /Change what you follow|<button|<a /, 'no control for someone who cannot open Settings');
    assert.doesNotMatch(source, /No games or guide listings available/, 'no empty-shelf text');
});

test('nothing followed: one page-level empty state with the pig mark class and exactly one btn-primary', () => {
    const { context, UI } = browser();
    const p = context.window.SportsDashboardPolicy;
    assert.equal(p.layout({ leagues: [], games: [] }, null, false).followed, false);
    assert.equal(p.layout({ leagues: [], games: [] }, null, true).followed, true, 'ordinary Sport has no follows to choose');
    const s = p.pageState('nofollow', { admin: true });
    const html = UI.stateBlock(s.kind, s.text, { ...s.action, run() {} }, s.options);
    assert.match(html, /^<div class="state-block state-empty sports-empty-page">/);
    assert.match(html, /Follow your teams and leagues/);
    assert.equal(html.match(/btn-primary/g)?.length, 1);
    assert.match(html, />Choose your sport</);
    assert.doesNotMatch(html, /PigTV app/);
    const v = p.pageState('nofollow', { admin: false });
    const viewer = UI.stateBlock(v.kind, v.text, v.action && { ...v.action, run() {} }, v.options);
    assert.match(viewer, /^<div class="state-block state-empty sports-empty-page">/);
    assert.doesNotMatch(viewer, /<button|<a |btn-/, 'no button for someone who cannot open Settings');
    assert.match(viewer, /the scores\. Choose what you follow in the PigTV app on Apple TV, iPad or iPhone\.<\/p>/);
    assert.match(css, /\.sports-empty-page::before\s*\{[^}]*url\('\/img\/brand\/mark\.svg'\)/, 'the brand mark file, not a redraw');
});

test('"Choose your sport" opens Settings on its Sport tab (Your sport) by its address, #settings/sport', () => {
    const b = browser();
    const calls = [];
    const pg = page(b, { app: { currentUser: { role: 'admin' }, navigateTo: (...a) => calls.push(['nav', ...a]) } });
    pg.openSportSettings();
    assert.deepEqual(calls, [['nav', 'settings', 'push', 'sport']]);
});

test('loading: the page keeps its shape (header, placeholder chips and shelves of card shapes) while /api/info is pending', async () => {
    const b = browser({ API: { sports: {}, request: () => new Promise(() => {}) } });
    const pg = page(b);
    pg.show();
    assert.match(pg.root.querySelector('.page-header').textContent, /Sport/);
    const line = pg.root.querySelector('.sports-message');
    assert.equal(line.getAttribute('role'), 'status');
    assert.equal(line.textContent, 'Loading today’s games…');
    assert.match(pg.root.querySelector('.sports-filters').innerHTML, /sports-sk-chip/);
    const sk = pg.root.querySelector('.sports-state').innerHTML;
    assert.match(sk, /^<div class="sports-skeleton" aria-hidden="true">/);
    assert.equal(sk.match(/class="sports-sk-card"/g).length, 10, 'two shelves of five card shapes');
    assert.doesNotMatch(sk.replace(/<[^>]*>/g, ''), /\S/, 'no fake text in the shapes');
    assert.doesNotMatch(sk, /state-block/, 'a Sport skeleton, not the generic block');
    assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.sports-sk\s*\{\s*animation:\s*none/);
});

test('the hidden attribute always hides, app-wide, whatever display a class gives', () => {
    assert.match(css, /(^|\n)\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
    assert.ok(css.indexOf('[hidden]') < css.indexOf('.btn {'), 'in the base rules');
    assert.doesNotMatch(css, /#page-sports \[hidden\]/, 'one rule, not per page');
});

test('load failure: an error block that says what still works, with "Try again", instead of a bare sentence', async () => {
    const b = browser({ API: { sports: {}, request: async () => { throw Error('offline'); } } });
    const pg = page(b);
    await pg.show();
    const html = pg.root.querySelector('.sports-state').innerHTML;
    assert.match(html, /class="state-block state-error" role="alert"/);
    assert.match(html, /Sport could not be loaded\./);
    assert.match(html, /Live TV and the TV Guide still work\./);
    assert.match(html, />Try again</);
    assert.doesNotMatch(source, /Sport unavailable\. Try opening Sport again\./);
});

test('the record dialog says what it does, and Save names its thing', () => {
    const record = source.slice(source.indexOf('confirmRecording(id'), source.indexOf('notice(message)'));
    assert.doesNotMatch(record, />Confirm</);
    assert.match(record, /'Record every game' : 'Record'/);
    assert.doesNotMatch(source, />Save<\/button>/);
    assert.match(source, />Save score settings<\/button>/);
});
