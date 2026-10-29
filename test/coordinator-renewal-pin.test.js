const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Reset review (30 Oct) of 0314: when a renewal budget runs out, the relay retires the primary's
// session but keeps its renewal pin, and the pin alone holds the primary's provider connection
// open while backups are tried. No session or recording names that ingest and it is not idle, so
// admission did not count it: with a limit of one, a sibling feed or another device was admitted
// beside it. The real streamCoordinator with its registries stubbed, as in coordinator-own-stream.
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
const sub = (purpose, owner = 'device:tv') => ({ info: { purpose, owner } });
const pinned = (key, subs = [sub('renewal-pin')]) => ({ id: 7, closed: false, key, pool: 'primary', state: 'live', providerId: null,
    startedAt: Date.now(), lastByteAt: Date.now(), subs: new Set(subs), waiters: 0 });
const settings = { maxProviderStreams: 1 };
const released = (verdict) => JSON.parse(JSON.stringify((verdict.release || []).map(r => r.stream.ingestKey || r.stream.id).sort()));

test('a connection held only by a renewal pin is counted: another device is not admitted beside it', () => {
    const c = loadCoordinator([], [pinned('fox')]);
    assert.equal(c.canAdmitWithoutDisturbing({ owner: 'device:ipad', settings, joinIngest: 'sibling' }), false);
    assert.equal(c.requestForViewer({ owner: 'device:ipad', settings }).allowed, false);
});

test('the relay\'s own next leg on another feed of that pool replaces the pinned connection', () => {
    const c = loadCoordinator([], [pinned('fox')]);
    const verdict = c.requestForViewer({ owner: 'device:tv', settings, joinIngest: 'sibling' });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(released(verdict), ['fox'], 'one connection: the pinned one must go before the sibling opens');
});

test('falling back onto the pinned primary joins it and costs nothing', () => {
    const c = loadCoordinator([], [pinned('fox')]);
    const verdict = c.requestForViewer({ owner: 'device:tv', settings, joinIngest: 'fox' });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.joining, true);
    assert.deepEqual(released(verdict), []);
});

test('a pinned connection whose feed went quiet is reclaimable as idle, like any other', () => {
    const c = loadCoordinator([], [{ ...pinned('fox'), lastByteAt: Date.now() - 120000 }]);
    const verdict = c.requestForViewer({ owner: 'device:ipad', settings });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.release[0].cause, 'idle');
});

test('an ingest a session also reads is still one connection, not two', () => {
    const c = loadCoordinator([{ id: 'live', owner: 'device:tv', providerId: null, idleMs: 0, startTime: Date.now(), ingestKey: 'fox' }],
        [pinned('fox', [sub('renewal-pin'), sub('viewer')])]);
    assert.equal(c.requestForViewer({ owner: 'device:ipad', settings: { maxProviderStreams: 2 } }).allowed, true);
});
