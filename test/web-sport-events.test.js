const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, answer, NOW, ctx, page, root } = require('./helpers/sportWeb');

// #323 step 5: the event pages (C-V: golf, tennis, UFC, IndyCar and NASCAR), as Apple's SportEventsViews, to mock 09.
// Hidden scores: no leaderboard position, to-par or round, no set, no winner, no bout result, no last winner.
const golden = (f) => JSON.parse(fs.readFileSync(path.join(root, 'test/golden', f), 'utf8'));
const H = 3600000;

function golf() {
    const p = golden('sports-page-events-pga-tour.json');
    p.events[0].followed = ['Matthieu Pavon'];
    p.events[0].leaderboard[0].toPar = '-23'; p.events[0].leaderboard[0].rounds = [67, 61, null];
    p.events.push({ id: 'espn:golf/pga:2', name: 'The RSM Classic', start: NOW + 9 * H, end: NOW + 80 * H, status: 'scheduled', followed: [], leaderboard: [], round: null, venue: null });
    return p;
}
function tennis() {
    const p = golden('sports-page-events-atp-tour.json');
    for (const m of p.events[0].matches) m.start = NOW - H;
    p.events[0].matches[0].sets = [[1, 6], [6, 7]];
    p.events[0].followed = ['Mattia Bellucci'];
    return p;
}
/** The UFC answer's finished night alone (the page leads with a night under way, else the next, else the latest). */
const ufc = () => { const p = golden('sports-page-events-ufc.json'); p.events = p.events.slice(0, 1); return p; };
const GOLF_SECRETS = ['-23', '-17', '>67<', '>61<', 'R1 67', 'behind', '>Leader<', '<table class="lb"'];
const TENNIS_SECRETS = ['class="sets', 'trow won', '>Final<'];
const UFC_SECRETS = ['Szabová · R3', 'R3 3:20', 'class="won"', 'Rodriguez · '];

test('golf: the leaderboard (position, to par, rounds), your player with the gap, the week\'s other events', () => {
    const { V } = browser();
    const html = V.leaguePage('Golf', 'PGA Tour', 'events', { answer: golf(), loaded: true }, ctx(V, answer()));
    assert.match(html, /<table class="lb"><thead><tr><th scope="col" class="tl">Pos<\/th><th scope="col" class="tl">Player<\/th><th scope="col">To par<\/th><th scope="col">R1<\/th>/);
    assert.match(html, /<td class="tp pig-amount">-23<\/td><td class="r pig-amount">67<\/td><td class="r pig-amount">61<\/td>/);
    assert.match(html, /<tr class="me"><td class="pos">2<\/td><td class="nm"><span class="star"/);
    assert.match(html, /<span class="gap">6 behind<\/span>/);
    assert.match(html, /<td class="pos">CUT<\/td>/);
    assert.match(html, /<h4>Also this week<\/h4><div class="slim"><b>The RSM Classic<\/b>/);
    assert.match(html, /<div class="evhead"><div><h3>VidantaWorld Mexico Open<\/h3><div class="sub">Round 3 · Round 3 complete<\/div>/);
});

for (const phone of [false, true]) {
    test(`events with scores hidden (${phone ? 'phone' : 'computer'}): no position, score, set, winner or result`, () => {
        const { V } = browser();
        const c = (o = {}) => ctx(V, answer(), { hide: true, phone, ...o });
        const g = V.leaguePage('Golf', 'PGA Tour', 'events', { answer: golf(), loaded: true }, c());
        for (const s of GOLF_SECRETS) assert.ok(!g.includes(s), `golf: "${s}"`);
        assert.match(g, /The leaderboard is hidden while Hide scores is on\./);
        assert.match(g, /<div class="pcard"><div class="t"><span class="star"[^>]*>★<\/span><span class="visually-hidden">Your player, <\/span>Matthieu Pavon<\/div><\/div>/, 'your player: the name alone');
        const t = V.leaguePage('Tennis', 'ATP Tour', 'events', { answer: tennis(), loaded: true }, c({ now: NOW }));
        for (const s of TENNIS_SECRETS) assert.ok(!t.includes(s), `tennis: "${s}"`);
        const u = V.leaguePage('Combat', 'UFC', 'events', { answer: ufc(), loaded: true }, c());
        for (const s of UFC_SECRETS) assert.ok(!u.includes(s), `UFC: "${s}"`);
        const r = V.leaguePage('Motorsport', 'NASCAR', 'events', { answer: golden('sports-page-events-nascar.json'), loaded: true }, c());
        assert.ok(!r.includes('Kyle Larson'), 'NASCAR: the last winner');
    });
}

