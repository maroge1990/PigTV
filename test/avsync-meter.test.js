const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// #267: the A/V sync meter (scripts/avsync-meter.js) and the fake provider's TEST A/V SYNC channel.
// T1: the onset pairing and the summary on made-up onset lists. T2 (needs ffmpeg): the generator's own output measures
// in step (the source truth), and the same file through the production session's own ffmpeg arguments still does
// (the meter invents no offset). The relay rig's T3 run is in docs/TESTING.md › A/V sync harness.
const meter = require('../scripts/avsync-meter');
const fake = require('../scripts/fake-provider');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-avsync-'));
after(() => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* the OS temp cleaner */ } });

/** Marks once a second from `from` for `n` seconds, long every 10th second of the source clock (t % 10 === 0). */
const marks = (n, { from = 0, shift = 0, drop = [], driftPerSec = 0 } = {}) => {
    const out = [];
    for (let i = 0; i < n; i++) {
        const t = from + i;
        if (drop.includes(t)) continue;
        out.push({ t: t + shift + driftPerSec * i, long: t % 10 === 0 });
    }
    return out;
};

// ---- T1: pairing ----------------------------------------------------------------------------------------------

test('T1: in step: every flash pairs with its beep at 0 ms', () => {
    const r = meter.pairOnsets(marks(30, { from: 1 }), marks(30, { from: 1 }));
    assert.equal(r.pairs.length, 30);
    assert.ok(r.pairs.every(p => p.offsetMs === 0));
    assert.deepEqual([r.missingBeeps, r.missingFlashes, r.kindMismatches, r.ambiguous], [[], [], 0, false]);
});

test('T1: sound 120 ms late, a missing beep and a missing flash are reported, not mispaired', () => {
    const flashes = marks(30, { from: 1, drop: [7] });
    const beeps = marks(30, { from: 1, shift: 0.12, drop: [15] });
    const r = meter.pairOnsets(flashes, beeps);
    assert.equal(r.pairs.length, 28);
    assert.ok(r.pairs.every(p => p.offsetMs === 120), JSON.stringify(r.pairs.map(p => p.offsetMs)));
    assert.deepEqual(r.missingBeeps, [15], 'the flash at 15 s has no beep');
    assert.deepEqual(r.missingFlashes.map(t => Math.round(t * 100) / 100), [7.12], 'the beep at 7 s has no flash');
    assert.equal(r.kindMismatches, 0);
});

test('T1: a whole-second slip is measured from the long marks, not folded to the nearest beep', () => {
    // Sound 1.2 s late: the nearest beep to each flash is only 0.2 s away, but the long marks say 1.2 s.
    const r = meter.pairOnsets(marks(40, { from: 1 }), marks(40, { from: 1, shift: 1.2 }));
    assert.equal(r.ambiguous, false);
    assert.equal(r.coarseMs, 1200);
    assert.ok(r.pairs.length >= 38 && r.pairs.every(p => p.offsetMs === 1200), JSON.stringify(r.pairs.map(p => p.offsetMs)));
    assert.equal(r.kindMismatches, 0);
    // Sound 0.9 s EARLY reads as -900, not +100.
    const early = meter.pairOnsets(marks(40, { from: 1 }), marks(40, { from: 1, shift: -0.9 }));
    assert.ok(early.pairs.every(p => p.offsetMs === -900), JSON.stringify(early.pairs.map(p => p.offsetMs)));
    // With no long marks the second cannot be known: said so.
    const plain = (list) => list.map(m => ({ ...m, long: false }));
    const amb = meter.pairOnsets(plain(marks(40, { from: 1 })), plain(marks(40, { from: 1, shift: 1.2 })));
    assert.equal(amb.ambiguous, true);
    assert.ok(meter.summarise(amb).wholeSecondAmbiguous);
});

