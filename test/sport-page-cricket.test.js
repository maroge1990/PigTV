const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const express = require('express');

// #21 (0383, C-S): the Cricket page's data from ESPN's free cricket feeds, as captured on 31 Oct 2026 01:56 UTC (12:56
// Melbourne): the 3rd Test of Australia's tour of South Africa at stumps on day 4 (the series level 1-1 after three
// ODIs, a tour match and two Tests), the Sheffield Shield's three matches in play, the WBBL's next games, and
// tomorrow's panel. The fixtures are ESPN's answers with only other series' blocks (and, in the summary, the rosters,
// news and commentary) left out. The old code has no Cricket page.
const cricket = require('../server/services/sportPageCricket');
const dir = path.join(__dirname, 'fixtures/sport-page-cricket');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const NOW = Date.parse('2026-10-31T01:56:00Z');
const TEST_START = Date.parse('2026-10-27T08:30Z');
const DAY = 86400e3;
const localMidnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
let asked, followed;

/** ESPN from the fixtures; `edit(name, json)` changes one answer (a live state the capture did not have). */
function stub(edit = () => {}) {
    asked = [];
    const days = fixture('scoreboard-24203.json');
    const answer = (name, json) => { edit(name, json); return { ok: true, json }; };
    cricket.fetcher.get = async (url) => {
        asked.push(url);
        const u = new URL(url);
        const d = u.searchParams.get('dates');
        if (u.pathname.endsWith('/cricket/scorepanel') && fs.existsSync(path.join(dir, `scorepanel-${d}.json`))) return answer(`scorepanel-${d}`, fixture(`scorepanel-${d}.json`));
        if (u.pathname.endsWith('/cricket/24203/scoreboard') && days[d]) return answer(`24203-${d}`, days[d]);
        if (u.pathname.endsWith('/cricket/24203/summary') && u.searchParams.get('event') === '1525661') return answer('summary', fixture('summary-1525661.json'));
        return { ok: false, error: 'HTTP 404' };
    };
}
const eventIn = (json, id) => json.scores.flatMap(b => b.events).find(e => e.id === id);
beforeEach(() => {
    cricket.reset();
    followed = ['Australia'];
    cricket.prefs.get = () => ({ spoilerFree: false, sports: ['Cricket'], teams: followed.length ? { Cricket: followed } : {}, following: {} });
    stub();
});

/** The Test as it was in the afternoon session of day 4: South Africa 294/5, Rickelton and Mulder at the crease. */
function liveDay4(name, json) {
    if (name === 'scorepanel-20261031') {
        const c = eventIn(json, '1525661').competitions[0];
        c.status.type = { id: '1', description: 'Live', detail: 'Live', shortDetail: 'Live', state: 'in' };
        c.status.summary = 'South Africa lead by 194 runs';
        const [sa, aus] = c.competitors;
        Object.assign(sa.linescores[2], { runs: 294, wickets: 5, overs: 103, description: '' });
        Object.assign(aus.linescores[2], { overs: 103, description: '' });
        sa.score = '329 & 294/5 (103 ov)';
    }
    if (name === 'summary') {
        const card = json.matchcards.find(k => k.headline === 'Batting');
        for (const p of card.playerDetails) p.dismissal = ['RD Rickelton', 'PWA Mulder'].includes(p.playerName) ? 'not out' : 'caught';
        json.notes = json.notes.filter(n => !(n.dayNumber === '4' && /^(Drinks: South Africa - 335|Innings Break)/.test(n.text)));
    }
}

test('the page is not available until ESPN answers; then the lead is the Test on day 4, both innings, with its days', async () => {
    cricket.fetcher.get = async () => ({ ok: false, error: 'HTTP 503' });
    assert.deepEqual(await cricket.page(NOW), { available: false });

    cricket.reset();
    stub(liveDay4);
    const p = await cricket.build(NOW, { followed: ['Australia'] });
    assert.equal(p.available, true);
    const lead = p.lead;
    assert.deepEqual([lead.id, lead.seriesId, lead.label, lead.format, lead.status, lead.breakLabel, lead.day, lead.session],
        ['1525661', '24203', '3rd Test', 'test', 'live', null, 'Day 4', 3], 'after Lunch and Tea on day 4: session 3');
    assert.deepEqual([lead.competition, lead.venue, lead.city], ['Australia in South Africa', 'Newlands, Cape Town', 'Cape Town']);
    assert.deepEqual(lead.teams, [{ abbr: 'SA', name: 'South Africa', logo: 'https://a.espncdn.com/i/teamlogos/cricket/500/3.png' },
        { abbr: 'AUS', name: 'Australia', logo: 'https://a.espncdn.com/i/teamlogos/cricket/500/2.png' }]);
    assert.deepEqual(lead.innings, [
        [{ runs: 329, wickets: 10, overs: '82.3', declared: false, current: false }, { runs: 294, wickets: 5, overs: '103', declared: false, current: true }],
        [{ runs: 429, wickets: 10, overs: '125.1', declared: false, current: false }]
    ], 'per team in order played, overs as text, the mirrored rows left out');
    assert.equal(lead.summary, 'South Africa lead by 194 runs');
    assert.deepEqual(lead.crease, [{ name: 'RD Rickelton', runs: 101, balls: 219 }, { name: 'PWA Mulder', runs: 115, balls: 221 }]);
    assert.deepEqual(lead.days.map(d => d.state), ['done', 'done', 'done', 'live', 'next']);
    assert.deepEqual(lead.days.map(d => d.date), [0, 1, 2, 3, 4].map(i => localMidnight(TEST_START + i * DAY)));
    assert.equal(lead.nextStart, null);
    assert.equal(lead.start, TEST_START);
    assert.equal(lead.end, TEST_START + 4 * DAY + 6.5 * 3600e3);
    assert.deepEqual(lead.channels, []);
    assert.equal(cricket.ttlOf(p, NOW), 2 * 60e3, 'kept 2 min while the lead is in play');
});

