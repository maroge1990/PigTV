const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #272 (batch D, owner's call of 11 Nov 2026): on the rig the Premier League page said a game was live at +2:57 and over
// at +0:51 while the front page said +2:07 and +2:11: the league pages read ESPN on their own cache (10 min on a game day,
// 2 min while a game is on) and took no score delay, the front the score collector's store with the account's delay. For
// the same account at the same moment a game's status and score on a league page must be the front page's, in each
// contract's own words (C-R `finished`, C-T/C-Q `done`). Spoilers: the front leaves scores out when the household's
// spoiler-free switch is on; the pages always send them and the client hides them by that same switch (C-P, C-Q, C-T).
// This replays one scripted game (scripts/fake-scores.js, the rig's) through the collector and both answers, for an
// account with the default 90 s delay and one with none, at instants before, at kick-off, mid-game, at the final, after.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-pages-agree-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
delete process.env.PIGTV_SPORTS_DASHBOARD;
delete process.env.PIGTV_SPORT_FIXTURES;
process.env.TZ = 'UTC';

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const dashboard = load('services/sportsDashboard');
const requestPolicy = load('services/espnRequestPolicy');
const { scriptedGame, scoreboard } = require('../scripts/fake-scores');
/** What the page routes hand a page for this account (sportPageState, from 0557), or nothing before it existed. */
const pageDeps = (userId, now) => { try { return load('services/sportPageState').deps(userId, now); } catch { return {}; } };

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const MIN = 60000;
const K = Date.parse('2026-11-04T09:00:00Z');
// C-R's words as each page says them (0548/0554 edge tables); `unknown` (stale) has no page word and is never asked here.
const C_T = { scheduled: 'scheduled', live: 'live', break: 'break', finished: 'done', postponed: 'postponed', cancelled: 'cancelled' };
const ACCOUNTS = { delayed: 1, instant: 2 };

/** The front's card for the game (sportsDashboard.buildDashboard with the front page's options, as its worker runs it). */
function frontCard(league, cardId, userId, now, spoilerFree) {
    const r = dashboard.buildDashboard(dashboard.store(), { now, userId, leagues: new Set([league]), timezone: 'UTC', keepFinishedToday: true,
        teams: null, spoilerFree, channelTimes: true, upcomingHours: 72, guideCards: false });
    return r.games.find(g => g.id === cardId);
}

let prefsSet = false;
/**
 * Replay the scripted game kicking off at `at` through the collector, the front's card and one page (`ask(now, deps)` ->
 * the page's game, `{ status, home: { score }, away: { score } }`, or `{ status, scores }` with `scores` a list or null
 * where a page has no home and away), for both accounts, at five instants. -> disagreements. `board(game, now)` is ESPN's
 * answer (the scripted Premier League scoreboard unless given), `card` the collector's id for the game, `check(g, card,
 * who)` more of the page's own rules at each instant (#297: no finished session without its result, no live one with it).
 */
async function replay({ league, source, at, serve, ask, words, reset, board = scoreboard, card: cardOf, collect, check = () => {} }) {
    const store = dashboard.store();
    if (!prefsSet) { store.updatePreferences(ACCOUNTS.instant, { revision: 0, scoreDelaySeconds: 0 }); prefsSet = true; } // the other keeps 90 s
    const game = scriptedGame({ at, guideMin: 10, finalMin: 25 });
    const clock = { now: at - 17.5 * MIN }; // the page's own refreshes then fall as they may, not on the kick-off
    requestPolicy.reset();
    reset();
    const answer = (url) => serve(board(game, clock.now), url);
    const collector = dashboard.createCollector({ store, clock: () => clock.now, enabled: () => true, leagues: () => new Set([league]),
        followed: () => new Map(), feedGames: async () => ({ ok: true, games: [] }), recordFeed: () => {}, busy: () => true,
        every: () => null, windowDemand: () => false,
        fetchJson: collect ? async url => collect(board(game, clock.now), url)
            : async url => (url.includes(`${source}/scoreboard`) ? board(game, clock.now) : { events: [] }) });
    const instants = { before: at - 5 * MIN, 'kick-off': at + 2 * MIN, 'mid-game': at + 12 * MIN, final: at + 26 * MIN, after: at + 40 * MIN };
    const cardId = cardOf || `espn:${source}:${game.id}`;
    const seen = [], bad = [];
    try {
        // the server's pace: a collector pass every 30 s (someone is looking), each account asking both answers as it goes
        for (; clock.now <= at + 40 * MIN; clock.now += 30000) {
            await collector.refresh();
            for (const userId of Object.values(ACCOUNTS)) {
                const g = await ask(clock.now, pageDeps(userId, clock.now), answer);
                await new Promise(r => setImmediate(r)); // a background page refresh lands as it would between requests
                const name = Object.entries(instants).find(([, t]) => t === clock.now)?.[0];
                if (!name) continue;
                for (const spoilerFree of [false, true]) {
                    const card = frontCard(league, cardId, userId, clock.now, spoilerFree);
                    assert.ok(card, `${name}: the front has the game's card`);
                    assert.notEqual(card.status, 'unknown', `${name}: the front's snapshot is fresh`);
                    const who = `${league} ${name}, account ${userId}${spoilerFree ? ', scores hidden' : ''}`;
                    const pageScores = g.scores !== undefined ? g.scores : [g.home.score, g.away.score];
                    seen.push(`${who}: front ${card.status} ${card.scores?.join('-') ?? '(none)'}, page ${g.status} ${pageScores?.map(v => v ?? '-').join('-') ?? '(none)'}`);
                    if (g.status !== words[card.status]) bad.push(`${who}: the page says ${g.status}, the front ${card.status}`);
                    if (spoilerFree) assert.equal(card.scores, undefined, `${who}: the front leaves the score out (the page sends it; the client hides it)`);
                    const pageScore = JSON.stringify(pageScores === null ? null : pageScores.map(v => (v === null ? null : String(v))));
                    // before kick-off the NFL page says 0-0 (ESPN's pre-game score); the front shows no score then
                    const frontScore = JSON.stringify(card.scores || (card.status === 'scheduled' && league === 'NFL' ? ['0', '0'] : pageScores === null ? null : [null, null]));
                    if (!spoilerFree && pageScore !== frontScore) bad.push(`${who}: the page's score ${pageScore}, the front's ${frontScore}`);
                    for (const problem of [check(g, card, who)].flat().filter(Boolean)) bad.push(problem);
                }
            }
        }
    } finally {
        collector.stop();
    }
    assert.equal(seen.length, 20);
    return { bad, seen };
}

test('the League page and the front page agree about a game\'s status and score at every moment, with and without a delay', async () => {
    const lp = load('services/sportPageLeague');
    const { bad, seen } = await replay({ league: 'EPL', source: 'soccer/eng.1', at: K, words: C_T, reset: () => lp.reset(),
        serve: (json, url) => (url.includes('soccer/eng.1/scoreboard') ? { ok: true, json } : { ok: false, error: 'HTTP 404' }),
        ask: async (now, deps, answer) => {
            lp.fetcher.get = async url => answer(url);
            const page = await lp.page('EPL', now, { zone: 'UTC', ...deps });
            return page.rounds.flatMap(r => r.games).find(x => x.id === '9917001');
        },
        // #347: the game's `card` is the front card's id, what a recording made from that card carries
        check: (g, card, who) => g.card !== card.id && `${who}: the page's card ${g.card}, the front card's id ${card.id}` });
    assert.deepEqual(bad, [], seen.join('\n'));
});

