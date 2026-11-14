const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, assertNoScores, ctx, page } = require('./helpers/sportWeb');
const eq = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message); // across the vm realm

// #323 step 2: a sport's page (Apple's SportPageView on a computer, SportPhonePage on a phone), in the address
// (#sports/Football), from the front page's own answer (C-R). On a computer: the banner (the sport's hero, the sport's
// leagues as its list) and the chosen league's games under Live, Later today, Coming up and Earlier, in two columns. On a
// phone: "‹ Sport", the league chips, the league's carousel, the same groups. Hidden scores hold here too.

test('the sport\'s leagues, hero and groups follow Apple\'s rules', () => {
    const { V } = browser();
    const front = answer();
    eq(V.sportLeagues('Football', front).map(s => s.league), ['EPL']);
    eq(V.sportHero('Football', front), { gameId: 'ars', followIndex: 0 }, 'a follow of the sport live');
    eq(V.sportHero('American football', front), { gameId: 'nfl', followIndex: null }, 'else a live game of the sport');
    eq(V.sportHero('Motorsport', front), { gameId: 'f1', followIndex: 1 }, 'else a follow\'s next game');
    eq(V.leagueGroups('EPL', front, NOW).map(g => [g.title, g.games.map(x => x.id)]),
        [['Live', ['ars', 'pen']], ['Later today', ['nxt']], ['Earlier', ['avl']]]);
    const later = answer(); later.games.find(g => g.id === 'nxt').start = NOW + 3 * 86400000;
    eq(V.leagueGroups('EPL', later, NOW).map(g => g.title), ['Live', 'Coming up', 'Earlier'], 'another day: Coming up');
    assert.equal(V.openingLeague('Football', front, 'Nope'), 'EPL', 'a chosen league no longer followed falls back');
    const items = V.leagueItems('Football', front, NOW, { EPL: 'Premier League' });
    eq(items.map(i => [i.title, i.trailing, i.live]), [['Premier League', '2 live', true]]);
});

test('the sport page on a computer: the banner with the back button and the leagues list, the groups in two columns', () => {
    const { V } = browser();
    const front = answer({ sports: [...answer().sports, { league: 'A-League', sport: 'Football', live: 0, next: { gameId: 'x', start: NOW + 86400000 }, line: 'next' }] });
    const html = V.sportPage('Football', ctx(V, front, { links: true }));
    assert.match(html, /<section class="banner" aria-label="Arsenal v Chelsea"><img class="art" src="\/api\/logo\/ars"[^>]*><button type="button" class="backbtn" data-act="back" aria-label="Back to Sport">/);
    assert.match(html, /<span class="up">Football · Your leagues<\/span>/);
    assert.match(html, /class="brow sel" data-act="league" data-index="0"[\s\S]*?<span class="t">Premier League<\/span><span class="tr live">2 live<\/span>/);
    assert.match(html, /data-act="league" data-index="1"[\s\S]*?<span class="t">A-League<\/span><span class="tr">[^<]+<\/span>/);
    assert.match(html, /<div class="groups2"><div><section class="grp" aria-label="Live">[\s\S]*?<section class="grp" aria-label="Later today">[\s\S]*?<\/div><div><section class="grp" aria-label="Earlier">/);
    assert.equal((html.match(/pill primary/g) || []).length, 1, 'one rose button');
});

test('the sport page on a phone: the league chips, the carousel of the league\'s games, then the groups', () => {
    const { V } = browser();
    const front = answer({ sports: [...answer().sports, { league: 'A-League', sport: 'Football', live: 0, next: null, line: 'quiet' }] });
    const html = V.sportPage('Football', ctx(V, front, { phone: true, links: true }));
    assert.match(html, /<div class="chips" role="group" aria-label="Football leagues"><button type="button" class="lchip on" data-act="league" data-league="EPL" aria-pressed="true"[^>]*>Premier League<\/button><button type="button" class="lchip" data-act="league" data-league="A-League" aria-pressed="false"/);
    assert.match(html, /<div class="carousel" data-carousel="league:EPL" aria-label="Premier League">/);
    assert.match(html, /<span>1 of 2<\/span>/, 'yours, then the other live game');
    assert.match(html, /<section class="grp" aria-label="Live">/);
    const quiet = V.sportPage('Football', ctx(V, front, { phone: true, chosen: 'A-League' }));
    assert.match(quiet, /Nothing in the next three days[\s\S]*A-League has no games in the next three days\.[\s\S]*href="#guide">Open the TV Guide/);
});

