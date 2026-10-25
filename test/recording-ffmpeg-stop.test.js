const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0264 (Codex review of 0261): a deletion stops a recording's ffmpeg through its writer's signal, and
// waits for it. The runner must kill the real process and resolve only once it has exited, so
// nothing it writes outlives the deletion. A stand-in ffmpeg (a node script) that writes its output
// and never stops by itself.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-ffmpeg-stop-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const media = require('../server/services/recordingMedia');

const fake = path.join(dir, 'ffmpeg-fake');
fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('fs');
const out = process.argv[process.argv.length - 1];
setInterval(() => fs.appendFileSync(out, 'x'), 5);
`);
fs.chmodSync(fake, 0o755);

test('0264: an aborted ffmpeg is killed, and the run resolves only after the process has exited', async () => {
    media.setToolPaths({ ffmpegPath: fake });
    const out = path.join(dir, 'out.partial');
    const controller = new AbortController();
    const run = media.runFfmpegCollectingTail(['-i', 'in.ts', out], { signal: controller.signal });
    for (let i = 0; i < 400 && !fs.existsSync(out); i++) await new Promise(r => setTimeout(r, 25)); // it has started writing
    assert.ok(fs.existsSync(out), 'the stand-in ffmpeg started');
    controller.abort();
    const result = await run;
    assert.match(result.tail.join('\n'), /Stopped: the recording was deleted/);
    fs.unlinkSync(out);
    await new Promise(r => setTimeout(r, 200)); // forty of its writes, had it still been running
    assert.equal(fs.existsSync(out), false, 'nothing is written once the run has resolved');
});

test('0264: an ffmpeg asked for after the abort is never started', async () => {
    media.setToolPaths({ ffmpegPath: fake });
    const out = path.join(dir, 'never.partial');
    const controller = new AbortController();
    controller.abort();
    const result = await media.runFfmpegCollectingTail(['-i', 'in.ts', out], { signal: controller.signal });
    assert.equal(result.code, -1);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(fs.existsSync(out), false);
});

// 0265 (Codex re-review of 0264): the checks run inside a writer - ffprobe and the audio decode check -
// stop with it too, or a deletion waits on a check that never ends (a share that stopped answering).
const hang = path.join(dir, 'tool-hangs');
fs.writeFileSync(hang, `#!${process.execPath}
require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'pid-'))} + process.pid, '');
setInterval(() => {}, 1000);
`);
fs.chmodSync(hang, 0o755);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const started = []; // killed afterwards whatever happened, so a failing run leaves nothing running
after(() => { for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });

for (const [label, run] of [
    ['the audio decode check', (signal) => media.nativeTools.audioErrors('in.ts', { signal })],
    ['the length probe', (signal) => media.nativeTools.duration('in.ts', { signal })],
    ['the codec probe', (signal) => media.nativeTools.codecs('in.ts', { signal })]
]) {
    test(`0265: ${label} is killed when its writer stops, and answers only once the process has exited`, async () => {
        media.setToolPaths({ ffmpegPath: hang, ffprobePath: hang });
        for (const f of fs.readdirSync(dir).filter(n => n.startsWith('pid-'))) fs.unlinkSync(path.join(dir, f));
        const controller = new AbortController();
        const answer = run(controller.signal);
        let pid = null;
        for (let i = 0; i < 400 && pid === null; i++) {
            const f = fs.readdirSync(dir).find(n => n.startsWith('pid-'));
            if (f) pid = Number(f.slice(4)); else await new Promise(r => setTimeout(r, 25));
        }
        if (pid) started.push(pid);
        assert.ok(pid, 'the stand-in started');
        controller.abort();
        const outcome = await Promise.race([answer.then(v => ({ v })), new Promise(r => setTimeout(() => r('still running'), 10000))]);
        assert.notEqual(outcome, 'still running', 'it answered once stopped');
        assert.ok(outcome.v === null || (outcome.v && outcome.v.video === null), 'no result from a stopped check');
        assert.equal(alive(pid), false, 'its process has exited');
    });
}