// C-Q's words: a break is play (`live`), postponed/cancelled are `done`.
const C_Q = { scheduled: 'scheduled', live: 'live', break: 'live', finished: 'done', postponed: 'done', cancelled: 'done' };
test('the NFL page and the front page agree about a game\'s status and score at every moment, with and without a delay', async () => {
    const nfl = load('services/sportPageNFL');
    // the scripted game as an NFL week's scoreboard (the page needs ESPN's season and week)
    // and ESPN's pre-game score of 0 that NFL answers carry
    const asNfl = (json) => ({ ...json, season: { type: 2, year: 2026 }, week: { number: 9 }, leagues: [{ calendar: [] }],
        events: json.events.map(e => ({ ...e, competitions: e.competitions.map(c => ({ ...c, competitors: c.competitors.map(x => ({ score: '0', ...x })) })) })) });
    const { bad, seen } = await replay({ league: 'NFL', source: 'football/nfl', at: K + 24 * 60 * MIN, words: C_Q, reset: () => nfl.reset(),
        serve: (json, url) => (url.endsWith('/football/nfl/scoreboard') ? { ok: true, json: asNfl(json) } : { ok: false, error: 'HTTP 404' }),
        ask: async (now, deps, answer) => {
            nfl.fetcher.get = async url => answer(url);
            const page = await nfl.page(now, { ...deps });
            return page.weeks.flatMap(w => w.games).find(x => x.id === '9917001');
        },
        check: (g, card, who) => g.card !== card.id && `${who}: the page's card ${g.card}, the front card's id ${card.id}` });
    assert.deepEqual(bad, [], seen.join('\n'));
});

// ESPN's status for the scripted game at `now` (as scripts/fake-scores.js words it), for the boards below.
function statusAt(game, now) {
    const state = game.stateAt(now);
    const type = state === 'pre' ? { id: '1', name: 'STATUS_SCHEDULED', state: 'pre', completed: false, description: 'Scheduled', detail: 'Scheduled', shortDetail: 'Scheduled' }
        : state === 'in' ? { id: '2', name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, description: 'In Progress', detail: 'In Progress', shortDetail: 'In Progress' }
            : { id: '3', name: 'STATUS_FINAL', state: 'post', completed: true, description: 'Final', detail: 'Final', shortDetail: 'Final' };
    return { state, status: { clock: 0, displayClock: '0:00', period: state === 'pre' ? 0 : 1, type } };
}
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

// #297: the F1 page took each session's status from its own read (kept 10 min on a race weekend), so it said a session
// was live or over up to 10 minutes after the front page did. The scripted game as an F1 race: one weekend, its race, two
// drivers whose finishing order the page shows (its `top`) only once the race is over.
const C_P = { scheduled: 'scheduled', live: 'live', break: 'live', finished: 'done', postponed: 'done', cancelled: 'done' };
function f1Board(game, now) {
    const { state, status } = statusAt(game, now);
    const date = iso(game.start);
    const drivers = [['901', 'Alex Abel'], ['902', 'Bea Brook']];
    const race = { id: game.id, date, type: { abbreviation: 'R' }, status,
        competitors: drivers.map(([id, name], i) => ({ id, type: 'athlete', order: i + 1, winner: state === 'post' && i === 0, athlete: { displayName: name } })) };
    return {
        leagues: [{ id: '2030', name: 'Formula 1', calendar: [{ label: 'Scripted Grand Prix', startDate: iso(game.start - 2 * 24 * 60 * MIN), endDate: iso(game.start + 120 * MIN),
            event: { $ref: 'http://sports.core.api.espn.com/v2/sports/racing/leagues/f1/events/600' } }] }],
        events: [{ id: '600', name: 'Scripted Grand Prix', shortName: 'Scripted GP', date, endDate: iso(game.start + 120 * MIN),
            circuit: { fullName: 'Scripted Circuit', address: { city: 'Melbourne', country: 'Australia' } }, competitions: [race], status }]
    };
}
test('the F1 page and the front page agree about a session\'s status at every moment, with and without a delay; its result shows only once it is over', async () => {
    const f1 = load('services/sportPageF1');
    const { bad, seen } = await replay({ league: 'F1', source: 'racing/f1', at: K + 2 * 24 * 60 * MIN, words: C_P, reset: () => f1.reset(), board: f1Board,
        // the championship table: the winner's 25 points once the race is over
        serve: (json, url) => (url.includes('/racing/f1/scoreboard') ? { ok: true, json } : url.includes('/racing/f1/standings') ? { ok: true, json: { children: [{ name: 'Driver Standings',
            standings: { entries: [{ athlete: { id: '901', displayName: 'Alex Abel' }, stats: [{ name: 'rank', value: 1 }, { name: 'championshipPts', value: json.events[0].status.type.state === 'post' ? 25 : 0 }] }] } }] } }
            : { ok: false, error: 'HTTP 404' }),
        ask: async (now, deps, answer) => {
            f1.fetcher.get = async url => answer(url);
            const page = await f1.page(now, { ...deps });
            const race = page.weekend.sessions.find(s => s.id === 'race');
            return { status: race.status, scores: null, top: race.top, phase: page.weekend.phase, results: page.results, standings: page.standings, card: race.card };
        },
        check: (g, card, who) => [
            g.status === 'done' && !g.top && `${who}: a finished race without its result`,
            g.status !== 'done' && g.top && `${who}: a race not over with its result (${g.top.driver})`,
            g.status !== 'done' && g.results?.kind === 'race' && g.results.title.includes('Scripted') && `${who}: the results block names a race not over`,
            g.status !== 'done' && g.standings?.drivers?.[0]?.points === 25 && `${who}: the championship table counts a race not over`,
            (g.phase === 'after') !== (g.status === 'done') && `${who}: the weekend's phase ${g.phase} with the race ${g.status}`,
            g.card !== card.id && `${who}: the session's card ${g.card}, the front card's id ${card.id}`
        ] });
    assert.deepEqual(bad, [], seen.join('\n'));
});