test('tennis: Your players, Live now, Tonight, Results today; sets and the winner once shown', () => {
    const { V } = browser();
    const html = V.leaguePage('Tennis', 'ATP Tour', 'events', { answer: tennis(), loaded: true }, ctx(V, answer(), { now: NOW }));
    assert.match(html, /aria-label="Your players"/);
    assert.match(html, /aria-label="Results today"/);
    assert.match(html, /<span class="trow won"><span class="star"[\s\S]*?Mattia Bellucci<\/span><span class="sets pig-amount"><span>6<\/span><span>7<\/span><\/span>/);
});

test('UFC: the main card and the prelims, the result once shown; racing: the entry list, the last winner, the next race', () => {
    const { V } = browser();
    const u = V.leaguePage('Combat', 'UFC', 'events', { answer: ufc(), loaded: true }, ctx(V, answer()));
    assert.match(u, /<b>Prelims<\/b>/);
    assert.match(u, /<span class="bl">Szabová · R3 3:20<\/span>/);
    const r = V.leaguePage('Motorsport', 'NASCAR', 'events', { answer: golden('sports-page-events-nascar.json'), loaded: true }, ctx(V, answer()));
    assert.match(r, /<ul class="entries"><li>Austin Cindric<\/li><li>Denny Hamlin<\/li><\/ul>/);
    assert.match(r, /<b>Last winner<\/b><span class="w">Kyle Larson · NASCAR Cup Series at Talladega<\/span>/);
    assert.match(r, /<b>Next race<\/b>/);
});

test('an events page on a computer keeps the sport\'s banner; its list goes to another league\'s page in place', async () => {
    const located = [];
    const front = answer({ sports: [...answer().sports, { league: 'PGA Tour', sport: 'Golf', live: 0, next: null, line: 'quiet' }, { league: 'LPGA', sport: 'Golf', live: 0, next: null, line: 'quiet' }] });
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? front : url === '/sports/pages/preferences' ? { spoilerFree: false }
        : url === '/info' ? { features: { sportPageEvents: true } } : url.startsWith('/sports/pages/events?league=') ? golf() : {}) });
    const p = page(b, { setLocation: (...a) => located.push(a) });
    await p.show('Golf/PGA%20Tour');
    await new Promise(setImmediate); await new Promise(setImmediate);
    assert.match(p.root.innerHTML, /<h2 class="visually-hidden">PGA Tour<\/h2><section class="banner"[\s\S]*?Back to Golf/);
    assert.match(p.root.innerHTML, /class="brow sel" data-act="league-page" data-index="0"/);
    p.act('league-page', { getAttribute: (k) => ({ 'data-index': '1' })[k] });
    assert.deepEqual(located.pop(), ['sports', 'Golf/LPGA', 'replace']);
    assert.equal(p.route.league, 'LPGA');
});

test('an events league with nothing this week says so', () => {
    const { V } = browser();
    assert.match(V.leaguePage('Golf', 'LPGA', 'events', { answer: { available: true, kind: 'golf', events: [] } }, ctx(V, answer())), /Nothing in LPGA this week[\s\S]*Its next events show here once the scores feed lists them\./);
});

// #323 Codex review of step 5 (medium): with scores hidden, several followed golfers in the leaderboard's order would
// reveal who leads; they go in the follow order (else by name), so swapping their places changes nothing in the markup.
test('golf with scores hidden: your players in the follow order, the same whatever the leaderboard says', () => {
    const { V } = browser();
    const page = (swap) => {
        const p = golf();
        p.events[0].followed = ['Matthieu Pavon', 'Andrew Novak'];
        if (swap) { const lb = p.events[0].leaderboard; [lb[0], lb[1]] = [lb[1], lb[0]]; lb[0].pos = '1'; lb[1].pos = '2'; }
        return p;
    };
    for (const phone of [false, true]) {
        const html = (swap) => V.leaguePage('Golf', 'PGA Tour', 'events', { answer: page(swap), loaded: true }, ctx(V, answer(), { hide: true, phone }));
        assert.equal(html(false), html(true), 'a swap of places leaves the hidden page unchanged');
        const players = html(false).slice(html(false).indexOf('Your players'));
        assert.ok(players.indexOf('Matthieu Pavon') < players.indexOf('Andrew Novak'), 'the follow order');
    }
});
