const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument, FakeEvent } = require('./helpers/fakeDom');

// #323 step 1: the web Sport front page on C-R (GET /api/sports/front), ported from the Apple apps (SportFrontTVPage on a
// computer, SportFrontPhonePage on a phone) to the mocks Mark approved on 14 Nov 2026. Rendered with the real modules.
// The rule that must hold (#192, #278): with scores hidden, no score, result or score-revealing word is anywhere in the
// markup, its attributes included; hidden is the OR of the account's choice (unknown or unread counts as hidden) and the
// answer's own spoilerFree.
const root = path.join(__dirname, '..');
const js = (f) => fs.readFileSync(path.join(root, 'public/js', f), 'utf8');
const golden = JSON.parse(fs.readFileSync(path.join(root, 'test/golden/sports-front.json'), 'utf8'));

function browser(api = {}) {
    const document = createDocument();
    // The page's refresh timers must not keep the test process alive.
    const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
    const context = vm.createContext({ console: { ...console, log() {}, warn() {}, error() {} }, document, setTimeout: later, clearTimeout, Date,
        localStorage: { getItem: () => 'tok' }, API: api });
    context.window = context;
    loadUi(context);
    vm.runInContext(js('pages/SportView.js'), context);
    vm.runInContext(js('pages/SportsPage.js'), context);
    return { context, document, V: context.window.SportView };
}

const NOW = Date.UTC(2026, 10, 14, 9, 0);
const team = (name, logo = null) => ({ id: name, name, logo });
/** A front answer with distinctive scores and score-revealing details in every place they can appear. */
function answer(extra = {}) {
    const g = (o) => ({ league: 'EPL', sport: 'Football', title: 'A v B', start: NOW - 3600000, end: null, session: null, circuit: null, format: null,
        status: 'live', freshness: 'fresh', progress: {}, availability: 'matched', broadcastStatus: 'on-tv', canWatch: true, events: [],
        channels: [{ sourceId: 1, stableId: 's1', id: '101', name: 'Stan Sport 1', start: NOW - 3600000, end: NOW + 3600000 }], followed: false, ...o });
    const games = [
        g({ id: 'ars', title: 'Arsenal v Chelsea', competitors: [team('Arsenal', '/api/logo/ars'), team('Chelsea')], scores: ['47', '31'],
            progress: { period: 2, clock: "67'" }, followed: true, followedSides: [0] }),
        g({ id: 'pen', title: 'Liverpool v Man City', competitors: [team('Liverpool'), team('Man City')], scores: ['58', '59'],
            progress: { period: 5, clock: "120'" } }),
        g({ id: 'avl', title: 'Aston Villa v Brentford', competitors: [team('Aston Villa'), team('Brentford')], scores: ['63', '64'],
            status: 'finished', channels: [] }),
        g({ id: 'nfl', league: 'NFL', sport: 'American football', title: 'Packers v Bears', competitors: [team('Packers'), team('Bears')],
            scores: ['71', '72'], progress: { period: 2, clock: '5:00' }, situation: { down: 3, distance: 8, yardLine: 33 } }),
        g({ id: 'cri', league: 'Cricket', sport: 'Cricket', title: 'Australia v South Africa', competitors: [team('Australia'), team('South Africa')],
            scores: ['287/6', '312'], format: 'test', progress: { day: 'Day 2' } }),
        g({ id: 'nxt', title: 'Newcastle v Tottenham', competitors: [team('Newcastle'), team('Tottenham')], status: 'scheduled', start: NOW + 7200000,
            channels: [{ sourceId: 1, stableId: 's2', id: '102', name: 'Stan Sport 2', start: NOW + 7200000, end: NOW + 14400000 }],
            recording: { scheduleId: 4, status: 'scheduled', ruleId: null } }),
        g({ id: 'f1', league: 'F1', sport: 'Motorsport', title: 'Las Vegas Grand Prix', competitors: [], session: 'Race', status: 'scheduled',
            start: NOW + 86400000, channels: [], followed: true })
    ];
    return {
        now: NOW, timezone: 'UTC', spoilerFree: false, scores: 'fresh',
        sports: [{ league: 'EPL', sport: 'Football', live: 2, next: null, line: 'live' }, { league: 'NFL', sport: 'American football', live: 1, next: null, line: 'live' },
            { league: 'Cricket', sport: 'Cricket', live: 1, next: null, line: 'live' }, { league: 'F1', sport: 'Motorsport', live: 0, next: { gameId: 'f1', start: NOW + 86400000 }, line: 'next' },
            { league: 'AFL', sport: 'Australian football', live: 0, next: null, line: 'quiet' }],
        follows: [{ league: 'EPL', sport: 'Football', name: 'Arsenal', logo: '/api/logo/ars', state: 'live', gameId: 'ars', start: NOW - 3600000 },
            { league: 'F1', sport: 'Motorsport', name: 'Oscar Piastri', logo: null, state: 'next', gameId: 'f1', start: NOW + 86400000 },
            { league: 'AFL', sport: 'Australian football', name: 'Collingwood', logo: null, state: 'none', gameId: null, start: null }],
        hero: { reason: 'follow-live', followIndex: 0, gameId: 'ars' },
        rails: [{ league: 'EPL', sport: 'Football', gameIds: ['ars', 'pen', 'avl', 'nxt'] }, { league: 'NFL', sport: 'American football', gameIds: ['nfl'] },
            { league: 'Cricket', sport: 'Cricket', gameIds: ['cri'] }, { league: 'F1', sport: 'Motorsport', gameIds: ['f1'] }],
        games, ...extra
    };
}
const SCORE_TEXT = ['47', '31', '58', '59', '63', '64', '71', '72', '287/6', '312'];
const REVEALING = /Penalties|Pens\b|Down 3|8 yards|Yard line|47–31/;
function assertNoScores(html, where) {
    for (const s of SCORE_TEXT) assert.ok(!html.includes(s), `${where}: "${s}" is in the markup`);
    assert.doesNotMatch(html, REVEALING, `${where}: a score-revealing word`);
}
const ctx = (V, front, o = {}) => ({ front, hide: false, now: NOW, labels: { EPL: 'Premier League' }, phone: false, heroId: 'ars', followIndex: 0, ...o });