// #297: the Events pages (tennis, golf, UFC, IndyCar, NASCAR) took each event's status from their own read (kept 10 min
// while one is on, else up to an hour), so an event turned live or over up to 10 minutes after the front's card. The
// scripted game as an IndyCar race, whose winner the page shows (`lastWinner`) only once it is over. C-V's words are C-R's.
const C_V = { scheduled: 'scheduled', live: 'live', break: 'break', finished: 'finished', postponed: 'postponed', cancelled: 'cancelled' };
function raceBoard(game, now) {
    const { state, status } = statusAt(game, now);
    const date = iso(game.start);
    const drivers = [['801', 'Cara Cole'], ['802', 'Dev Dunn']];
    return {
        leagues: [{ id: '2040', name: 'IndyCar', calendar: [] }],
        events: [{ id: game.id, name: 'Scripted 500', date, status, competitions: [{ id: game.id, date, status,
            venue: { fullName: 'Scripted Speedway', address: { city: 'Indianapolis', country: 'USA' } },
            competitors: drivers.map(([id, name], i) => ({ id, type: 'athlete', order: i + 1, winner: state === 'post' && i === 0, athlete: { displayName: name } })) }] }]
    };
}
test('the Events page and the front page agree about an event\'s status at every moment, with and without a delay; a race\'s winner shows only once it is over', async () => {
    const ev = load('services/sportPageEvents');
    const { bad, seen } = await replay({ league: 'IndyCar', source: 'racing/irl', at: K + 4 * 24 * 60 * MIN, words: C_V, reset: () => ev.reset(), board: raceBoard,
        serve: (json, url) => (url.includes('/racing/irl/scoreboard') ? { ok: true, json } : { ok: false, error: 'HTTP 404' }),
        ask: async (now, deps, answer) => {
            ev.fetcher.get = async url => answer(url);
            const page = await ev.page('IndyCar', now, { event: deps.event });
            const race = page.events.find(e => e.name === 'Scripted 500');
            return { status: race.status, scores: null, lastWinner: page.lastWinner };
        },
        check: (g, card, who) => [
            g.status === 'finished' && g.lastWinner?.race !== 'Scripted 500' && `${who}: a finished race without its winner`,
            g.status !== 'finished' && g.lastWinner?.race === 'Scripted 500' && `${who}: a race not over with its winner`
        ] });
    assert.deepEqual(bad, [], seen.join('\n'));
});

// #297: the Cricket page took each match's status and score from its own read (kept 2 min while its lead is in play,
// 10 min on a match day), so a match turned live or over up to 10 minutes after the front's card, and without the
// account's delay. The scripted game as a T20 international: Australia made 150/7, India chase; its result line ("India
// won by 3 wickets") only once it is over.
const C_S = { scheduled: 'scheduled', live: 'live', break: 'break', finished: 'done', postponed: 'done', cancelled: 'done' };
function cricketBoard(game, now) {
    const { state, status } = statusAt(game, now);
    const minute = Math.max(1, Math.floor((Math.min(now, game.finalAt) - game.start) / MIN) + 1);
    const date = iso(game.start);
    const innings = state === 'pre' ? [null, null] : [{ period: 1, runs: 150, wickets: 7, overs: '20', current: false },
        { period: 2, runs: Math.min(151, minute * 6), wickets: Math.min(7, Math.floor(minute / 4)), overs: `${Math.min(19, minute - 1)}.3`, current: state === 'in' }];
    const side = ([id, name, abbr, homeAway], i) => ({ id, homeAway, order: i + 1, team: { id, displayName: name, name, abbreviation: abbr },
        ...(innings[i] ? { score: `${innings[i].runs}/${innings[i].wickets}`, linescores: [{ isBatting: true, period: innings[i].period, runs: innings[i].runs,
            wickets: innings[i].wickets, overs: innings[i].overs, isCurrent: innings[i].current ? 1 : 0 }] } : {}) });
    const summary = state === 'pre' ? 'Starts at 09:00 local time' : state === 'in' ? `India need ${151 - innings[1].runs} runs` : 'India won by 3 wickets';
    return {
        leagues: [{ id: '1500', name: 'Scripted Series 2026', abbreviation: 'SS', calendar: [iso(Date.parse(date.slice(0, 10)))] }],
        events: [{ id: game.id, date, competitions: [{ id: game.id, date, description: '1st T20I', class: { generalClassCard: 'T20I', internationalClassId: 3 },
            venue: { fullName: 'Scripted Oval', address: { city: 'Adelaide' } }, status: { ...status, summary },
            competitors: [['2', 'Australia', 'AUS', 'home'], ['6', 'India', 'IND', 'away']].map(side) }] }]
    };
}
test('the Cricket page and the front page agree about a match\'s status and score at every moment, with and without a delay; its result shows only once it is over', async () => {
    const cricket = load('services/sportPageCricket');
    const panel = (json) => ({ scores: [json] });
    const { bad, seen } = await replay({ league: 'Cricket', source: 'cricket/1500', at: K + 5 * 24 * 60 * MIN, words: C_S, reset: () => cricket.reset(), board: cricketBoard,
        collect: (json, url) => (url.includes('cricket/scorepanel') ? panel(json) : url.includes('cricket/1500/scoreboard') ? json : { events: [] }),
        serve: (json, url) => (url.includes('cricket/scorepanel') ? { ok: true, json: panel(json) } : url.includes('cricket/1500/scoreboard') ? { ok: true, json } : { ok: false, error: 'HTTP 404' }),
        ask: async (now, deps, answer) => {
            cricket.fetcher.get = async url => answer(url);
            const page = await cricket.page(now, { ...deps, followed: [], leagues: ['Cricket'] });
            const lead = page.lead;
            return { status: lead.status, scores: lead.innings.map(list => (list.length ? `${list.at(-1).runs}/${list.at(-1).wickets}` : null)),
                summary: lead.summary, result: page.series.matches.find(m => m.current)?.result ?? null, seriesStatus: page.series.matches.find(m => m.current)?.status,
                card: lead.card, seriesCard: page.series.matches.find(m => m.current)?.card };
        },
        check: (g, card, who) => [
            g.status === 'done' && !/won/.test(g.summary || '') && `${who}: a finished match without its result line`,
            g.status !== 'done' && /won/.test(`${g.summary} ${g.result}`) && `${who}: a match not over with its result (${g.summary} / ${g.result})`,
            g.seriesStatus !== g.status && `${who}: the series list says ${g.seriesStatus}, the lead ${g.status}`,
            (g.card !== card.id || g.seriesCard !== card.id) && `${who}: the match's card ${g.card} (series list ${g.seriesCard}), the front card's id ${card.id}`
        ] });
    assert.deepEqual(bad, [], seen.join('\n'));
});

test('Cricket: a finish the page\'s read still lacks after renewing keeps the page\'s own status and score, renewing at most every 30 s', async () => {
    const cricket = load('services/sportPageCricket');
    const espn = load('services/sportsScoresEspn');
    cricket.reset();
    const at = K + 6 * 24 * 60 * MIN;
    const game = { ...scriptedGame({ at, guideMin: 10, finalMin: 25 }), id: '9917003' };
    let panels = 0;
    const lagging = cricketBoard(game, at + 20 * MIN);
    cricket.fetcher.get = async url => { if (url.includes('scorepanel')) { panels++; return { ok: true, json: { scores: [lagging] } }; } return url.includes('/scoreboard') ? { ok: true, json: lagging } : { ok: false, error: 'HTTP 404' }; };
    for (let t = at + 20 * MIN; t <= at + 27 * MIN; t += 30000) dashboard.store().ingest(espn.normalize(cricketBoard(game, t), 'Cricket', 'cricket/1500'), t);
    const ask = (now) => cricket.page(now, { ...pageDeps(2, now), followed: ['India'], leagues: ['Cricket'] });
    const first = await ask(at + 27 * MIN);
    assert.equal(first.lead.status, 'live', 'the read says live: shown live');
    assert.deepEqual(first.lead.innings.map(l => l.at(-1)?.runs), [150, 126], 'with the read\'s own score, not the final one');
    assert.equal(first.lead.summary, 'India need 25 runs');
    for (let t = at + 27 * MIN; t < at + 27.5 * MIN; t += 5000) await ask(t);
    assert.equal(panels, 4, 'one read (two day lists), then one renewal (two) in the 30 s however many requests');
});