test('T1: drift is followed and measured; a step shows when it leaves ±80 ms', () => {
    // 10 ms later every second for 60 s: 600 ms/min, ending 590 ms out, every pair still with its own beep.
    const drift = meter.pairOnsets(marks(60, { from: 1 }), marks(60, { from: 1, driftPerSec: 0.01 }));
    assert.equal(drift.pairs.length, 60);
    assert.equal(drift.pairs[59].offsetMs, 590);
    const s = meter.summarise(drift);
    assert.equal(s.driftMsPerMin, 600);
    assert.equal(s.firstOutOfStepSec, 10, 'first beyond 80 ms at 9 s late = t 10, and out for 5 s');
    // A step: in step for 20 s, then 300 ms late (a switch), with an event marked at it.
    const flashes = marks(40, { from: 1 });
    const beeps = flashes.map(f => ({ ...f, t: f.t + (f.t >= 21 ? 0.3 : 0) }));
    const step = meter.summarise(meter.pairOnsets(flashes, beeps), [{ t: 20.5, label: 'switch' }]);
    assert.deepEqual([step.minMs, step.maxMs, step.worstMs, step.firstOutOfStepSec], [0, 300, 300, 21]);
    assert.deepEqual(step.events, [{ t: 20.5, label: 'switch', beforeMs: 0, afterMs: 300 }]);
    // A short excursion (under 5 s) is not "out of step".
    const blip = flashes.map(f => ({ ...f, t: f.t + (f.t >= 10 && f.t < 13 ? 0.2 : 0) }));
    assert.equal(meter.summarise(meter.pairOnsets(flashes, blip)).firstOutOfStepSec, null);
});

test('T1: a gap (no marks for a while, as across a switch) pairs both sides', () => {
    const flashes = [...marks(10, { from: 1 }), ...marks(10, { from: 30 })];
    const beeps = [...marks(10, { from: 1, shift: 0.02 }), ...marks(10, { from: 30, shift: 0.06 })];
    const r = meter.pairOnsets(flashes, beeps);
    assert.equal(r.pairs.length, 20);
    assert.deepEqual([...new Set(r.pairs.map(p => p.offsetMs))], [20, 60]);
});

test('T1: onsets: half way between the quiet and bright levels, upward, with the mark\'s length', () => {
    const series = [];
    for (let i = 0; i < 400; i++) {
        const t = i * 0.04; const s = t % 1;
        series.push({ t, v: s < (Math.floor(t + 1e-9) % 10 === 0 ? 0.3 : 0.1) - 1e-9 ? 230 : 30 });
    }
    const found = meter.onsets(series, { minSpread: 20 });
    // t=0 is lit at the start: not an onset. Then 1, 2, ... 15.
    assert.deepEqual(found.map(f => Math.round(f.t * 100) / 100), Array.from({ length: 15 }, (_, i) => i + 1));
    assert.deepEqual(found.filter(f => f.long).map(f => Math.round(f.t)), [10]);
    assert.deepEqual(meter.onsets(series.map(s => ({ t: s.t, v: 30 })), { minSpread: 20 }), [], 'no marks: none found');
});

test('0905: a one-second sound slip for eight seconds between long marks is ambiguous, never "in step" at zero', () => {
    const flashes = marks(40, { from: 1 });
    // The sound of seconds 11-18 comes a second late (heard at 12-19; the 18th lands on the 19th's own beep), so the beep
    // at 11 is missing; the long marks at 10 and 20 are untouched.
    const beeps = [...marks(10, { from: 1 }), ...marks(8, { from: 12 }), ...marks(21, { from: 20 })];
    const r = meter.pairOnsets(flashes, beeps);
    const s = meter.summarise(r);
    assert.notEqual(s.verdict, 'in step');
    assert.equal(s.verdict, 'ambiguous');
    assert.deepEqual(s.ambiguousIntervals, [{ from: 10, to: 20 }]);
    for (const p of r.pairs.filter(x => x.t > 10 && x.t < 20)) assert.ok(p.ambiguous || p.offsetMs !== 0, `t=${p.t} reported as plain zero`);
    // Away from it, and in a clean run, the verdict stands.
    assert.equal(meter.summarise(meter.pairOnsets(marks(40, { from: 1 }), marks(40, { from: 1 }))).verdict, 'in step');
    // A mark cut at the very start of the file is not a slip.
    const cut = meter.pairOnsets(marks(30, { from: 1 }), marks(31, { from: 0 }), { start: 0, end: 31 });
    assert.equal(meter.summarise(cut).verdict, 'in step');
});

