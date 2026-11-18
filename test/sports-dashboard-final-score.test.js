const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

// #343: a later final snapshot of the same game that lacks its scores keeps the last known final score, among the
// snapshots the account's delay already allows; a snapshot not yet eligible is never read; a live one is not bridged.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-final-score-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.PIGTV_DB_BACKUPS = '0';
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const dashboard = load('services/sportsDashboard');
after(() => { process.chdir(os.tmpdir()); try { load('db/sqlite').getDb().close(); } catch {} fs.rmSync(sandbox, { recursive: true, force: true }); });

const NOW = Date.now(), H = 3600000;
const game = (state, scores) => ({ id: 'espn:football/nfl:77', league: 'NFL', title: 'Chiefs v Bills', start: NOW - 5 * H, end: null, session: null, circuit: null,
    competitors: [{ id: '12', name: 'Chiefs', aliases: ['Chiefs'], logo: null }, { id: '2', name: 'Bills', aliases: ['Bills'], logo: null }],
    snapshot: { state, progress: {}, scores, situation: null } });
const scoresAt = (delay) => dashboard.store().view(NOW, delay).selected.get('espn:football/nfl:77')?.data.scores;

test('a final without scores keeps the last known final score; a live snapshot before is not bridged', () => {
    const store = dashboard.store();
    store.ingest([game('live', ['14', '10'])], NOW - 3 * H);
    store.ingest([game('finished', null)], NOW - 2 * H);
    assert.equal(scoresAt(0), null, 'only a live score before it: not carried into a final');
    store.ingest([game('finished', ['24', '21'])], NOW - 90 * 60000);
    store.ingest([game('finished', null)], NOW - 60 * 60000);
    store.ingest([game('finished', null)], NOW - 30 * 60000);
    assert.deepEqual(scoresAt(0), ['24', '21'], 'the newest final has no scores: the last known final score');
});

test('only a score the account\'s delay allows is carried (never from a snapshot not yet eligible)', () => {
    // a delay of 100 minutes: the scored final (90 minutes old) is not yet eligible, so nothing is shown
    assert.equal(scoresAt(100 * 60), null);
    // 45 minutes: the newest eligible final (60 min old) has none; the one before it does
    assert.deepEqual(scoresAt(45 * 60), ['24', '21']);
});
