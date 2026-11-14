const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #307: the log lines for a session start, a failed probe, a guide fetch and a stalled session named the provider
// by its address (host and port, credentials masked). They name the provider now, never any part of the address.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-provider-logs-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);
const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const transcodeSession = load('services/transcodeSession');
const playbackStrategy = load('services/playbackStrategy');
const syncService = load('services/syncService');

const HOST = 'hidden-host.invalid';
const STREAM_URL = `http://u:pw@${HOST}:8123/live/u/pw/441360.ts`;
let source;

before(async () => {
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: `http://${HOST}:8123/get.php` });
});
after(() => {
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* temp cleaner */ }
});

/** Everything console.log/warn/error print while fn runs. */
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
const noAddress = (lines) => {
    const text = lines.join('\n');
    for (const bit of [HOST, '8123', '://', 'pw']) assert.ok(!text.includes(bit), `the log shows "${bit}": ${text}`);
};

test('session start and a stalled session name the provider, not its address', async () => {
    const session = await transcodeSession.createSession(STREAM_URL, {
        ffmpegPath: process.execPath, live: true, providerId: source.id, channelName: 'Fox Sports 505', stallMs: 60000, startupMs: 60000
    });
    session.buildFFmpegArgs = () => ['-e', 'setTimeout(() => {}, 30000)'];
    try {
        const lines = await captured(() => session.start());
        noAddress(lines);
        assert.ok(lines.some(l => /Starting session/.test(l) && l.includes('Household') && l.includes('Fox Sports 505')), lines.join('\n'));
        const stalled = await captured(async () => { await session.handleStall(); });
        noAddress(stalled);
        assert.ok(stalled.some(l => /stalled/.test(l) && l.includes('Household')), stalled.join('\n'));
    } finally {
        await transcodeSession.removeSession(session.id).catch(() => {});
    }
});

test('a failed probe names the provider, not its address', async () => {
    const fake = path.join(sandbox, 'fake-ffprobe.sh');
    fs.writeFileSync(fake, '#!/bin/sh\necho "Connection refused: $@" >&2\nexit 1\n', { mode: 0o755 });
    const lines = await captured(async () => {
        await assert.rejects(playbackStrategy.resolve({ url: STREAM_URL, settings: {}, ffprobePath: fake, providerId: source.id, live: true }));
    });
    noAddress(lines);
    assert.ok(lines.some(l => /probe failed/.test(l) && l.includes('Household')), lines.join('\n'));
});

test('a guide fetch names the provider, not its address', async () => {
    const lines = await captured(async () => {
        try { await syncService.syncEpgFromUrl(source.id, `http://${HOST}:8123/xmltv.php?username=u&password=pw`); } catch { /* unreachable on purpose */ }
    });
    const mine = lines.filter(l => /Fetching/.test(l));
    assert.ok(mine.length, lines.join('\n'));
    noAddress(mine);
    assert.ok(mine.some(l => l.includes('Household')), mine.join('\n'));
});
