const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Copy the server so its relative data paths never touch real data (same
// approach as access.test.js; a junction so it works on Windows without admin).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-codecs-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const remux = require(path.join(sandbox, 'server/routes/remux'));
const probe = require(path.join(sandbox, 'server/services/streamProbe'));

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

const URL_ = 'http://provider.invalid/live/u/p/1.ts';
const AAC = { video: 'h264', audio: 'aac' };

// Injectable stand-ins that record what happened.
function deps({ detectResults = [], cached = null } = {}) {
    const calls = { detect: 0, waits: [] };
    return {
        calls,
        options: {
            detect: async () => { calls.detect++; return detectResults.length ? detectResults.shift() : null; },
            cached: () => cached,
            wait: async (ms) => { calls.waits.push(ms); },
            retryDelayMs: 1500
        }
    };
}

test('without ffprobe there is nothing to identify, and nothing is attempted', async () => {
    const { calls, options } = deps({ detectResults: [AAC] });
    const found = await remux.identifyCodecs(URL_, undefined, 'ua', options);
    assert.equal(found.codecs, null);
    assert.equal(calls.detect, 0);
});

test('what /api/playback/resolve already learned is reused, with no new connection to the provider', async () => {
    const { calls, options } = deps({ cached: AAC, detectResults: [{ video: 'x', audio: 'y' }] });
    const found = await remux.identifyCodecs(URL_, 'ffprobe', 'ua', options);
    assert.deepEqual(found.codecs, AAC);
    assert.equal(found.source, 'playback probe');
    assert.equal(calls.detect, 0, 'no ffprobe: a provider that allows one connection is not asked for another');
});

test('a probe that works first time is used as it is', async () => {
    const { calls, options } = deps({ detectResults: [AAC] });
    const found = await remux.identifyCodecs(URL_, 'ffprobe', 'ua', options);
    assert.deepEqual(found.codecs, AAC);
    assert.equal(calls.detect, 1);
    assert.deepEqual(calls.waits, [], 'no pause when nothing failed');
});

test('a probe the provider refused is retried after a pause, and playback proceeds', async () => {
    const { calls, options } = deps({ detectResults: [null, AAC] });
    const found = await remux.identifyCodecs(URL_, 'ffprobe', 'ua', options);
    assert.deepEqual(found.codecs, AAC);
    assert.equal(found.source, 'ffprobe (retry)');
    assert.equal(calls.detect, 2);
    assert.deepEqual(calls.waits, [1500], 'waits for the provider to let go of the previous connection');
});

test('two failures give up with a reason, rather than guessing a codec', async () => {
    const { calls, options } = deps({ detectResults: [null, null] });
    const found = await remux.identifyCodecs(URL_, 'ffprobe', 'ua', options);
    assert.equal(found.codecs, null);
    assert.match(found.why, /could not read/);
    assert.equal(calls.detect, 2, 'one retry, not a loop');
});

test('findCachedCodecs matches on the URL under any capability set, and ignores stale or empty entries', () => {
    probe.probeCache.clear();
    const now = Date.now();
    probe.probeCache.set(`${URL_}|chrome|hls,fmp4`, { result: AAC, timestamp: now });
    assert.deepEqual(probe.findCachedCodecs(URL_), AAC);

    // A different URL that merely starts the same must not match.
    assert.equal(probe.findCachedCodecs(`${URL_}2`), null);
    assert.equal(probe.findCachedCodecs('http://provider.invalid/live/u/p/2.ts'), null);

    probe.probeCache.clear();
    probe.probeCache.set(`${URL_}|chrome|hls`, { result: AAC, timestamp: now - probe.CACHE_TTL - 1 });
    assert.equal(probe.findCachedCodecs(URL_), null, 'an expired probe is not trusted');

    probe.probeCache.clear();
    probe.probeCache.set(`${URL_}|chrome|hls`, { result: { video: null, audio: null }, timestamp: now });
    assert.equal(probe.findCachedCodecs(URL_), null, 'an entry that found no codecs tells us nothing');
});