test('the followed team decides the lead; with none (or one not playing), the first live match ESPN lists', async () => {
    assert.equal((await cricket.build(NOW, { followed: ['Australia'] })).lead.id, '1525661');
    assert.equal((await cricket.build(NOW, { followed: ['australia'] })).lead.id, '1525661', 'any case');
    const none = await cricket.build(NOW, { followed: [] });
    assert.deepEqual([none.lead.id, none.lead.competition, none.lead.status], ['1544870', 'Sheffield Shield', 'live'],
        'the Shield\'s South Australia v Western Australia: live, and first in the panel (the Test is at stumps)');
    assert.deepEqual(none.lead.teams.map(t => t.name), ['Western Australia', 'South Australia'], 'never "Australia" by the location field');
    assert.equal(none.lead.seriesLine, null, 'no tally for a domestic competition');
    assert.equal((await cricket.build(NOW, { followed: ['England'] })).lead.id, '1544870');

    // page(): the household's follow is read each request, and a change is not served from the old answer.
    followed = [];
    assert.equal((await cricket.page(NOW)).lead.id, '1544870');
    followed = ['Australia'];
    assert.equal((await cricket.page(NOW + 1000)).lead.id, '1525661');
});

// 0383 Codex round 1 (medium): a followed team's finished match stayed the lead while other matches were in play.
test('a followed team\'s finished match gives way to a live one, and leads only when every match is finished', async () => {
    const finish = (c, summary) => { c.status.type = { id: '28', description: 'Result', detail: 'Result', shortDetail: 'Result', state: 'post', completed: true }; c.status.summary = summary; };
    stub((name, json) => { if (name === 'scorepanel-20261031') finish(eventIn(json, '1525661').competitions[0], 'South Africa won by 150 runs'); });
    const p = await cricket.build(NOW, { followed: ['Australia'] });
    assert.ok(['1544870', '1544871'].includes(p.lead.id), `a live match leads, not the finished Test (got ${p.lead.id})`);
    assert.equal(p.lead.status, 'live');

    stub((name, json) => { if (/^scorepanel-/.test(name)) for (const e of json.scores.flatMap(b => b.events)) finish(e.competitions[0], 'Result'); });
    const all = await cricket.build(NOW, { followed: ['Australia'] });
    assert.deepEqual([all.lead.id, all.lead.status], ['1525661', 'done'], 'nothing in play or to come: the followed team\'s match');
});

test('stumps: a break labelled Stumps, play resumes the next day at the same time, its chip is next', async () => {
    const p = await cricket.build(NOW, { followed: ['Australia'] });
    const lead = p.lead;
    assert.deepEqual([lead.status, lead.breakLabel, lead.day, lead.session], ['break', 'Stumps', 'Day 4', null]);
    assert.equal(lead.nextStart, Date.parse('2026-10-31T08:30Z'), 'day 5 at day 1\'s time');
    assert.deepEqual(lead.days.map(d => [d.number, d.state]), [[1, 'done'], [2, 'done'], [3, 'done'], [4, 'done'], [5, 'next']]);
    assert.equal(lead.summary, 'South Africa lead by 287 runs');
    assert.equal(lead.crease, null, 'South Africa are all out: nobody is at the crease');
    assert.equal(cricket.ttlOf(p, NOW), 10 * 60e3, 'a match day: day 5 starts within 12 h');
    assert.equal(cricket.ttlOf({ lead: { ...lead, nextStart: NOW + 20 * 3600e3 }, others: [] }, NOW), 60 * 60e3);
});