test('hidden is the OR of the account\'s choice and the answer\'s own switch; an unknown choice is hidden', () => {
    const { V } = browser();
    assert.equal(V.hidden({ known: true, preference: false, answer: false }), false, 'both say shown: shown');
    assert.equal(V.hidden({ known: false, preference: false, answer: false }), true, 'the choice not read yet');
    assert.equal(V.hidden({}), true, 'nothing known');
    assert.equal(V.hidden({ known: true, preference: true, answer: false }), true, 'the account hides');
    assert.equal(V.hidden({ known: true, preference: false, answer: true }), true, 'the answer hides');
    assert.equal(V.hidden({ known: true, preference: false, answer: false, page: true }), true, 'a parent page hides');
});

test('scores shown: the cards, the hero line and the phone rows carry them', () => {
    const { V } = browser();
    const front = answer();
    const desk = V.front(ctx(V, front));
    assert.match(desk, /<span class="sc pig-amount">47<\/span>/);
    assert.match(desk, /<span class="sc pig-amount">31<\/span>/);
    assert.match(desk, /<div class="line pig-amount">47–31 · Second half · 67&#39; · Stan Sport 1<\/div>/);
    assert.match(V.front(ctx(V, front, { heroId: 'nfl' })), /71–72 · Quarter 2 · 5:00 · Down 3 · 8 yards · Yard line 33/, 'the NFL hero\'s situation, shown');
    const phone = V.front(ctx(V, front, { phone: true }));
    assert.match(phone, /<span class="fscore pig-amount">47–31<\/span>/);
    assert.match(phone, /<span class="sc pig-amount">287\/6–312<\/span>/);
});

for (const phone of [false, true]) {
    test(`scores hidden (${phone ? 'phone' : 'computer'}): no score, result or revealing word anywhere in the markup or its attributes`, () => {
        const { V } = browser();
        const html = V.front(ctx(V, answer(), { hide: true, phone }));
        assertNoScores(html, phone ? 'phone' : 'computer');
        assert.match(html, phone ? /<span class="fscore v pig-amount">v<\/span>/ : /<span class="n">Arsenal<\/span><\/span>/, 'the score space is blank');
        assert.match(html, />FT</, 'a finished game reads FT');
        // the hero follows a different follow, and the NFL hero: still nothing
        for (const heroId of ['nfl', 'pen', 'cri']) assertNoScores(V.front(ctx(V, answer(), { hide: true, phone, heroId })), `hero ${heroId}`);
    });
}

test('the answer\'s own spoilerFree hides even when the account reads shown (the page decides with both)', async () => {
    const front = answer({ spoilerFree: true });
    const b = browser({ request: async (m, url) => (url === '/sports/pages/preferences' ? { spoilerFree: false } : url === '/sports/front' ? front : { sports: [] }) });
    const page = new b.context.window.SportsPage({ currentUser: { role: 'admin' } });
    page.root = b.document.createElement('div'); b.document.body.appendChild(page.root); page.wire(page.root);
    await page.show();
    assertNoScores(page.root.innerHTML, 'answer spoilerFree');
    assert.match(page.root.innerHTML, /Scores hidden/);
});

test('a failed or unread preference read keeps the scores out; a read that says shown lets them in', async () => {
    let prefs = () => { throw Object.assign(new Error('offline'), { status: 0 }); };
    const front = answer();
    const b = browser({ request: async (m, url) => (url === '/sports/pages/preferences' ? prefs() : url === '/sports/front' ? front : { sports: [] }) });
    const page = new b.context.window.SportsPage({ currentUser: { role: 'viewer' } });
    page.root = b.document.createElement('div'); b.document.body.appendChild(page.root); page.wire(page.root);
    await page.show();
    assertNoScores(page.root.innerHTML, 'preferences failed');
    prefs = () => ({ spoilerFree: false });
    await page.refresh();
    assert.match(page.root.innerHTML, />47</, 'shown once the account says so');
    assert.match(page.root.innerHTML, /Scores shown/);
    prefs = () => ({ spoilerFree: true });
    await page.refresh();
    assertNoScores(page.root.innerHTML, 'the account hides');
    // leaving and coming back forgets the choice: the cached answer is drawn hidden until it is read again
    prefs = () => new Promise(() => {});
    page.hide();
    page.show();
    assertNoScores(page.root.innerHTML, 'shown again before the read answers');
});

test('the front page as drawn: the banner (hero, follows list), a section per sport, league rails, "Also in your sports"', () => {
    const { V } = browser();
    const html = V.front(ctx(V, answer()));
    assert.match(html, /<section class="banner" aria-label="Arsenal v Chelsea">/);
    assert.match(html, /<div class="kicker live"><span class="dot" aria-hidden="true"><\/span><span>Live · Football · Premier League · Your team<\/span>/);
    assert.match(html, /<button type="button" class="pill primary" data-act="watch" data-id="ars" data-key="hero:watch">[\s\S]*?Watch<\/button><button type="button" class="pill" data-act="record"/);
    assert.equal((html.match(/pill primary/g) || []).length, 1, 'one rose button');
    assert.match(html, /<span class="up">Following<\/span> · your order, playing now on top/);
    assert.match(html, /class="brow sel" data-act="follow" data-index="0"[^>]*aria-current="true">[\s\S]*?<span class="t">Arsenal<\/span><span class="tr live">Live · v Chelsea<\/span>/);
    assert.match(html, /<span class="t">Collingwood<\/span><span class="tr">Nothing in 3 days<\/span>/);
    assert.match(html, /<section class="sec" aria-label="Football">[\s\S]*?<span class="s">Football<\/span><span class="note">Premier League · 2 live<\/span>/);
    assert.match(html, /<div class="rail" data-rail="EPL">/);
    assert.match(html, /class="gcard fol" data-act="game" data-id="ars"/, 'your team: the rose outline');
    assert.match(html, /class="gcard live" data-act="game" data-id="pen"/, 'another live game: the live outline');
    assert.match(html, /<span class="star" aria-hidden="true">★<\/span><span class="visually-hidden">Your team, <\/span><span class="n">Arsenal<\/span>/);
    assert.match(html, /<img class="badge" src="\/api\/logo\/ars" alt=""/);
    assert.match(html, /<span class="rmark" role="img" aria-label="Set to record"><\/span>/, '#310: the record mark, with its words');
    assert.match(html, /<span class="sk">Race<\/span><span class="stitle"><span class="star"/, 'a session card: its session, title, star');
    assert.match(html, /<div class="also"><span class="also-t">Also in your sports<\/span><span class="b">Australian football<\/span><\/div>/);
});

test('the phone front page: the follows carousel with its dots, then a card of rows per sport', () => {
    const { V } = browser();
    const html = V.front(ctx(V, answer(), { phone: true }));
    assert.match(html, /<div class="carousel" data-carousel="follows" aria-label="Your follows">/);
    assert.match(html, /<div class="kicker k live"><span class="dot" aria-hidden="true"><\/span><span>Live · Premier League · Your team<\/span>/);
    assert.match(html, /<div class="fline">Nothing in the next three days<\/div>/, 'a follow with nothing on');
    assert.match(html, /<div class="dots" aria-hidden="true"><i class="on"><\/i><i><\/i><i><\/i><span>1 of 3 follows<\/span><\/div>/);
    assert.match(html, /<section class="grp" aria-label="Football">[\s\S]*?<div class="rows"><button type="button" class="row" data-act="game" data-id="ars"/);
    assert.match(html, /<span class="lv"><span class="dot" aria-hidden="true"><\/span>Live 2nd half 67&#39;<\/span>/);
    assert.doesNotMatch(html, /class="banner"/);
});

test('every server string is escaped, and only same-server logo-cache paths are drawn', () => {
    const { V } = browser();
    const front = answer();
    front.games[0].competitors[1] = team('<img src=x onerror=alert(1)>', 'https://provider.example/logo.png');
    front.games[0].title = '"><script>x</script>';
    front.follows[2].name = '<b>bold</b>';
    const html = V.front(ctx(V, front)) + V.front(ctx(V, front, { phone: true }));
    assert.doesNotMatch(html, /<img src=x|<script>|<b>bold/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /provider\.example/, 'a provider address never reaches the page');
    assert.equal(V.logo('/api/logo/../secret'), null);
    assert.equal(V.logo('/api/logo/a?size=1'), null);
});

test('the hero: kept while its game is under way, a follow gone live takes it, a flip in the list wins', () => {
    const { V } = browser();
    const a = answer();
    assert.equal(V.resolveHero({ current: null, front: a }), 'ars', 'the server\'s hero');
    const b = answer({ hero: { reason: 'league-live', followIndex: null, gameId: 'nfl' } });
    assert.equal(V.resolveHero({ current: 'ars', front: b }), 'ars', 'kept while under way');
    assert.equal(V.resolveHero({ current: 'ars', front: b, selectedFollow: 1 }), 'f1', 'a flip to a follow');
    const before = answer(); before.follows[1].state = 'next';
    const after = answer(); after.follows[1].state = 'live';
    assert.deepEqual(V.followsGoneLive(before, after), [1]);
    assert.equal(V.resolveHero({ current: 'ars', front: after, wentLive: [1] }), 'f1', 'a follow gone live takes it');
    assert.equal(V.heroFollowIndex(a, 'f1', null), 1);
});

test('states: loading, the error with Try again, nothing followed (Choose your sport for an admin only)', async () => {
    let front = () => { throw new Error('down'); };
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? front() : url === '/sports/pages/preferences' ? { spoilerFree: false } : { sports: [] }) });
    const page = new b.context.window.SportsPage({ currentUser: { role: 'admin' }, navigateTo: (...a) => { page.went = a; } });
    page.root = b.document.createElement('div'); b.document.body.appendChild(page.root); page.wire(page.root);
    page.active = true; page.render();
    assert.match(page.root.querySelector('.sp-state').innerHTML, /state-loading/);
    await page.show();
    assert.match(page.root.querySelector('.sp-state').innerHTML, /role="alert"[\s\S]*Sport didn’t load[\s\S]*Try again/);
    front = () => answer({ sports: [], follows: [], rails: [], games: [] });
    await page.refresh();
    assert.match(page.root.innerHTML, /<h2>Sport<\/h2>/);
    const empty = page.root.querySelector('.sp-state').innerHTML;
    assert.match(empty, /state-empty sp-empty[\s\S]*Follow a sport to start[\s\S]*btn-primary state-block-action" data-state-action>Choose your sport/);
    page.root.querySelector('.sp-state').querySelector('[data-state-action]');
    page.app.currentUser.role = 'viewer';
    page.render();
    assert.doesNotMatch(page.root.querySelector('.sp-state').innerHTML, /Choose your sport</, 'a viewer has no Settings to open');
});