test('0906: only a mark the track edge could really have cut is exempt; a slip before the first long mark is not hidden', () => {
    // A capture starting at 0.5 s, the beep of second 1 missing, every mark matching from 2 s.
    const a = meter.pairOnsets(marks(30, { from: 1 }), marks(29, { from: 2 }), { start: 0.5, end: 31 });
    const sa = meter.summarise(a);
    assert.notEqual(sa.verdict, 'in step');
    assert.ok(sa.ambiguousIntervals.length > 0, JSON.stringify(sa));
    // The first nine beeps a second late, the ninth landing on the long beep at 10 s.
    const beeps = [...marks(8, { from: 2 }), ...marks(21, { from: 10 })];
    const b = meter.pairOnsets(marks(30, { from: 1 }), beeps, { start: 0, end: 31 });
    const sb = meter.summarise(b);
    assert.notEqual(sb.verdict, 'in step');
    assert.ok(sb.ambiguousIntervals.length > 0, JSON.stringify(sb));
    // A long mark paired with a short one at the very start is still evidence.
    const flashes = marks(30, { from: 0 });
    const shortFirst = marks(30, { from: 0 }).map((m, i) => (i === 0 ? { ...m, long: false } : m));
    assert.notEqual(meter.summarise(meter.pairOnsets(flashes, shortFirst, { start: 0, end: 31 })).verdict, 'in step');
    // What the edge really cuts stays exempt: the flash lit before the first frame (its beep at 0.005, the first frame
    // at 0.021) and the last mark still lit when the file ends.
    const generator = meter.pairOnsets(marks(29, { from: 1 }), [{ t: 0.005, long: true }, ...marks(29, { from: 1 })],
        { flashStart: 0.021, flashEnd: 29.9, beepStart: 0, beepEnd: 29.9 });
    assert.equal(meter.summarise(generator).verdict, 'in step');
});

test('0907: a flash already lit on the first frame at 29.97 fps reads in step; a missing interior mark is still ambiguous', () => {
    // The recording starts 10 ms after the source's second: the first frame (t 0) is lit, the first beep's onset is seen at 0.01.
    const fps = 30000 / 1001;
    const lit = (t, src) => { const x = t + src; const s = ((x % 1) + 1) % 1; return s < (Math.floor(x + 1e-9) % 10 === 0 ? 0.3 : 0.1); };
    const luma = []; for (let i = 0; i < 30 * fps; i++) { const t = i / fps; luma.push({ t, v: lit(t, 0.0) ? 230 : 30 }); }
    const level = []; for (let i = 0; i < 30 * 200; i++) { const t = i / 200; level.push({ t, v: lit(t, -0.01) ? -10 : -60 }); }
    const measureSeries = (lumaS, levelS) => {
        const v = meter.seriesBounds(lumaS), a = meter.seriesBounds(levelS);
        const r = meter.pairOnsets(meter.onsets(lumaS, { minSpread: 20 }), meter.onsets(levelS, { minSpread: 12 }),
            { flashStart: v.start, flashEnd: v.end, beepStart: a.start, beepEnd: a.end, flashStep: v.step, beepStep: a.step });
        return meter.summarise(r);
    };
    const s = measureSeries(luma, level);
    assert.equal(s.verdict, 'in step', JSON.stringify(s));
    assert.ok(Math.abs(s.medianMs - 10) <= 20, String(s.medianMs));
    // The beep of second 14 missing: ambiguous, edges or not.
    const gap = level.map(x => (x.t > 13.9 && x.t < 14.2 ? { t: x.t, v: -60 } : x));
    const g = measureSeries(luma, gap);
    assert.equal(g.verdict, 'ambiguous', JSON.stringify(g));
});

test('0906: a 30-minute capture\'s readings (about 470,000) are measured without overflowing the stack', () => {
    const started = Date.now();
    const luma = [], level = [];
    for (let i = 0; i < 30 * 60 * 60; i++) { const t = i / 60; luma.push({ t, v: t % 1 < 0.1 ? 230 : 30 }); }
    for (let i = 0; i < 30 * 60 * 200; i++) { const t = i / 200; level.push({ t, v: t % 1 < 0.1 ? -10 : -60 }); }
    assert.throws(() => Math.min(...level.map(x => x.t)), RangeError, 'spreading them into one call overflows (0905 did)');
    const bounds = meter.seriesBounds(level);
    assert.deepEqual([bounds.start, bounds.end], [0, (level.length - 1) / 200]);
    assert.ok(Math.abs(bounds.step - 0.005) < 1e-9, 'the observed sampling interval');
    const flashes = meter.onsets(luma, { minSpread: 20 });
    const beeps = meter.onsets(level, { minSpread: 12 });
    const r = meter.pairOnsets(flashes, beeps, { flashStart: 0, flashEnd: meter.seriesBounds(luma).end, beepStart: 0, beepEnd: meter.seriesBounds(level).end });
    const s = meter.summarise(r);
    assert.ok(s.pairs >= 1790, String(s.pairs));
    assert.ok(Date.now() - started < 15000, `${Date.now() - started} ms`);
});

