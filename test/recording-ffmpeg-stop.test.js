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
