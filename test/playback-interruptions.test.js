const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0188: streams lost mid-play are counted, with how long they took to come back: the baseline
// any change to recovery is judged against (Status -> Interruptions).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-interruptions-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const ix = load('services/playbackInterruptions');

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

const MIN = 60000;
const NOW = Date.parse('2026-10-02T10:00Z');

test('a loss is closed by the same viewer\'s next resolve of the same channel, within 3 minutes', () => {
    ix.reset();
    ix.noteLost({ owner: 'device:tv', channel: 'Fox Footy', provider: 'Strong8K', how: 'stall', providerReason: true, playedSec: 1800 }, NOW);
    ix.noteResolved({ owner: 'device:ipad', channel: 'Fox Footy', provider: 'Dream4K' }, NOW + 10000); // someone else
    ix.noteResolved({ owner: 'device:tv', channel: 'ABC', provider: 'Strong8K' }, NOW + 12000);       // another channel
    assert.equal(ix.summary(NOW + MIN).recovered, 0);
    ix.noteResolved({ owner: 'device:tv', channel: 'Fox Footy', provider: 'Dream4K' }, NOW + 31000);
    const s = ix.summary(NOW + MIN);
    assert.equal(s.count, 1); assert.equal(s.recovered, 1);
    assert.equal(s.medianRecoverSec, 31); assert.equal(s.worstRecoverSec, 31);
    assert.deepEqual(s.recent[0], { at: NOW, channel: 'Fox Footy', provider: 'Strong8K', how: 'stall', providerReason: true,
        playedSec: 1800, recoverSec: 31, recoveredProvider: 'Dream4K' });
    // A later resolve does not move a recovery that is already recorded.
    ix.noteResolved({ owner: 'device:tv', channel: 'Fox Footy', provider: 'Trex' }, NOW + 90000);
    assert.equal(ix.summary(NOW + 2 * MIN).recent[0].recoveredProvider, 'Dream4K');
});

test('a loss nobody came back from in time stays open; the summary is 7 days, the rate per hour watched', () => {
    ix.reset();
    ix.noteLost({ owner: 'device:tv', channel: 'ABC', provider: 'Strong8K', how: 'exit' }, NOW);
    ix.noteResolved({ owner: 'device:tv', channel: 'ABC', provider: 'Strong8K' }, NOW + 4 * MIN); // too late: a new play
    ix.noteLost({ owner: 'device:tv', channel: 'ABC', provider: 'Strong8K', how: 'exit' }, NOW + 5 * MIN);
    ix.noteResolved({ owner: 'device:tv', channel: 'ABC', provider: 'Strong8K' }, NOW + 5 * MIN + 9000);
    ix.noteLost({ owner: 'device:tv', channel: 'Old', provider: 'Strong8K', how: 'stall' }, NOW - 8 * 24 * 60 * MIN);
    let s = ix.summary(NOW + 10 * MIN);
    assert.equal(s.count, 2, 'the 8-day-old one is outside the window');
    assert.equal(s.recovered, 1);
    assert.equal(s.recent.find(r => r.at === NOW).recoverSec, null);
    assert.equal(s.perHour, null, 'no rate under an hour watched');
    sqlite.getDb().prepare(`INSERT INTO channel_health (source_id, channel_key, name, at, ok, watched_sec) VALUES (1, 'k', 'ABC', ?, 1, ?)`).run(NOW, 4 * 3600);
    s = ix.summary(NOW + 10 * MIN);
    assert.equal(s.watchedHours, 4); assert.equal(s.perHour, 0.5);
});

test('nothing stored is a URL, and a bad call never throws', () => {
    ix.reset();
    ix.noteLost({ owner: 'device:tv', channel: 'http://host.invalid/live/u/p/1.ts', provider: 'P', how: 'weird' }, NOW);
    const row = ix.summary(NOW + 1000).recent[0];
    assert.equal(row.channel, '[url removed]'); assert.equal(row.how, 'exit');
    assert.doesNotThrow(() => { ix.noteLost(); ix.noteResolved(); ix.noteResolved({ owner: 'x' }); });
});

test('the resolve route records both ends, and Status shows it', () => {
    const route = fs.readFileSync(path.join(sandbox, 'server/routes/playback.js'), 'utf8');
    assert.match(route, /interruptions\.noteResolved\(\{ owner, channel: channelLabel, provider: providerLabel \}\)/);
    assert.match(route, /played\.once\('lost',[\s\S]{0,200}interruptions\.noteLost\(/);
    assert.match(fs.readFileSync(path.join(sandbox, 'server/routes/status.js'), 'utf8'), /interruptions: require\('\.\.\/services\/playbackInterruptions'\)\.summary\(\)/);
    assert.match(fs.readFileSync(path.join(__dirname, '../public/js/pages/StatusPage.js'), 'utf8'), /this\.section\('Interruptions'/);
});