for (const phone of [false, true]) {
    test(`a sport page with scores hidden (${phone ? 'phone' : 'computer'}): nothing that reveals a score`, () => {
        const { V } = browser();
        for (const sport of ['Football', 'American football', 'Cricket']) {
            assertNoScores(V.sportPage(sport, ctx(V, answer(), { hide: true, phone, links: true })), `${sport} ${phone ? 'phone' : 'computer'}`);
        }
        assert.match(V.sportPage('Football', ctx(V, answer(), { phone, links: true })), /47/, 'shown: the score is there');
    });
}

test('the address: #sports/Football is the sport\'s page, Back and the page\'s back button return, the title follows', async () => {
    const front = answer();
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? front : url === '/sports/pages/preferences' ? { spoilerFree: false }
        : url === '/info' ? { features: {} } : { sports: [] }) });
    const located = [];
    const app = { setLocation: (pg, sub, mode) => located.push([pg, sub, mode]), titleFor: (pg, sub) => `Sport${sub ? ` · ${sub}` : ''}` };
    const p = page(b, app);
    await p.show('American%20football');
    eq(p.route, { sport: 'American football', league: null });
    assert.match(p.root.innerHTML, /<h2 class="visually-hidden">American football<\/h2>/);
    eq(p.titleParts('Football/EPL'), ['Football', 'EPL']);
    p.labels = { EPL: 'Premier League' };
    eq(p.titleParts('Football/EPL'), ['Football', 'Premier League']);
    // from the front page: a section's header opens the sport's page as a new history entry
    p.openPath('', 'none');
    p.act('open-sport', { getAttribute: (k) => ({ 'data-sport': 'Football' })[k] });
    assert.deepEqual(located.pop(), ['sports', 'Football', 'push']);
    assert.equal(p.path, 'Football');
    let backs = 0;
    b.context.history = { back: () => { backs++; p.openPath('', 'none'); } };
    p.back();
    assert.equal(backs, 1, 'the page\'s back button goes back through history');
    assert.equal(p.path, '');
    // a sport page opened from its address (no history of ours): back goes up a place, in place
    await p.show('Football');
    p.back();
    assert.deepEqual(located.pop(), ['sports', undefined, 'replace']);
    assert.equal(backs, 1);
});

test('choosing a league in the banner\'s list or a chip shows its games, and is kept per sport', async () => {
    const front = answer({ sports: [...answer().sports, { league: 'A-League', sport: 'Football', live: 0, next: null, line: 'quiet' }],
        rails: [...answer().rails, { league: 'A-League', sport: 'Football', gameIds: ['nxt'] }] });
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? front : url === '/sports/pages/preferences' ? { spoilerFree: false } : { features: {} }) });
    const p = page(b, { setLocation() {} });
    await p.show('Football');
    p.act('league', { getAttribute: (k) => ({ 'data-index': '1' })[k] ?? null });
    assert.equal(p.chosen.Football, 'A-League');
    assert.match(p.root.innerHTML, /class="brow sel" data-act="league" data-index="1"/);
    assert.doesNotMatch(p.root.innerHTML, /aria-label="Live"/, 'the A-League has nothing live');
    p.act('league', { getAttribute: (k) => ({ 'data-league': 'EPL' })[k] ?? null });
    assert.equal(p.chosen.Football, 'EPL');
});

test('the front page links each sport\'s page: its section header, the hero\'s "Open Football", "Also in your sports"', () => {
    const { V } = browser();
    const html = V.front(ctx(V, answer(), { links: true }));
    assert.match(html, /<button type="button" class="sec-h" data-act="open-sport" data-sport="Football" data-key="sec:Football"><span class="s">Football<\/span><span class="chev" aria-hidden="true">›<\/span>/);
    assert.match(html, /data-act="open-sport" data-sport="Football" data-key="hero:open">Open Football/);
    assert.match(html, /<button type="button" class="b" data-act="open-sport" data-sport="Australian football"/);
    const phone = V.front(ctx(V, answer(), { links: true, phone: true }));
    assert.match(phone, /<button type="button" class="grp-h" data-act="open-sport" data-sport="Football"/);
    assert.match(phone, /<button type="button" class="fbody fsolo" data-act="open-sport" data-sport="Australian football"/, 'a follow with nothing on opens its sport');
});
