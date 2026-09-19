const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// The stall limit is read when the watchdog module loads, so set it first.
process.env.PIGTV_STALL_TIMEOUT_MS = '300';

// A stand-in ffmpeg: emits one byte of "media", then goes silent while staying
// alive - exactly what ffmpeg does in a reconnect loop after the upstream dies.
// It is a shell script, so this test runs on Linux/macOS (which is where CI and
// the Docker image are).
const skip = process.platform === 'win32' ? 'needs a POSIX shell for the fake ffmpeg' : false;
let sandbox, server, base, remux;

before(async () => {
    if (skip) return;
    // Copy the server so its relative data paths never touch real data (same
    // approach as access.test.js).
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-remux-'));
    fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
    const fakeFfmpeg = path.join(sandbox, 'fake-ffmpeg.sh');
    fs.writeFileSync(fakeFfmpeg, '#!/bin/sh\nprintf x\nexec sleep 300\n', { mode: 0o755 });

    remux = require(path.join(sandbox, 'server/routes/remux'));
    const app = express();
    app.locals.ffmpegPath = fakeFfmpeg; // no ffprobePath: codec detection is skipped
    app.use('/api/remux', remux);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) {
        server.closeAllConnections?.();
        server.close();
    }
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

function withTimeout(promise, ms, what) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test('a remux whose ffmpeg goes silent is ended and leaves the registry', { skip }, async () => {
    const url = encodeURIComponent('http://provider.invalid/live/user/pw/1.ts');
    const response = await fetch(`${base}/api/remux?url=${url}`);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();

    const first = await withTimeout(reader.read(), 5000, 'first byte');
    assert.equal(first.done, false, 'ffmpeg produced output before going quiet');

    const [active] = remux.listActiveRemuxes();
    assert.ok(active, 'the remux is registered while it is running');
    // idleMs is time since media last flowed, not time since the remux began.
    assert.ok(active.idleMs < 1500, `idleMs should be small right after output, got ${active.idleMs}`);

    // Nothing more will ever arrive. The watchdog must end the response.
    for (;;) {
        const { done } = await withTimeout(reader.read(), 10000, 'response to end after stall');
        if (done) break;
    }
    assert.equal(remux.listActiveRemuxes().length, 0, 'a stalled remux must free the provider slot');
});
