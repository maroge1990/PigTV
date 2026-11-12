const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// C-2 (#274 item 5): the coordinator counted the running recordings from a list each caller handed in, with a
// default of none, so a caller that forgot it saw a recording's connection as free. Now the coordinator reads them
// from one source, which the recording engine registers when it loads. Here a real schedule row is recording on
// the provider's only connection and the coordinator is asked the way a forgetful caller asked: with no list.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-recsource-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const { scheduled } = load('db/recordingsDb');
const recordingEngine = load('services/recordingEngine'); // registers its listActive with the coordinator
const coordinator = load('services/streamCoordinator');

const S = { maxProviderStreams: 1, viewerIdleTimeoutSec: 60 };
let source, row;

before(async () => {
    source = await db.sources.create({ type: 'xtream', name: 'Strong8K', url: 'http://strong.invalid', username: 'u', password: 'p' });
    row = scheduled.create({ title: 'The News', description: null, source_id: source.id, channel_item_id: '505', channel_name: 'ABC',
        channel_logo: null, program_start: Date.now() - 60000, program_end: Date.now() + 3600000, pre_buffer_min: 0, post_buffer_min: 0,
        created_by: 1, created_at: Date.now() });
    scheduled.setStatus(row.id, 'recording');
    assert.ok(recordingEngine.listActive().some(r => r.id === row.id), 'the engine lists it as recording');
});

afterEach(() => { coordinator._leases.clear(); });

after(() => {
    try { sqlite.getDb().close(); } catch { /* never opened */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('C-2: a caller that hands in no recordings still sees the recording on the only connection', async () => {
    assert.equal(coordinator.hasFreeConnection(null, S), false, 'hasFreeConnection: not free');
    assert.equal(coordinator.tryReserveFree(null, 'standby', S), null, 'tryReserveFree: no lease');
    assert.equal(coordinator.tryReserveFree(null, 'warm', S, { owner: 'device:tv' }), null, 'tryReserveFree with options: no lease');
    assert.equal(await coordinator.reserveTakingWarm(null, 'standby', S), null, 'reserveTakingWarm: no lease');
    assert.equal(coordinator.canAdmitWithoutDisturbing({ owner: 'device:tv', settings: S }), false, 'canAdmitWithoutDisturbing: not admitted');
    const verdict = coordinator.requestForViewer({ owner: 'device:tv', settings: S });
    assert.equal(verdict.allowed, false, 'requestForViewer: not admitted');
    assert.equal(verdict.conflict.type, 'recording-in-progress');
    assert.equal(verdict.conflict.scheduleId, row.id);
    assert.equal(coordinator.canRecordFreely(null, S), false, 'canRecordFreely: a recording already holds it');
    assert.equal(coordinator.listLeases().length, 0, 'nothing was leased');
});

test('C-2: recordings that cannot be read are not counted as none: the decision throws', () => {
    coordinator.setRecordingsSource(() => { throw new Error('SQLITE_BUSY: database is locked'); });
    try {
        for (const [name, fn] of [
            ['hasFreeConnection', () => coordinator.hasFreeConnection(null, { ...S, maxProviderStreams: 5 })],
            ['tryReserveFree', () => coordinator.tryReserveFree(null, 'warm', { ...S, maxProviderStreams: 5 })],
            ['canAdmitWithoutDisturbing', () => coordinator.canAdmitWithoutDisturbing({ owner: 'device:tv', settings: { ...S, maxProviderStreams: 5 } })],
            ['canRecordFreely', () => coordinator.canRecordFreely(null, { ...S, maxProviderStreams: 5 })]
        ]) assert.throws(fn, /database is locked/, `${name} throws`);
        assert.equal(coordinator.listLeases().length, 0, 'and leases nothing');
    } finally { coordinator.setRecordingsSource(recordingEngine.listActive); }
});

test('C-2: with no source registered (the coordinator loaded alone) recordings count as none, as before', () => {
    coordinator.setRecordingsSource(null);
    try {
        assert.equal(coordinator.hasFreeConnection(null, S), true);
    } finally { coordinator.setRecordingsSource(recordingEngine.listActive); }
    assert.equal(coordinator.hasFreeConnection(null, S), false, 'the engine\'s list again');
});
