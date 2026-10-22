const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
const context = { window: {}, console, document: { getElementById: () => null } };
vm.runInNewContext(fs.readFileSync('public/js/components/VideoPlayer.js', 'utf8'), context);
const p = Object.create(context.window.VideoPlayer.prototype);
const noop = () => {};
const cls = { add: noop, remove: noop };
Object.assign(p, {
  needsAudioEncode: () => false, clearStartWatch: noop, reportPlayEnd: noop, stopTranscodeSession: noop,
  stopConflictWatch: noop, updateTranscodeStatus: noop, beginPlayMeasurement: noop,
  video: { pause: noop, load: noop }, overlay: { classList: cls }, nowPlaying: { classList: cls }
});
let finish, played = [];
p.resolvePlayback = () => new Promise(resolve => { finish = resolve; });
p.playDecision = async (decision, channel) => { played.push(channel.id); };
(async () => {
  const pending = p.play({ id: 'A' }, 'fixture');
  p.stop();
  finish({ url: '/fixture' });
  await pending;
  assert.deepEqual(played, ['A']);
  console.log('REPRODUCED: stop while resolving still applies the completed play decision.');
})().catch(e => { console.error(e); process.exitCode = 1; });
