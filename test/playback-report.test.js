const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse, summarise, report, median, percentile } = require('../scripts/playback-report');

// Lines exactly as the server writes them (the first ones are from a real run of build 0075).
const REAL = `
[Playback] resolve timing: HLS session, probe 4.8s, first segment after 5.0s
[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=9.7s first-picture=9.8s from=user:1
[Player] play-end via transcode(hls, video copy) hls-delivery=on watched=13s stalls=0 from=user:1
[Playback] resolve timing: HLS session, probe cached, first segment after 5.0s
[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=5.0s first-picture=5.0s from=user:1
[Player] play-end via transcode(hls, video copy) hls-delivery=on watched=13s stalls=0 from=user:1
[Playback] resolve timing: remux, probe 4.8s
[Remux] remux_1 first output after 4.8s
[Player] play-start via remux(fmp4) hls-delivery=off resolve=4.8s first-picture=12.6s from=user:1
[Playback] resolve timing: remux, probe cached
[Player] play-start via remux(fmp4) hls-delivery=off resolve=0.0s first-picture=7.8s from=user:1
`.trim();

test('the real lines are understood: two paths, cold and warm told apart', () => {
    const rows = summarise(parse(REAL));
    assert.deepEqual(rows.map(r => r.label), ['HLS session', 'remux'], 'the HLS session row first; an old log\'s remux plays after it');
    const [hls, remux] = rows;
    assert.equal(remux.plays, 2);
    assert.deepEqual([remux.cold.n, remux.cold.median, remux.warm.n, remux.warm.median], [1, 12.6, 1, 7.8]);
    assert.deepEqual([hls.cold.n, hls.cold.median, hls.warm.n, hls.warm.median], [1, 9.8, 1, 5.0]);
    assert.equal(hls.sessions, 2);
    assert.equal(hls.watchedSec, 26);
});

test('a play-start pairs with the resolve line of its own kind, and a resolve is used once', () => {
    const text = `
[Playback] resolve timing: HLS session, probe cached, first segment after 4.0s
[Playback] resolve timing: remux, probe 5.0s
[Player] play-start via remux(fmp4) hls-delivery=off resolve=5.0s first-picture=9.0s from=user:1
[Player] play-start via remux(fmp4) hls-delivery=off resolve=0.0s first-picture=3.0s from=user:1
[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=4.0s first-picture=4.0s from=user:1`;
    const rows = summarise(parse(text));
    const remux = rows.find(r => r.label === 'remux');
    const hls = rows.find(r => r.label === 'HLS session');
    assert.deepEqual([remux.cold.n, remux.warm.n], [1, 0], 'the second remux play had no resolve line of its own: unknown, not guessed');
    assert.equal(hls.warm.n, 1, 'the HLS play pairs with the HLS resolve line, not the remux one');
});

test('docker log timestamps in front of every line (docker logs -t) are ignored', () => {
    const stamped = REAL.split('\n').map(l => `2026-09-20T01:23:45.678901234Z ${l}`).join('\n');
    assert.deepEqual(summarise(parse(stamped)).map(r => r.plays), [2, 2]);
});

test('median and percentile behave, including with nothing to measure', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 10]), 2.5);
    assert.equal(median([]), null);
    assert.equal(median([null, NaN]), null);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
    assert.equal(percentile([5], 90), 5);
    assert.equal(percentile([], 90), null);
});