// Opus review (low): with no innings or score in the collector's snapshot to place, the lead fell back to the read's
// newer innings and the others to its newer scores.
test('Cricket: a snapshot with no score to place and a read newer than the account\'s view: no score from the read', async () => {
    const cricket = load('services/sportPageCricket');
    const espn = load('services/sportsScoresEspn');
    cricket.reset();
    const at = K + 9 * 24 * 60 * MIN;
    const lead = { ...scriptedGame({ at, guideMin: 10, finalMin: 25 }), id: '9917007' };
    const other = { ...scriptedGame({ at, guideMin: 10, finalMin: 25 }), id: '9917008' };
    const otherBoard = (t) => { const b = cricketBoard(other, t); return { ...b, leagues: [{ ...b.leagues[0], id: '1601' }],
        events: b.events.map(e => ({ ...e, competitions: e.competitions.map(c => ({ ...c,
            competitors: c.competitors.map(x => (x.team.displayName === 'India' ? { ...x, team: { ...x.team, id: '7', displayName: 'Pakistan', name: 'Pakistan', abbreviation: 'PAK' } } : x)) })) })) }; };
    const readAt = at + 24 * MIN;
    cricket.fetcher.get = async url => (url.includes('scorepanel') ? { ok: true, json: { scores: [cricketBoard(lead, readAt), otherBoard(readAt)] } }
        : url.includes('cricket/1500/scoreboard') ? { ok: true, json: cricketBoard(lead, readAt) } : url.includes('cricket/1601/scoreboard') ? { ok: true, json: otherBoard(readAt) } : { ok: false, error: 'HTTP 404' });
    const store = dashboard.store();
    const unplaced = (cards) => cards.map(c => ({ ...c, snapshot: { ...c.snapshot, scores: null, situation: null } }));
    for (let t = at + 18 * MIN; t <= at + 24 * MIN; t += 30000) {
        store.ingest(unplaced(espn.normalize(cricketBoard(lead, t), 'Cricket', 'cricket/1500')), t);
        store.ingest(unplaced(espn.normalize(otherBoard(t), 'Cricket', 'cricket/1601')), t);
    }
    const now = at + 24 * MIN;
    const page = await cricket.page(now, { ...pageDeps(1, now), followed: ['India'], leagues: ['Cricket'] });
    assert.equal(page.lead.status, 'live');
    assert.deepEqual(page.lead.innings, [[], []], 'not the read\'s 150/7 and 150/6');
    assert.equal(page.lead.summary, null);
    const o = page.others.find(x => x.id === '9917008');
    assert.deepEqual([o.scores, o.line], [[null, null], null]);
});

// Codex sign-off (high): with the results held back, a golf field still came in ESPN's finishing order (winner first).
test('Events: a golf event over in the page\'s read, still on for a delayed account: no result fields and no finishing order', async () => {
    const ev = load('services/sportPageEvents');
    const individual = load('services/sportIndividual');
    ev.reset();
    const at = K + 10 * 24 * 60 * MIN;
    const golf = { ...scriptedGame({ at, guideMin: 10, finalMin: 25 }), id: '9917009' };
    const board = (t) => {
        const { status } = statusAt(golf, t);
        const date = iso(golf.start);
        const field = [['21', 'Zed Young', '-12'], ['22', 'Abe Ames', '-9'], ['23', 'Mia Moss', '-7']]; // ESPN's order: the finish
        return { leagues: [{ id: '1106', calendar: [] }], events: [{ id: golf.id, name: 'Scripted Classic', date, endDate: date, status: { ...status, period: 4 },
            competitions: [{ id: golf.id, date, endDate: date, status: { ...status, period: 4 },
                competitors: field.map(([id, name, score], i) => ({ id, order: i + 1, score, athlete: { displayName: name }, linescores: [] })) }] }] };
    };
    ev.fetcher.get = async url => (url.includes('golf/pga/scoreboard') ? { ok: true, json: board(at + 26 * MIN) } : { ok: false, error: 'HTTP 404' });
    const store = dashboard.store();
    for (let t = at + 20 * MIN; t <= at + 26 * MIN; t += 30000) store.ingest(individual.normalize(board(t), 'PGA Tour', 'golf/pga'), t);
    const now = at + 26 * MIN;
    const e = (await ev.page('PGA Tour', now, { event: pageDeps(1, now).event })).events.find(x => x.name === 'Scripted Classic');
    assert.equal(e.status, 'live');
    assert.deepEqual(e.leaderboard.map(r => [r.name, r.pos, r.toPar]), [['Abe Ames', null, null], ['Mia Moss', null, null], ['Zed Young', null, null]],
        'by name: the winner is not first');
    const own = (await ev.page('PGA Tour', now, { event: pageDeps(2, now).event })).events.find(x => x.name === 'Scripted Classic');
    assert.deepEqual([own.status, own.leaderboard.map(r => r.name)], ['finished', ['Zed Young', 'Abe Ames', 'Mia Moss']], 'the cached field is untouched');
});

// Opus review (medium): an event over in the page's read but still on for the account kept the read's winners.
test('Events: a UFC night over in the page\'s read, still on for a delayed account: no winner or result from the read', async () => {
    const ev = load('services/sportPageEvents');
    const individual = load('services/sportIndividual');
    ev.reset();
    const at = K + 8 * 24 * 60 * MIN;
    const night = { ...scriptedGame({ at, guideMin: 10, finalMin: 25 }), id: '9917006' };
    const ufc = (t) => {
        const { state, status } = statusAt(night, t);
        const date = iso(night.start);
        return { leagues: [{ id: '3321', calendar: [] }], events: [{ id: night.id, name: 'UFC Scripted Night', date, status,
            competitions: [{ id: '9917061', date, status, type: { abbreviation: 'Lightweight' },
                competitors: [['Eve Ford', 1], ['Gil Hart', 2]].map(([name, order]) => ({ order, winner: state === 'post' && order === 1, athlete: { displayName: name } })) }] }] };
    };
    ev.fetcher.get = async url => (url.includes('mma/ufc/scoreboard') ? { ok: true, json: ufc(at + 26 * MIN) } : { ok: false, error: 'HTTP 404' });
    const store = dashboard.store();
    for (let t = at + 20 * MIN; t <= at + 26 * MIN; t += 30000) store.ingest(individual.normalize(ufc(t), 'UFC', 'mma/ufc'), t);
    const now = at + 26 * MIN;
    const page = await ev.page('UFC', now, { event: pageDeps(1, now).event }); // 90 s: the night is still on
    const e = page.events.find(x => x.name === 'UFC Scripted Night');
    assert.equal(e.status, 'live');
    assert.deepEqual(e.bouts.map(b => [b.result, ...b.fighters.map(f => f.winner)]), [[null, null, null]], 'no winner or result from the read');
    const own = (await ev.page('UFC', now, { event: pageDeps(2, now).event })).events.find(x => x.name === 'UFC Scripted Night');
    assert.deepEqual([own.status, own.bouts[0].fighters.map(f => f.winner)], ['finished', [true, false]], 'over for the account with no delay: its result');
});

