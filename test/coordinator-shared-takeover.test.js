const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// PB2 (22 Oct review, 0233): the coordinator counts a shared upstream once, and a forced takeover
// of it must name every one of its readers. The real streamCoordinator with its session registry,
// database and ingest stubbed (no network, no database), as in the review's reproduction - whose
// assertions described the defect; these describe the fix. ingest-playback.test.js checks the
// same through the route with real subscribers and provider connections.
function loadCoordinator(sessions) {
    const mod = { exports: {} };
    const stubs = {
        './transcodeSession': { getAllSessions: () => sessions, peekSession: () => null },
        '../db/sqlite': { isOpen: () => false },
        './ingest': { idleInPool: () => [], _registry: new Map() }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/services/streamCoordinator.js'), 'utf8'), {
        module: mod, require: (name) => { if (stubs[name]) return stubs[name]; throw new Error(name); },
        console: { log() {}, warn() {}, error() {} }, process, Date, Map, Set, Number, String, Math
    });
    return mod.exports;
}
const settings = { maxProviderStreams: 1 };
const plain = (v) => JSON.parse(JSON.stringify(v)); // out of the vm's realm, for deepEqual
const rec = (id) => ({ id, title: `Fixture ${id}`, channel_name: 'Fixture', program_end: Date.now() + 60000, providerId: null, ingestKey: 'shared' });

test('PB2: two recordings on one ingest - the takeover stops both and closes the ingest', () => {
    const c = loadCoordinator([]);
    const verdict = c.requestForViewer({ force: true, activeRecordings: [rec(1), rec(2)], settings, owner: 'new' });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(plain(verdict.sacrificed).sort(), [1, 2]);
    assert.deepEqual(plain(verdict.closeIngests), ['shared']);
});

test('PB2: a recording and a viewer on one ingest - the viewer is released with it', () => {
    const c = loadCoordinator([{ id: 'viewer', owner: 'other', ingestKey: 'shared', providerId: null, idleMs: 0, startTime: Date.now() }]);
    const verdict = c.requestForViewer({ force: true, activeRecordings: [rec(1)], settings, owner: 'new' });
    assert.equal(verdict.allowed, true);
    assert.deepEqual(plain(verdict.sacrificed), [1]);
    assert.deepEqual(plain(verdict.release.map(r => r.stream.id)), ['viewer']);
    assert.deepEqual(plain(verdict.closeIngests), ['shared']);
});

test('PB2: still counted once - without force it is one recording conflict, and nothing is released', () => {
    const c = loadCoordinator([]);
    const verdict = c.requestForViewer({ force: false, activeRecordings: [rec(1), rec(2)], settings: { maxProviderStreams: 2 }, owner: 'new' });
    assert.equal(verdict.allowed, true, 'two recordings on one ingest use one of two connections');
    const asked = c.requestForViewer({ force: false, activeRecordings: [rec(1), rec(2)], settings, owner: 'new' });
    assert.equal(asked.allowed, false);
    assert.equal(asked.conflict.type, 'recording-in-progress');
    assert.equal(asked.sacrificed, undefined);
});
