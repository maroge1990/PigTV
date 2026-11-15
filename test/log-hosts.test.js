const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #315: after #307 named the provider in three lines, other log lines could still carry its host and port (with the
// login masked by redact()): ffmpeg's command line, its stderr lines and the stderr tails of a stalled or timed-out
// session, and error texts that quote an address. Each family is driven with a URL-bearing input here and its
// output must carry no host and no port. No provider is contacted: the "ffmpeg" is a shell script.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-log-hosts-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const transcodeSession = load('services/transcodeSession');
const syncService = load('services/syncService');
const ingest = load('services/ingest');
const recordingEngine = load('services/recordingEngine');
const { stripUrls } = load('redact');

const HOST = 'hidden-host.invalid';
const PORT = '8123';
const IP = '10.9.8.7';
const STREAM_URL = `http://u:pw@${HOST}:${PORT}/live/u/pw/441360.ts`;
// What ffmpeg and a socket say when a provider cannot be reached: a URL, a bare host name and a bare address.
const LOUD = [`[tcp @ 0x1] Failed to resolve hostname ${HOST}: Name or service not known`,
    `Connection to tcp://${HOST}:${PORT}?timeout=5 failed`, `connect ECONNREFUSED ${IP}:${PORT}`];

before(() => {});
after(() => {
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* temp cleaner */ }
});

async function captured(fn) {
    const lines = [];
    const saved = {};
    for (const k of ['log', 'warn', 'error']) {
        saved[k] = console[k];
        console[k] = (...a) => lines.push(a.map(String).join(' '));
    }
    try { await fn(); } finally { Object.assign(console, saved); }
    return lines;
}
const noAddress = (lines, what) => {
    const text = lines.join('\n');
    for (const bit of [HOST, PORT, IP, '://']) assert.ok(!text.includes(bit), `${what} shows "${bit}":\n${text}`);
};

/** A stand-in ffmpeg: says what ffmpeg says when the provider is unreachable, then waits. */
function fakeFfmpeg() {
    const file = path.join(sandbox, 'fake-ffmpeg.sh');
    fs.writeFileSync(file, `#!/bin/sh\n${LOUD.map(l => `echo "${l}" >&2`).join('\n')}\nexec sleep 30\n`, { mode: 0o755 });
    return file;
}

test('#315: ffmpeg\'s command line, its stderr lines and the stall and timeout tails carry no host or port', async () => {
    const session = await transcodeSession.createSession(STREAM_URL, {
        ffmpegPath: fakeFfmpeg(), live: true, channelName: 'Fox Sports 505', stallMs: 60000, startupMs: 60000
    });
    try {
        const started = await captured(async () => {
            await session.start();
            const until = Date.now() + 5000;
            while (session.stderrTail.length < LOUD.length && Date.now() < until) await new Promise(r => setTimeout(r, 20));
        });
        assert.ok(started.some(l => /Command: /.test(l) && /-i /.test(l)), started.join('\n'));
        assert.equal(started.filter(l => /\[FFmpeg /.test(l)).length, LOUD.length, started.join('\n'));
        noAddress(started, 'the command line and stderr lines');
        assert.ok(started.some(l => /Failed to resolve hostname \[host\]/.test(l)), 'the line itself is kept');

        const timedOut = await captured(() => session.logTimeoutDiagnostics(1000));
        assert.ok(timedOut.filter(l => /Failed to resolve|Connection to|ECONNREFUSED/.test(l)).length >= LOUD.length, timedOut.join('\n'));
        noAddress(timedOut, 'the timeout tail');

        const stalled = await captured(() => session.handleStall());
        assert.ok(stalled.some(l => /ECONNREFUSED/.test(l)), stalled.join('\n'));
        noAddress(stalled, 'the stall tail');
    } finally {
        await transcodeSession.removeSession(session.id).catch(() => {});
    }
});

test('#315: an error text that quotes the address (a refused shared ingest) carries no host or port', async () => {
    const subscribe = ingest.subscribe;
    ingest.subscribe = async () => { throw new Error(`${LOUD.join('; ')} for ${STREAM_URL}`); };
    const session = await transcodeSession.createSession(STREAM_URL, {
        ffmpegPath: fakeFfmpeg(), live: true, stallMs: 60000, startupMs: 60000, ingestSource: { pool: 'p', url: STREAM_URL }
    });
    try {
        const lines = await captured(() => session.start());
        assert.ok(lines.some(l => /Shared ingest not used/.test(l)), lines.join('\n'));
        noAddress(lines, 'the ingest error');
    } finally {
        ingest.subscribe = subscribe;
        await transcodeSession.removeSession(session.id).catch(() => {});
    }
});

test('#315: a failed sync logs and stores no host or port', async () => {
    const source = await db.sources.create({ type: 'm3u', name: 'Household', url: `http://${HOST}:${PORT}/get.php?username=u&password=pw` });
    const m3uParser = load('services/m3uParser');
    const feedCheck = load('services/feedCheck');
    const saved = { stream: m3uParser.fetchAndParseStreaming, feed: feedCheck.fetchFeed };
    const boom = () => { throw new Error(`Failed to fetch ${source.url}: ${LOUD.join('; ')}`); };
    m3uParser.fetchAndParseStreaming = async function* () { boom(); };
    feedCheck.fetchFeed = async () => boom();
    try {
        const lines = await captured(() => syncService.syncSource(source.id));
        assert.ok(lines.some(l => /Failed sync/.test(l)), lines.join('\n'));
        noAddress(lines, 'the sync log');
        const row = sqlite.getDb().prepare(`SELECT error FROM sync_status WHERE source_id = ? AND type = 'all'`).get(source.id);
        assert.ok(row && row.error, 'the failure is still recorded');
        noAddress([row.error], 'the stored sync error');
    } finally {
        Object.assign(m3uParser, { fetchAndParseStreaming: saved.stream });
        feedCheck.fetchFeed = saved.feed;
        await db.sources.delete(source.id);
    }
});

test('#315: why a recording ended (ffmpeg\'s last line) names no host or port', () => {
    const why = recordingEngine._captureEndWhy({ stderrTail: LOUD, inputUrl: STREAM_URL }, 1);
    assert.match(why, /ffmpeg exit 1/);
    noAddress([why], 'the capture end reason');
    for (const line of LOUD) noAddress([stripUrls(line, [STREAM_URL])], 'stripUrls');
    assert.equal(stripUrls(`a ${HOST}:${PORT} b`, [STREAM_URL]), 'a [host] b');
});
