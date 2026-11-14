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
        } });
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
        } });
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
        serve: (json, url) => (url.includes('/racing/f1/scoreboard') ? { ok: true, json } : { ok: false, error: 'HTTP 404' }),
        ask: async (now, deps, answer) => {
            f1.fetcher.get = async url => answer(url);
            const page = await f1.page(now, { ...deps });
            const race = page.weekend.sessions.find(s => s.id === 'race');
            return { status: race.status, scores: null, top: race.top, phase: page.weekend.phase, results: page.results };
        },
        check: (g, card, who) => [
            g.status === 'done' && !g.top && `${who}: a finished race without its result`,
            g.status !== 'done' && g.top && `${who}: a race not over with its result (${g.top.driver})`,
            g.status !== 'done' && g.results?.kind === 'race' && g.results.title.includes('Scripted') && `${who}: the results block names a race not over`,
            (g.phase === 'after') !== (g.status === 'done') && `${who}: the weekend's phase ${g.phase} with the race ${g.status}`
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
                summary: lead.summary, result: page.series.matches.find(m => m.current)?.result ?? null, seriesStatus: page.series.matches.find(m => m.current)?.status };
        },
        check: (g, card, who) => [
            g.status === 'done' && !/won/.test(g.summary || '') && `${who}: a finished match without its result line`,
            g.status !== 'done' && /won/.test(`${g.summary} ${g.result}`) && `${who}: a match not over with its result (${g.summary} / ${g.result})`,
            g.seriesStatus !== g.status && `${who}: the series list says ${g.seriesStatus}, the lead ${g.status}`
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
