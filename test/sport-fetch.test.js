const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');

// #272 (D-2, 0547): every sport feed request goes through one fetch (server/services/sportFetch.js). Before, the fixture
// refresh and the four page builders (sportsFixturesEspn.getJson) had no size cap, followed redirects and only joined
// the shared ESPN cooldown under a rule of their own; the leagues' own feeds (sportFeeds.getUrl) asked ESPN's AFL teams
// list with no cooldown at all. No request here leaves the machine: global.fetch is a stub throughout.
delete process.env.PIGTV_SPORTS_DASHBOARD; // the collector's default: on, so the shared cooldown applies
const policy = require('../server/services/espnRequestPolicy');
const fixturesEspn = require('../server/services/sportsFixturesEspn');
const scores = require('../server/services/sportsScoresEspn');
const feeds = require('../server/services/sportFeeds');
const pages = {
    nfl: require('../server/services/sportPageNFL'), f1: require('../server/services/sportPageF1'),
    league: require('../server/services/sportPageLeague'), cricket: require('../server/services/sportPageCricket'),
    events: require('../server/services/sportPageEvents')
};
const realGet = Object.fromEntries(Object.entries(pages).map(([k, m]) => [k, m.fetcher.get]));
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; policy.reset(); });
const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
// Each caller, by the way it asks, with a URL of the shape it asks today. `ok(result)` says whether it got an answer.
const CALLERS = {
    'fixture refresh (getJson)': () => fixturesEspn.getJson(`${SITE}/football/nfl/scoreboard?dates=20261101`, 10000),
    'NFL page': () => realGet.nfl(`${SITE}/football/nfl/scoreboard`),
    'F1 page': () => realGet.f1('https://sports.core.api.espn.com/v2/sports/racing/leagues/f1/events/600057447?lang=en&region=us'),
    'League page': () => realGet.league('https://site.api.espn.com/apis/v2/sports/australian-football/afl/standings'),
    'Cricket page': () => realGet.cricket(`${SITE}/cricket/scorepanel?dates=20261031`),
    'Events page': () => realGet.events(`${SITE}/golf/leaderboard?league=pga`),
    'score collector (fetchJson)': () => scores.fetchJson(`${SITE}/soccer/eng.1/scoreboard?dates=20261101&limit=1000`).then(json => ({ ok: true, json }), err => ({ ok: false, error: err.message })),
    'league feeds (getUrl, ESPN AFL badges)': () => feeds.getUrl(`${SITE}/australian-football/afl/teams`)
};

function counting(answer) {
    const seen = [];
    global.fetch = async (url, opts) => { seen.push({ url: String(url), opts }); return answer(String(url)); };
    return seen;
}

