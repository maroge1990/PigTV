const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, answer, NOW, ctx, page, root } = require('./helpers/sportWeb');

// #323 step 3: a league's own page (#sports/Football/EPL), as Apple's SportFixtureView: the round switcher (the last
// and current round), the round's games, the standings beside them (under them on a narrow screen). C-T for the team
// leagues, C-Q for the NFL (Division, Conference, Overall). With scores hidden: no score, record, situation or result
// word, and no standings (positions and points reveal results): "Standings hidden".
const eq = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const golden = (f) => JSON.parse(fs.readFileSync(path.join(root, 'test/golden', f), 'utf8'));

/** The golden C-T (AFL) page with distinctive scores and standings, so their absence can be told. */
function afl() {
    const p = golden('sports-page-league-afl.json');
    p.teams['1'].logo = '/api/logo/fre'; p.teams['4'].logo = '/api/logo/syd'; p.following = '1';
    p.rounds[1].games[0] = { ...p.rounds[1].games[0], status: 'live', detail: 'Q3 5:21', home: { ...p.rounds[1].games[0].home, score: '9131' }, away: { ...p.rounds[1].games[0].away, score: '8717' } };
    p.rounds[0].games[0].home.score = '7373'; p.rounds[0].games[0].away.score = '6262';
    p.standings.groups[0].rows[0].values = { played: '23', wins: '19', percentage: '137.200', points: '5151' };
    p.standings.groups[0].columns = [{ key: 'played', label: 'P' }, { key: 'wins', label: 'W' }, { key: 'percentage', label: '%' }, { key: 'points', label: 'Pts' }];
    return p;
}
function nfl() {
    const p = golden('sports-page-nfl.json');
    const g = p.weeks[1].games[0];
    p.weeks[1].games[0] = { ...g, status: 'live', detail: 'Q4 2:10', situation: { downDistance: '3rd & 8 at CAR 12', possession: 'GB', redZone: true },
        home: { ...g.home, score: 9131, record: '93-17' }, away: { ...g.away, score: 8717, record: '91-19' } };
    p.standings.divisions[0].teams[0] = { ...p.standings.divisions[0].teams[0], record: '93-17', streak: 'W93' };
    return p;
}
const SECRETS = ['9131', '8717', '7373', '6262', '5151', '137.2', '93-17', '91-19', 'W93', '3rd &amp; 8', 'Q3 5:21', 'Q4 2:10', 'Final · ', '>FT<'];
function assertNothingRevealed(html, where) {
    for (const s of SECRETS) assert.ok(!html.includes(s), `${where}: "${s}" is in the markup`);
    assert.doesNotMatch(html, /class="sc |class="rec"|<table class="st"/, `${where}: a score, a record or a standings table`);
}

test('a C-T league page as drawn: the rounds, the current one\'s games, the standings with their header row', () => {
    const { V } = browser();
    const html = V.leaguePage('Australian football', 'AFL', 'league', { answer: afl(), loaded: true }, ctx(V, answer(), { labels: { AFL: 'AFL' } }));
    assert.match(html, /<div class="rounds" role="group" aria-label="Rounds"><button type="button" class="fchip" data-act="round" data-round="3:4" aria-pressed="false"[^>]*>Preliminary Finals<\/button><button type="button" class="fchip on" data-act="round" data-round="3:5" aria-pressed="true"[^>]*>Grand Final<\/button><span class="rnote">1 game<\/span>/);
    assert.match(html, /<span class="sc pig-amount">9131<\/span>/);
    assert.match(html, /<span class="clk pig-amount">Q3 5:21<\/span>/);
    assert.match(html, /<thead><tr><th scope="col"><span class="visually-hidden">Position<\/span><\/th><th scope="col" class="tl">Team<\/th><th scope="col">P<\/th><th scope="col">W<\/th><th scope="col">%<\/th><th scope="col">Pts<\/th><\/tr><\/thead>/);
    assert.match(html, /<td class="pig-amount">137\.2<\/td>/, 'a percentage to one decimal');
    assert.match(html, /<img class="badge" src="\/api\/logo\/fre"/);
    const followed = html.match(/<tr class="me">[\s\S]*?<\/tr>/);
    assert.ok(followed, 'the followed team\'s row (C-T `following`) is marked');
    assert.match(html, /<div class="lh"><b>AFL<\/b><span>2026<\/span><\/div>/);
    const earlier = V.leaguePage('Australian football', 'AFL', 'league', { answer: afl(), loaded: true }, ctx(V, answer(), { round: '3:4' }));
    assert.match(earlier, /<span class="sc pig-amount">7373<\/span>/, 'the chosen round');
    assert.match(earlier, /Final · /, 'a result with its day');
});

for (const phone of [false, true]) {
    test(`a league page with scores hidden (${phone ? 'phone' : 'computer'}): no score, result, record, situation or standings`, () => {
        const { V } = browser();
        for (const [kind, league, data] of [['league', 'AFL', afl()], ['nfl', 'NFL', nfl()]]) {
            for (const round of [null, '3:4', '7']) {
                const html = V.leaguePage('X', league, kind, { answer: data, loaded: true }, ctx(V, answer(), { hide: true, phone, round }));
                assertNothingRevealed(html, `${league} round ${round}`);
                assert.match(html, /Standings hidden[\s\S]*Records, positions and points reveal results while Hide scores is on\./);
                assert.match(html, /<span class="clk pig-amount">Live<\/span>|Played · /, 'neutral words only');
            }
        }
        // shown, the same pages carry them
        const shown = V.leaguePage('X', 'NFL', 'nfl', { answer: nfl(), loaded: true }, ctx(V, answer(), { phone }));
        for (const s of ['9131', '93-17', '3rd &amp; 8 at CAR 12', 'W93']) assert.ok(shown.includes(s), `shown: ${s}`);
    });
}

test('the NFL page: away team first, the byes, Division / Conference / Overall standings, the followed team\'s division first', () => {
    const { V } = browser();
    const fx = V.nflFixture(nfl(), ['Buffalo Bills'], false);
    eq(fx.rounds.map(r => [r.key, r.current, r.note]), [['7', false, 'Bye: Bills, Chargers'], ['8', true, 'Bye: Saints, Giants']]);
    eq(fx.views.map(v => v.name), ['Division', 'Conference', 'Overall']);
    eq(fx.views[0].tables[0].rows.find(r => r.followed).abbr, 'BUF');
    eq(fx.views[1].tables[0].rows.map(r => r.rank), [2, 3, 6, 8], 'a conference by seed');
    const html = V.fixturePage(fx, ctx(V, answer(), { standingsView: 'Conference' }), 'NFL');
    assert.match(html, /data-act="standings-view" data-view="Conference" aria-pressed="true"/);
    assert.match(html, /<span class="rnote">Bye: Saints, Giants<\/span>/);
    const card = html.match(/<button type="button" class="fx[^"]*" data-act="game"[\s\S]*?<\/button>/)[0];
    assert.ok(card.indexOf('Panthers') < card.indexOf('Packers'), 'the away team first');
});

test('the league page\'s states: loading, the failure with Try again, not available, no rounds', async () => {
    const { V } = browser();
    const c = ctx(V, answer(), { labels: { EPL: 'Premier League' } });
    assert.match(V.leaguePage('Football', 'EPL', 'league', null, c), /data-state="loading"/);
    assert.match(V.leaguePage('Football', 'EPL', 'league', { failed: true }, c), /data-state="league-error" data-title="Premier League didn’t load"/);
    assert.match(V.leaguePage('Football', 'EPL', 'league', { answer: { available: false } }, c), /data-title="Premier League isn’t available right now"/);
    assert.match(V.leaguePage('Football', 'EPL', 'league', { answer: { available: true, rounds: [] } }, c), /No Premier League games listed[\s\S]*href="#guide">Open the TV Guide/);
    assert.match(V.leaguePage('Football', 'EPL', 'league', { answer: afl(), stale: true, updatedAt: NOW }, c), /Couldn’t update\. Showing what you had at/);
    assert.match(V.leaguePage('Football', 'EPL', 'games', null, c), /<div class="cardgrid"><div class="gitem" data-game="ars">/, 'a league without a page: its cards');
});

test('#sports/Football/EPL asks for the league\'s page, draws it under "‹ Football", and its round chips switch', async () => {
    const asked = [];
    const front = answer();
    const b = browser({ request: async (m, url) => {
        asked.push(url);
        if (url === '/sports/front') return front;
        if (url === '/sports/pages/preferences') return { spoilerFree: false, teams: { EPL: ['Arsenal'] } };
        if (url === '/info') return { features: { sportPageLeagues: ['EPL'] } };
        if (url === '/sports/pages/league/EPL') return afl();
        return { sports: [{ sport: 'Football', leagues: [{ league: 'EPL', label: 'Premier League' }] }] };
    } });
    const p = page(b, { setLocation() {} });
    await p.show('Football/EPL');
    await new Promise(setImmediate); await new Promise(setImmediate);
    assert.ok(asked.includes('/sports/pages/league/EPL'));
    assert.match(p.root.innerHTML, /<button type="button" class="back-link" data-act="back">[\s\S]*?<span>Football<\/span><\/button><h2>Premier League<\/h2>/);
    assert.match(p.root.innerHTML, /data-round="3:5" aria-pressed="true"/);
    p.act('round', { getAttribute: (k) => ({ 'data-round': '3:4' })[k] });
    assert.match(p.root.innerHTML, /data-round="3:4" aria-pressed="true"/);
    // the sport page now links the league page
    p.openPath('Football', 'none');
    assert.match(p.root.innerHTML, /<button type="button" class="more-row" data-act="open-league" data-sport="Football" data-league="EPL"[^>]*><span class="s">Rounds and standings<\/span>/);
});

test('a fixture with no front-page card plays and records on its own channels, with no game id', async () => {
    const sent = [];
    const data = afl();
    const g = data.rounds[1].games[0];
    g.status = 'scheduled'; g.start = NOW + 7200000; g.channels = [{ sourceId: 2, stableId: 'k', id: '77', name: 'Fox Footy', start: NOW + 7000000, end: NOW + 18000000 }];
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? answer() : url === '/sports/pages/preferences' ? { spoilerFree: false }
        : url === '/info' ? { features: { sportPageLeagues: ['AFL'] } } : url.startsWith('/sports/pages/league/') ? data : {}),
        recordings: { schedule: async (d) => { sent.push(d); return {}; } } });
    const p = page(b, { setLocation() {} });
    await p.show('Australian%20football/AFL');
    await new Promise(setImmediate); await new Promise(setImmediate);
    const id = `fx:AFL:${g.id}`;
    assert.match(p.root.innerHTML, new RegExp(`data-act="game" data-id="${id}"`));
    const game = p.game(id);
    assert.equal(game.title, 'Fremantle v Brisbane Lions');
    assert.equal(b.V.action(game, p.now()), 'remind');
    await p.record(id);
    eq(sent, [{ sourceId: 2, channelItemId: '77', channelName: 'Fox Footy', title: 'Fremantle v Brisbane Lions', programStart: NOW + 7000000, programEnd: NOW + 18000000 }]);
});
