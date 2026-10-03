#!/usr/bin/env node
/**
 * Stream doctor: find out what a provider feed actually sends, and what the
 * server's own ffmpeg arguments do with it — without a redeploy.
 *
 * The problem it solves. A playback fault that only appears on the real feed
 * used to cost a patch, a rebuild, a redeploy and an evening of watching, per
 * attempt, and a redeploy ends every live session. Worse, it invited guessing:
 * 0085 shipped a flag that fixed the channel in front of us and silently broke
 * a different class of channel, because there was no way to try it against more
 * than one feed. A 60-second capture removes all of that — every experiment
 * after it is local, offline and repeatable, and costs seconds.
 *
 *   node scripts/stream-doctor.js list <search>        find a channel
 *   node scripts/stream-doctor.js capture <pos_N> [s]  grab a sample + packet dump
 *   node scripts/stream-doctor.js classify <sample>    what its timestamps do
 *   node scripts/stream-doctor.js bench <sample>       score candidate ffmpeg flags
 *   node scripts/stream-doctor.js probecost <pos_N>    time a probe change live
 *
 * Runs inside the container (`docker exec <container> node scripts/stream-doctor.js …`)
 * or from a checkout. Provider credentials never reach the console: every URL
 * goes through the server's own redact().
 *
 * capture saves the provider's raw bytes (0191; before, it copied through ffmpeg,
 * which smooths over the very jumps it was meant to find) and says whether the
 * connection held. classify reports jumps per stream, the A/V start skew and
 * whether the picture is blank, besides the evenness verdict.
 *
 * capture and probecost open a connection to the provider, which allows ONE.
 * Nothing may be playing while they run. list, classify and bench touch only
 * files on disk and are always safe.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { redact } = require(path.join(ROOT, 'server/redact'));
// The server's own classifier, not a copy of it. A diagnostic that reimplements
// the rule can disagree with the code it is meant to explain, which is worse
// than having no diagnostic - this way "what the doctor says" and "what the
// server will do" cannot drift apart.
const { classifyTimestamps } = require(path.join(ROOT, 'server/services/streamProbe'));

const DATA = path.join(ROOT, 'data');
// Samples go under the data directory because that is the bind mount
// (./data:/app/data in docker-compose.yml). They were written to /app/samples
// at first, which is the container's writable layer - and `docker compose up
// --force-recreate`, the documented way to deploy, throws that layer away. The
// first captured corpus was destroyed by the very next deploy, before anything
// had been retested against it. Samples are evidence: they have to outlive the
// build they were taken on, or they cannot be used to check the next one.
const OUT = path.join(DATA, 'samples');

// ---------------------------------------------------------------- channels --

function openDb() {
    const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
    return new Database(path.join(DATA, 'content.db'), { readonly: true });
}

function userAgent() {
    // Settings live in content.db since 0135 (app_settings, JSON values); a server
    // that has not started on 0135 yet still has them in db.json.
    try {
        const db = openDb();
        try {
            const get = (k) => { const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k); return r ? JSON.parse(r.value) : undefined; };
            if (get('userAgentPreset') === 'custom' && get('userAgentCustom')) return get('userAgentCustom');
            return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        } finally { db.close(); }
    } catch { /* no app_settings table yet: fall back to db.json */ }
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
        const s = raw.settings || {};
        if (s.userAgentPreset === 'custom' && s.userAgentCustom) return s.userAgentCustom;
    } catch { /* fall through to the server's own default */ }
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

// An M3U sync leaves stream_url empty and keeps the URL in the data blob, which is
// where routes/playback.js looks too - so look in both, in the same order it does.
function urlOf(row) {
    if (!row) return null;
    if (row.stream_url) return row.stream_url;
    try {
        const d = JSON.parse(row.data || '{}');
        return d.url || d.stream_url || null;
    } catch { return null; }
}

const COLS = 'source_id, item_id, name, stream_url, data';

function findChannels(db, search) {
    // An exact item_id wins outright: "pos_46" must not also drag in pos_460..pos_469.
    const exact = db.prepare(`SELECT ${COLS} FROM playlist_items WHERE type='live' AND item_id = ?`).all(search);
    if (exact.length) return exact;
    const like = `%${search}%`;
    return db.prepare(`
        SELECT ${COLS} FROM playlist_items
        WHERE type = 'live' AND (name LIKE ? OR item_id LIKE ? OR stream_url LIKE ? OR data LIKE ?)
        ORDER BY name LIMIT 20
    `).all(like, like, like, like);
}