test('player-reported failures are counted per path, and HLS ones are listed', () => {
    const text = `${REAL}
[Player] media-error HLS_networkError(?) via hls path=/api/transcode/abc/stream.m3u8 msg="manifestLoadError http 404" networkState=2 readyState=0 t=0s buffered=0s from=user:1
[Player] media-error MEDIA_ERR_DECODE(3) via remux path=/api/remux msg="PIPELINE_ERROR_DECODE: Failed to send audio packet" networkState=2 readyState=1 t=25s buffered=24s from=user:1
[Player] start-timeout via remux path=/api/remux waited=15s networkState=2 readyState=0 t=0s buffered=0s from=user:1`;
    const rows = summarise(parse(text));
    const remux = rows.find(r => r.label === 'remux');
    const hls = rows.find(r => r.label === 'HLS session');
    assert.equal(remux.errors.length, 2);
    assert.equal(hls.errors.length, 1);
    const printed = report(parse(text));
    assert.match(printed, /  HLS session: HLS_networkError x1/);
    assert.match(printed, /remux: MEDIA_ERR_DECODE x1, start-timeout x1/);
    assert.match(printed, /Failures in detail\n\s+HLS session: media-error HLS_networkError \/api\/transcode\/abc\/stream\.m3u8 manifestLoadError http 404/);
    assert.match(printed, /HLS session: 2 plays;.*player failures 1/);
});

test('server-side signatures are counted, including an HLS session that never produced a segment', () => {
    const text = `
[Playback] resolve timing: HLS session, probe 4.0s, first segment NOT produced in time
[Remux] remux_4 ffmpeg: Could not write header for output file #0 (incorrect codec parameters ?): Invalid argument
[Remux] remux_5 never produced a byte, killing it
[TranscodeSession abc] output stalled for 20s, treating ffmpeg as stalled
[Remux] Codec probe failed (exit 1)
[Remux] Not starting remux: cannot identify the stream
[Playback] resolve timing: HLS session, probe 3.3s, first segment NOT produced - ffmpeg ended after 0.4s (provider HTTP 4xx), source timing even - DTS kept`;
    const parsed = parse(text);
    assert.equal(parsed.segmentTimeouts, 1);
    assert.equal(parsed.startFailures, 1, '0113: a session that ended before its first segment is counted apart from a timeout');
    const printed = report(parse(`${text}\n[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=4.0s first-picture=4.0s from=user:1`));
    assert.match(printed, /HLS session ended before its first segment \(e\.g\. the provider refused it\): 1/);
    assert.match(printed, /server-side failures: 7/);
    assert.equal(parsed.server['Could not write header'], 1);
    assert.equal(parsed.server['ffmpeg produced no output'], 1);
    assert.equal(parsed.server['stalled ffmpeg killed'], 1);
    assert.equal(parsed.server['codec probe failed'], 1);
    assert.equal(parsed.server['remux refused to start'], 1);
});

test('stalls per hour are only quoted once there is enough watching behind them', () => {
    const short = summarise(parse('[Player] play-end via remux(fmp4) hls-delivery=off watched=300s stalls=1 from=user:1'))[0];
    assert.equal(short.stallsPerHour, null, 'five minutes of watching says nothing about a rate');
    const long = summarise(parse(`
[Player] play-end via remux(fmp4) hls-delivery=off watched=3600s stalls=2 from=user:1
[Player] play-end via remux(fmp4) hls-delivery=off watched=3600s stalls=0 from=user:1`))[0];
    assert.equal(long.stallsPerHour, 1);
    assert.equal(long.longSessions, 2);
});

test('0113: the summary gives plays, first picture cold and warm (median and p90), stalls per hour and failures', () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
        lines.push(`[Playback] resolve timing: HLS session, probe ${i % 2 ? 'cached' : '4.0s'}, first segment after 4.0s`);
        lines.push(`[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=4.0s first-picture=${i % 2 ? 4 + i / 10 : 8 + i / 10}s from=user:1`);
    }
    lines.push('[Player] play-end via transcode(hls, video copy) hls-delivery=on watched=3600s stalls=2 from=user:1');
    lines.push('[Player] start-timeout via hls path=/api/transcode/x/stream.m3u8 waited=15s from=user:1');
    const printed = report(parse(lines.join('\n')));
    assert.match(printed, /\nSummary\n  HLS session: 10 plays; first picture cold median 8\.4s \/ p90 8\.8s \(n=5\), warm median 4\.5s \/ p90 4\.9s \(n=5\); stalls 2\.0\/h; player failures 1\n/);
    assert.match(printed, /server-side failures: 0/);
    assert.match(printed, /the log never names a channel/, 'the by-hand item is stated, not silently dropped');
});

