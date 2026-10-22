// No network, ffmpeg, files, provider or database; exercises the actual class.
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
let completeSubscribe, spawned = 0, killed = 0;
const waiting = new Promise(resolve => { completeSubscribe = resolve; });
const child = new EventEmitter();
Object.assign(child, { stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, kill: () => { killed++; } });
const fakeFs = { promises: { mkdir: async () => {}, rm: async () => {} } };
const stubs = {
  './streamUrl': { isStreamUrl: () => true }, child_process: { spawn: () => { spawned++; return child; } },
  fs: fakeFs, '../redact': { redact: () => '[fixture]' }, './hwDetect': {}, './stallWatchdog': {},
  './streamProbe': {}, './playbackErrors': { MESSAGES: {} },
  './ingest': { subscribe: () => waiting, keyOf: () => 'fixture' }
};
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync('server/services/transcodeSession.js', 'utf8'), {
  module: mod, require: name => stubs[name] || require(name), process, console: { log(){}, warn(){}, error(){} },
  setTimeout, clearTimeout, setInterval, clearInterval, Buffer
});
(async () => {
  const session = new mod.exports.TranscodeSession('http://fixture.invalid/live', { ingestSource: { pool: 'fixture', url: 'http://fixture.invalid/live' } });
  session.buildFFmpegArgs = () => [];
  session.startWatchdog = session.stopWatchdog = session.stopPictureCheck = () => {};
  const start = session.start();
  await Promise.resolve(); // start is now waiting for ingest.subscribe
  await session.cleanup();
  const feed = new EventEmitter();
  feed.pipe = () => {};
  completeSubscribe(feed);
  await start;
  await session.stop();
  assert.equal(session._cleanedUp, true);
  assert.equal(session.stopRequested, true);
  assert.equal(session.status, 'running');
  assert.equal(spawned, 1);
  assert.equal(killed, 0);
  console.log('REPRODUCED: canceled/cleaned session spawns after ingest resolves; subsequent stop does not kill it.');
})().catch(error => { console.error(error); process.exitCode = 1; });
