const { test } = require('node:test');
const assert = require('node:assert/strict');

// #272 (D-4a, 0548): ESPN's game status is read once (server/services/espnState.js) into one internal vocabulary, and each
// endpoint translates it to its contract's words at its edge. Every raw status the stored ESPN samples carry (test/fixtures)
// and every branch the six old copies had, with what each endpoint answers. Columns:
//   internal | C-O collector (NFL) | C-O collector (a cricket league) | C-V/individual (stateOf) | C-T League | C-Q NFL | C-P F1 | C-S Cricket
// Resolved disagreements (before 0548 -> now), each a rare raw status; no common status (scheduled, live, final) changed:
//   suspended with state post: League done -> break, NFL/F1/Cricket done -> live (stopped, not over: as the "in" variant)
//   postponed or cancelled with state pre: NFL/F1 (and Cricket postponed) scheduled -> done (never at the old time)
//   "HT"/"Delayed" only in shortDetail/detail: collector live -> break (the League page read the detail; now all do)
//   a pause word with no ESPN state ("Stumps", "Delayed"): collector break -> unknown, Cricket break -> scheduled
//   forfeit: League cancelled -> done (ESPN says completed: a result)
//   completed with no state: NFL scheduled -> done
//   cricket pause words on the League page (never a cricket league there): live -> break
const scores = require('../server/services/sportsScoresEspn');
const individual = require('../server/services/sportIndividual');
const league = require('../server/services/sportPageLeague');
const nfl = require('../server/services/sportPageNFL');
const f1 = require('../server/services/sportPageF1');
const cricket = require('../server/services/sportPageCricket');
const { espnState, STATES } = require('../server/services/espnState');

