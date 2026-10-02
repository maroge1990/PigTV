#!/usr/bin/env node
/**
 * The relay rig (0189, docs/STANDBY-BRIEF.md): in-stream recovery and the hot standby against
 * REAL ffmpeg, with two made-up providers on this machine (test patterns, no network).
 *
 *   node scripts/relay-rig.js                 a cold switch: provider A closes after 16 s
 *   node scripts/relay-rig.js stall           ... A stops sending instead (the 20 s watchdog)
 *   node scripts/relay-rig.js standby stall   a hot standby on B; A stops sending after 40 s
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
fsSync.cpSync(pathMod.join(repo, 'server'), pathMod.join(sandbox, 'server'), { recursive: true });
fsSync.cpSync(pathMod.join(repo, 'package.json'), pathMod.join(sandbox, 'package.json'));
fsSync.symlinkSync(pathMod.join(repo, 'node_modules'), pathMod.join(sandbox, 'node_modules'), 'junction');
process.on('exit', () => { try { fsSync.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* left to the OS */ } });
process.env.PIGTV_RELAY = '1';
if (process.argv.includes('standby')) process.env.PIGTV_STANDBY = '1';
process.env.JWT_SECRET = 'x'.repeat(40);
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const path = pathMod;
process.chdir(sandbox);
const mode = { aDead: false };
const feeds = new Set();
const provider = http.createServer((req, res) => {
    const which = req.url.startsWith('/a') ? 'a' : 'b';
    if (which === 'a' && mode.aDead) { res.statusCode = 503; return res.end(); }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    const color = which === 'a' ? 'testsrc2=size=640x360:rate=25' : 'smptebars=size=640x360:rate=25';
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', color, '-f', 'lavfi', '-i', `sine=frequency=${which === 'a' ? 440 : 880}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1']);
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
    routing.plan = async () => ({ candidates: mode.aDead ? [B] : [A, B], primaryKey: 'ch', channelName: 'Test', primarySkipped: mode.aDead, providerCount: 2, backupsConfigured: true });
    const coordinator = require(sandbox + '/server/services/streamCoordinator');
    if (process.argv.includes('standby')) { coordinator.samePool = (a, b) => a === b; coordinator.hasFreeConnection = (id) => !coordinator.activeStreams().some(s => s.providerId === id); }
    const strategy = require(sandbox + '/server/services/playbackStrategy');
    const sessions = require(sandbox + '/server/services/transcodeSession');
    const relay = require(sandbox + '/server/services/streamRelay');
    const app = express();
    app.use('/api/transcode', require(sandbox + '/server/routes/transcode'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const settings = { ffmpegPath: 'ffmpeg', hwEncoder: 'software' };
    const caps = { hls: true, fmp4: process.argv.includes('ts') ? false : true };
    const decision = await strategy.resolve({ url: A.url, capabilities: caps, settings, ffprobePath: 'ffprobe', owner: 'device:tv', live: true, providerId: 1 });
    console.log('DECISION', decision.strategy, decision.url, decision.videoMode);
    const session = sessions.getSession(decision.sessionId);
    relay.adopt(session, { sourceId: 1, channelId: 'x', capabilities: caps, settings, ffprobePath: 'ffprobe', owner: 'device:tv', channelName: 'Test', primaryKey: 'ch', candidate: A });
    const playlistUrl = `${base}/api/transcode/${decision.sessionId}/stream.m3u8`;
    console.log('PLAYLIST', playlistUrl);
    // a consumer reading the stream the whole time
    const out = path.join(sandbox, 'consumer.ts');
    const consumer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', '-live_start_index', '0', '-i', playlistUrl, '-t', process.argv.includes('long') ? '110' : '70', '-c', 'copy', out]);
    let clog = ''; consumer.stderr.on('data', d => { clog += d; });
    const killAt = process.argv.includes('standby') ? 40000 : 16000;
    setTimeout(() => { console.log('--- KILLING PROVIDER A'); mode.aDead = true; for (const f of feeds) if (f.which === 'a') { if (process.argv.includes('stall')) { f.ff.stdout.unpipe(f.res); f.ff.kill('SIGSTOP'); } else { f.res.destroy(); } } }, killAt);
    const t0 = Date.now();
    const poll = setInterval(async () => {
        const r = await fetch(playlistUrl); const text = await r.text();
        const segs = text.split('\n').filter(l => l && !l.startsWith('#'));
        console.log(`t=${Math.round((Date.now() - t0) / 1000)}s status=${r.status} segs=${segs.length} last=${segs[segs.length - 1]} disc=${(text.match(/DISCONTINUITY\n/g) || []).length} relay=${JSON.stringify(relay.list())}`);
    }, 4000);
    consumer.on('exit', async (code) => {
        clearInterval(poll);
        console.log('CONSUMER exit', code); console.log('CONSUMER LOG\n' + clog.split('\n').slice(-25).join('\n'));
        const text = await (await fetch(playlistUrl)).text(); console.log('FINAL PLAYLIST\n' + text);
        const seg = text.split('\n').filter(l => /^L1-/.test(l))[0];
        if (seg) { const r = await fetch(`${base}/api/transcode/${decision.sessionId}/${seg}`); console.log('L1 segment fetch', r.status, (await r.arrayBuffer()).byteLength); const i = await fetch(`${base}/api/transcode/${decision.sessionId}/L1-init.mp4`); console.log('L1 init', i.status); }
        await relay.closeAll(); server.close(); provider.close(); for (const f of feeds) try { f.ff.kill('SIGKILL'); } catch (e) {}
        setTimeout(() => process.exit(0), 500);
    });
})().catch(e => { console.error('FAILED', e); process.exit(1); });