// Codex (high) on the Cricket overlay: with both reads live, the page's own summary, crease and the others' lines were
// kept beside the collector's (delayed) score, so "India need 1 run" and a batter's 99 showed beside a score of 120.
test('Cricket: both reads live at different points: no line, crease or declaration from the page\'s read beside the collector\'s score', async () => {
    const cricket = load('services/sportPageCricket');
    const espn = load('services/sportsScoresEspn');
    cricket.reset();
    const at = K + 7 * 24 * 60 * MIN;
    const lead = { ...scriptedGame({ at, guideMin: 10, finalMin: 25 }), id: '9917004' };
    const other = { ...scriptedGame({ at, guideMin: 10, finalMin: 25 }), id: '9917005' };
    const otherBoard = (t) => { const b = cricketBoard(other, t); return { ...b, leagues: [{ ...b.leagues[0], id: '1600' }],
        events: b.events.map(e => ({ ...e, competitions: e.competitions.map(c => ({ ...c, status: { ...c.status, summary: c.status.summary.replace('India', 'Pakistan') },
            competitors: c.competitors.map(x => (x.team.displayName === 'India' ? { ...x, team: { ...x.team, id: '7', displayName: 'Pakistan', name: 'Pakistan', abbreviation: 'PAK' } } : x)) })) })) }; };
    const panelAt = (t) => ({ scores: [cricketBoard(lead, t), otherBoard(t)] });
    const summary = { matchcards: [{ headline: 'Batting', inningsNumber: 2, playerDetails: [{ playerName: 'Ahead Batter', dismissal: 'not out', runs: 99, ballsFaced: 60 }] }] };
    let readAt = at + 24 * MIN; // the page's read: further on than the delayed view
    cricket.fetcher.get = async url => (url.includes('scorepanel') ? { ok: true, json: panelAt(readAt) } : url.includes('/summary') ? { ok: true, json: summary }
        : url.includes('cricket/1500/scoreboard') ? { ok: true, json: cricketBoard(lead, readAt) } : url.includes('cricket/1600/scoreboard') ? { ok: true, json: otherBoard(readAt) } : { ok: false, error: 'HTTP 404' });
    const store = dashboard.store();
    for (let t = at + 18 * MIN; t <= at + 24 * MIN; t += 30000) {
        store.ingest(espn.normalize(cricketBoard(lead, t), 'Cricket', 'cricket/1500'), t);
        store.ingest(espn.normalize(otherBoard(t), 'Cricket', 'cricket/1600'), t);
    }
    const now = at + 24 * MIN;
    const page = await cricket.page(now, { ...pageDeps(1, now), followed: ['India'], leagues: ['Cricket'] }); // 90 s behind
    assert.equal(page.lead.status, 'live');
    assert.deepEqual(page.lead.innings.map(l => l.at(-1)?.runs), [150, 138], 'the delayed score (the read says 150)');
    assert.equal(page.lead.summary, null, `the read's line ("India need 1 run") is held back: ${page.lead.summary}`);
    assert.equal(page.lead.crease, null, 'the read\'s batter on 99 is held back');
    const o = page.others.find(x => x.id === '9917005');
    assert.deepEqual([o.status, o.scores[1], o.line], ['live', '138/5', null], 'an other match: its delayed score, no line from the read');
    // the same point of the match: the read's line and crease stand
    cricket.reset(); readAt = now;
    const instant = await cricket.page(now, { ...pageDeps(2, now), followed: ['India'], leagues: ['Cricket'] });
    assert.deepEqual([instant.lead.summary, instant.lead.crease?.[0]?.runs], ['India need 1 runs', 99]);
    assert.equal(instant.others.find(x => x.id === '9917005').line, 'Pakistan need 1 runs');
});

test('F1: a finish the page\'s read still lacks after renewing keeps the page\'s own status (never over without a result), renewing at most every 30 s', async () => {
    const f1 = load('services/sportPageF1');
    const espn = load('services/sportsScoresEspn');
    f1.reset();
    const at = K + 3 * 24 * 60 * MIN;
    const game = { ...scriptedGame({ at, guideMin: 10, finalMin: 25 }), id: '9917002' };
    let reads = 0;
    // ESPN's weekend answer lags: the page's every read says the race is still on
    f1.fetcher.get = async url => { if (!url.includes('/racing/f1/scoreboard')) return { ok: false, error: 'HTTP 404' }; if (url.includes('dates=')) reads++; return { ok: true, json: f1Board(game, at + 20 * MIN) }; };
    const store = dashboard.store();
    for (let t = at + 20 * MIN; t <= at + 27 * MIN; t += 30000) store.ingest(espn.normalize(f1Board(game, t), 'F1', 'racing/f1'), t);
    const race = page => page.weekend.sessions.find(s => s.id === 'race');
    const first = await f1.page(at + 27 * MIN, pageDeps(2, at + 27 * MIN));
    assert.deepEqual([race(first).status, race(first).top, first.weekend.phase], ['live', null, 'during'], 'the read says live: shown live, no result');
    for (let t = at + 27 * MIN; t < at + 27 * MIN + 30000; t += 5000) await f1.page(t, pageDeps(2, t));
    assert.equal(reads, 2, 'one read, then one renewal in the 30 s however many requests');
    await f1.page(at + 27.5 * MIN, pageDeps(2, at + 27.5 * MIN));
    assert.equal(reads, 3, 'and the next after 30 s');
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); // that renewal lands (still lagging)
    // the read catches up: over, with its result
    f1.fetcher.get = async url => (url.includes('/racing/f1/scoreboard') ? { ok: true, json: f1Board(game, at + 27 * MIN) } : { ok: false, error: 'HTTP 404' });
    await f1.page(at + 28 * MIN, pageDeps(2, at + 28 * MIN)); // renews; this request is answered from the entry at once
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    const caught = await f1.page(at + 28 * MIN, pageDeps(2, at + 28 * MIN));
    assert.deepEqual([race(caught).status, race(caught).top?.driver, caught.weekend.phase], ['done', 'Alex Abel', 'after']);
});