test('0113: nothing is left of the retired HLS-vs-remux trial', () => {
    const printed = report(parse(`${REAL}\n[Player] start-timeout via hls path=/x waited=15s from=user:1`));
    for (const gone of [/opt-in/, /trial criteria/i, /HLS Delivery \(beta\)/, /toggle/, /\[ok\]/, /aim for/]) {
        assert.doesNotMatch(printed, gone);
    }
});

test('a log with none of the lines gets an explanation instead of an empty table', () => {
    const printed = report(parse('[Sync] nothing to see here\n[Remux] Started remux_1'));
    assert.match(printed, /No play-start \/ play-end lines found/);
    assert.doesNotMatch(printed, /toggle|beta/);
});

test('it runs as a command, from a file and from stdin', () => {
    const script = path.join(__dirname, '../scripts/playback-report.js');
    const fromStdin = spawnSync(process.execPath, [script], { input: REAL, encoding: 'utf8' });
    assert.equal(fromStdin.status, 0);
    assert.match(fromStdin.stdout, /HLS session\s+2\s+7\.4/);
    assert.match(fromStdin.stdout, /9\.8 \(n=1\)/);

    const missing = spawnSync(process.execPath, [script, path.join(__dirname, 'no-such-file.log')], { encoding: 'utf8' });
    assert.notEqual(missing.status, 0, 'a wrong file name is an error, not an empty report');
});

// ---- 0084: plays from a paired device (the Apple client) are kept apart from the web player's ----

const APPLE = `
[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=5.0s first-picture=5.4s from=device:7
[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=4.0s first-picture=4.2s from=device:7
[Player] play-end via transcode(hls, video copy) hls-delivery=on watched=3700s stalls=1 from=device:7
[Player] media-error AVFoundationErrorDomain(-11850) via transcode path=/api/transcode/abc/stream.m3u8 msg="Media codes: 404" networkState=? readyState=? t=312s buffered=330s from=device:7`.trim();

test('device plays get their own rows, apart from the web player\'s', () => {
    const rows = summarise(parse(`${REAL}\n${APPLE}`));
    assert.deepEqual(rows.map(r => r.label), ['HLS session', 'HLS session [Apple/device]', 'remux']);
    const web = rows.find(r => r.label === 'HLS session');
    const apple = rows.find(r => r.label === 'HLS session [Apple/device]');
    assert.equal(web.plays, 2, 'the two web HLS plays are untouched by the device lines');
    assert.equal(apple.plays, 2);
    assert.equal(apple.longSessions, 1, 'a device session of an hour or more is counted on the device row');
    assert.equal(web.longSessions, 0);
    assert.equal(web.errors.length, 0, 'and so is the device failure');
    assert.equal(apple.errors.length, 1);
});

test('a device-only log gets its own summary line', () => {
    const printed = report(parse(APPLE));
    assert.match(printed, /  HLS session \[Apple\/device\]: 2 plays;.*player failures 1/);
});

test('a device failure is reported by name on the device row', () => {
    const printed = report(parse(`${REAL}\n${APPLE}`));
    assert.match(printed, /HLS session \[Apple\/device\]: AVFoundationErrorDomain x1/);
});

test('a line with no sender is treated as the web player, as before 0084', () => {
    const rows = summarise(parse('[Player] play-start via remux(fmp4) hls-delivery=off resolve=0.0s first-picture=6.0s'));
    assert.deepEqual(rows.map(r => r.label), ['remux']);
});

test('0114: a play that used a stored channel profile counts as warm (no ffprobe ran)', () => {
    const rows = summarise(parse(`
[Playback] resolve timing: HLS session, probe profile (age 3d), first segment after 4.4s, source timing even - DTS kept
[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=4.4s first-picture=4.6s from=device:7`));
    assert.deepEqual([rows[0].warm.n, rows[0].cold.n, rows[0].warm.median], [1, 0, 4.6]);
});
