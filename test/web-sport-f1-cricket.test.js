const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, answer, NOW, ctx, page, root } = require('./helpers/sportWeb');

// #323 step 4: Formula 1 (C-P) and cricket (C-S) on the web, as Apple's SportMotorViews and CricketPageView, to mocks 07 and
// 08. Hidden scores: no session result ("Pole · …", "Winner · …"), no results list or standings (Formula 1); no innings,
// summary, crease, series line, series result, other match's score or line (cricket).
const golden = (f) => JSON.parse(fs.readFileSync(path.join(root, 'test/golden', f), 'utf8'));
const H = 3600000, D = 86400000;

function f1() {
    const p = golden('sports-page-f1.json');
    p.weekend.info.map = '/api/logo/lv?size=3840'; p.weekend.info.mapDark = '/api/logo/lvd?size=3840';
    p.weekend.sessions = [
        { id: 'practice 1', name: 'Practice 1', start: NOW - D, end: NOW - D + H, status: 'done', top: { kind: 'fastest', driver: 'Lando Norris' }, channels: [] },
        { id: 'qualifying', name: 'Qualifying', start: NOW - 2 * H, end: NOW - H, status: 'done', top: { kind: 'pole', driver: 'Kimi Antonelli' }, channels: [] },
        { id: 'race', name: 'Race', start: NOW + 6 * D, end: NOW + 6 * D + 2 * H, status: 'scheduled', top: null,
            channels: [{ sourceId: 1, stableId: 'f', id: '506', name: 'Fox Sports 506', start: NOW + 6 * D - 600000, end: NOW + 6 * D + 2 * H }] }];
    p.standings.drivers[0].points = 3651; p.standings.constructors[0].points = 6071;
    return p;
}
const F1_SECRETS = ['Pole · ', 'Fastest · ', 'Winner · ', '3651', '6071', 'class="mrow', 'Antonelli</span>'];

test('Formula 1: the banner (the next session, Remind me), the session tiles and the circuit, the lists with your driver', () => {
    const { V } = browser();
    const html = V.leaguePage('Motorsport', 'F1', 'f1', { answer: f1(), loaded: true }, ctx(V, answer(), { following: ['Lando Norris'], dark: true }));
    assert.match(html, /<section class="banner full" aria-label="Mexico City Grand Prix"><img class="art map" src="\/api\/logo\/lvd\?size=3840"/, 'the dark circuit map');
    assert.match(html, /<span>Next · Motorsport · Formula 1 · Your driver<\/span>/);
    assert.match(html, /<div class="line pig-amount">Race · [^<]+ · Fox Sports 506<\/div>/);
    assert.match(html, /data-act="remind" data-id="f1s:race"/);
    assert.match(html, /<button type="button" class="tile done" data-act="game" data-id="f1s:qualifying"[^>]*><span class="tt">Qualifying<\/span><span class="wh pig-amount">[^<]+<\/span><span class="ln">Pole · Antonelli<\/span>/);
    assert.match(html, /<span class="tt">Race<span class="tag next">Next<\/span><\/span>[\s\S]*?<span class="ln">In 6 days<\/span>/);
    assert.match(html, /<dt>Length<\/dt><dd class="pig-amount">4\.304 km<\/dd>/);
    assert.match(html, /<div class="lh"><b>Last race · United States GP<\/b><\/div>/);
    assert.match(html, /<div class="lh"><b>Drivers<\/b><span>After round 20<\/span><\/div>/);
    assert.match(html, /<span class="pt pig-amount">3651<\/span>/);
});

for (const phone of [false, true]) {
    test(`Formula 1 with scores hidden (${phone ? 'phone' : 'computer'}): no session result, results or standings`, () => {
        const { V } = browser();
        const html = V.leaguePage('Motorsport', 'F1', 'f1', { answer: f1(), loaded: true }, ctx(V, answer(), { hide: true, phone, following: ['Lando Norris'] }));
        for (const s of F1_SECRETS) assert.ok(!html.includes(s), `"${s}" is in the markup`);
        assert.match(html, /<span class="ln">Finished<\/span>/);
        assert.equal((html.match(/Results and standings are hidden while Hide scores is on\./g) || []).length, 3);
    });
}

test('Formula 1\'s session plays, waits and records as a game on its channel\'s own airing', async () => {
    const sent = [];
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? answer() : url === '/sports/pages/preferences' ? { spoilerFree: false }
        : url === '/info' ? { features: { sportPages: true } } : url === '/sports/pages/f1' ? f1() : {}),
        recordings: { schedule: async (d) => { sent.push(d); return {}; } } });
    const p = page(b, { setLocation() {} });
    await p.show('Motorsport/F1');
    await new Promise(setImmediate); await new Promise(setImmediate);
    assert.match(p.root.innerHTML, /<h2 class="visually-hidden">F1<\/h2>/, 'on a computer the banner holds the back button');
    const race = p.game('f1s:race');
    assert.equal(race.title, 'Mexico City GP · Race');
    await p.record('f1s:race');
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ sourceId: 1, channelItemId: '506', channelName: 'Fox Sports 506', title: 'Mexico City GP · Race',
        programStart: NOW + 6 * D - 600000, programEnd: NOW + 6 * D + 2 * H }]);
    assert.equal(p.game('f1s:practice 1').status, 'finished');
});