const ROWS = [
    ["scheduled", {"type":{"id":"1","name":"STATUS_SCHEDULED","state":"pre","completed":false,"description":"Scheduled","shortDetail":"10/30 - 2:30 PM EDT"}},
        ["scheduled","scheduled","scheduled","scheduled","scheduled","scheduled","scheduled","scheduled"]],
    ["scheduled (F1 trimmed)", {"type":{"name":"STATUS_SCHEDULED","state":"pre","completed":false}},
        ["scheduled","scheduled","scheduled","scheduled","scheduled","scheduled","scheduled","scheduled"]],
    ["in progress", {"type":{"id":"2","name":"STATUS_IN_PROGRESS","state":"in","completed":false,"description":"In Progress","shortDetail":"Q2 5:21"},"period":2,"displayClock":"5:21"},
        ["live","live","live","live","live","live","live","live"]],
    ["second half", {"type":{"id":"26","name":"STATUS_SECOND_HALF","state":"in","completed":false,"description":"Second Half","shortDetail":"82'"},"period":2,"displayClock":"82'"},
        ["live","live","live","live","live","live","live","live"]],
    ["halftime", {"type":{"id":"23","name":"STATUS_HALFTIME","state":"in","completed":false,"description":"Halftime","shortDetail":"Halftime"},"period":2},
        ["break(Half-time)","break(Half-time)","break(Half-time)","live","break","live","live","live"]],
    ["end of period", {"type":{"id":"22","name":"STATUS_END_PERIOD","state":"in","completed":false,"description":"End of Period","shortDetail":"End of 1st"},"period":1},
        ["break(End of period)","live","live","live","break","live","live","live"]],
    ["delayed (in)", {"type":{"id":"7","name":"STATUS_DELAYED","state":"in","completed":false,"description":"Delayed","shortDetail":"Delayed"}},
        ["break(Delayed)","break(Delayed)","break(Delayed)","live","break","live","live","break(Delayed)"]],
    ["delayed (pre)", {"type":{"id":"7","name":"STATUS_DELAYED","state":"pre","completed":false,"description":"Delayed","shortDetail":"Delayed"}},
        ["scheduled","scheduled","scheduled","scheduled","scheduled","scheduled","scheduled","scheduled"]],
    ["rain delay (in)", {"type":{"id":"17","name":"STATUS_RAIN_DELAY","state":"in","completed":false,"description":"Rain Delay","shortDetail":"Rain Delay"}},
        ["break(Rain delay)","break(Rain delay)","break(Rain delay)","live","break","live","live","break(Rain delay)"]],
    ["suspended (in)", {"type":{"id":"8","name":"STATUS_SUSPENDED","state":"in","completed":false,"description":"Suspended","shortDetail":"Suspended"}},
        ["suspended","suspended","suspended","suspended","break","live","live","live"]],
    ["suspended (post)", {"type":{"id":"8","name":"STATUS_SUSPENDED","state":"post","completed":false,"description":"Suspended","shortDetail":"Suspended"}},
        ["suspended","suspended","suspended","suspended","break","live","live","live"]],
    ["postponed (pre)", {"type":{"id":"6","name":"STATUS_POSTPONED","state":"pre","completed":false,"description":"Postponed","shortDetail":"Postponed"}},
        ["postponed","postponed","postponed","postponed","postponed","done","done","done"]],
    ["canceled (pre)", {"type":{"id":"5","name":"STATUS_CANCELED","state":"pre","completed":false,"description":"Canceled","shortDetail":"Canceled"}},
        ["cancelled","cancelled","cancelled","cancelled","cancelled","done","done","done"]],
    ["HT only in shortDetail", {"type":{"name":"STATUS_IN_PROGRESS","state":"in","completed":false,"description":"In Progress","shortDetail":"HT"}},
        ["break(Half-time)","break(Half-time)","break(Half-time)","live","break","live","live","live"]],
    ["delay only in detail", {"type":{"name":"STATUS_IN_PROGRESS","state":"in","completed":false,"description":"In Progress","detail":"Delayed"}},
        ["break(Delayed)","break(Delayed)","break(Delayed)","live","break","live","live","break(Delayed)"]],
    ["suspend only in detail", {"type":{"name":"STATUS_IN_PROGRESS","state":"in","completed":false,"description":"In Progress","detail":"Play suspended"}},
        ["break(Suspended)","live","live","live","break","live","live","live"]],
    ["quarter time", {"type":{"name":"STATUS_END_PERIOD","state":"in","completed":false,"description":"End of Period","shortDetail":"QT","detail":"Quarter Time"}},
        ["break(Quarter-time)","live","live","live","break","live","live","live"]],
    ["place in detail (Bahrain)", {"type":{"name":"STATUS_IN_PROGRESS","state":"in","completed":false,"description":"In Progress","detail":"Lap 12 - Bahrain"}},
        ["live","live","live","live","live","live","live","live"]],
    ["unknown state + Stumps", {"type":{"description":"Stumps"}},
        ["unknown","unknown","unknown","unknown","scheduled","scheduled","scheduled","scheduled"]],
    ["unknown state + Delayed", {"type":{"description":"Delayed"}},
        ["unknown","unknown","unknown","unknown","scheduled","scheduled","scheduled","scheduled"]],
    ["postponed", {"type":{"id":"6","name":"STATUS_POSTPONED","state":"post","completed":false,"description":"Postponed","shortDetail":"Postponed"}},
        ["postponed","postponed","postponed","postponed","postponed","done","done","done"]],
    ["canceled (fixture)", {"type":{"id":"5","name":"STATUS_CANCELED","state":"post","completed":false,"description":"Canceled","shortDetail":"Canceled"}},
        ["cancelled","cancelled","cancelled","cancelled","cancelled","done","done","done"]],
    ["abandoned", {"type":{"id":"45","name":"STATUS_ABANDONED","state":"post","completed":false,"description":"Abandoned","shortDetail":"Abandoned"}},
        ["cancelled","cancelled","cancelled","cancelled","cancelled","done","done","done"]],
    ["final", {"type":{"id":"3","name":"STATUS_FINAL","state":"post","completed":true,"description":"Final","shortDetail":"Final"}},
        ["finished","finished","finished","finished","done","done","done","done"]],
    ["final OT", {"type":{"id":"3","name":"STATUS_FINAL","state":"post","completed":true,"description":"Final","shortDetail":"Final/OT"}},
        ["finished","finished","finished","finished","done","done","done","done"]],
    ["final AET", {"type":{"id":"45","name":"STATUS_FINAL_AET","state":"post","completed":true,"description":"Final AET","shortDetail":"AET"}},
        ["finished","finished","finished","finished","done","done","done","done"]],
    ["final pens", {"type":{"id":"46","name":"STATUS_FINAL_PEN","state":"post","completed":true,"description":"Final Pens","shortDetail":"FT-Pens"}},
        ["finished","finished","finished","finished","done","done","done","done"]],
    ["full time", {"type":{"id":"28","name":"STATUS_FULL_TIME","state":"post","completed":true,"description":"Full Time","shortDetail":"FT"}},
        ["finished","finished","finished","finished","done","done","done","done"]],
    ["forfeit", {"type":{"id":"4","name":"STATUS_FORFEIT","state":"post","completed":true,"description":"Forfeit","shortDetail":"Forfeit"}},
        ["finished","finished","finished","finished","done","done","done","done"]],
    ["walkover", {"type":{"name":"STATUS_WALKOVER","state":"post","completed":true,"description":"Walkover"}},
        ["finished","finished","finished","finished","done","done","done","done"]],
    ["completed, no state", {"type":{"completed":true}},
        ["finished","finished","finished","finished","done","done","done","done"]],
    ["unknown: no type", {},
        ["unknown","unknown","unknown","unknown","scheduled","scheduled","scheduled","scheduled"]],
    ["unknown: other state", {"type":{"state":"x","description":""}},
        ["unknown","unknown","unknown","unknown","scheduled","scheduled","scheduled","scheduled"]],
    ["cricket live", {"type":{"id":"0","state":"in","description":"Live","shortDetail":"Live"},"summary":"South Aust require 184 runs"},
        ["live","live","live","live","live","live","live","live"]],
    ["cricket stumps", {"type":{"id":"112","state":"in","description":"Stumps","shortDetail":"Live"},"summary":"Day 2 - Stumps"},
        ["break(Stumps)","break(Stumps)","break(Stumps)","live","break","live","live","break(Stumps)"]],
    ["cricket lunch", {"type":{"state":"in","description":"Lunch"}},
        ["break(Lunch)","break(Lunch)","break(Lunch)","live","break","live","live","break(Lunch)"]],
    ["cricket tea", {"type":{"state":"in","description":"Tea"}},
        ["break(Tea)","break(Tea)","break(Tea)","live","break","live","live","break(Tea)"]],
    ["cricket innings break", {"type":{"state":"in","description":"Innings Break"}},
        ["break(Innings break)","break(Innings break)","break(Innings break)","live","break","live","live","break(Innings break)"]],
    ["cricket dinner", {"type":{"state":"in","description":"Dinner"}},
        ["break(Dinner)","live","live","live","break","live","live","break(Dinner)"]],
    ["cricket starts in", {"type":{"state":"in","description":"Live"},"summary":"Starts in 2 hrs 10 mins"},
        ["scheduled","live","scheduled","live","live","live","live","scheduled"]],
    ["cricket result", {"type":{"id":"1","state":"post","description":"Result","shortDetail":"Final"}},
        ["finished","finished","finished","finished","done","done","done","done"]],
    ["cricket no result", {"type":{"state":"post","description":"No result"}},
        ["finished","finished","finished","finished","done","done","done","done"]],
    ["cricket abandoned", {"type":{"state":"post","description":"Match abandoned without a ball bowled"}},
        ["cancelled","cancelled","cancelled","cancelled","cancelled","done","done","done"]],
];