test('a failed refresh keeps the page under the slim notice; no scores feed is said once', async () => {
    let fail = false;
    const front = answer({ scores: 'unavailable' });
    const b = browser({ request: async (m, url) => { if (url === '/sports/front' && fail) throw new Error('x'); return url === '/sports/front' ? front : { spoilerFree: false }; } });
    const page = new b.context.window.SportsPage({});
    page.root = b.document.createElement('div'); b.document.body.appendChild(page.root); page.wire(page.root);
    await page.show();
    assert.equal((page.root.innerHTML.match(/The scores feed isn’t available right now/g) || []).length, 1);
    assertNoScores(page.root.innerHTML, 'no scores feed');
    fail = true;
    await page.refresh();
    assert.match(page.root.innerHTML, /Couldn’t update. Showing what you had at [^<]+\.<\/span><button type="button" class="btn btn-secondary btn-sm" data-act="retry">Try again/);
    assert.match(page.root.innerHTML, /Arsenal v Chelsea/, 'what was shown stays');
});

test('pressing a card: Watch while its channel airs it, else its menu; the hero\'s Watch plays the channel found by identity', async () => {
    const front = answer();
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? front : { spoilerFree: false }) });
    const played = [];
    const app = { currentUser: { role: 'admin' }, navigateTo: (p) => played.push(['nav', p]),
        channelList: { channels: [{ sourceId: 1, stableId: 's1', id: 'pos_9', name: 'Stan Sport 1' }], loadSources: async () => {}, loadChannels: async () => {},
            selectChannel: async (d) => played.push(['play', d.sourceId, d.channelId]) } };
    const page = new b.context.window.SportsPage(app);
    page.root = b.document.createElement('div'); b.document.body.appendChild(page.root); page.wire(page.root);
    await page.show();
    page.received = Date.now() - 0; page.front.now = NOW;
    await page.act('game', { getAttribute: () => 'ars' });
    assert.deepEqual(played, [['nav', 'live'], ['play', 1, 'pos_9']], 'by its stable identity, never a stored position');
    const anchor = b.document.createElement('button'); b.document.body.appendChild(anchor);
    page.select('nxt', anchor);
    const menu = b.document.body.querySelector('.sp-menu');
    assert.ok(menu, 'a game to come opens its menu');
    assert.equal(menu.getAttribute('role'), 'menu');
    assert.match(menu.innerHTML, /<div class="mh"><b>Newcastle v Tottenham<\/b><span>Stan Sport 2 · /);
    assert.match(menu.innerHTML, /data-act="remind" data-id="nxt">[\s\S]*?<b>Remind me<\/b>/);
    assert.match(menu.innerHTML, /<div class="ms" aria-hidden="true">Record<\/div><button type="button" class="mi" role="menuitem" tabindex="-1" data-act="record" data-id="nxt">/);
    menu.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    assert.equal(b.document.body.querySelector('.sp-menu'), null, 'Escape closes it');
    assert.equal(b.document.activeElement, anchor, 'focus goes back to the card');
    page.select('nxt', anchor);
    const outside = b.document.createElement('div'); b.document.body.appendChild(outside);
    outside.dispatchEvent(new FakeEvent('pointerdown'));
    assert.equal(b.document.body.querySelector('.sp-menu'), null, 'a click outside closes it (the old Sport dialog\'s test, #323)');
});