// #328 (owner's call of 16 Nov 2026, option 2): while both the collector's delayed view and the Events page's own read
// said an event was on, the page showed tennis set scores and winners, golf scores to par and UFC results from its own
// read, up to the account's delay ahead of what it should see. The page now keeps its reads and shows, for a delayed
// account, the event's detail from the newest read at least the delay old (blank only until one is that old); with no
// delay, the current read as before. Each read encodes its time: a set score and a score to par of `half-minutes since
// the start`, a UFC bout won 12 minutes in.
const ON_STATUS = { clock: 0, displayClock: '0:00', period: 2, type: { id: '2', name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, description: 'In Progress', detail: 'In Progress', shortDetail: 'In Progress' } };
const OVER_STATUS = { clock: 0, displayClock: '3:10', period: 2, type: { id: '3', name: 'STATUS_FINAL', state: 'post', completed: true, description: 'Final', detail: 'Final', shortDetail: 'Final' } };
const halves = (at, t) => Math.round((t - at) / 30000);
const eventBoards = {
    tennis: (at, t, over = false) => ({ leagues: [{ id: '850', calendar: [] }], events: [{ id: '9918001', name: 'Scripted Open', date: iso(at), endDate: iso(at + 3 * 24 * 60 * MIN), major: false,
        groupings: [{ grouping: { displayName: 'Men\'s Singles' }, competitions: [
            { id: '9918011', date: iso(at), round: { id: 1, displayName: 'Round 1' }, status: over ? OVER_STATUS : ON_STATUS,
                competitors: [['Ann Ash', halves(at, t)], ['Bo Bell', 0]].map(([name, games], i) => ({ order: i + 1, winner: over && i === 0, athlete: { displayName: name }, linescores: [{ value: games }] })) },
            { id: '9918012', date: iso(at), round: { id: 1, displayName: 'Round 1' }, status: over || t >= at + 12 * MIN ? OVER_STATUS : ON_STATUS,
                competitors: [['Cy Cole', 6], ['Di Dunn', 3]].map(([name, games], i) => ({ order: i + 1, winner: (over || t >= at + 12 * MIN) && i === 0, athlete: { displayName: name }, linescores: [{ value: games }] })) }] }] }] }),
    golf: (at, t) => ({ leagues: [{ id: '1106', calendar: [] }], events: [{ id: '9918002', name: 'Scripted Invitational', date: iso(at), endDate: iso(at + 3 * 24 * 60 * MIN), status: ON_STATUS,
        competitions: [{ id: '9918002', date: iso(at), endDate: iso(at + 3 * 24 * 60 * MIN), status: ON_STATUS,
            competitors: [['31', 'Ed Eve', `-${halves(at, t)}`], ['32', 'Flo Fay', 'E']].map(([id, name, score], i) => ({ id, order: i + 1, score, athlete: { displayName: name }, linescores: [] })) }] }] }),
    ufc: (at, t) => ({ leagues: [{ id: '3321', calendar: [] }], events: [{ id: '9918003', name: 'UFC Scripted Fight Night', date: iso(at), status: ON_STATUS,
        competitions: [['9918031', t >= at + 12 * MIN], ['9918032', false]].map(([id, won]) => ({ id, date: iso(at), status: won ? OVER_STATUS : ON_STATUS, type: { abbreviation: 'Lightweight' },
            competitors: [['Gus Gray', 1], ['Hal Hill', 2]].map(([name, order]) => ({ order, winner: won && order === 1, athlete: { displayName: name } })) })) }] })
};
const EVENT_LEAGUES = [['ATP Tour', 'tennis/atp', eventBoards.tennis], ['PGA Tour', 'golf/pga', eventBoards.golf], ['UFC', 'mma/ufc', eventBoards.ufc]];
const detailOf = (e) => ({ round: e.round, matchStatus: e.matches?.map(m => m.status), sets: e.matches?.map(m => m.sets), winners: e.matches?.map(m => m.players.map(p => p.winner)), toPar: e.leaderboard?.map(r => r.toPar),
    order: e.leaderboard?.map(r => r.name), bouts: e.bouts?.map(b => [b.status, b.result, ...b.fighters.map(f => f.winner)]) });
const eventDeps = (userId, now) => { const d = pageDeps(userId, now); return { event: d.event, delay: d.delay }; };

test('#328: Events with a 90 s delay and both views live: tennis sets and winners, golf scores to par and UFC results from the newest read at least 90 s old; with no delay the current read', async () => {
    const ev = load('services/sportPageEvents');
    const individual = load('services/sportIndividual');
    const store = dashboard.store();
    if (!prefsSet) { store.updatePreferences(ACCOUNTS.instant, { revision: 0, scoreDelaySeconds: 0 }); prefsSet = true; }
    ev.reset();
    const at = K + 12 * 24 * 60 * MIN;
    let clock = at, probing = false;
    const builds = new Map(EVENT_LEAGUES.map(([league]) => [league, []])); // league -> the times its reads were made
    ev.fetcher.get = async url => {
        const hit = EVENT_LEAGUES.find(([, source]) => url.includes(`${source}/scoreboard`));
        if (!hit) return { ok: false, error: 'HTTP 404' };
        if (!probing) builds.get(hit[0]).push(clock);
        return { ok: true, json: hit[2](at, clock) };
    };
    const bad = [];
    for (let t = at - 5 * MIN; t <= at + 30 * MIN; t += 30000) {
        for (const [league, source, board] of EVENT_LEAGUES) store.ingest(individual.normalize(board(at, t), league, source), t);
        if (t < at + MIN) continue;
        clock = t;
        for (const [league] of EVENT_LEAGUES) {
            await ev.page(league, t);
            for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res)); // a read this starts lands
            const delayed = (await ev.page(league, t, eventDeps(ACCOUNTS.delayed, t))).events[0];
            const instant = (await ev.page(league, t, eventDeps(ACCOUNTS.instant, t))).events[0];
            const own = (await ev.page(league, t)).events[0]; // the cached read, no account's view
            const at90 = t - 90000;
            if (delayed.status !== 'live' || instant.status !== 'live') bad.push(`${league} +${halves(at, t)}: ${delayed.status}/${instant.status}`);
            assert.deepEqual(detailOf(instant), detailOf(own), `${league} +${halves(at, t)}: no delay, the current read`);
            const r = builds.get(league).filter(b => b <= at90).at(-1);
            if (r === undefined) { // no read 90 s old yet: nothing newer than the delayed view (no detail at all)
                const blank = detailOf(delayed);
                if ([...(blank.matchStatus || []), ...(blank.bouts || []).map(b => b[0])].some(st => st !== 'scheduled') || (blank.round ?? null) !== null)
                    bad.push(`${league} +${halves(at, t)}: a match's or bout's state or the round before any read was 90 s old`);
                if ([blank.sets, blank.toPar].some(l => l && l.flat().some(v => v !== null)) || (blank.bouts || []).some(b => b.slice(1).some(v => v !== null)) ||
                    (blank.winners || []).flat().some(v => v !== null)) bad.push(`${league} +${halves(at, t)}: detail before any read was 90 s old`);
                continue;
            }
            probing = true; clock = r;
            const want = detailOf((await ev.build(league, r)).events[0]); // what that read said
            probing = false; clock = t;
            if (JSON.stringify(detailOf(delayed)) !== JSON.stringify(want)) bad.push(`${league} +${halves(at, t)}: shows ${JSON.stringify(detailOf(delayed))}, the read at +${halves(at, r)} says ${JSON.stringify(want)}`);
        }
    }
    assert.deepEqual(bad, []);
    for (const [league] of EVENT_LEAGUES) assert.ok(builds.get(league).length >= 3, `${league}: the page read more than once (${builds.get(league).length})`);
});