const withLabel = (state, label) => state + (label ? `(${label})` : '');
function collector(status, lg) {
    const json = { events: [{ id: 'e', date: '2026-11-01T00:00Z', competitions: [{ id: '1', date: '2026-11-01T00:00Z', status,
        competitors: [{ score: '1', team: { id: 'a', displayName: 'A' } }, { score: '2', team: { id: 'b', displayName: 'B' } }] }] }] };
    const g = scores.normalize(json, lg, lg === 'IPL' ? 'cricket/8048' : 'football/nfl')[0];
    return withLabel(g.snapshot.state, g.snapshot.breakLabel);
}
const nflGame = (status) => nfl.gameOf({ id: '1', date: '2026-11-01T00:00Z', competitions: [{ status,
    competitors: [{ homeAway: 'home', team: { abbreviation: 'GB' } }, { homeAway: 'away', team: { abbreviation: 'CAR' } }] }] }, new Map(), u => u);
const f1Status = (status) => f1.sessionsOf({ competitions: [{ id: '1', date: '2026-11-01T00:00Z', type: { abbreviation: 'Race' }, status }] })[0].status;

for (const [label, status, want] of ROWS) {
    test(`ESPN status "${label}": one reading, each endpoint's words`, () => {
        const e = espnState(status, { cricket: /cricket/.test(label) });
        assert.ok(STATES.includes(e.state));
        const c = cricket.statusOf({ status });
        assert.deepEqual([withLabel(e.state, e.breakLabel), collector(status, 'NFL'), collector(status, 'IPL'), individual.stateOf(status),
            league.statusOf({ status }, 'soccer'), nflGame(status).status, f1Status(status), withLabel(c.status, c.breakLabel)], want);
    });
}