test('the series: every match of the tour in order, results as ESPN words them, the current one marked', async () => {
    const p = await cricket.build(NOW, { followed: ['Australia'] });
    assert.deepEqual([p.series.id, p.series.name, p.series.season], ['24203', 'Australia in South Africa', '2026/27']);
    assert.deepEqual(p.series.matches.map(m => [m.label, m.status, m.result, m.current]), [
        ['1st ODI', 'done', 'South Africa won by 67 runs', false],
        ['2nd ODI', 'done', 'South Africa won by 32 runs', false],
        ['3rd ODI', 'done', 'Australia won by 45 runs (DLS)', false],
        ['Tour Match', 'done', 'Match drawn', false],
        ['1st Test', 'done', 'Australia won by 214 runs', false],
        ['2nd Test', 'done', 'South Africa won by an inns & 31 runs', false],
        ['3rd Test', 'break', null, true]
    ]);
    assert.ok(p.series.matches.every((m, i, a) => !i || a[i - 1].start <= m.start));
    assert.equal(p.lead.seriesLine, 'Series level 1–1 · third of three Tests');
    const days = asked.filter(u => /24203\/scoreboard/.test(u)).map(u => new URL(u).searchParams.get('dates')).sort();
    assert.deepEqual(days, ['20260924', '20260927', '20260930', '20261003', '20261009', '20261018'],
        'one request per run of days: a Test\'s or the tour match\'s later days are not asked for');
    stub();
    await cricket.build(NOW + 60e3, { followed: ['Australia'] });
    assert.ok(!asked.some(u => /24203\/scoreboard/.test(u)), 'days already played are kept');
});

test('others: the other competitions today and tomorrow, live and at stumps, with channels for the day in the window', async () => {
    stub((name, json) => {
        if (name !== 'scorepanel-20261031') return;
        const w = eventIn(json, '1543947').competitions[0];
        w.status = { ...w.status, summary: 'Stars need 99 from 75 balls', type: { id: '1', description: 'Live', detail: 'Live', shortDetail: 'Live', state: 'in' } };
        w.competitors[0].score = '161/6';
        w.competitors[0].linescores = [{ period: 1, runs: 161, wickets: 6, overs: 20, isBatting: true, isCurrent: 0, description: '' }];
        w.competitors[1].score = '63/2 (7.3/20 ov, target 162)';
        w.competitors[1].linescores = [{ period: 2, runs: 63, wickets: 2, overs: 7.3, isBatting: true, isCurrent: 1, description: '' }];
        const s = eventIn(json, '1544871').competitions[0];
        s.status.type = { id: '112', description: 'Stumps', detail: 'Live', shortDetail: 'Live', state: 'in' };
    });
    const at = (iso) => Date.parse(iso);
    const ev = (title, start, end, id, league = 'Cricket') => ({ league, kind: 'event', title, aliases: [], start: at(start), end: at(end), channels: [{ sourceId: 8, id }] });
    const events = [
        ev('WBBL: Adelaide Strikers v Melbourne Stars', '2026-10-31T04:15Z', '2026-10-31T08:00Z', 'fox-wbbl', 'BBL'),
        ev('Sheffield Shield: Tasmania v New South Wales', '2026-10-31T23:00Z', '2026-11-01T07:00Z', 'kayo-day3'),
        ev('Sheffield Shield: Tasmania v New South Wales', '2026-10-30T23:00Z', '2026-10-31T07:00Z', 'kayo-day2'),
        ev('Sheffield Shield: South Australia v Western Australia', '2026-10-30T23:30Z', '2026-10-31T07:00Z', 'kayo-shield'),
        ev('Test Cricket: South Africa v Australia, Day 5', '2026-10-31T08:00Z', '2026-10-31T16:00Z', 'fox-test'),
        ev('Test Cricket: South Africa v Australia, Day 4', '2026-10-30T08:00Z', '2026-10-30T16:00Z', 'fox-test-day4')
    ];
    let windows;
    const p = await cricket.page(NOW, { channelsFor: async (airings) => { windows = airings; return cricket.channelsForMatches(airings, events); } });
    const o = (id) => p.others.find(x => x.id === id);
    assert.ok(!p.others.some(x => x.seriesId === '24203'), 'the lead\'s series is shown as the series');
    assert.ok(!p.others.some(x => x.teams.every(t => t.name === 'TBC')), 'no TBC v TBC');
    const wbbl = o('1543947');
    assert.deepEqual([wbbl.competition, wbbl.status, wbbl.line, wbbl.scores], ['WBBL', 'live', 'Stars need 99 from 75 balls', ['161/6', '63/2 (7.3/20 ov, target 162)']]);
    assert.deepEqual(wbbl.teams.map(t => t.name), ['Adelaide Strikers Women', 'Melbourne Stars Women']);
    assert.deepEqual(wbbl.channels.map(c => c.id), ['fox-wbbl'], 'the women\'s sides by their names without "Women"');
    const shield = o('1544871');
    assert.deepEqual([shield.competition, shield.status, shield.nextStart], ['Sheffield Shield', 'break', at('2026-10-31T23:30Z')]);
    assert.deepEqual(shield.channels.map(c => c.id), ['kayo-day3'], 'the next day\'s programme, not the day before\'s');
    assert.deepEqual(o('1544870').channels.map(c => c.id), ['kayo-shield']);
    assert.deepEqual(p.lead.channels.map(c => c.id), ['fox-test'], 'day 5, not day 4; and "South Australia" is not "Australia"');
    const next = o('1543949');
    assert.deepEqual([next.status, next.scores, next.start, next.nextStart, next.channels], ['scheduled', [null, null], at('2026-11-01T04:40Z'), at('2026-11-01T04:40Z'), []],
        'tomorrow\'s game, no 0 for a team that has not batted');
    assert.ok(p.others.findIndex(x => x.id === '1543947') < p.others.findIndex(x => x.id === '1544871'), 'in play before stumps');
    assert.ok(windows.every(w => w.end > w.start && Array.isArray(w.teams)));
    const cached = await cricket.page(NOW + 1000);
    assert.ok(cached.others.every(x => Array.isArray(x.channels) && !x.channels.length), 'channels belong to the request, not the cache');
});