test('T1: events files and metadata lines parse', () => {
    assert.deepEqual(meter.parseEvents('# rig\n120 close on A\n2:30 stall\n\n1:00:00\n'),
        [{ t: 120, label: 'close on A' }, { t: 150, label: 'stall' }, { t: 3600, label: null }]);
    assert.deepEqual(meter.parseMetadataPrint('frame:0    pts:0       pts_time:0\nlavfi.x=-inf\nframe:1 pts:240 pts_time:0.005\nlavfi.x=-20.5\n', 'lavfi.x'),
        [{ t: 0, v: -200 }, { t: 0.005, v: -20.5 }]);
});

test('files only: a URL is refused and never printed', () => {
    for (const url of ['http://user:secret@provider.invalid/live/u/p/1.ts', 'https://x.invalid/a.m3u8', 'rtmp://x.invalid/a', 'srt://x.invalid:9000']) {
        const lines = [];
        assert.equal(meter.main([url], (l) => lines.push(l)), 2);
        assert.match(lines.join('\n'), /files only/);
        assert.ok(!lines.join('\n').includes('invalid'), 'the address is not echoed');
    }
    const lines = [];
    assert.equal(meter.main([path.join(work, 'f.ts'), '--events', 'http://x.invalid/e'], (l) => lines.push(l)), 2);
    assert.ok(!lines.join('\n').includes('x.invalid'));
    assert.equal(meter.isUrl('C:\\rec\\ipad.mov'), false, 'a Windows path is a file');
    assert.equal(meter.main([path.join(work, 'missing.mov')], () => {}), 2);
    // 0905: an unknown or malformed argument is never echoed (--events=<URL> is one argument).
    for (const argv of [['--events=http://user:secret@x.invalid/e', 'f.ts'], ['f.ts', 'https://x.invalid/2.ts'], ['--corner', 'http://x.invalid/c'], ['-x', 'rtmp://x.invalid/a']]) {
        const got = [];
        assert.equal(meter.main(argv, (l) => got.push(l)), 2);
        assert.ok(!/invalid|secret/.test(got.join('\n')), got.join('\n'));
    }
    // ...and a label from the events file never carries an address out.
    const events = meter.parseEvents('12 switch to http://user:secret@p.invalid/live/u/p/1.ts now\n13 www.p.invalid/x\n');
    assert.ok(!/invalid|secret/.test(JSON.stringify(events)), JSON.stringify(events));
    assert.match(events[0].label, /^switch to <address> now$/);
    assert.throws(() => meter.parseEvents('http://x.invalid/1 a'), (e) => !/invalid/.test(e.message));
});

// ---- T2: real media ----------------------------------------------------------------------------------------------

/** 60 s of TEST A/V SYNC written to a file with the fake provider's own generator arguments (not paced). */
function generate(file, seconds = 60) {
    const textFile = path.join(work, 'sync.txt');
    fs.writeFileSync(textFile, 'UK| TEST A/V SYNC HD\n%{localtime}');
    const drawtext = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=64x36:duration=0.1', '-vf', `drawtext=textfile=${textFile}`, '-f', 'null', '-']).status === 0;
    const ctx = { size: '640x360', uhdSize: '960x540', fps: 25, videoKbps: 600, caps: { drawtext }, textFile: () => textFile, fontFile: null, title: 'FakeTV A' };
    const args = fake.generatorArgs({ id: 1027, kind: 'sync', name: 'UK| TEST A/V SYNC HD' }, ctx).filter(a => a !== '-re');
    assert.equal(args[args.length - 1], 'pipe:1');
    args.splice(args.length - 1, 1, '-t', String(seconds), '-y', file);
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
}