test('every endpoint emits only its contract\'s words', () => {
    const words = { collector: ['scheduled', 'live', 'break', 'suspended', 'postponed', 'cancelled', 'finished', 'unknown'],
        league: ['scheduled', 'live', 'break', 'done', 'postponed', 'cancelled'], nfl: ['scheduled', 'live', 'done'], f1: ['scheduled', 'live', 'done'],
        cricket: ['scheduled', 'live', 'break', 'done'] };
    for (const [, status] of ROWS) {
        assert.ok(words.collector.includes(collector(status, 'NFL').replace(/\(.*/, '')));
        assert.ok(words.collector.includes(individual.stateOf(status)));
        assert.ok(words.league.includes(league.statusOf({ status }, 'soccer')));
        assert.ok(words.nfl.includes(nflGame(status).status));
        assert.ok(words.f1.includes(f1Status(status)));
        assert.ok(words.cricket.includes(cricket.statusOf({ status }).status));
    }
});

test('baseball: the end of an inning is play, elsewhere the end of a period is a break (League page)', () => {
    const status = { type: { name: 'STATUS_IN_PROGRESS', state: 'in', description: 'In Progress', detail: 'End of 5th' } };
    assert.equal(league.statusOf({ status }, 'baseball'), 'live');
    assert.equal(league.statusOf({ status }, 'basketball'), 'break');
    assert.equal(collector(status, 'NFL'), 'live', 'C-O has no such break label: play');
});

test('C-Q: a postponed or cancelled NFL game says so in its detail, never "Final"', () => {
    const post = (name, description) => ({ type: { name, state: 'post', completed: false, description, shortDetail: description } });
    assert.deepEqual([nflGame(post('STATUS_POSTPONED', 'Postponed')).status, nflGame(post('STATUS_POSTPONED', 'Postponed')).detail], ['done', 'Postponed']);
    assert.deepEqual([nflGame(post('STATUS_CANCELED', 'Canceled')).status, nflGame(post('STATUS_CANCELED', 'Canceled')).detail], ['done', 'Cancelled']);
    assert.equal(nflGame({ type: { name: 'STATUS_FINAL', state: 'post', completed: true, description: 'Final', shortDetail: 'Final/OT' } }).detail, 'Final · OT');
});