function oneChannel(search) {
    const db = openDb();
    const rows = findChannels(db, search);
    if (!rows.length) die(`No live channel matches "${search}"`);
    if (rows.length > 1) {
        console.error(`"${search}" matches ${rows.length} channels - use an exact id:`);
        for (const r of rows.slice(0, 10)) console.error(`  ${r.item_id}  ${r.name}`);
        process.exit(1);
    }
    const row = rows[0];
    const url = urlOf(row);
    if (!url) die(`"${row.name}" has no stored URL (an Xtream source builds it at play time).`);
    return { row, url };
}

const die = (msg) => { console.error(msg); process.exit(1); };

// ------------------------------------------------------------------ probes --

function ffprobeJson(args) {
    const r = spawnSync('ffprobe', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    try { return { json: JSON.parse(r.stdout || '{}'), raw: r }; }
    catch { return { json: {}, raw: r }; }
}

function packetsOf(file) {
    const { json } = ffprobeJson(['-v', 'error', '-print_format', 'json', '-show_packets', file]);
    return json.packets || [];
}

// ----------------------------------------------------------------- commands --

function cmdList(search) {
    const db = openDb();
    const rows = findChannels(db, search);
    if (!rows.length) die(`No live channel matches "${search}"`);
    for (const r of rows) {
        console.log(`${r.source_id}\t${r.item_id}\t${r.name}\t${redact(urlOf(r) || '(no URL stored)')}`);
    }
}

// The provider's bytes, untouched. An ffmpeg capture (-c copy) cannot be used for
// this: ffmpeg's demuxer rebases a backward timestamp step before anything is
// written, so a provider jump or a reconnect arrives in the file already smoothed
// over - the 23 Sept 19 s resend and the 3 Oct Fox Footy captures both "classified
// EVEN" that way. A plain HTTP read also has no reconnect, so it shows exactly when
// the provider closes or goes silent (3 Oct: ETIMEDOUT 1045 s into an idle capture).
function rawFetch(url, sec, file, ua) {
    return new Promise((resolve) => {
        const out = fs.createWriteStream(file);
        const t0 = Date.now();
        let settled = false;
        let req = null;
        const finish = (how) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (req) req.destroy();
            out.end(() => resolve({ how, seconds: Math.round((Date.now() - t0) / 1000), bytes: fs.statSync(file).size }));
        };
        const timer = setTimeout(() => finish('complete'), sec * 1000);
        const get = (target, hops) => {
            const lib = target.startsWith('https:') ? require('https') : require('http');
            req = lib.get(target, { headers: { 'User-Agent': ua } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
                    res.resume();
                    return get(new URL(res.headers.location, target).href, hops + 1);
                }
                if (res.statusCode !== 200) { res.resume(); return finish(`HTTP ${res.statusCode}`); }
                res.pipe(out, { end: false });
                res.on('end', () => finish('closed by the provider'));
                res.on('error', (err) => finish(`error ${err.code || err.message}`));
            });
            req.on('error', (err) => finish(`error ${err.code || err.message}`));
        };
        get(url, 0);
    });
}

async function cmdCapture(search, secArg) {
    const { row, url } = oneChannel(search);
    const sec = Number.parseInt(secArg, 10) || 60;
    const slug = String(row.item_id).replace(/[^A-Za-z0-9_-]/g, '_');
    fs.mkdirSync(OUT, { recursive: true });
    const ts = path.join(OUT, `${slug}.ts`);

    console.log(`Channel : ${row.name}  (source ${row.source_id}, id ${row.item_id})`);
    console.log(`URL     : ${redact(url)}`);
    console.log(`Grabbing ${sec}s of raw bytes -> ${ts}`);

    const got = await rawFetch(url, sec, ts, userAgent());
    if (!got.bytes) die(`Capture produced nothing (${got.how}).`);
    console.log(`Captured ${(got.bytes / 1e6).toFixed(1)} MB in ${got.seconds}s - ` +
        (got.how === 'complete' ? 'the connection held' : `${got.how} at ${got.seconds}s`) + '\n');
    cmdClassify(ts);
}