// The route, its flag and its auth, in a sandbox (the database opens in it).
test('GET /api/sports/pages/cricket: 401 signed out, the page signed in, /api/info advertises it', async (t) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-cricket-'));
    fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
    const load = p => require(path.join(sandbox, 'server', p));
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-cricket-page-key-at-least-32-characters';
    process.env.PIGTV_DB_BACKUPS = '0';
    delete process.env.PIGTV_SPORT_FIXTURES;
    const auth = load('auth'), db = load('db');
    const token = auth.generateToken(await db.users.create({ username: 'viewer', role: 'viewer' }));
    const page = load('services/sportPageCricket');
    const events = load('services/sportsEvents');
    const leagues = [];
    events.leagueEvents = async ({ league }) => { leagues.push(league); return league === 'Cricket'
        ? [{ league: 'Cricket', kind: 'event', title: 'Test Cricket: South Africa v Australia', start: Date.now() - 3600e3, end: Date.now() + 3600e3, channels: [] }] : []; };
    page.fetcher.get = async (url) => {
        const u = new URL(url);
        const name = u.pathname.endsWith('/scorepanel') ? `scorepanel-${u.searchParams.get('dates')}.json` : null;
        // Today's panel, whatever today is: the route reads the clock.
        if (name) return { ok: true, json: fixture(u.searchParams.get('dates') === new Date().toISOString().slice(0, 10).replaceAll('-', '') ? 'scorepanel-20261031.json' : 'scorepanel-20261101.json') };
        return { ok: false, error: 'HTTP 404' };
    };
    const app = express(); app.use(express.json());
    app.use('/api/info', load('routes/info'));
    app.use('/api/sports', load('routes/sports'));
    const server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', err => err ? reject(err) : resolve(s)); });
    t.after(async () => {
        try { events.shutdown(); } catch { /* never started */ }
        await new Promise(r => server.close(r));
        load('db/sqlite').getDb().close();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, { auth: withToken = true, body } = {}) => {
        const r = await fetch(base + route, { method: body ? 'PUT' : 'GET', headers: { ...(withToken ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    assert.equal((await call('/api/info')).body.features.sportPageCricket, true);
    assert.equal((await call('/api/sports/pages/cricket', { auth: false })).status, 401);
    assert.equal((await call('/api/sports/pages/preferences', { body: { sports: ['Cricket'], teams: { Cricket: ['Australia'] } } })).status, 200);
    const r = await call('/api/sports/pages/cricket');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['available', 'lead', 'others', 'series', 'updatedAt']);
    assert.equal(r.body.lead.id, '1525661', 'the household\'s followed team, from the stored preferences');
    for (const k of ['id', 'seriesId', 'competition', 'label', 'format', 'venue', 'city', 'start', 'end', 'status', 'breakLabel', 'day', 'session',
        'teams', 'innings', 'summary', 'crease', 'seriesLine', 'days', 'nextStart', 'channels']) assert.ok(k in r.body.lead, k);
    assert.ok(Array.isArray(r.body.others) && r.body.others.every(o => Array.isArray(o.channels)));
    assert.ok(!JSON.stringify(r.body).includes('espncdn'), 'team logos go through the logo cache');
    assert.ok(leagues.includes('Cricket') && leagues.includes('BBL'), 'the guide is asked for each league cricket is filed under');
});

after(() => { cricket.reset(); });