test('Record this game: the best channel\'s own airing, the usual padding, the game\'s id', async () => {
    const front = answer();
    const sent = [];
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? front : { spoilerFree: false }),
        recordings: { schedule: async (d) => { sent.push(d); return { id: 1 }; } } });
    const page = new b.context.window.SportsPage({});
    page.root = b.document.createElement('div'); b.document.body.appendChild(page.root); page.wire(page.root);
    await page.show();
    await page.record('nxt');
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ sourceId: 1, channelItemId: '102', channelName: 'Stan Sport 2', title: 'Newcastle v Tottenham',
        programStart: NOW + 7200000, programEnd: NOW + 14400000, gameId: 'nxt' }]);
    assert.deepEqual(b.context.toasts.map(t => t[0]), ['Set to record: Newcastle v Tottenham.']);
});

test('the address: Sport is a page with places, so Back and the nav link reach its front page (app.js)', () => {
    const app = js('app.js');
    assert.match(app, /if \(controller\?\.opensRoot\) \{ controller\.openPath\(sub, historyMode\); return; \}/);
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="css\/sport\.css[^"]*">/);
    assert.match(html, /<script src="\/js\/pages\/SportView\.js[^"]*"><\/script>\s*<script src="\/js\/pages\/SportsPage\.js/);
});

test('the golden C-R answer renders in both layouts, hidden and shown', () => {
    const { V } = browser();
    for (const phone of [false, true]) for (const hide of [false, true]) {
        const html = V.front({ front: golden, hide, now: golden.now, labels: {}, phone, heroId: golden.hero.gameId, followIndex: 0 });
        assert.match(html, /Packers/);
        if (hide) assert.doesNotMatch(html, /7–3|>7<|>3<|Down 3/); else assert.match(html, /7–3/);
    }
});