test('a 429 seen by any caller blocks every other caller until the cooldown ends', async () => {
    for (const [first, ask] of Object.entries(CALLERS)) {
        policy.reset();
        counting(() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
        assert.equal((await ask()).ok, false, first);
        assert.equal(policy.blocked(), true, `${first}: its 429 is recorded`);
        for (const [other, askOther] of Object.entries(CALLERS)) {
            const seen = counting(() => new Response('{"events":[]}', { status: 200 }));
            const r = await askOther();
            assert.equal(r.ok, false, `${other} answered during ${first}'s cooldown`);
            assert.equal(seen.length, 0, `${other} asked ESPN during the cooldown ${first} recorded`);
        }
    }
    // when it ends, everyone asks again
    policy.reset();
    for (const [name, ask] of Object.entries(CALLERS)) {
        const seen = counting(() => new Response('{"events":[]}', { status: 200 }));
        assert.equal((await ask()).ok, true, name);
        assert.equal(seen.length, 1, name);
    }
});

test('an answer past the size cap is refused, and reading stops there, for the callers that had no cap', async () => {
    for (const name of ['fixture refresh (getJson)', 'NFL page', 'F1 page', 'League page', 'Cricket page']) {
        let sent = 0;
        const chunk = new Uint8Array(1024 * 1024).fill(0x78);
        counting(() => new Response(new ReadableStream({ pull(c) {
            if (sent === 0) c.enqueue(new TextEncoder().encode('{"a":"'));
            if (sent++ < 8) c.enqueue(chunk); else { c.enqueue(new TextEncoder().encode('"}')); c.close(); }
        } }), { status: 200 }));
        const r = await CALLERS[name]();
        assert.deepEqual([r.ok, r.error], [false, 'answer too large'], name);
        assert.ok(sent <= 8, `${name}: stopped reading at the cap (${sent} MB asked for)`);
    }
});

test('a redirect is never followed, for every caller', async () => {
    for (const [name, ask] of Object.entries(CALLERS)) {
        const seen = counting(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
        const r = await ask();
        assert.equal(r.ok, false, name);
        assert.equal(seen.length, 1, name);
        assert.equal(seen[0].opts?.redirect, 'manual', `${name}: fetch told not to follow`);
    }
});

test('anything off the list is refused before a request: another host, path, scheme or port', async () => {
    const seen = counting(() => new Response('{}', { status: 200 }));
    for (const url of ['https://provider.invalid/get.php?password=x', 'http://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
        'https://site.api.espn.com/apis/fantasy/v2/games', 'https://site.api.espn.com:8443/apis/site/v2/sports/x',
        'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events', 'https://site.api.espn.com.evil.example/apis/site/v2/sports/x',
        'https://user:pw@site.api.espn.com/apis/site/v2/sports/x']) {
        assert.deepEqual(await fixturesEspn.getJson(url, 1000), { ok: false, error: 'host not allowed' }, url);
    }
    assert.equal(seen.length, 0);
});

// Every URL shape each caller asks today is still asked: the pages are built from ESPN's stored samples through their
// real fetcher and a stub fetch, and every URL a page asked must have reached fetch (a refusal would silently drop
// standings or the F1 circuit data: the page still builds without them).
async function built(name, answers, run) {
    const asked = [], fetched = [];
    const mod = pages[name];
    mod.fetcher.get = async (url) => { asked.push(url); return realGet[name](url); };
    global.fetch = async (url) => {
        fetched.push(String(url));
        const json = answers(new URL(String(url)), String(url));
        return json === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(json), { status: 200 });
    };
    try { mod.reset(); await run(mod); } finally { mod.fetcher.get = realGet[name]; }
    assert.deepEqual(asked.filter(u => !fetched.includes(u)), [], `${name}: a URL it asked never reached fetch`);
    return asked;
}

test('each page builder\'s URL shapes still reach ESPN: scoreboards, standings and the F1 core lookups', async () => {
    const nfl = await built('nfl', (u, s) => /standings/.test(s) ? fx('espn/nfl/standings.json') : /week=7/.test(s) ? fx('espn/nfl/scoreboard-week7.json')
        : /scoreboard$/.test(s) ? fx('espn/nfl/scoreboard-week8.json') : undefined, (m) => m.build(Date.parse('2026-10-30T21:42:00Z')));
    assert.ok(nfl.includes('https://site.api.espn.com/apis/v2/sports/football/nfl/standings?level=3'), nfl.join('\n'));
    assert.ok(nfl.some(u => /seasontype=2&week=7&dates=2026$/.test(u)));

    const { answers } = fx('sport-page-f1.json');
    const f1 = await built('f1', (u) => {
        const p = u.pathname;
        const key = p.endsWith('/racing/f1/scoreboard') ? (u.searchParams.get('dates') ? `/scoreboard?dates=${u.searchParams.get('dates')}` : '/scoreboard')
            : p.endsWith('/racing/f1/standings') ? 'standings' : `core${p.split('/leagues/f1')[1]}`;
        return answers[key];
    }, async (m) => assert.ok((await m.build(Date.parse('2026-10-30T12:00:00Z'), { registerImage: () => '/api/logo/x' })).weekend.info.map, 'the circuit map came from the core lookups'));
    assert.ok(f1.includes('https://site.api.espn.com/apis/v2/sports/racing/f1/standings'));
    assert.ok(f1.some(u => u.startsWith('https://sports.core.api.espn.com/v2/sports/racing/leagues/f1/circuits/')));
    assert.ok(f1.some(u => /\/competitions\/\d+\/competitors\/\d+/.test(u)));

    const ROUTES = [[/afl\/scoreboard$/, 'afl-scoreboard'], [/afl\/scoreboard\?seasontype=3&week=4&dates=2026$/, 'afl-week4'], [/afl\/standings$/, 'afl-standings'],
        [/eng\.1\/scoreboard$/, 'epl-scoreboard'], [/eng\.1\/standings$/, 'epl-standings']];
    const league = await built('league', (u, s) => { for (const [re, n] of ROUTES) if (re.test(s)) return fx(`espn/league/${n}.json`); return /eng\.1\/scoreboard\?dates=/.test(s) ? { events: [] } : undefined; },
        async (m) => { await m.build('AFL', Date.parse('2026-10-31T07:40:00Z'), { zone: 'Australia/Melbourne' }); await m.build('EPL', Date.parse('2026-10-31T07:40:00Z'), { zone: 'Australia/Melbourne' }); });
    assert.ok(league.includes('https://site.api.espn.com/apis/v2/sports/australian-football/afl/standings'));
    assert.ok(league.includes('https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings'));
    assert.ok(league.some(u => /eng\.1\/scoreboard\?dates=\d{8}&limit=100$/.test(u)), 'a day league asks by day');

    const days = fx('sport-page-cricket/scoreboard-24203.json');
    const cricket = await built('cricket', (u) => {
        const d = u.searchParams.get('dates');
        if (u.pathname.endsWith('/cricket/scorepanel') && fs.existsSync(path.join(__dirname, 'fixtures/sport-page-cricket', `scorepanel-${d}.json`))) return fx(`sport-page-cricket/scorepanel-${d}.json`);
        if (u.pathname.endsWith('/cricket/24203/scoreboard') && days[d]) return days[d];
        if (u.pathname.endsWith('/cricket/24203/summary')) return fx('sport-page-cricket/summary-1525661.json');
        return undefined;
    }, (m) => m.build(Date.parse('2026-10-31T01:56:00Z'), { followed: ['Australia'] }));
    assert.ok(cricket.some(u => /\/cricket\/24203\/summary\?event=1525661$/.test(u)));
    assert.ok(cricket.some(u => /\/cricket\/scorepanel\?dates=\d{8}$/.test(u)));

    const EV = [[/tennis\/atp\/scoreboard$/, 'tennis-atp-2026-11-01'], [/golf\/pga\/scoreboard$/, 'golf-pga-scoreboard-2026-11-01'],
        [/golf\/leaderboard\?league=pga$/, 'golf-pga-leaderboard-2026-11-01'], [/mma\/ufc\/scoreboard\?dates=20261029-20261108$/, 'ufc-2026-10-29-2026-11-08']];
    const events = await built('events', (u, s) => { for (const [re, n] of EV) if (re.test(s)) return fx(`espn-events/${n}.json`); return undefined; },
        async (m) => { for (const l of ['ATP Tour', 'PGA Tour', 'UFC']) await m.build(l, Date.parse('2026-11-01T09:30:00Z')); });
    assert.ok(events.some(u => /golf\/leaderboard\?league=pga$/.test(u)) && events.some(u => /ufc\/scoreboard\?dates=\d{8}-\d{8}$/.test(u)));
});

test('the fixture refresh, the collector, suggestions and the leagues\' own feeds: each URL shape they ask is allowed', async () => {
    const { allowed } = require('../server/services/sportFetch');
    const asked = [
        // sportsFixturesEspn: fetchScoreboard, fetchTeams, discoverCricketSeries
        `${SITE}/football/nfl/scoreboard?dates=20261101`, `${SITE}/football/nfl/teams`, `${SITE}/cricket/scorepanel`, `${SITE}/cricket/8048/scoreboard?dates=20261101`,
        // the collector: dated, current (tennis/golf), discovery, a team's schedule (football with ?fixture=true)
        `${scores.BASE}soccer/eng.1/scoreboard?dates=20261101&limit=1000`, `${scores.BASE}tennis/atp/scoreboard`, `${scores.BASE}cricket/scorepanel?dates=20261101`,
        `${scores.BASE}soccer/eng.1/teams/359/schedule?fixture=true`, `${scores.BASE}basketball/nba/teams/13/schedule`,
        // follow suggestions
        `${SITE}/soccer/all/teams/359/schedule?fixture=true`,
        // sportFeeds: AFLW, Champion Data, MotoGP, Supercars, ESPN's AFL badges
        'https://aflapi.afl.com.au/afl/v2/competitions/3/compseasons', 'https://aflapi.afl.com.au/afl/v2/matches?compSeasonId=96&pageSize=250',
        'https://mc.championdata.com/data/competitions.json', 'https://mc.championdata.com/data/12345/fixture.json',
        'https://api.motogp.pulselive.com/motogp/v1/results/seasons', 'https://api.motogp.pulselive.com/motogp/v1/results/events?seasonUuid=x',
        'https://api.motogp.pulselive.com/motogp/v1/results/sessions?eventUuid=x&categoryUuid=y', 'https://www.supercars.com/calendar',
        `${SITE}/australian-football/afl/teams`
    ];
    assert.deepEqual(asked.filter(u => !allowed(u)), []);
    // and through the real callers, with the stub answering
    const seen = counting(() => new Response('{"events":[],"scores":[],"sports":[]}', { status: 200 }));
    assert.equal((await fixturesEspn.fetchScoreboard('football/nfl', Date.parse('2026-11-01T00:00Z'), Date.parse('2026-11-01T01:00Z'))).ok, true);
    assert.equal((await fixturesEspn.fetchTeams('football/nfl')).ok, true);
    assert.equal((await fixturesEspn.discoverCricketSeries()).ok, true);
    await scores.fetchJson(`${scores.BASE}soccer/eng.1/teams/359/schedule?fixture=true`);
    assert.equal((await feeds.getUrl('https://www.supercars.com/calendar', { as: 'text' })).ok, true);
    assert.equal(seen.length, 5);
    assert.equal(seen.at(-1).opts.headers['user-agent'], 'PigTV (self-hosted; fixtures)', 'the feeds keep their user agent');
});

test('a 5xx is recorded like a 429; with the collector off (=0) ESPN requests neither record nor honour the cooldown', async () => {
    counting(() => new Response('', { status: 503 }));
    assert.deepEqual((await realGet.nfl(`${SITE}/football/nfl/scoreboard`)).error, 'HTTP 503');
    assert.equal(policy.blocked(), true);
    policy.reset();
    process.env.PIGTV_SPORTS_DASHBOARD = '0';
    try {
        await realGet.nfl(`${SITE}/football/nfl/scoreboard`);
        assert.equal(policy.blocked(), false);
        policy.observe(429, '60');
        const seen = counting(() => new Response('{}', { status: 200 }));
        assert.equal((await realGet.events(`${SITE}/golf/pga/scoreboard`)).ok, true);
        assert.equal(seen.length, 1);
    } finally { delete process.env.PIGTV_SPORTS_DASHBOARD; }
});
