const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// FR-11 (27 Oct): a device watches one thing. Its new play replaced its earlier stream only when the
// provider's limit forced it; a play that joined the shared ingest the earlier stream was reading
// (or found a free connection) left that stream running, ffmpeg and relay with it, until the idle
// sweep. The real streamCoordinator with its registries stubbed, as in coordinator-shared-takeover.
function loadCoordinator(sessions, ingests = []) {
    const mod = { exports: {} };
    const stubs = {
        './transcodeSession': { getAllSessions: () => sessions, peekSession: () => null },
        '../db/sqlite': { isOpen: () => false },
        './ingest': { idleInPool: () => [], _registry: new Map(ingests.map((i, n) => [n, i])) }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/services/streamCoordinator.js'), 'utf8'), {
        module: mod, require: (name) => { if (stubs[name]) return stubs[name]; throw new Error(name); },
        console: { log() {}, warn() {}, error() {} }, process, Date, Map, Set, Number, String, Math
    });
    return mod.exports;
}
const session = (id, extra = {}) => ({ id, owner: 'device:tv', providerId: null, idleMs: 0, startTime: Date.now(), ...extra });
const live = (key) => ({ closed: false, key, pool: 'primary', state: 'live' });
const released = (verdict) => JSON.parse(JSON.stringify(verdict.release.map(r => r.stream.id).sort())); // out of the vm's realm

test('FR-11: a play joining the ingest its own earlier stream reads ends that stream', () => {
    const c = loadCoordinator([session('old', { ingestKey: 'nbc' })], [live('nbc')]);
    const verdict = c.requestForViewer({ settings: { maxProviderStreams: 1 }, owner: 'device:tv', joinIngest: 'nbc' });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.joining, true);
    assert.deepEqual(released(verdict), ['old']);
    assert.equal(verdict.release[0].cause, 'replacement');
    assert.equal(verdict.release[0].stream.type, 'transcode', 'the session alone: the ingest it reads is the one being joined');
});

test('FR-11: with a free connection, the device\'s earlier stream still goes', () => {
    const c = loadCoordinator([session('old')]);
    const verdict = c.requestForViewer({ settings: { maxProviderStreams: 2 }, owner: 'device:tv' });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(released(verdict), ['old']);
});

test('FR-11: somebody else\'s stream, a standby, a warm session and the adopted one are left alone', () => {
    const c = loadCoordinator([
        session('theirs', { owner: 'device:ipad' }),
        session('standby', { standby: true }),
        session('warm', { warm: true }),
        session('adopted', { warm: true })
    ]);
    const verdict = c.requestForViewer({ settings: { maxProviderStreams: 5 }, owner: 'device:tv', adopt: 'adopted' });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(released(verdict), []);
});

test('FR-11: a plain login (one owner in every browser it is open in) keeps its other stream when there is room', () => {
    const c = loadCoordinator([session('tab1', { owner: 'user:1' })]);
    const verdict = c.requestForViewer({ settings: { maxProviderStreams: 2 }, owner: 'user:1' });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(released(verdict), []);
});

test('FR-11: an unidentified caller replaces nothing', () => {
    const c = loadCoordinator([session('old', { owner: null })]);
    const verdict = c.requestForViewer({ settings: { maxProviderStreams: 2 }, owner: null });
    assert.deepEqual(released(verdict), []);
});

test('FR-11: when the limit already takes the earlier stream, it is released once', () => {
    const c = loadCoordinator([session('old')]);
    const verdict = c.requestForViewer({ settings: { maxProviderStreams: 1 }, owner: 'device:tv' });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(released(verdict), ['old']);
});