const within = (m, ms) => {
    const s = m.summary;
    assert.ok(s.pairs >= 55, `pairs ${s.pairs} (${m.flashes.length} flashes, ${m.beeps.length} beeps)`);
    assert.equal(s.wholeSecondAmbiguous, false);
    assert.equal(s.kindMismatches, 0);
    assert.equal(s.verdict, 'in step', JSON.stringify(s.ambiguousIntervals));
    // The beep at t 0 has no flash onset (the first frame is already lit); nothing else is left over.
    assert.ok(s.missingBeeps === 0 && s.missingFlashes <= 1, `unpaired: ${s.missingBeeps} flashes, ${s.missingFlashes} beeps`);
    assert.ok(Math.abs(s.minMs) <= ms && Math.abs(s.maxMs) <= ms, `offsets ${s.minMs}..${s.maxMs} ms, limit ±${ms}`);
};

let source = null;
test('T2: the generator\'s own output is in step within ±20 ms (the source truth)', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
    source = path.join(work, 'sync-source.ts');
    generate(source);
    const m = meter.measure(source);
    console.log(`AVSYNC-T2 source ${JSON.stringify(m.summary)}`);
    within(m, 20);
    assert.deepEqual(m.flashes.filter(f => f.long).map(f => Math.round(f.t) % 10), Array(m.flashes.filter(f => f.long).length).fill(0), 'long marks every 10th second');
});

/** The production session's own arguments (transcodeSession.buildFFmpegArgs), pointed at a file, as stream-doctor bench does. */
function throughSession(input, opts, segExt) {
    const sandbox = fs.mkdtempSync(path.join(work, 'server-'));
    fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
    const { TranscodeSession } = require(path.join(sandbox, 'server/services/transcodeSession'));
    const session = new TranscodeSession('http://sample.invalid/x.ts', { ffmpegPath: 'ffmpeg', ...opts });
    const out = fs.mkdtempSync(path.join(work, 'out-'));
    const a = session.buildFFmpegArgs().slice();
    for (const flag of ['-user_agent', '-reconnect', '-reconnect_streamed', '-reconnect_delay_max', '-seekable']) {
        let i; while ((i = a.indexOf(flag)) >= 0) a.splice(i, 2);
    }
    a[a.indexOf('-i') + 1] = input;
    const segI = a.indexOf('-hls_segment_filename');
    assert.ok(segI >= 0, 'an HLS session');
    a[segI + 1] = path.join(out, `seg%04d.${segExt}`);
    a[a.length - 1] = path.join(out, 'stream.m3u8');
    const r = spawnSync('ffmpeg', a, { encoding: 'utf8', cwd: out, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr && r.stderr.slice(-500));
    // What a player reads: the segments in playlist order (fMP4: the init segment first).
    const names = fs.readFileSync(path.join(out, 'stream.m3u8'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
    const init = fs.existsSync(path.join(out, 'init.mp4')) ? ['init.mp4'] : [];
    const joined = path.join(out, init.length ? 'joined.mp4' : 'joined.ts');
    fs.writeFileSync(joined, Buffer.concat([...init, ...names].map(f => fs.readFileSync(path.join(out, f)))));
    return joined;
}

for (const [label, segExt, opts] of [
    ['fMP4, copy A/V', 'm4s', { segmentType: 'fmp4', videoMode: 'copy', audioMode: 'copy', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2 }],
    ['MPEG-TS, copy V, encode A', 'ts', { segmentType: 'mpegts', videoMode: 'copy', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2 }]
]) {
    test(`T2: through the session's own ffmpeg arguments (${label}) still within ±40 ms`, { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
        if (!source) { source = path.join(work, 'sync-source.ts'); generate(source); }
        const m = meter.measure(throughSession(source, opts, segExt));
        console.log(`AVSYNC-T2 session ${label} ${JSON.stringify(m.summary)}`);
        within(m, 40);
    });
}

test('T2: a real offset is read back: the sound moved 250 ms late, then 1.3 s late (a whole-second slip)', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
    if (!source) { source = path.join(work, 'sync-source.ts'); generate(source); }
    for (const [shift, expect] of [[0.25, 250], [1.3, 1300]]) {
        const moved = path.join(work, `moved-${expect}.mkv`);
        const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-itsoffset', String(shift), '-i', source,
            '-map', '0:v', '-map', '1:a', '-c', 'copy', moved], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        const s = meter.measure(moved).summary;
        assert.ok(s.pairs >= 50 && Math.abs(s.medianMs - expect) <= 20 && Math.abs(s.minMs - expect) <= 20 && Math.abs(s.maxMs - expect) <= 20,
            `${expect} ms: ${JSON.stringify(s)}`);
    }
});

test('0905: a label with an address never reaches the output, in text or JSON, quiet or not', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
    if (!source) { source = path.join(work, 'sync-source.ts'); generate(source); }
    const ev = path.join(work, 'events.txt');
    fs.writeFileSync(ev, '20.5 switch on http://user:secret@p.invalid/live/u/p/1.ts\n');
    for (const quiet of [false, true]) {
        const lines = [];
        assert.equal(meter.main([source, '--events', ev, ...(quiet ? ['--quiet'] : [])], (l) => lines.push(l)), 0);
        const text = lines.join('\n');
        assert.ok(!/invalid|secret/.test(text), text.slice(-400));
        assert.match(text, /"label":"switch on <address>"/);
    }
});

