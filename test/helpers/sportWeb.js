// #323: the web Sport pages' test fixtures: the real modules in a vm with the fake DOM, and a C-R answer with distinctive
// scores and score-revealing details in every place they can appear (for the hidden-scores rule, #192).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { loadUi } = require('./webUi');
const { createDocument } = require('./fakeDom');
const root = path.join(__dirname, '..', '..');
const js = (f) => fs.readFileSync(path.join(root, 'public/js', f), 'utf8');

function browser(api = {}) {
    const document = createDocument();
    // The page's refresh timers must not keep the test process alive.
    const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
    const context = vm.createContext({ console: { ...console, log() {}, warn() {}, error() {} }, document, setTimeout: later, clearTimeout, Date,
        localStorage: { getItem: () => 'tok' }, API: api });
    context.window = context;
    loadUi(context);
    vm.runInContext(js('pages/SportView.js'), context);
    vm.runInContext(js('pages/SportsPage.js'), context);
    return { context, document, V: context.window.SportView };
}

const NOW = Date.UTC(2026, 10, 14, 9, 0);
const team = (name, logo = null) => ({ id: name, name, logo });
/** A front answer with distinctive scores and score-revealing details in every place they can appear. */
function answer(extra = {}) {
    const g = (o) => ({ league: 'EPL', sport: 'Football', title: 'A v B', start: NOW - 3600000, end: null, session: null, circuit: null, format: null,
        status: 'live', freshness: 'fresh', progress: {}, availability: 'matched', broadcastStatus: 'on-tv', canWatch: true, events: [],
        channels: [{ sourceId: 1, stableId: 's1', id: '101', name: 'Stan Sport 1', start: NOW - 3600000, end: NOW + 3600000 }], followed: false, ...o });
    const games = [
        g({ id: 'ars', title: 'Arsenal v Chelsea', competitors: [team('Arsenal', '/api/logo/ars'), team('Chelsea')], scores: ['47', '31'],
            progress: { period: 2, clock: "67'" }, followed: true, followedSides: [0] }),
        g({ id: 'pen', title: 'Liverpool v Man City', competitors: [team('Liverpool'), team('Man City')], scores: ['58', '59'],
            progress: { period: 5, clock: "120'" } }),
        g({ id: 'avl', title: 'Aston Villa v Brentford', competitors: [team('Aston Villa'), team('Brentford')], scores: ['63', '64'],
            status: 'finished', channels: [] }),
        g({ id: 'nfl', league: 'NFL', sport: 'American football', title: 'Packers v Bears', competitors: [team('Packers'), team('Bears')],
            scores: ['71', '72'], progress: { period: 2, clock: '5:00' }, situation: { down: 3, distance: 8, yardLine: 33 } }),
        g({ id: 'cri', league: 'Cricket', sport: 'Cricket', title: 'Australia v South Africa', competitors: [team('Australia'), team('South Africa')],
            scores: ['287/6', '312'], format: 'test', progress: { day: 'Day 2' } }),
        g({ id: 'nxt', title: 'Newcastle v Tottenham', competitors: [team('Newcastle'), team('Tottenham')], status: 'scheduled', start: NOW + 7200000,
            channels: [{ sourceId: 1, stableId: 's2', id: '102', name: 'Stan Sport 2', start: NOW + 7200000, end: NOW + 14400000 }],
            recording: { scheduleId: 4, status: 'scheduled', ruleId: null } }),
        g({ id: 'f1', league: 'F1', sport: 'Motorsport', title: 'Las Vegas Grand Prix', competitors: [], session: 'Race', status: 'scheduled',
            start: NOW + 86400000, channels: [], followed: true })
    ];
    return {
        now: NOW, timezone: 'UTC', spoilerFree: false, scores: 'fresh',
        sports: [{ league: 'EPL', sport: 'Football', live: 2, next: null, line: 'live' }, { league: 'NFL', sport: 'American football', live: 1, next: null, line: 'live' },
            { league: 'Cricket', sport: 'Cricket', live: 1, next: null, line: 'live' }, { league: 'F1', sport: 'Motorsport', live: 0, next: { gameId: 'f1', start: NOW + 86400000 }, line: 'next' },
            { league: 'AFL', sport: 'Australian football', live: 0, next: null, line: 'quiet' }],
        follows: [{ league: 'EPL', sport: 'Football', name: 'Arsenal', logo: '/api/logo/ars', state: 'live', gameId: 'ars', start: NOW - 3600000 },
            { league: 'F1', sport: 'Motorsport', name: 'Oscar Piastri', logo: null, state: 'next', gameId: 'f1', start: NOW + 86400000 },
            { league: 'AFL', sport: 'Australian football', name: 'Collingwood', logo: null, state: 'none', gameId: null, start: null }],
        hero: { reason: 'follow-live', followIndex: 0, gameId: 'ars' },
        rails: [{ league: 'EPL', sport: 'Football', gameIds: ['ars', 'pen', 'avl', 'nxt'] }, { league: 'NFL', sport: 'American football', gameIds: ['nfl'] },
            { league: 'Cricket', sport: 'Cricket', gameIds: ['cri'] }, { league: 'F1', sport: 'Motorsport', gameIds: ['f1'] }],
        games, ...extra
    };
}
const SCORE_TEXT = ['47', '31', '58', '59', '63', '64', '71', '72', '287/6', '312'];
const REVEALING = /Penalties|Pens\b|Down 3|8 yards|Yard line|47–31/;
/**
 * No score anywhere in the markup, text or attribute: each score as a token of its own (">47<", "47–31", "aria-label=\"… 47\""),
 * never inside a clock ("10:47 pm", which the page's real "Couldn't update … at" time can be).
 */
function assertNoScores(html, where) {
    for (const s of SCORE_TEXT) {
        const token = new RegExp(`(^|[\\s"'>–(])${s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[\\s"'<–),])`);
        assert.doesNotMatch(html, token, `${where}: "${s}" is in the markup`);
    }
    assert.doesNotMatch(html, REVEALING, `${where}: a score-revealing word`);
}
const ctx = (V, front, o = {}) => ({ front, hide: false, now: NOW, labels: { EPL: 'Premier League' }, phone: false, heroId: 'ars', followIndex: 0, ...o });

/** A page controller on a fresh root, wired as the app wires it. */
function page(b, app = {}) {
    const p = new b.context.window.SportsPage(app);
    p.root = b.document.createElement('div'); b.document.body.appendChild(p.root); p.wire(p.root);
    return p;
}

module.exports = { browser, answer, NOW, team, SCORE_TEXT, REVEALING, assertNoScores, ctx, page, js, root };
