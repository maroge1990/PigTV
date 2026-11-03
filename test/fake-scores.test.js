const { test } = require('node:test');
const assert = require('node:assert/strict');

// scripts/fake-scores.js (docs/FAKE-PROVIDER.md › Scripted game): the fake ESPN score source that makes #217's T3 (a
// recording that rolls on past its guide end while the game is in play and stops at final + post-padding) runnable on the
// rig. Its answers go through the server's OWN readers: the score collector's normalize, the fixtures' parser, the
// recording's game join and its stop rule, so the fake is proven to steer the real code, not a copy of it.
process.env.PIGTV_SPORT_FIXTURES = '0'; // nothing here leaves the machine
const espn = require('../server/services/sportsScoresEspn');
const fixturesEspn = require('../server/services/sportsFixturesEspn');
const guideEnd = require('../server/services/recordingGuideEnd');
const overrun = require('../server/services/sportOverrun');
const { GAME, scriptedGame, scoreboard, createFakeScores } = require('../scripts/fake-scores');
const { programmesFor, parseArgs } = require('../scripts/fake-provider');

const MIN = 60000;
const K = Date.parse('2026-11-04T09:00:00Z');
const read = (game, now) => espn.normalize(scoreboard(game, now), GAME.league, GAME.path);

test('the scripted game is scheduled, then live past its guide slot, then final, as the collector reads it', () => {
    const game = scriptedGame({ at: K, guideMin: 10, finalMin: 25 });
    const at = (t) => read(game, t);
    assert.equal(at(K - MIN).length, 1);
    const [before] = at(K - MIN);
    assert.equal(before.id, `espn:soccer/eng.1:${GAME.id}`);
    assert.equal(before.start, K);
    assert.deepEqual(before.competitors.map(c => c.name), ['Everton', 'Fulham']);
    assert.equal(before.snapshot.state, 'scheduled');
    assert.equal(at(K + 5 * MIN)[0].snapshot.state, 'live');
    assert.equal(at(K + 20 * MIN)[0].snapshot.state, 'live', 'still live after the guide end (the overrun)');
    assert.deepEqual(at(K + 20 * MIN)[0].snapshot.scores, ['1', '1']);
    assert.equal(at(K + 25 * MIN)[0].snapshot.state, 'finished');
    // the fixtures side reads the same answer (its teams, its state)
    const [rec] = fixturesEspn.recordsFromScoreboard(scoreboard(game, K + 5 * MIN));
    assert.equal(rec.state, 'in');
    assert.deepEqual(rec.teams.map(t => t.displayName), ['Everton', 'Fulham']);
});

test('a recording of its guide programme links to it and rolls on while live, then stops at final + post-padding', () => {
    const game = scriptedGame({ at: K, guideMin: 10, finalMin: 25 });
    const prog = game.programme();
    const schedule = { id: 1, title: prog.title, program_start: prog.start, program_end: prog.stop, post_buffer_min: 2, status: 'recording' };
    const catalog = read(game, K - MIN);
    assert.equal(guideEnd.gameFor(schedule, catalog)?.id, catalog[0].id, 'the guide title joins the scripted game');
    const floor = guideEnd.floorOf(schedule);
    assert.equal(floor, K + 12 * MIN);
    const latest = (now, finishedAt = null) => ({ observedAt: now, finishedAt, data: read(game, now)[0].snapshot });
    // live 3 minutes past the floor: rolled on OVERRUN_STEP from now
    const now = floor + 3 * MIN;
    assert.equal(overrun.recordingEnd({ floor, postMs: 2 * MIN, now, latest: latest(now), gameStart: K }), now + overrun.OVERRUN_STEP);
    // final, first seen at the scripted final: stops 2 minutes (the post-padding) after it
    const done = game.finalAt + 20000;
    assert.equal(overrun.recordingEnd({ floor, postMs: 2 * MIN, now: done, latest: latest(done, game.finalAt), gameStart: K }), game.finalAt + 2 * MIN);
});

test('the fake provider puts the same game in ITV1\'s guide with --game-at, and nowhere else', () => {
    assert.equal(parseArgs(['--game-at', '2026-11-04T09:00:00Z', '--game-guide-min', '10']).gameAt, '2026-11-04T09:00:00Z');
    const prog = scriptedGame({ at: K, guideMin: 10 }).programme();
    const itv = programmesFor('itv1.uk', K - 3 * 60 * MIN, K - 60 * MIN, K + 60 * MIN, [prog]);
    const hit = itv.filter(p => p.title === GAME.title);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].start, K);
    assert.equal(hit[0].stop, K + 10 * MIN);
    assert.ok(itv.every((p, i) => i === 0 || p.start === itv[i - 1].stop), 'the filler around it still tiles the hour');
    assert.equal(programmesFor('bbcone.uk', K, K - 60 * MIN, K + 60 * MIN, [prog]).filter(p => p.title === GAME.title).length, 0);
    assert.equal(programmesFor('itv1.uk', K, K - 60 * MIN, K + 60 * MIN).filter(p => p.title === GAME.title).length, 0, 'not without --game-at');
});

test('over HTTP it answers the collector\'s paths, other leagues empty, and /fake/game moves the final', async () => {
    const fake = createFakeScores({ at: Date.now() - 5 * MIN, guideMin: 10, finalMin: 60, quiet: true });
    const base = await fake.listen(0);
    try {
        const get = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json() }; };
        const board = await get('/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20261104&limit=1000');
        assert.equal(board.status, 200);
        assert.equal(espn.normalize(board.body, 'EPL', 'soccer/eng.1')[0].snapshot.state, 'live');
        assert.deepEqual((await get('/apis/site/v2/sports/football/nfl/scoreboard')).body.events, []);
        assert.equal((await get('/apis/site/v2/sports/soccer/eng.1/teams')).body.sports[0].leagues[0].teams.length, 2);
        assert.deepEqual((await get('/apis/site/v2/sports/cricket/scorepanel')).body, { scores: [] });
        assert.equal((await get('/apis/v2/sports/soccer/eng.1/standings')).status, 404);
        assert.equal((await get('/fake/game?final=nonsense', { method: 'POST' })).status, 400);
        const moved = await get('/fake/game?final=now', { method: 'POST' });
        assert.equal(moved.body.state, 'post');
        const after = await get('/apis/site/v2/sports/soccer/eng.1/scoreboard');
        assert.equal(espn.normalize(after.body, 'EPL', 'soccer/eng.1')[0].snapshot.state, 'finished');
    } finally {
        await fake.close();
    }
});