// Steps over this are a jump (the stream's own frame and audio steps are well under).
const JUMP_TICKS = 90000; // 1 s at 90 kHz
const WRAP_TICKS = 2 ** 32; // half the 33-bit range: a step this far back is the clock wrapping

/**
 * What a raw capture's timestamps do, per stream: where each starts, every backward
 * step or forward gap over a second (a 33-bit wrap named as such), and the seconds of
 * media actually carried (the sum of the ordinary steps). Exported for the tests.
 */
function timeline(packets, streams) {
    const kinds = new Map((streams || []).map((st) => [Number(st.index), st.codec_type]));
    const per = new Map();
    packets.forEach((pk, i) => {
        const dts = Number(pk.dts);
        if (!Number.isFinite(dts)) return;
        const idx = Number(pk.stream_index);
        const s = per.get(idx) || { index: idx, kind: kinds.get(idx) || pk.codec_type || '?', first: dts, last: null, packets: 0, carried: 0, jumps: [] };
        if (s.last !== null) {
            const step = dts - s.last;
            if (step < 0 || step > JUMP_TICKS) {
                s.jumps.push({ packet: i, atSec: s.carried / 90000, stepSec: step / 90000, wrap: step < -WRAP_TICKS });
            } else {
                s.carried += step;
            }
        }
        s.last = dts;
        s.packets++;
        per.set(idx, s);
    });
    const list = [...per.values()].map((s) => ({ ...s, seconds: s.carried / 90000 }));
    const video = list.find((s) => s.kind === 'video');
    const audio = list.find((s) => s.kind === 'audio');
    const skewSec = video && audio ? (audio.first - video.first) / 90000 : null;
    return { streams: list, video, audio, skewSec };
}

function cmdClassify(file) {
    if (!fs.existsSync(file)) die(`No such file: ${file}`);
    const packets = packetsOf(file);
    const video = packets.filter((p) => Number(p.stream_index) === 0);

    const dts = video.map((p) => Number(p.dts)).filter(Number.isFinite);
    const steps = dts.slice(1).map((d, i) => d - dts[i]);
    const mean = steps.length ? steps.reduce((t, s) => t + s, 0) / steps.length : 0;
    // Reported for the reader; the verdict itself comes from the server's function
    // so the two can never disagree.
    const degenerate = steps.filter((s) => mean > 0 && s >= 0 && s < mean / 4).length;
    const doubled = steps.filter((s) => mean > 0 && s > mean * 1.5).length;
    const pct = (n) => ((n / Math.max(1, steps.length)) * 100).toFixed(1) + '%';

    const { json } = ffprobeJson(['-v', 'error', '-print_format', 'json', '-show_streams', file]);
    const codecs = (json.streams || []).map((s) => `${s.codec_type}:${s.codec_name}`).join(' ');
    const verdict = classifyTimestamps(packets);

    console.log(path.basename(file));
    console.log('  codecs          : ' + (codecs || '?'));
    console.log('  video packets   : ' + video.length);
    console.log('  near-zero steps : ' + degenerate + ' (' + pct(degenerate) + ')   <- repeats already bumped upstream');
    console.log('  doubled steps   : ' + doubled + ' (' + pct(doubled) + ')');
    console.log('  mean step       : ' + mean.toFixed(1) + ' ticks');
    console.log('  VERDICT         : ' + (verdict === null ? 'cannot tell - the server would keep the source DTS'
        : verdict ? 'UNEVEN - the server rebuilds DTS (igndts)'
            : 'EVEN - the server keeps the source DTS'));

    // 0191: what the evenness verdict cannot see - jumps, the A/V start, and a blank picture.
    const tl = timeline(packets, json.streams);
    if (tl.skewSec !== null) console.log('  A/V start skew  : ' + (tl.skewSec * 1000).toFixed(0) + ' ms (audio minus video)');
    for (const st of tl.streams) {
        const label = `${st.kind} (stream ${st.index})`;
        if (!st.jumps.length) { console.log(`  jumps           : none in ${label}`); continue; }
        console.log(`  jumps           : ${st.jumps.length} in ${label}`);
        for (const j of st.jumps.slice(0, 10)) {
            console.log(`                    ~${Math.round(j.atSec)}s in: ${j.stepSec >= 0 ? '+' : ''}${j.stepSec.toFixed(2)}s` +
                (j.wrap ? '  (33-bit clock wrap - normal)' : j.stepSec < 0 ? '  (backwards: repeated content or a provider reset)' : '  (gap)'));
        }
        if (st.jumps.length > 10) console.log(`                    … ${st.jumps.length - 10} more`);
    }
    if (tl.video && tl.video.seconds > 0) {
        const vs = (json.streams || []).find((s) => s.codec_type === 'video') || {};
        const kbps = Math.round((fs.statSync(file).size * 8) / tl.video.seconds / 1000);
        // The server's own threshold, for the same reason as classifyTimestamps above.
        const { blankKbps } = require(path.join(ROOT, 'server/services/transcodeSession'));
        const limit = blankKbps(Number(vs.height) || 0);
        console.log('  media rate      : ' + kbps + ' kbps over ' + Math.round(tl.video.seconds) + 's' + (vs.height ? ` at ${vs.height}p` : ''));
        console.log('  PICTURE         : ' + (kbps < limit
            ? `BLANK - under ${limit} kbps: a black or still placeholder (the server marks such a play blank)`
            : 'has picture data'));
    }
}