test('#328: the Events page\'s kept reads are bounded: per event at most READS_KEPT, none older than needed for the longest delay, an event over forgotten', async () => {
    const ev = load('services/sportPageEvents');
    const individual = load('services/sportIndividual');
    const store = dashboard.store();
    ev.reset();
    const at = K + 13 * 24 * 60 * MIN;
    let readAt = at, over = false;
    ev.fetcher.get = async url => (url.includes('tennis/atp/scoreboard') ? { ok: true, json: eventBoards.tennis(at, readAt, over) } : { ok: false, error: 'HTTP 404' });
    // the collector already has it over (a lagging read): the page renews its read every 30 s, each read kept
    for (let t = at; t <= at + 20 * MIN; t += 30000) {
        store.ingest(individual.normalize(eventBoards.tennis(at, t, true), 'ATP Tour', 'tennis/atp'), t);
        readAt = t;
        await ev.page('ATP Tour', t, eventDeps(ACCOUNTS.delayed, t));
        for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
        const kept = ev._reads.get('ATP Tour')?.get('espn:tennis/atp:9918001') || [];
        assert.ok(kept.length <= ev.READS_KEPT, `${kept.length} kept`);
        if (kept.length > 1) assert.ok(kept[1].at > kept.at(-1).at - 300000, 'only one read older than the longest delay');
    }
    const kept = ev._reads.get('ATP Tour').get('espn:tennis/atp:9918001');
    assert.ok(kept.length >= 10, `the reads of the last 5 minutes are there (${kept.length})`);
    // the read catches up (over), and once its last read on is READS_MS old a new read forgets the event
    over = true;
    const later = at + 20 * MIN + ev.READS_MS + 30000;
    readAt = later;
    store.ingest(individual.normalize(eventBoards.tennis(at, later, true), 'ATP Tour', 'tennis/atp'), later);
    await ev.page('ATP Tour', later, eventDeps(ACCOUNTS.delayed, later));
    for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
    assert.equal(ev._reads.get('ATP Tour').get('espn:tennis/atp:9918001').at(-1).event.status, 'finished', 'its first read over is kept');
    const last = later + ev.READS_MS + 30000;
    readAt = last;
    store.ingest(individual.normalize(eventBoards.tennis(at, last, true), 'ATP Tour', 'tennis/atp'), last);
    await ev.page('ATP Tour', last, eventDeps(ACCOUNTS.delayed, last));
    for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
    await ev.page('ATP Tour', last + 1000, eventDeps(ACCOUNTS.delayed, last + 1000));
    assert.equal(ev._reads.get('ATP Tour').has('espn:tennis/atp:9918001'), false, 'an event no longer on is forgotten');
});

// #328 (lead's call): with no fresh collector snapshot for the event, the delayed account still saw the page's current
// detail. Its detail is now the delay old there too (the read's own status), and its result shows once the read that
// has it is the delay old; with no delay, the current read.
test('#328: Events with no collector snapshot: a delayed account still sees the status and detail of the newest read at least its delay old, the finish and result once that read has them', async () => {
    const ev = load('services/sportPageEvents');
    const store = dashboard.store();
    if (!prefsSet) { store.updatePreferences(ACCOUNTS.instant, { revision: 0, scoreDelaySeconds: 0 }); prefsSet = true; }
    ev.reset();
    const at = K + 14 * 24 * 60 * MIN, overAt = at + 25 * MIN; // nothing ingested: the collector holds no snapshot
    let clock = at, probing = false;
    const builds = [];
    ev.fetcher.get = async url => {
        if (!url.includes('tennis/atp/scoreboard')) return { ok: false, error: 'HTTP 404' };
        if (!probing) builds.push(clock);
        const json = eventBoards.tennis(at, clock, clock >= overAt);
        json.events[0].id = '9918101'; // an event the collector has never seen
        return { ok: true, json };
    };
    const bad = [];
    for (let t = at + MIN; t <= at + 40 * MIN; t += 30000) {
        clock = t;
        await ev.page('ATP Tour', t);
        for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
        const delayed = (await ev.page('ATP Tour', t, eventDeps(ACCOUNTS.delayed, t))).events[0];
        const instant = (await ev.page('ATP Tour', t, eventDeps(ACCOUNTS.instant, t))).events[0];
        const own = (await ev.page('ATP Tour', t)).events[0];
        assert.deepEqual(detailOf(instant), detailOf(own), `+${halves(at, t)}: no delay, the current read`);
        const r = builds.filter(b => b <= t - 90000).at(-1);
        let want, wantStatus;
        if (r === undefined) {
            want = detailOf({ ...own, matches: own.matches.map(m => ({ ...m, status: 'scheduled', sets: null, players: m.players.map(p => ({ ...p, winner: null })) })) });
            wantStatus = 'live'; // first seen on: never a newer status
        } else { probing = true; clock = r; const then = (await ev.build('ATP Tour', r)).events[0]; want = detailOf(then); wantStatus = then.status; probing = false; clock = t; }
        if (JSON.stringify(detailOf(delayed)) !== JSON.stringify(want)) bad.push(`+${halves(at, t)} (${own.status}): shows ${JSON.stringify(detailOf(delayed))}, want ${JSON.stringify(want)}`);
        if (delayed.status !== wantStatus) bad.push(`+${halves(at, t)}: status ${delayed.status}, the read the delay old says ${wantStatus} (the current one ${own.status})`);
        if (instant.status !== own.status) bad.push(`+${halves(at, t)}: no delay, status ${instant.status} not the read's ${own.status}`);
    }
    assert.deepEqual(bad, []);
    assert.ok(builds.some(b => b >= overAt), 'the page read the event over');
});

