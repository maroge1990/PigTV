'use strict';
// Raw read of one channel from its first two providers, the second started after a delay
// (as Hot standby does). Reports every pause over 2 s and how each connection ended.
// URLs are never printed.
const path = require('path');
const fs = require('fs');
const ROOT = '/app';
const routing = require(path.join(ROOT, 'server/services/providerRouting'));
const { redact } = require(path.join(ROOT, 'server/redact'));

const [, , sourceId, channelId, totalArg = '660', delayArg = '60'] = process.argv;
const TOTAL = Number(totalArg) * 1000;
const DELAY = Number(delayArg) * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';

function read(name, url, untilMs, file) {
    return new Promise((resolve) => {
        const out = fs.createWriteStream(file);
        const st = { name, bytes: 0, longest: 0, longestAt: null, pauses: [], end: 'complete', started: Date.now() };
        let last = Date.now();
        let req = null;
        let done = false;
        const finish = (how) => {
            if (done) return;
            done = true;
            st.end = how;
            clearTimeout(timer);
            if (req) req.destroy();
            out.end(() => resolve(st));
        };
        const timer = setTimeout(() => finish('complete'), Math.max(0, untilMs - Date.now()));
        const note = () => {
            const now = Date.now();
            const gap = now - last;
            if (gap > 2000) { st.pauses.push({ at: ((last - t0) / 1000).toFixed(1), ms: gap }); console.log(`${at()} ${name}: pause of ${(gap / 1000).toFixed(1)} s ended`); }
            if (gap > st.longest) { st.longest = gap; st.longestAt = ((last - t0) / 1000).toFixed(1); }
            last = now;
        };
        const get = (target, hops) => {
            const lib = target.startsWith('https:') ? require('https') : require('http');
            req = lib.get(target, { headers: { 'User-Agent': UA } }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
                    res.resume();
                    return get(new URL(res.headers.location, target).href, hops + 1);
                }
                if (res.statusCode !== 200) { res.resume(); return finish(`HTTP ${res.statusCode}`); }
                console.log(`${at()} ${name}: connected`);
                last = Date.now();
                res.on('data', (c) => { note(); st.bytes += c.length; out.write(c); });
                res.on('end', () => { console.log(`${at()} ${name}: closed by the provider`); finish(`closed by the provider at ${at()}`); });
                res.on('error', (err) => finish(`error ${redact(err.code || err.message)} at ${at()}`));
            });
            req.on('error', (err) => finish(`error ${redact(err.code || err.message)} at ${at()}`));
        };
        get(url, 0);
        // Silence still in progress is reported too.
        const tick = setInterval(() => {
            if (done) return clearInterval(tick);
            const gap = Date.now() - last;
            if (gap > 5000 && gap < 6100) console.log(`${at()} ${name}: silent for 5 s and counting`);
        }, 1000);
    });
}

(async () => {
    const plan = await routing.plan(sourceId, channelId);
    const seen = new Set();
    const picks = [];
    for (const c of plan.candidates) {
        if (seen.has(c.providerId) || !c.url) continue;
        seen.add(c.providerId);
        picks.push(c);
    }
    console.log(`channel ${plan.channelName}; providers: ${picks.map(p => `${p.providerName} (${p.via})`).join(', ')}`);
    if (picks.length < 2) { console.log('fewer than two providers; stopping'); process.exit(1); }
    const until = t0 + TOTAL;
    const [a, b] = picks;
    const dir = path.join(ROOT, 'data/samples');
    fs.mkdirSync(dir, { recursive: true });
    const ra = read(a.providerName, a.url, until, path.join(dir, `dual-${a.providerId}.ts`));
    await new Promise(r => setTimeout(r, DELAY));
    console.log(`${at()} starting ${b.providerName}`);
    const rb = read(b.providerName, b.url, until, path.join(dir, `dual-${b.providerId}.ts`));
    for (const s of await Promise.all([ra, rb])) {
        const secs = (Date.now() - s.started) / 1000;
        console.log(`\n${s.name}: ${s.end}; ${(s.bytes / 1e6).toFixed(1)} MB (${Math.round(s.bytes * 8 / secs / 1000)} kbps avg); longest pause ${(s.longest / 1000).toFixed(1)} s at ${s.longestAt}s; pauses over 2 s: ${s.pauses.length ? s.pauses.map(p => `${p.at}s (${(p.ms / 1000).toFixed(1)} s)`).join(', ') : 'none'}`);
    }
    process.exit(0);
})().catch((err) => { console.error(redact(String(err && err.stack || err))); process.exit(1); });