test('0906: a file or tool failure prints a fixed reason, never the path or the tool\'s own words', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
    if (!source) { source = path.join(work, 'sync-source.ts'); generate(source); }
    const odd = path.join(work, 'user:secret@x.invalid');
    fs.mkdirSync(odd, { recursive: true });
    const cases = [
        [[source, '--events', path.join(odd, 'missing.txt')], /The events file is not found\./],
        [[source, '--events', odd], /The events file is a folder, not a file\./]
    ];
    const locked = path.join(odd, 'locked.txt');
    fs.writeFileSync(locked, '1 x\n'); fs.chmodSync(locked, 0o000);
    let readable = true; try { fs.readFileSync(locked); } catch { readable = false; }
    if (!readable) cases.push([[source, '--events', locked], /The events file is not readable \(permission denied\)\./]);
    const junk = path.join(odd, 'http-x.invalid.mov');
    fs.writeFileSync(junk, 'not media at all');
    cases.push([[junk], /^avsync-meter: (the file has no picture|ffmpeg could not read the file)/]);
    for (const [argv, want] of cases) {
        const lines = [];
        assert.notEqual(meter.main(argv, (l) => lines.push(l)), 0);
        const text = lines.join('\n');
        assert.match(text, want);
        assert.ok(!/invalid|secret/.test(text), text);
    }
    fs.chmodSync(locked, 0o600);
});

test('a label with a relative Xtream path or a token parameter keeps no credentials, in text or quiet JSON', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
    const labels = meter.parseEvents('5 switch on /live/xuser1/xpass9/123.ts\n6 token ?token=tk-abc999&username=xuser1&password=xpass9 there\n7 /movie/xuser1/xpass9/77.mkv\n8 /timeshift/xuser1/xpass9/60/2026-11-23:10-00/5.ts\n');
    const text = JSON.stringify(labels);
    assert.ok(!/xuser1|xpass9|tk-abc999/.test(text), text);
    assert.deepEqual(labels.map(l => l.label), ['switch on 123', 'token there', '77', '5']);
    if (!source) { source = path.join(work, 'sync-source.ts'); generate(source); }
    const ev = path.join(work, 'events-xtream.txt');
    fs.writeFileSync(ev, '20.5 switch on /live/xuser1/xpass9/123.ts?token=tk-abc999\n');
    for (const quiet of [false, true]) {
        const lines = [];
        assert.equal(meter.main([source, '--events', ev, ...(quiet ? ['--quiet'] : [])], (l) => lines.push(l)), 0);
        const out = lines.join('\n');
        assert.ok(!/xuser1|xpass9|tk-abc999/.test(out), out.slice(-400));
        assert.match(out, /"label":"switch on 123"/);
    }
});

test('a file with no sound: picture onsets only, and it says so', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
    if (!source) { source = path.join(work, 'sync-source.ts'); generate(source); }
    const silent = path.join(work, 'silent.mp4');
    assert.equal(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-t', '12', '-an', '-c', 'copy', silent]).status, 0);
    const lines = [];
    assert.equal(meter.main([silent], (l) => lines.push(l)), 0);
    assert.match(lines[0], /no sound in this file; picture onsets only \(1[01]\)/);
    assert.match(lines[lines.length - 1], /^AVSYNC \{"file":"silent.mp4","audio":false/);
});