// #328 (Codex, high): with no read the delay old yet, the fallback cleared scores and winners but kept each match's and
// bout's own status from the current read, so a delayed account's first look showed a just-finished bout "Finished".
test('#328: Events cold, a bout and a match just finished in the first read: a delayed account sees neither over (nor live) before its delay', async () => {
    const ev = load('services/sportPageEvents');
    const individual = load('services/sportIndividual');
    const store = dashboard.store();
    if (!prefsSet) { store.updatePreferences(ACCOUNTS.instant, { revision: 0, scoreDelaySeconds: 0 }); prefsSet = true; }
    const at = K + 15 * 24 * 60 * MIN, now = at + 13 * MIN; // bout 1 and match 2 finished at +12
    const relabel = (json, id) => { json.events[0].id = id; return json; };
    const boards = { UFC: ['mma/ufc', t => relabel(eventBoards.ufc(at, t), '9918203')], 'ATP Tour': ['tennis/atp', t => relabel(eventBoards.tennis(at, t), '9918201')],
        'PGA Tour': ['golf/pga', t => relabel(eventBoards.golf(at, t), '9918202')] };
    for (const [league, [source, board]] of Object.entries(boards)) {
        ev.reset();
        for (let t = at; t <= now; t += 30000) store.ingest(individual.normalize(board(t), league, source), t); // live throughout
        ev.fetcher.get = async url => (url.includes(`${source}/scoreboard`) ? { ok: true, json: board(now) } : { ok: false, error: 'HTTP 404' });
        for (const [who, gap] of [['first look', 0], ['80 s on', 80000]]) {
            const e = (await ev.page(league, now + gap, eventDeps(ACCOUNTS.delayed, now + gap))).events[0];
            assert.equal(e.status, 'live', `${league} ${who}`);
            assert.deepEqual([...(e.matches || []).map(m => m.status), ...(e.bouts || []).map(b => b.status)].filter(st => st !== 'scheduled'), [], `${league} ${who}: no match or bout over or on`);
            assert.equal(JSON.stringify(e).match(/"winner":true|"result":\{/), null, `${league} ${who}: no winner or result`);
            assert.equal(e.round ?? null, null, `${league} ${who}: no round`);
        }
        const instant = (await ev.page(league, now, eventDeps(ACCOUNTS.instant, now))).events[0];
        if (league !== 'PGA Tour') assert.ok(JSON.stringify(instant).includes('"finished"'), `${league}: no delay, the read's own finished match or bout`);
        const later = now + 91000;
        const after = (await ev.page(league, later, eventDeps(ACCOUNTS.delayed, later))).events[0];
        if (league !== 'PGA Tour') assert.ok(JSON.stringify(after).includes('"finished"'), `${league}: once the read is 90 s old, its finished match or bout`);
    }
});

// #347: a finished card plays its recording by `recordings[].gameId` = the card's id (D-68). A league page's game (C-T,
// C-Q), an F1 session (C-P) and a cricket match (C-S) carry that id as `card` even when the front page no longer has the
// game (its card aged out, or the collector holds nothing for it): the same id the front card had, from ESPN's own ids.
test('#347: with nothing in the collector (no front card), each page\'s `card` is the id the front card has for the same game', async () => {
    const espn = load('services/sportsScoresEspn');
    const at = K + 11 * 24 * 60 * MIN, now = at + 40 * MIN; // the game is over
    const game = { ...scriptedGame({ at, guideMin: 10, finalMin: 25 }), id: '9917011' };
    const frontId = (json, league, source) => espn.normalize(json, league, source).map(c => c.id);
    const noCollector = {}; // what the page routes hand a page with the collector off or holding nothing

    const lp = load('services/sportPageLeague');
    lp.reset();
    lp.fetcher.get = async url => (url.includes('soccer/eng.1/scoreboard') ? { ok: true, json: scoreboard(game, now) } : { ok: false, error: 'HTTP 404' });
    const epl = (await lp.page('EPL', now, { zone: 'UTC', ...noCollector })).rounds.flatMap(r => r.games).find(x => x.id === game.id);
    assert.deepEqual([epl.card], frontId(scoreboard(game, now), 'EPL', 'soccer/eng.1'));

    const nfl = load('services/sportPageNFL');
    nfl.reset();
    const asNfl = (json) => ({ ...json, season: { type: 2, year: 2026 }, week: { number: 9 }, leagues: [{ calendar: [] }] });
    nfl.fetcher.get = async url => (url.endsWith('/football/nfl/scoreboard') ? { ok: true, json: asNfl(scoreboard(game, now)) } : { ok: false, error: 'HTTP 404' });
    const nflGame = (await nfl.page(now, noCollector)).weeks.flatMap(w => w.games).find(x => x.id === game.id);
    assert.deepEqual([nflGame.card], frontId(asNfl(scoreboard(game, now)), 'NFL', 'football/nfl'));

    const f1 = load('services/sportPageF1');
    f1.reset();
    f1.fetcher.get = async url => (url.includes('/racing/f1/scoreboard') ? { ok: true, json: f1Board(game, now) } : { ok: false, error: 'HTTP 404' });
    const race = (await f1.page(now, noCollector)).weekend.sessions.find(s => s.id === 'race');
    assert.deepEqual([race.card], frontId(f1Board(game, now), 'F1', 'racing/f1'));

    const cricket = load('services/sportPageCricket');
    cricket.reset();
    const other = { ...game, id: '9917012' };
    const otherBoard = (t) => { const b = cricketBoard(other, t); return { ...b, leagues: [{ ...b.leagues[0], id: '1602' }] }; };
    cricket.fetcher.get = async url => (url.includes('scorepanel') ? { ok: true, json: { scores: [cricketBoard(game, now), otherBoard(now)] } }
        : url.includes('cricket/1500/scoreboard') ? { ok: true, json: cricketBoard(game, now) } : url.includes('cricket/1602/scoreboard') ? { ok: true, json: otherBoard(now) } : { ok: false, error: 'HTTP 404' });
    const page = await cricket.page(now, { ...noCollector, followed: ['India'], leagues: ['Cricket'] });
    const leadId = frontId(cricketBoard(game, now), 'Cricket', 'cricket/1500');
    assert.deepEqual([page.lead.card], leadId, 'the lead');
    assert.deepEqual(page.series.matches.filter(m => m.id === game.id).map(m => m.card), leadId, 'its series list');
    assert.deepEqual(page.others.filter(o => o.id === other.id).map(o => o.card), frontId(otherBoard(now), 'Cricket', 'cricket/1602'), 'another match');
});

// #347 (Codex, medium): a page's `card` is the collector's id or nothing: built from the competition's id exactly as the
// collector builds it, never from the event's id (which the collector never uses), null when the collector would make none.
test('#347: `card` is the collector\'s id from the competition (not the event), null where the collector makes none', async () => {
    const espn = load('services/sportsScoresEspn');
    const at = K + 12 * 24 * 60 * MIN, now = at + 40 * MIN;
    const game = { ...scriptedGame({ at, guideMin: 10, finalMin: 25 }), id: '9917021' };
    // ESPN's competition id differs from its event's (or is missing, or is one the collector rejects)
    const withComp = (json, compId) => ({ ...json, events: json.events.map(e => ({ ...e, competitions: e.competitions.map(c => {
        const { id, ...rest } = c; return compId === undefined ? rest : { ...rest, id: compId }; }) })) });
    const cases = [['777001', (src) => `espn:${src}:777001`], [undefined, () => null], ['7 7', () => null], [' 777001 ', () => null]];
    for (const [compId, expected] of cases) {
        const collectorIds = (json, league, src) => espn.normalize(json, league, src).map(c => c.id);
        const lp = load('services/sportPageLeague');
        lp.reset();
        const epl = withComp(scoreboard(game, now), compId);
        lp.fetcher.get = async url => (url.includes('soccer/eng.1/scoreboard') ? { ok: true, json: epl } : { ok: false, error: 'HTTP 404' });
        const g = (await lp.page('EPL', now, { zone: 'UTC' })).rounds.flatMap(r => r.games).find(x => x.id === game.id);
        assert.equal(g.card, expected('soccer/eng.1'), `league, competition ${compId}`);
        if (g.card) assert.deepEqual([g.card], collectorIds(epl, 'EPL', 'soccer/eng.1'));

        const nfl = load('services/sportPageNFL');
        nfl.reset();
        const asNfl = { ...withComp(scoreboard(game, now), compId), season: { type: 2, year: 2026 }, week: { number: 9 }, leagues: [{ calendar: [] }] };
        nfl.fetcher.get = async url => (url.endsWith('/football/nfl/scoreboard') ? { ok: true, json: asNfl } : { ok: false, error: 'HTTP 404' });
        const n = (await nfl.page(now, {})).weeks.flatMap(w => w.games).find(x => x.id === game.id);
        assert.equal(n.card, expected('football/nfl'), `NFL, competition ${compId}`);

        const f1 = load('services/sportPageF1');
        f1.reset();
        const board = withComp(f1Board(game, now), compId);
        f1.fetcher.get = async url => (url.includes('/racing/f1/scoreboard') ? { ok: true, json: board } : { ok: false, error: 'HTTP 404' });
        const race = (await f1.page(now, {})).weekend.sessions.find(s => s.id === 'race');
        assert.equal(race.card, expected('racing/f1'), `F1, competition ${compId}`);

        const cricket = load('services/sportPageCricket');
        cricket.reset();
        const ck = withComp(cricketBoard(game, now), compId);
        cricket.fetcher.get = async url => (url.includes('scorepanel') ? { ok: true, json: { scores: [ck] } } : url.includes('cricket/1500/scoreboard') ? { ok: true, json: ck } : { ok: false, error: 'HTTP 404' });
        const page = await cricket.page(now, { followed: [], leagues: ['Cricket'] });
        assert.equal(page.lead.card, expected('cricket/1500'), `cricket, competition ${compId}`);
    }
});