// The flag sets worth comparing. Each takes the server's own arguments and
// changes one thing, so a difference in the score is a difference that flag made.
const setFlag = (a, name, value) => { const i = a.indexOf(name); if (i >= 0) a[i + 1] = value; return a; };
const dropPair = (a, name) => { const i = a.indexOf(name); if (i >= 0) a.splice(i, 2); return a; };

const VARIANTS = [
    ['as the server would run it', (a) => a],
    ['force igndts on', (a) => setFlag(a, '-fflags', '+genpts+discardcorrupt+igndts')],
    ['force igndts off', (a) => setFlag(a, '-fflags', '+genpts+discardcorrupt')],
    ['default interleave', (a) => dropPair(a, '-max_interleave_delta')],
    ['no avoid_negative_ts', (a) => dropPair(a, '-avoid_negative_ts')],
];

const WARNINGS = [
    ['non-monotonic DTS', /Non-monotonic DTS/i],
    ['packet duration out of range', /Packet duration.*out of range/i],
    ['invalid timestamps', /Invalid timestamps/i],
    ['invalid DTS/PTS', /Invalid (DTS|PTS)/i],
    ['timestamp discontinuity', /timestamp discontinuity/i],
];
// Joining mid-GOP makes the decoder complain until the next keyframe; self-ending
// and nothing to do with muxing, so it is counted apart from the rest.
const CHATTER = /non-existing (PPS|SPS)|decode_slice_header|no frame!|Increasing reorder|corrupt|SEI type/i;