test('Formula 1 with no weekend: "No race scheduled"', () => {
    const { V } = browser();
    assert.match(V.leaguePage('Motorsport', 'F1', 'f1', { answer: { available: true, weekend: null } }, ctx(V, answer())), /No race scheduled[\s\S]*The next race weekend shows here once the scores feed lists it\./);
});

const CRICKET_SECRETS = ['>329<', '>387<', '>429<', '>134.4<', '329 &amp;', '329/', 'lead by 287', 'Series level', 'won by', '272 &amp; 79/6', 'Bangladesh lead by', '20:00 local time', '1st inns'];

test('cricket: the lead match (its scoreboard, days, actions) beside its tour, then the league\'s other matches', () => {
    const { V } = browser();
    const html = V.leaguePage('Cricket', 'Cricket', 'cricket', { answer: golden('sports-page-cricket.json'), loaded: true },
        ctx(V, answer(), { leagues: ['Cricket'], labels: { Cricket: 'International (men)' } }));
    assert.match(html, /<div class="lead-k"><span>3rd Test · Newlands, Cape Town · Series level 1–1 · third of three Tests<\/span><span class="lpill">/);
    assert.match(html, /<h3 class="ltitle">South Africa v Australia<\/h3>/);
    assert.match(html, /<span>1st inns<\/span><span>2nd inns<\/span><span>Overs<\/span>/);
    assert.match(html, /<span class="r pig-amount">329<\/span><span class="r pig-amount">387<\/span><span class="o pig-amount">134\.4<\/span>/);
    assert.match(html, /<b>South Africa lead by 287 runs<\/b>/);
    assert.match(html, /<section class="series" aria-label="Australia in South Africa">[\s\S]*South Africa won by 67 runs[\s\S]*<div class="sm cur">[\s\S]*Stumps · day 4/);
    assert.match(html, /<h3>More International \(men\)<\/h3>/);
    assert.match(html, /data-act="game" data-id="ck:1553295"[\s\S]*?<span class="sc pig-amount">272 &amp; 79\/6 \(29 ov\)<\/span>/);
});

for (const phone of [false, true]) {
    test(`cricket with scores hidden (${phone ? 'phone' : 'computer'}): no innings, summary, series line, result or other score`, () => {
        const { V } = browser();
        const html = V.leaguePage('Cricket', 'Cricket', 'cricket', { answer: golden('sports-page-cricket.json'), loaded: true },
            ctx(V, answer(), { hide: true, phone, leagues: ['Cricket'] }));
        for (const s of CRICKET_SECRETS) assert.ok(!html.includes(s), `"${s}" is in the markup`);
        assert.match(html, /<span class="res">Finished<\/span>/);
        assert.match(html, /<span class="nm">[\s\S]*?South Africa<\/span>/, 'the teams stay');
    });
}

test('cricket: another league\'s matches are not on this league\'s page; with nothing of its own, its cards', () => {
    const { V } = browser();
    const p = golden('sports-page-cricket.json');
    p.lead.league = 'BBL'; p.others.forEach(o => { o.league = 'BBL'; });
    const html = V.leaguePage('Cricket', 'Cricket', 'cricket', { answer: p, loaded: true }, ctx(V, answer(), { leagues: ['Cricket', 'BBL'] }));
    assert.doesNotMatch(html, /South Africa v Australia|Bangladesh/);
    assert.match(html, /<div class="cardgrid"><div class="gitem[^"]*" data-game="cri">/, 'the league\'s front-page cards instead');
    eq(V.cricketLeagueOf('1', null, 'International (men)', { leagues: ['Cricket', 'BBL'], labels: { Cricket: 'International (men)' } }), 'Cricket');
});
function eq(a, b) { assert.deepEqual(JSON.parse(JSON.stringify(a)), b); }

test('the sport pages link Formula 1 and cricket: "Weekend and standings ›", "Scoreboard and tour ›"', () => {
    const { V } = browser();
    const features = { sportPages: true, sportPageCricket: true };
    const pages = ['league', 'nfl', 'f1', 'cricket'];
    assert.match(V.sportPage('Motorsport', ctx(V, answer(), { links: true, features, pages })), /data-act="open-league" data-sport="Motorsport" data-league="F1"[^>]*><span class="s">Weekend and standings<\/span>/);
    assert.match(V.sportPage('Cricket', ctx(V, answer(), { links: true, features, pages })), /data-league="Cricket"[^>]*><span class="s">Scoreboard and tour<\/span>/);
});
