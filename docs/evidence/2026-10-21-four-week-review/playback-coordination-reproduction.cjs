// Review evidence, asserts observed defects at a104726. No network/provider/database.
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
let sessions = [];
const mod = { exports: {} };
const stubs = {
  './transcodeSession': { getAllSessions: () => sessions, peekSession: () => null },
  '../db/sqlite': { isOpen: () => false },
  './ingest': { idleInPool: () => [], _registry: new Map() }
};
vm.runInNewContext(fs.readFileSync('server/services/streamCoordinator.js', 'utf8'), {
  module: mod, require: name => { if (stubs[name]) return stubs[name]; throw new Error(name); },
  console, process, Date, Map, Set, Number, String, Math
});
const coordinator = mod.exports;
const settings = { maxProviderStreams: 1 };
const recordings = [1, 2].map(id => ({ id, title: `Fixture ${id}`, channel_name: 'Fixture',
  program_end: Date.now() + 60000, providerId: null, ingestKey: 'shared' }));
let verdict = coordinator.requestForViewer({ force: true, activeRecordings: recordings, settings, owner: 'new' });
assert.equal(verdict.allowed, true);
assert.equal(verdict.sacrificed.length, 1);
assert.equal(verdict.release.length, 0);
console.log('REPRODUCED: forced takeover releases only one of two recordings sharing an upstream.');
sessions = [{ id: 'viewer', owner: 'other', ingestKey: 'shared', providerId: null, idleMs: 0, startTime: Date.now() }];
verdict = coordinator.requestForViewer({ force: true, activeRecordings: [recordings[0]], settings, owner: 'new' });
assert.equal(verdict.allowed, true);
assert.equal(verdict.sacrificed.length, 1);
assert.equal(verdict.release.length, 0);
console.log('REPRODUCED: forced takeover of a recording plus shared viewer leaves the viewer upstream active.');
sessions = [];
const lease = coordinator.takeLease(null, 'recording', { schedule: recordings[0] });
coordinator.bindLeaseToRecording(lease, 1);
assert.equal(coordinator.requestForViewer({ activeRecordings: [], settings, owner: 'new' }).allowed, true);
assert.equal(coordinator.requestForViewer({ activeRecordings: [recordings[0]], settings, owner: 'new' }).allowed, false);
console.log('REPRODUCED: stale recordings snapshot misses a recording once its lease is bound.');