function classifyStderr(stderr) {
    const counts = {}; let chatter = 0; const other = [];
    for (const line of (stderr || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const hit = WARNINGS.find(([, re]) => re.test(line));
        if (hit) { counts[hit[0]] = (counts[hit[0]] || 0) + 1; continue; }
        if (CHATTER.test(line)) { chatter++; continue; }
        if (other.length < 4) other.push(redact(line.trim()).slice(0, 120));
    }
    return { counts, chatter, other };
}

// Microseconds, not milliseconds: 59.94 fps is a 16.683 ms period, so rounding to
// whole ms alternates 16/17 for a perfectly even stream and makes it look faulty.
function evenness(file) {
    const forced = file.endsWith('.ts') ? ['-f', 'mpegts'] : [];
    const csv = spawnSync('ffprobe', ['-v', 'error', ...forced, '-select_streams', 'v',
        '-show_entries', 'packet=dts_time', '-of', 'csv=p=0', file],
        { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).stdout || '';
    // csv=p=0 can leave a trailing comma on a row, which Number() reads as NaN.
    const dts = csv.split(/\r?\n/).filter(Boolean).map((l) => Number(l.split(',')[0])).filter(Number.isFinite);
    if (dts.length < 3) return null;
    const steps = dts.slice(1).map((d, i) => Math.round((d - dts[i]) * 1e6));
    const mean = steps.reduce((t, s) => t + s, 0) / steps.length;
    return {
        packets: dts.length,
        meanMs: (mean / 1000).toFixed(3),
        outliers: steps.filter((s) => Math.abs(s - mean) > 1000).length,
        minMs: (Math.min(...steps) / 1000).toFixed(3),
        maxMs: (Math.max(...steps) / 1000).toFixed(3),
        backwards: steps.filter((s) => s < 0).length
    };
}

function joinSegments(dir) {
    const init = fs.existsSync(path.join(dir, 'init.mp4')) ? ['init.mp4'] : [];
    const segs = fs.readdirSync(dir).filter((f) => /^seg\d+\.(m4s|ts)$/.test(f)).sort();
    if (!segs.length) return null;
    // init.mp4 + .m4s fragments make a valid MP4; .ts segments concatenate into a
    // transport stream. ffprobe reads them differently, so the extension must be honest.
    const joined = path.join(dir, init.length ? 'joined.mp4' : 'joined.ts');
    fs.writeFileSync(joined, Buffer.concat([...init, ...segs].map((f) => fs.readFileSync(path.join(dir, f)))));
    return joined;
}

// The session's own arguments, pointed at a file instead of a provider URL.
function forFile(args, input, outDir, segExt) {
    const a = args.slice();
    for (const flag of ['-user_agent', '-reconnect', '-reconnect_streamed', '-reconnect_delay_max', '-seekable']) {
        let i; while ((i = a.indexOf(flag)) >= 0) a.splice(i, 2); // http options, meaningless on a file
    }
    a[a.indexOf('-i') + 1] = input;
    const segI = a.indexOf('-hls_segment_filename');
    if (segI >= 0) a[segI + 1] = path.join(outDir, 'seg%04d.' + segExt);
    a[a.length - 1] = a[a.length - 1] === '-' ? path.join(outDir, 'out.mp4') : path.join(outDir, 'stream.m3u8');
    return a;
}

async function cmdBench(file) {
    if (!fs.existsSync(file)) die(`No such file: ${file}`);
    const sample = path.resolve(file);
    const transcodeSession = require(path.join(ROOT, 'server/services/transcodeSession'));

    // Codecs read off the sample, never assumed: handing an HEVC sample the h264
    // bitstream filter fails the session outright and reads like a server bug.
    const { json } = ffprobeJson(['-v', 'error', '-print_format', 'json', '-show_streams', sample]);
    const v = (json.streams || []).find((s) => s.codec_type === 'video') || {};
    const a = (json.streams || []).find((s) => s.codec_type === 'audio') || {};
    const codecs = { videoCodec: v.codec_name || 'h264', audioCodec: a.codec_name || 'aac', audioChannels: a.channels || 2 };
    const dtsUneven = classifyTimestamps(packetsOf(sample)) === true;

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-doctor-'));
    const report = (label, stderr, steps) => {
        const w = Object.entries(stderr.counts).map(([k, n]) => `${k}=${n}`).join(' ') || 'none';
        console.log('  ' + label.padEnd(30) + ' ' + (steps
            ? `${steps.packets}pkt mean ${steps.meanMs}ms, ${steps.outliers} outliers (${steps.minMs}-${steps.maxMs}ms), ${steps.backwards} backwards`
            : 'NO OUTPUT'));
        console.log('  ' + ''.padEnd(30) + ' warnings: ' + w + (stderr.chatter ? ` (+${stderr.chatter} decoder chatter)` : ''));
        for (const o of stderr.other) console.log('  ' + ''.padEnd(30) + '   ! ' + o);
    };

    console.log(`sample: ${sample}  (${(fs.statSync(sample).size / 1e6).toFixed(1)} MB)`);
    console.log(`codecs: ${codecs.videoCodec}/${codecs.audioCodec}, classified ${dtsUneven ? 'UNEVEN' : 'even'}`);
    console.log(`ffmpeg: ${(spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).stdout || '').split('\n')[0]}\n`);

    for (const [name, segExt, opts] of [
        ['HLS fmp4 (copy A/V)', 'm4s', { segmentType: 'fmp4', videoMode: 'copy', audioMode: 'copy', ...codecs, dtsUneven }],
        ['HLS mpegts (copy V, encode A)', 'ts', { segmentType: 'mpegts', videoMode: 'copy', ...codecs, dtsUneven }]
    ]) {
        console.log(`=== ${name} ===`);
        for (const [label, mutate] of VARIANTS) {
            const session = await transcodeSession.createSession('http://sample.invalid/x.ts', opts);
            const outDir = fs.mkdtempSync(path.join(work, 'run-'));
            const args = mutate(forFile(session.buildFFmpegArgs(), sample, outDir, segExt));
            const run = spawnSync('ffmpeg', args, { encoding: 'utf8', cwd: outDir, maxBuffer: 256 * 1024 * 1024 });
            const joined = joinSegments(outDir);
            report(label, classifyStderr(run.stderr), joined && evenness(joined));
        }
        console.log('');
    }

    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp cleaner gets it */ }
}

function cmdProbeCost(search) {
    const { row, url } = oneChannel(search);
    const COMMON = ['-v', 'error', '-user_agent', userAgent(), '-print_format', 'json',
        '-show_streams', '-show_format', '-probesize', '5000000', '-analyzeduration', '5000000'];
    const EXTRA = ['-show_packets', '-read_intervals', '%+#300'];

    const run = (label, args) => {
        const t0 = Date.now();
        const { json, raw } = ffprobeJson([...args, url]);
        const ms = Date.now() - t0;
        console.log(label);
        console.log('  exit / time     : ' + raw.status + ' / ' + ms + ' ms');
        console.log('  stdout bytes    : ' + (raw.stdout || '').length);
        console.log('  streams         : ' + ((json.streams || []).map((s) => s.codec_type + ':' + s.codec_name).join(' ') || '(probe failed)'));
        console.log('  format.size     : ' + (json.format || {}).size);
        if (json.packets) console.log('  packets         : ' + json.packets.length);
        return { ms, json };
    };

    console.log(`Channel: ${row.name} (${row.item_id})\n`);
    const before = run('--- probe without packets ---', COMMON);
    console.log('');
    const after = run('--- probe with packets (as it ships) ---', [...COMMON, ...EXTRA]);

    const same = JSON.stringify((before.json.streams || []).map((s) => [s.codec_type, s.codec_name, s.channels, s.profile]))
        === JSON.stringify((after.json.streams || []).map((s) => [s.codec_type, s.codec_name, s.channels, s.profile]));
    console.log('\n--- verdict ---');
    console.log('  cost delta      : ' + (after.ms - before.ms) + ' ms  (' + before.ms + ' -> ' + after.ms + ')');
    console.log('  streams match   : ' + (same ? 'yes' : 'NO - the packet options changed stream detection'));
    const verdict = classifyTimestamps(after.json.packets);
    console.log('  classified      : ' + (verdict === null ? 'cannot tell' : verdict ? 'UNEVEN - DTS rebuilt' : 'even - DTS kept'));
}

// --------------------------------------------------------------------- main --

const USAGE = `stream-doctor - what a feed sends, and what the server's ffmpeg does with it

  list <search>          find a channel (name, pos_N, or URL fragment)
  capture <pos_N> [sec]  grab the raw bytes + classify them (uses the provider slot)
  classify <sample.ts>   timestamps, jumps, A/V skew, blank picture
  bench <sample.ts>      score candidate ffmpeg flags against it
  probecost <pos_N>      time the resolve probe             (uses the provider slot)

capture and probecost connect to the provider, which allows one stream: nothing
may be playing. The others only read files.`;

async function main(argv) {
    const [, , cmd, arg1, arg2] = argv;
    switch (cmd) {
        case 'list': if (!arg1) die(USAGE); return cmdList(arg1);
        case 'capture': if (!arg1) die(USAGE); return cmdCapture(arg1, arg2);
        case 'classify': if (!arg1) die(USAGE); return cmdClassify(arg1);
        case 'bench': if (!arg1) die(USAGE); return cmdBench(arg1);
        case 'probecost': if (!arg1) die(USAGE); return cmdProbeCost(arg1);
        default: console.log(USAGE); process.exit(cmd ? 2 : 0);
    }
}

// Requirable so a test can check where samples land without running anything.
module.exports = { SAMPLE_DIR: OUT, DATA_DIR: DATA, main, timeline, rawFetch };

if (require.main === module) {
    main(process.argv).then(() => process.exit(0), (err) => die(redact(err && err.stack || String(err))));
}
