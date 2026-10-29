#!/usr/bin/env node
/**
 * The relay rig (0189, blueprint.md §3; history in docs/archive/STANDBY-BRIEF-2026-10-02.md): in-stream recovery and the hot standby against
 * REAL ffmpeg, with two made-up providers on this machine (test patterns, no network).
 *
 *   node scripts/relay-rig.js                 a cold switch: provider A closes after 16 s
 *   node scripts/relay-rig.js stall           ... A stops sending instead (the 20 s watchdog)
 *   node scripts/relay-rig.js standby stall   a hot standby on B; A stops sending after 40 s
 *   node scripts/relay-rig.js reconnect       shared ingest reconnects on A, renewing the timeline
 *   add "ts" for MPEG-TS segments, "long" for a 110 s run
 *
 * An ffmpeg "player" reads the stream the whole way through; the run prints the playlist every
 * 4 s, the relay's log lines, and the final playlist. Needs ffmpeg and ffprobe on the PATH.
 * Runs in a temporary copy of server/, so the real data folder and cache are never touched.
 */
const fsSync = require('fs');
const os = require('os');
const pathMod = require('path');
const sandbox = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), 'pigtv-relay-rig-'));
const repo = pathMod.resolve(__dirname, '..');
fsSync.cpSync(pathMod.join(process.env.RIG_SOURCE_ROOT || repo, 'server'), pathMod.join(sandbox, 'server'), { recursive: true });
fsSync.cpSync(pathMod.join(repo, 'package.json'), pathMod.join(sandbox, 'package.json'));
fsSync.symlinkSync(pathMod.join(repo, 'node_modules'), pathMod.join(sandbox, 'node_modules'), 'junction');
process.on('exit', () => { try { fsSync.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* left to the OS */ } });
process.env.JWT_SECRET = 'x'.repeat(40);
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const path = pathMod;
process.chdir(sandbox);
const mode = { aDead: false };
const reconnect = process.argv.includes('reconnect');
const flapping = process.argv.includes('flap');
let firstLossAt = null, firstRenewalMs = null;
const sample = process.env.RIG_SAMPLE;
if (process.env.RIG_OUTPUT) {
    const output = pathMod.resolve(process.env.RIG_OUTPUT);
    if (output === repo || output.startsWith(repo + pathMod.sep)) throw new Error('Keep replay media outside the repository');
}
const runSeconds = Number(process.env.RIG_SECONDS || (process.argv.includes('long') ? 110 : 70));
let connections = 0;
const feeds = new Set();
const provider = http.createServer((req, res) => {
    const which = req.url.startsWith('/a') ? 'a' : 'b';
    if (which === 'a' && mode.aDead) { res.statusCode = 503; return res.end(); }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    connections++;
    if (sample) {
        const first = connections === 1;
        const start = first ? 0 : Number(process.env.RIG_RESUME_BYTE);
        const ff = spawn(process.execPath, [pathMod.join(repo, 'docs/reviews/2026-10-27/avsync-repro/pace-pcr.js'), sample, String(start)],
            { env: { ...process.env, HEAD: process.env.HEAD || '8' } });
        const feed = { which, ff, res }; feeds.add(feed);
        let sent = 0;
        const cap = first ? Number(process.env.RIG_CUT_BYTE) : Infinity;
        ff.stdout.on('data', chunk => {
            const n = Math.min(chunk.length, cap - sent);
            if (n > 0) res.write(chunk.subarray(0, n));
            sent += n;
            if (sent === cap) { console.log('SAMPLE cut mid-packet', cap); ff.kill(); res.end(); }
        });
        // Keep the final connection open after the short fixture ends; only the intentional
        // cut is a reconnect. A real provider would keep delivering beyond the capture.
        const end = () => { feeds.delete(feed); ff.kill('SIGKILL'); };
        res.on('close', end);
        return;
    }
    const color = which === 'a' ? 'testsrc2=size=640x360:rate=25' : 'smptebars=size=640x360:rate=25';
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', color, '-f', 'lavfi', '-i', `sine=frequency=${which === 'a' ? 440 : 880}`,
        ...(reconnect && connections > 1 ? ['-output_ts_offset', String(27 + (flapping ? (connections - 2) * 4 : 0))] : []), '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1']);
    ff.stdout.pipe(res);
    const feed = { which, ff, res };
    feeds.add(feed);
    const end = () => { feeds.delete(feed); try { ff.kill('SIGKILL'); } catch (e) {} };
    req.on('close', end); res.on('close', end);
});
(async () => {
    await new Promise(r => provider.listen(0, '127.0.0.1', r));
    const P = `http://127.0.0.1:${provider.address().port}`;
    const routing = require(sandbox + '/server/services/providerRouting');
    const A = { providerId: 1, providerName: 'ProvA', role: 'primary', via: 'primary', url: `${P}/a.ts`, channelKey: 'ch' };
    const B = { providerId: 2, providerName: 'ProvB', role: 'backup', via: 'backup', url: `${P}/b.ts`, channelKey: 'chb' };
    routing.plan = async () => ({ candidates: (mode.aDead ? [B] : [A, B]).filter(c => !routing.isQuarantined(c.providerId, c.channelKey)),
        primaryKey: 'ch', channelName: 'Test', primarySkipped: mode.aDead, providerCount: 2, backupsConfigured: true });
    // Real directory/leases: the old hasFreeConnection stub was bypassed by tryReserveFree.
    const db = require(sandbox + '/server/db');
    await db.sources.create({ type: 'm3u', name: 'ProvA', role: 'primary', url: 'http://a.invalid/list.m3u' });
    await db.sources.create({ type: 'm3u', name: 'ProvB', role: 'backup', url: 'http://b.invalid/list.m3u' });
    const strategy = require(sandbox + '/server/services/playbackStrategy');
    const sessions = require(sandbox + '/server/services/transcodeSession');
    const relay = require(sandbox + '/server/services/streamRelay');
    if (flapping) require(sandbox + '/server/services/ingest').tuning.backoffMs = [100];
    const app = express();
    app.use('/api/transcode', require(sandbox + '/server/routes/transcode'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    // R12: the Settings switches, not environment variables.
    const settings = { ingestReconnectRenewal: reconnect, sharedIngestEnabled: reconnect, ffmpegPath: 'ffmpeg', hwEncoder: 'software', relayEnabled: true, standbyEnabled: process.argv.includes('standby') };
    const caps = { hls: true, fmp4: process.argv.includes('ts') ? false : true };
    const decision = await strategy.resolve({ url: A.url, capabilities: caps, settings, ffprobePath: 'ffprobe', owner: 'device:tv', live: true, providerId: 1, audioEncode: !!sample, ingestSource: reconnect ? require(sandbox + '/server/services/ingest').sourceFor(A, settings) : null });
    console.log('DECISION', decision.strategy, decision.url, decision.videoMode);
    const session = sessions.getSession(decision.sessionId);
    relay.adopt(session, { sourceId: 1, channelId: 'x', capabilities: caps, settings, ffprobePath: 'ffprobe', owner: 'device:tv', audioEncode: !!sample, channelName: 'Test', primaryKey: 'ch', candidate: A });
    const playlistUrl = `${base}/api/transcode/${decision.sessionId}/stream.m3u8`;
    console.log('PLAYLIST', playlistUrl);
    // a consumer reading the stream the whole time
    const out = path.join(sandbox, 'consumer.ts');
    const consumer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', '-live_start_index', '0', '-i', playlistUrl, '-t', String(flapping ? 3600 : runSeconds), '-c', 'copy', out]);
    let clog = ''; consumer.stderr.on('data', d => { clog += d; });
    const killAt = process.argv.includes('standby') ? 40000 : 16000;
    if (!sample && !flapping) setTimeout(() => { console.log('--- KILLING PROVIDER A'); mode.aDead = !reconnect; for (const f of feeds) if (f.which === 'a') { if (process.argv.includes('stall')) { f.ff.stdout.unpipe(f.res); f.ff.kill('SIGSTOP'); } else { f.res.destroy(); } } }, killAt);
    let avplayer = null;
    if (process.env.RIG_AVPLAYER) {
        fsSync.mkdirSync(process.env.RIG_OUTPUT, { recursive: true });
        avplayer = spawn(process.env.RIG_AVPLAYER, [playlistUrl, String(runSeconds)], { env: process.env });
        const playerLog = fsSync.createWriteStream(path.join(process.env.RIG_OUTPUT, 'avplayer.log'));
        avplayer.stdout.pipe(playerLog); avplayer.stderr.pipe(playerLog);
    }
    // Wall-clock bound also covers a consumer waiting at the end of a finite replay.
    const deadline = setTimeout(() => consumer.kill('SIGKILL'), (sample || flapping ? runSeconds : runSeconds + 50) * 1000);
    const t0 = Date.now();
    const flapTimer = flapping ? setInterval(() => {
        if (Date.now() - t0 >= 60000) { clearInterval(flapTimer); return; }
        firstLossAt ??= Date.now();
        for (const f of feeds) if (f.which === 'a') f.res.destroy();
    }, 4000) : null;
    const poll = setInterval(async () => {
        const r = await fetch(playlistUrl); const text = await r.text();
        if (firstLossAt && firstRenewalMs === null && text.includes('#EXT-X-DISCONTINUITY\n')) { firstRenewalMs = Date.now() - firstLossAt; console.log('FLAP first renewal ms', firstRenewalMs); }
        const segs = text.split('\n').filter(l => l && !l.startsWith('#'));
        console.log(`t=${Math.round((Date.now() - t0) / 1000)}s status=${r.status} segs=${segs.length} last=${segs[segs.length - 1]} disc=${(text.match(/DISCONTINUITY\n/g) || []).length} relay=${JSON.stringify(relay.list())}`);
    }, flapping ? 200 : 4000);
    consumer.on('exit', async (code) => {
        clearInterval(poll); clearInterval(flapTimer); clearTimeout(deadline);
        console.log('CONSUMER exit', code); console.log('CONSUMER LOG\n' + clog.split('\n').slice(-25).join('\n'));
        const text = await (await fetch(playlistUrl)).text(); console.log('FINAL PLAYLIST\n' + text);
        if (process.argv.includes('budget')) {
            const current = relay.list()[0];
            const passed = current && current.provider === 'ProvB' && current.switches <= 4 && text.includes('L4-');
            console.log('RENEWAL BUDGET', passed ? 'PASS' : 'FAIL', JSON.stringify(current));
            if (!passed) process.exitCode = 1;
        }
        const seg = text.split('\n').filter(l => /^L1-/.test(l))[0];
        if (seg) { const r = await fetch(`${base}/api/transcode/${decision.sessionId}/${seg}`); console.log('L1 segment fetch', r.status, (await r.arrayBuffer()).byteLength); const i = await fetch(`${base}/api/transcode/${decision.sessionId}/L1-init.mp4`); console.log('L1 init', i.status); }
        if (process.env.RIG_OUTPUT) {
            const dest = process.env.RIG_OUTPUT;
            fsSync.mkdirSync(dest, { recursive: true });
            fsSync.writeFileSync(path.join(dest, 'stream.m3u8'), text);
            const followed = relay.get(decision.sessionId);
            if (followed) for (const leg of followed.legs) {
                if (leg.removed || !fsSync.existsSync(leg.dir)) continue;
                fsSync.cpSync(leg.dir, path.join(dest, `leg${leg.n}`), { recursive: true });
            }
            fsSync.writeFileSync(path.join(dest, 'result.json'), JSON.stringify({ firstRenewalMs, connections, switches: followed?.switches, provider: followed?.active.candidate.providerId, consumerExit: code }));
        }
        if (avplayer) await new Promise(r => avplayer.exitCode !== null ? r() : avplayer.once('exit', r));
        await relay.closeAll(); require(sandbox + '/server/services/ingest').closeAll('rig over'); server.close(); provider.close(); for (const f of feeds) try { f.ff.kill('SIGKILL'); } catch (e) {}
        setTimeout(() => process.exit(0), 500);
    });
})().catch(e => { console.error('FAILED', e); process.exit(1); });
