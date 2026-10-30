#!/usr/bin/env node
/**
 * A fake IPTV provider (docs/FAKE-PROVIDER.md): an Xtream Codes look-alike that runs entirely on
 * this machine, so the real server (and the Apple app in a simulator) can be tested end to end
 * without the real feed. Node built-ins and ffmpeg only: no npm packages, so it runs from a bare
 * node:24 image.
 *
 *   node scripts/fake-provider.js [--port 8090] [--host 127.0.0.1] [--profile a|b]
 *                                 [--channels 4] [--user pigtv --pass fake]
 *
 * Serves what server/services/xtreamApi.js, m3uParser.js and epgParser.js read:
 *   /player_api.php            account (no action), get_live_categories, get_live_streams,
 *                              get_short_epg; VOD and series actions answer [] (none carried)
 *   /get.php                   the M3U (type=m3u|m3u_plus, output=ts|m3u8)
 *   /xmltv.php                 XMLTV, the 24 h before now to 72 h after, sport included
 *   /epgenius.m3u              an EPGenius-style curated M3U with #EXT-X-CREDENTIALS (a backup's id overlay)
 *   /live/<u>/<p>/<id>.ts      MPEG-TS from ffmpeg, one generator per channel shared by its readers,
 *   /<u>/<p>/<id>              started on the first reader and stopped when the last has gone
 *   /live/<u>/<p>/<id>.m3u8    HLS remuxed from that same generator (no second encode)
 *   /logos/<id>.png            a plain coloured square per channel
 *   GET /fake/status           what is running (readers, ffmpeg pids, bytes); no login
 *   POST /fake/fail?stream=<id>&mode=close|stall|404|ok   break a channel while it plays
 *
 * --profile b is a second provider with other names ("VIP: SKY SPORTS F1 SD"), other stream ids
 * and the same guide ids, for running two instances as a primary and a backup. Its TEST channels
 * play normally, so a failure on A can fail over to B.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TS_PACKET = 188;

// ---- the lineup ------------------------------------------------------------------------------------

const PROFILES = {
    a: {
        title: 'FakeTV A', idBase: 1000, catBase: 100,
        categories: { ukSport: 'UK| SPORTS', auSport: 'AU| SPORTS', usSport: 'US| SPORTS', ukTv: 'UK| ENTERTAINMENT', auTv: 'AU| GENERAL', test: 'TEST| DIAGNOSTICS', extra: 'EXTRA| FILLER' }
    },
    b: {
        title: 'FakeTV B', idBase: 5000, catBase: 300,
        categories: { ukSport: 'VIP: UK SPORT', auSport: 'AU: SPORT ᴴᴰ', usSport: 'US: SPORT', ukTv: 'UK: TV', auTv: 'AU: TV', test: 'VIP: TEST', extra: 'EXTRA: FILLER' }
    }
};
const CATEGORY_ORDER = ['ukSport', 'auSport', 'usSport', 'ukTv', 'auTv', 'test', 'extra'];

// One row per channel slot; a profile without a name for it does not carry it. `kind` is how the
// stream behaves (normal unless given per profile); `uhd` channels use --uhd-size.
const LINEUP = [
    { cat: 'ukSport', tvg: null, a: '##### SKY SPORTS #####', kind: 'separator' },
    { cat: 'ukSport', tvg: 'skysportsf1.uk', a: 'UK| SKY SPORTS F1 UHD/4K', b: '|UK| Sky Sports F1 4K', uhd: true },
    { cat: 'ukSport', tvg: 'skysportsf1.uk', a: 'UK| SKY SPORTS F1 FHD', b: '|UK| Sky Sports F1 FHD' },
    { cat: 'ukSport', tvg: 'skysportsf1.uk', a: 'UK| SKY SPORTS F1 HD', b: 'VIP: SKY SPORTS F1 HD' },
    { cat: 'ukSport', tvg: 'skysportsf1.uk', a: 'UK| SKY SPORTS F1 SD', b: 'VIP: SKY SPORTS F1 SD' },
    { cat: 'ukSport', tvg: 'skysportsmainevent.uk', a: 'UK| SKY SPORTS MAIN EVENT HD', b: 'VIP: SKY SPORTS MAIN EVENT SD' },
    { cat: 'ukSport', tvg: 'skysportscricket.uk', a: 'UK| SKY SPORTS CRICKET HD', b: 'VIP: SKY SPORTS CRICKET SD' },
    { cat: 'ukSport', tvg: 'skysportspremierleague.uk', a: 'UK| SKY SPORTS PREMIER LEAGUE FHD', b: '|UK| Sky Sports Premier League FHD' },
    { cat: 'ukSport', tvg: 'tntsports1.uk', a: 'UK| TNT SPORTS 1 HD', b: 'VIP: TNT SPORT 1 SD' },
    { cat: 'auSport', tvg: 'foxfooty.au', a: 'AU| FOX FOOTY HD', b: 'AU: FOX FOOTY FHD' },
    { cat: 'auSport', tvg: 'foxcricket.au', a: 'AU| FOX CRICKET HD', b: 'AU: FOX CRICKET FHD' },
    { cat: 'auSport', tvg: null, a: 'AU| KAYO SPORTS 1 HD' }, // no guide id: an unmatched channel
    { cat: 'usSport', tvg: 'nflnetwork.us', a: 'US| NFL NETWORK HD', b: 'US: NFL NETWORK FHD' },
    { cat: 'usSport', tvg: 'espn.us', a: 'US| ESPN HD', b: 'US: ESPN HD' },
    { cat: 'usSport', tvg: 'espn.us', a: 'US| ESPN UHD', uhd: true },
    { cat: 'ukTv', tvg: 'bbcone.uk', a: 'UK| BBC ONE HD', b: 'UK: BBC ONE HD' },
    { cat: 'ukTv', tvg: 'itv1.uk', a: 'UK| ITV1 HD', b: 'UK: ITV 1 HD' },
    { cat: 'ukTv', tvg: 'channel4.uk', a: 'UK| CHANNEL 4 SD' },
    { cat: 'auTv', tvg: 'abcnews.au', a: 'AU| ABC NEWS HD', b: 'AU: ABC NEWS HD' },
    { cat: 'auTv', tvg: 'nine.au', a: 'AU| CHANNEL 9 HD', b: 'AU: NINE HD' },
    // Failure modes (A only). B carries the same channels under names the server links to A's
    // automatically ("UK| X" and "UK: X" are one raw name), and they play normally there, so a
    // failure on A fails over to B.
    { cat: 'test', tvg: 'test.stall', a: 'UK| TEST STALLS AFTER {stall}S', b: 'UK: TEST STALLS AFTER {stall}S', kind: { a: 'stall' } },
    { cat: 'test', tvg: 'test.close', a: 'UK| TEST CLOSES AFTER {close}S', b: 'UK: TEST CLOSES AFTER {close}S', kind: { a: 'close' } },
    { cat: 'test', tvg: 'test.offline', a: 'UK| TEST OFFLINE 404', b: 'UK: TEST OFFLINE 404', kind: { a: 'offline' } },
    { cat: 'test', tvg: 'test.black', a: 'UK| TEST BLACK SCREEN HD', b: 'UK: TEST BLACK SCREEN HD', kind: { a: 'black' } },
    { cat: 'test', tvg: 'test.heaac', a: 'UK| TEST HE-AAC AUDIO HD', b: 'UK: TEST HE-AAC AUDIO HD', kind: 'heaac' },
    { cat: 'test', tvg: 'test.aacmain', a: 'UK| TEST HE-AAC LABELLED MAIN HD', kind: 'aacmain' }
];

// XMLTV display names, by guide id.
const GUIDE_NAMES = {
    'skysportsf1.uk': 'Sky Sports F1', 'skysportsmainevent.uk': 'Sky Sports Main Event', 'skysportscricket.uk': 'Sky Sports Cricket',
    'skysportspremierleague.uk': 'Sky Sports Premier League', 'tntsports1.uk': 'TNT Sports 1', 'foxfooty.au': 'Fox Footy',
    'foxcricket.au': 'Fox Cricket', 'nflnetwork.us': 'NFL Network', 'espn.us': 'ESPN', 'bbcone.uk': 'BBC One', 'itv1.uk': 'ITV1',
    'channel4.uk': 'Channel 4', 'abcnews.au': 'ABC News', 'nine.au': 'Channel 9', 'test.stall': 'Test: Stall', 'test.close': 'Test: Close',
    'test.offline': 'Test: Offline', 'test.black': 'Test: Black', 'test.heaac': 'Test: HE-AAC', 'test.aacmain': 'Test: AAC Main label'
};

/** The channels one profile carries: [{ id, name, tvg, catId, catName, kind, uhd }]. */
function buildLineup(profileKey, { extra = 4, stallAfter = 20, closeAfter = 20 } = {}) {
    const profile = PROFILES[profileKey];
    if (!profile) throw new Error(`Unknown profile "${profileKey}" (a or b)`);
    const catId = (key) => String(profile.catBase + CATEGORY_ORDER.indexOf(key) + 1);
    const out = [];
    LINEUP.forEach((row, i) => {
        const name = row[profileKey];
        if (!name) return;
        const kind = typeof row.kind === 'object' ? (row.kind[profileKey] || 'normal') : (row.kind || 'normal');
        out.push({
            id: profile.idBase + i + 1,
            name: name.replace('{stall}', stallAfter).replace('{close}', closeAfter),
            tvg: row.tvg, catKey: row.cat, catId: catId(row.cat), catName: profile.categories[row.cat], kind, uhd: !!row.uhd
        });
    });
    for (let i = 1; i <= extra; i++) {
        const n = String(i).padStart(3, '0');
        out.push({ id: profile.idBase + 500 + i, name: `${profileKey === 'a' ? 'EXTRA|' : 'EXTRA:'} FILLER ${n} HD`, tvg: `filler${n}.fake`,
            catKey: 'extra', catId: catId('extra'), catName: profile.categories.extra, kind: 'normal', uhd: false });
    }
    return out;
}

// ---- the guide --------------------------------------------------------------------------------------

const SPORT = ['Sport'];
// Sport events, relative to the anchor (the half hour the provider started in, moved forward every
// --reanchor hours). [guide ids, start (min), length (min), title, categories, flag]. `live` writes
// <live/> (sportsClassify.resolveLive believes it whatever the league's usual hours); `previously-shown`
// writes that flag. Titles differ a little across channels, as real guides do; the server merges them.
const F1_GP = 'Mexico City Grand Prix';
const EVENTS = [
    // F1: a weekend in progress, the race live now on four F1 channels and Main Event.
    [['skysportsf1.uk'], -26 * 60, 60, `Formula 1: ${F1_GP} - Practice 3`, [...SPORT, 'Motor Racing', 'Formula 1'], 'live'],
    [['skysportsf1.uk'], -23 * 60, 90, `Formula 1: ${F1_GP} - Qualifying`, [...SPORT, 'Motor Racing', 'Formula 1'], 'live'],
    [['skysportsf1.uk'], -60, 150, `Formula 1: ${F1_GP} - Race`, [...SPORT, 'Motor Racing', 'Formula 1'], 'live'],
    [['skysportsmainevent.uk'], -60, 150, `Live F1: ${F1_GP} Race`, [...SPORT, 'Formula 1'], 'live'],
    [['skysportsf1.uk'], 6 * 60, 120, `Formula 1: ${F1_GP} - Race Replay`, [...SPORT, 'Motor Racing'], 'previously-shown'],
    [['skysportsf1.uk'], 3 * 60, 60, 'The F1 Show', [...SPORT, 'Magazine'], null],
    [['skysportsf1.uk', 'skysportsmainevent.uk'], 48 * 60, 60, 'Formula 1: Brazilian Grand Prix - Practice 1', [...SPORT, 'Motor Racing', 'Formula 1'], 'live'],
    // Cricket: a Test in progress on two channels (two providers' worth of naming).
    [['skysportscricket.uk', 'foxcricket.au'], -3 * 60, 7 * 60, 'Australia v India - 1st Test, Day 2', [...SPORT, 'Cricket'], 'live'],
    [['skysportscricket.uk', 'foxcricket.au'], 21 * 60, 7 * 60, 'Australia v India - 1st Test, Day 3', [...SPORT, 'Cricket'], 'live'],
    // AFL: one live now, one starting within the hour, then a magazine.
    [['foxfooty.au'], -30, 150, 'AFL: Collingwood v Carlton', [...SPORT, 'Australian Rules Football'], 'live'],
    [['foxfooty.au'], 150, 60, 'AFL 360', [...SPORT, 'Talk'], null],
    [['foxfooty.au'], 24 * 60 + 30, 150, 'AFL: Brisbane Lions v Geelong Cats', [...SPORT, 'Australian Rules Football'], 'live'],
    // EPL: starts in 30 min on two channels; a Champions League game tomorrow.
    [['skysportspremierleague.uk'], 30, 120, 'Premier League: Arsenal v Chelsea', [...SPORT, 'Football'], 'live'],
    [['skysportsmainevent.uk'], 150, 120, 'Premier League: Arsenal v Chelsea (Live)', [...SPORT, 'Football'], null],
    [['tntsports1.uk'], 30, 120, 'Live Premier League: Arsenal vs Chelsea', [...SPORT, 'Football'], 'live'],
    [['tntsports1.uk'], 26 * 60, 120, 'UEFA Champions League: Real Madrid v Bayern Munich', [...SPORT, 'Football'], 'live'],
    [['skysportspremierleague.uk'], 27 * 60, 120, 'Premier League: Liverpool v Manchester City', [...SPORT, 'Football'], 'live'],
    // NFL and NBA: one starting in 30 min, one tomorrow, an earlier game's replay.
    [['nflnetwork.us', 'espn.us'], 30, 210, 'NFL: Kansas City Chiefs vs Buffalo Bills', [...SPORT, 'American Football'], 'live'],
    [['nflnetwork.us'], -20 * 60, 180, 'NFL: Dallas Cowboys vs Philadelphia Eagles', [...SPORT, 'American Football'], 'live'],
    [['nflnetwork.us'], 5 * 60, 180, 'NFL Replay: Dallas Cowboys vs Philadelphia Eagles', [...SPORT, 'American Football'], 'previously-shown'],
    [['nflnetwork.us'], 27 * 60, 210, 'NFL: Green Bay Packers vs Chicago Bears', [...SPORT, 'American Football'], 'live'],
    [['espn.us'], 4 * 60, 150, 'NBA: Boston Celtics vs Los Angeles Lakers', [...SPORT, 'Basketball'], 'live']
];

const FILLER = {
    sport: [['Sports Centre', 'News'], ['Golf: European Tour Highlights', 'Golf'], ['Racing Weekly', 'Magazine'], ['Classic Matches', 'Replay'],
        ['Sports Tonight', 'News'], ['Tennis: Masters Highlights', 'Tennis'], ['The Debate', 'Talk'], ['Darts: Grand Slam Highlights', 'Darts']],
    news: [['Morning News', 'News'], ['World Report', 'News'], ['Business Today', 'News'], ['Weather Watch', 'News'], ['The Interview', 'Talk']],
    general: [['The Cooking Hour', 'Lifestyle'], ['Wildlife: Rivers of Life', 'Documentary'], ['Quiz Night', 'Game Show'], ['Harbour Lights', 'Drama'],
        ['Movie: The Long Road', 'Movies'], ['Home Rescue', 'Lifestyle'], ['Local News', 'News'], ['Comedy Hour', 'Comedy'], ['Gardening Australia', 'Lifestyle']],
    test: [['Test Pattern', 'General'], ['Test Card', 'General']]
};

const fillerPool = (tvg) => (/^test\./.test(tvg) ? FILLER.test : /news/.test(tvg) ? FILLER.news
    : /sport|fox|nfl|espn|tnt/.test(tvg) ? FILLER.sport : FILLER.general);

/** A small deterministic hash (the same slot gets the same filler on every request). */
function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

/**
 * Programmes for one guide id between `from` and `to` (ms): the anchored events, filler in
 * between (30 or 60 min, aligned, never the same title twice running). -> [{ start, stop, title,
 * desc, categories, flag, episode }]
 */
function programmesFor(tvg, anchor, from, to) {
    const events = EVENTS.filter(e => e[0].includes(tvg))
        .map(([, s, len, title, categories, flag]) => ({ start: anchor + s * MIN, stop: anchor + (s + len) * MIN, title, categories, flag,
            desc: `${title}. A made-up listing from the fake provider.` }))
        .filter(e => e.stop > from && e.start < to)
        .sort((x, y) => x.start - y.start);
    const pool = fillerPool(tvg);
    const out = [];
    let t = from;
    let last = null;
    while (t < to) {
        const next = events.find(e => e.stop > t);
        if (next && next.start <= t) { out.push(next); t = next.stop; last = next.title; continue; }
        const h = hash(`${tvg}|${t}`);
        let stop = t + ((h & 1) ? HOUR : 30 * MIN);
        if (stop % (30 * MIN)) stop -= stop % (30 * MIN);
        if (next && next.start < stop) stop = next.start;
        if (stop <= t) stop = t + 30 * MIN;
        let pick = pool[(h >>> 1) % pool.length];
        if (pick[0] === last) pick = pool[((h >>> 1) + 1) % pool.length];
        const episode = (h >>> 8) % 3 === 0 ? `S${1 + (h >>> 12) % 5}E${1 + (h >>> 16) % 12}` : null;
        out.push({ start: t, stop, title: pick[0], categories: [pick[1]], flag: null, episode,
            desc: `${pick[0]}${episode ? ` (${episode})` : ''} on ${GUIDE_NAMES[tvg] || tvg}.` });
        last = pick[0];
        t = stop;
    }
    return out;
}

const pad = (n) => String(n).padStart(2, '0');
const xmltvTime = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`; };
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The guide window around `now`: the whole hour 24 h back to the whole hour 72 h on. */
function guideWindow(now) {
    return { from: Math.floor((now - 24 * HOUR) / HOUR) * HOUR, to: Math.ceil((now + 72 * HOUR) / HOUR) * HOUR };
}

function xmltvDocument(lineup, base, anchor, now) {
    const { from, to } = guideWindow(now);
    const ids = [...new Set(lineup.map(c => c.tvg).filter(Boolean))];
    const logoOf = new Map();
    for (const c of lineup) if (c.tvg && !logoOf.has(c.tvg)) logoOf.set(c.tvg, `${base}/logos/${c.id}.png`);
    const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv generator-info-name="pigtv-fake-provider">\n'];
    for (const id of ids) {
        parts.push(`  <channel id="${xml(id)}"><display-name>${xml(GUIDE_NAMES[id] || id)}</display-name><icon src="${xml(logoOf.get(id))}"/></channel>\n`);
    }
    for (const id of ids) {
        for (const p of programmesFor(id, anchor, from, to)) {
            parts.push(`  <programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}" channel="${xml(id)}">` +
                `<title lang="en">${xml(p.title)}</title><desc lang="en">${xml(p.desc)}</desc>` +
                p.categories.map(c => `<category lang="en">${xml(c)}</category>`).join('') +
                (p.episode ? `<episode-num system="onscreen">${p.episode}</episode-num>` : '') +
                (p.flag ? `<${p.flag}/>` : '') + '</programme>\n');
        }
    }
    parts.push('</tv>\n');
    return parts.join('');
}

// ---- logos: a solid-colour PNG, encoded by hand (no dependencies) ----------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
function logoPng(seed, size = 128) {
    const h = hash(String(seed));
    const rgb = [64 + (h & 127), 64 + ((h >>> 8) & 127), 64 + ((h >>> 16) & 127)];
    const row = Buffer.alloc(1 + size * 3);
    const rows = [];
    for (let y = 0; y < size; y++) {
        const band = y > size * 0.4 && y < size * 0.6;
        for (let x = 0; x < size; x++) row.set(band ? [255, 255, 255] : rgb, 1 + x * 3);
        rows.push(Buffer.from(row));
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---- ffmpeg --------------------------------------------------------------------------------------------

/** The name-and-clock overlay (drawtext; %{localtime} is expanded every frame). */
const drawtextFilter = (textFile, width, fontFile) => `drawtext=textfile=${textFile}:expansion=normal${fontFile ? `:fontfile=${fontFile}` : ''}` +
    `:fontsize=${Math.round(width / 24)}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:x=16:y=16`;

/**
 * What this ffmpeg can do: { ffmpeg, drawtext }. Checked once at start (well under a second), with
 * the very overlay the streams use, so a build without drawtext or a font falls back to plain test
 * patterns instead of failing every stream.
 */
function detectFfmpeg(ffmpegPath, fontFile, tmpDir) {
    const run = (args) => spawnSync(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    const version = run(['-hide_banner', '-version']);
    if (version.error || version.status !== 0) return { ffmpeg: false, drawtext: false };
    const textFile = path.join(tmpDir, 'drawtext-check.txt');
    fs.writeFileSync(textFile, 'check\n%{localtime}');
    const drawtext = run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=320x180:duration=0.1',
        '-vf', drawtextFilter(textFile, 320, fontFile), '-f', 'null', '-']);
    return { ffmpeg: true, drawtext: !drawtext.error && drawtext.status === 0 };
}

/** The HE-AAC fixture with every ADTS header's profile set to 0 ("AAC Main"), as Strong8K's FOX feeds label it. */
function relabelAdtsMain(buf) {
    const out = Buffer.from(buf);
    for (let i = 0; i + 7 <= out.length;) {
        if (out[i] !== 0xFF || (out[i + 1] & 0xF6) !== 0xF0) { i++; continue; }
        const len = ((out[i + 3] & 0x03) << 11) | (out[i + 4] << 3) | (out[i + 5] >> 5);
        out[i + 2] &= 0x3F;
        i += Math.max(len, 7);
    }
    return out;
}

function generatorArgs(channel, ctx) {
    const size = channel.uhd ? ctx.uhdSize : ctx.size;
    const [w] = size.split('x').map(Number);
    const kbps = channel.kind === 'black' ? 0 : Math.round(ctx.videoKbps * (w > 700 ? 1.5 : 1));
    // Without drawtext, channels alternate testsrc (its own seconds counter) and testsrc2, told apart
    // by their tone; a hue filter would cost half as much again as the source.
    const pattern = ctx.caps.drawtext || channel.id % 2 === 0 ? 'testsrc2' : 'testsrc';
    const video = channel.kind === 'black' ? `color=c=black:size=${size}:rate=${ctx.fps}` : `${pattern}=size=${size}:rate=${ctx.fps}`;
    const filters = channel.kind !== 'black' && ctx.caps.drawtext ? drawtextFilter(ctx.textFile(channel), w, ctx.fontFile) : null;
    const audioIn = channel.kind === 'heaac' || channel.kind === 'aacmain'
        ? ['-stream_loop', '-1', '-re', '-i', channel.kind === 'heaac' ? ctx.heaacFile : ctx.aacMainFile]
        : ['-re', '-f', 'lavfi', '-i', `sine=frequency=${300 + (channel.id % 10) * 60}:sample_rate=48000`];
    const audioOut = channel.kind === 'heaac' || channel.kind === 'aacmain' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '64k', '-ac', '2'];
    const rate = kbps ? ['-b:v', `${kbps}k`, '-minrate', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps}k`, '-x264-params', 'nal-hrd=cbr']
        : ['-b:v', '40k', '-maxrate', '40k', '-bufsize', '80k'];
    return ['-hide_banner', '-loglevel', 'error', '-nostdin',
        '-re', '-f', 'lavfi', '-i', video, ...audioIn,
        '-map', '0:v', '-map', '1:a', ...(filters ? ['-vf', filters] : []), '-filter_threads', '1',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '1', '-pix_fmt', 'yuv420p',
        '-g', String(ctx.fps * 2), '-keyint_min', String(ctx.fps * 2), '-sc_threshold', '0', ...rate,
        ...audioOut, '-metadata', `service_name=${channel.name}`, '-metadata', `service_provider=${ctx.title}`,
        '-f', 'mpegts', 'pipe:1'];
}

// ---- one generator per channel, shared by its readers ----------------------------------------------

class Feed {
    constructor(channel, ctx) {
        this.channel = channel;
        this.ctx = ctx;
        this.readers = new Set();
        this.proc = null;
        this.bytes = 0;          // since this ffmpeg started: where the next chunk starts, mod 188
        this.lingerTimer = null;
        this.startedAt = null;
        this.starts = 0;
    }

    add(reader) {
        clearTimeout(this.lingerTimer);
        this.lingerTimer = null;
        this.readers.add(reader);
        if (!this.proc) this.start();
    }

    remove(reader) {
        if (!this.readers.delete(reader) || this.readers.size || !this.proc) return;
        clearTimeout(this.lingerTimer);
        this.lingerTimer = setTimeout(() => this.stop('idle'), this.ctx.lingerMs);
        this.lingerTimer.unref?.();
    }

    start() {
        this.bytes = 0;
        this.starts++;
        this.startedAt = Date.now();
        const proc = spawn(this.ctx.ffmpegPath, generatorArgs(this.channel, this.ctx), { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = proc;
        this.ctx.procs.add(proc);
        this.ctx.log(`start ${this.channel.id} "${this.channel.name}" (pid ${proc.pid})`);
        let err = '';
        proc.stderr.on('data', d => { err = (err + d).slice(-2000); });
        proc.stdout.on('data', chunk => {
            if (this.proc !== proc) return; // stopped: a reader that came since has a new ffmpeg
            const at = this.bytes;
            this.bytes += chunk.length;
            for (const r of [...this.readers]) r.push(chunk, at);
        });
        proc.on('error', e => { err += e.message; });
        proc.on('close', (code, signal) => {
            this.ctx.procs.delete(proc);
            if (this.proc !== proc) return; // stopped on purpose
            this.proc = null;
            this.ctx.log(`ffmpeg for ${this.channel.id} ended (${signal || code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`);
            for (const r of [...this.readers]) r.end();
            this.readers.clear();
        });
    }

    /** Stop the generator. It is detached at once, so a reader arriving while it exits starts a new one. */
    stop(why) {
        clearTimeout(this.lingerTimer);
        this.lingerTimer = null;
        const proc = this.proc;
        if (!proc) return;
        this.proc = null;
        this.ctx.log(`stop ${this.channel.id} (${why})`);
        proc.kill('SIGTERM');
        setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 2000).unref?.();
    }
}

/**
 * A reader of a Feed: writes whole TS packets from the first packet boundary it sees. Each reader
 * has its own failure clock (stall: stops sending but keeps the connection; close: drops it).
 */
function tsReader({ write, end, kind, ctx }) {
    let aligned = false;
    const opened = Date.now();
    const reader = {
        stalled: false,
        push(chunk, at) {
            if (reader.stalled || (kind === 'stall' && Date.now() - opened >= ctx.stallAfterMs)) { reader.stalled = true; return; }
            if (kind === 'close' && Date.now() - opened >= ctx.closeAfterMs) { reader.end(); return; }
            let buf = chunk;
            if (!aligned) {
                const skip = (TS_PACKET - (at % TS_PACKET)) % TS_PACKET;
                if (skip >= buf.length) return;
                buf = buf.subarray(skip);
                aligned = true;
            }
            write(buf);
        },
        end
    };
    return reader;
}

// ---- HLS: the same generator, remuxed by a copy ffmpeg into a temporary folder ----------------------

class HlsSession {
    constructor(feed, ctx) {
        this.feed = feed;
        this.ctx = ctx;
        this.dir = fs.mkdtempSync(path.join(ctx.tmpDir, `hls-${feed.channel.id}-`));
        this.lastUsed = Date.now();
        this.proc = spawn(ctx.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'mpegts', '-i', 'pipe:0', '-c', 'copy',
            '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6', '-hls_flags', 'delete_segments+omit_endlist',
            '-hls_segment_filename', path.join(this.dir, 'seg%05d.ts'), path.join(this.dir, 'index.m3u8')], { stdio: ['pipe', 'ignore', 'ignore'] });
        this.proc.stdin.on('error', () => {});
        this.proc.on('close', () => this.close('remuxer ended'));
        this.reader = tsReader({ kind: 'normal', ctx, write: b => { if (!this.proc.stdin.destroyed) this.proc.stdin.write(b); }, end: () => this.close('feed ended') });
        feed.add(this.reader);
    }

    close(why) {
        if (this.closed) return;
        this.closed = true;
        this.ctx.log(`hls ${this.feed.channel.id} closed (${why})`);
        this.feed.remove(this.reader);
        try { this.proc.kill('SIGKILL'); } catch { /* gone */ }
        this.ctx.hls.delete(this.feed.channel.id);
        fs.rm(this.dir, { recursive: true, force: true }, () => {});
    }
}

// ---- the server ----------------------------------------------------------------------------------------

const DEFAULTS = {
    profile: 'a', user: 'pigtv', pass: 'fake', channels: 4, maxConnections: 4, enforceLimit: true, expiresDays: 365,
    size: '640x360', uhdSize: '960x540', fps: 25, videoKbps: 600, lingerMs: 5000, stallAfter: 20, closeAfter: 20,
    reanchorHours: 3, ffmpegPath: 'ffmpeg', fontFile: null, publicUrl: null, quiet: false, anchor: null,
    heaacFile: path.join(__dirname, '..', 'test', 'fixtures', 'synthetic-heaac.aac')
};

/**
 * createFakeProvider(options) -> { listen(port, host) -> base URL, close(), lineup, ctx, status() }.
 * Options as DEFAULTS above (the CLI flags, camel-cased).
 */
function createFakeProvider(options = {}) {
    const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
    const profile = PROFILES[o.profile];
    if (!profile) throw new Error(`Unknown profile "${o.profile}" (a or b)`);
    const startedAt = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-fake-provider-'));
    const caps = detectFfmpeg(o.ffmpegPath, o.fontFile, tmpDir);
    const lineup = buildLineup(o.profile, { extra: o.channels, stallAfter: o.stallAfter, closeAfter: o.closeAfter });
    const byId = new Map(lineup.map(c => [String(c.id), c]));
    const halfHour = (ms) => Math.floor(ms / (30 * MIN)) * 30 * MIN;
    let anchor = halfHour(o.anchor ? new Date(o.anchor).getTime() : startedAt);
    const currentAnchor = (now) => {
        if (!o.anchor && o.reanchorHours > 0 && now - anchor >= o.reanchorHours * HOUR) anchor = halfHour(now);
        return anchor;
    };
    const heaacOk = fs.existsSync(o.heaacFile);
    let aacMainFile = null;
    if (heaacOk) {
        aacMainFile = path.join(tmpDir, 'aac-main-label.aac');
        fs.writeFileSync(aacMainFile, relabelAdtsMain(fs.readFileSync(o.heaacFile)));
    }
    const textFiles = new Map();
    const ctx = {
        title: profile.title, caps, tmpDir, ffmpegPath: o.ffmpegPath, fontFile: o.fontFile, size: o.size, uhdSize: o.uhdSize,
        fps: o.fps, videoKbps: o.videoKbps, lingerMs: o.lingerMs, stallAfterMs: o.stallAfter * 1000, closeAfterMs: o.closeAfter * 1000,
        heaacFile: o.heaacFile, aacMainFile, hls: new Map(), procs: new Set(),
        log: (...a) => { if (!o.quiet) console.log(`[fake ${o.profile}]`, ...a); },
        textFile(channel) {
            if (!textFiles.has(channel.id)) {
                const file = path.join(tmpDir, `text-${channel.id}.txt`);
                // %{localtime} is expanded by drawtext every frame (wall clock, the server's zone).
                fs.writeFileSync(file, `${channel.name}  [${channel.id}]\n${profile.title}  %{localtime}`);
                textFiles.set(channel.id, file);
            }
            return textFiles.get(channel.id);
        }
    };
    const feeds = new Map();
    const feedOf = (channel) => { if (!feeds.has(channel.id)) feeds.set(channel.id, new Feed(channel, ctx)); return feeds.get(channel.id); };
    const overrides = new Map(); // stream id -> 'stall' | '404' (POST /fake/fail)
    const tsConnections = new Set();
    const connectionCount = () => tsConnections.size + ctx.hls.size;
    const requests = { api: 0, m3u: 0, xmltv: 0, live: 0, refused: 0 };

    const hlsReaper = setInterval(() => {
        for (const s of [...ctx.hls.values()]) if (Date.now() - s.lastUsed > 20000) s.close('idle');
    }, 5000);
    hlsReaper.unref?.();

    const baseOf = (req) => o.publicUrl ? o.publicUrl.replace(/\/+$/, '') : `http://${req.headers.host || '127.0.0.1'}`;
    const authed = (u, p) => u === o.user && p === o.pass;
    const send = (res, status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    const json = (res, value) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(value));
    const streamUrl = (base, c, ext = 'ts') => `${base}/live/${encodeURIComponent(o.user)}/${encodeURIComponent(o.pass)}/${c.id}.${ext}`;

    function accountBody(req) {
        const now = Math.floor(Date.now() / 1000);
        const host = new URL(baseOf(req));
        return {
            user_info: { username: o.user, password: o.pass, message: `${profile.title} (fake provider, local only)`, auth: 1, status: 'Active',
                exp_date: String(now + Math.round(o.expiresDays * 86400)), is_trial: '0', active_cons: String(connectionCount()),
                created_at: String(Math.floor(startedAt / 1000)), max_connections: String(o.maxConnections), allowed_output_formats: ['m3u8', 'ts'] },
            server_info: { url: host.hostname, port: host.port || '80', https_port: '', server_protocol: 'http', rtmp_port: '', timezone: 'UTC',
                timestamp_now: now, time_now: sqlTime(Date.now()), process: true }
        };
    }

    function liveStreams(base, categoryId) {
        return lineup.filter(c => !categoryId || c.catId === String(categoryId)).map((c, i) => ({
            num: i + 1, name: c.name, stream_type: 'live', stream_id: c.id, stream_icon: c.kind === 'separator' ? '' : `${base}/logos/${c.id}.png`,
            epg_channel_id: c.tvg, added: String(Math.floor(startedAt / 1000)), is_adult: 0, category_id: c.catId, category_ids: [Number(c.catId)],
            custom_sid: '', tv_archive: 0, direct_source: '', tv_archive_duration: 0
        }));
    }

    function shortEpg(streamId, limit) {
        const c = byId.get(String(streamId));
        if (!c || !c.tvg) return { epg_listings: [] };
        const now = Date.now();
        const b64 = (s) => Buffer.from(String(s)).toString('base64');
        return { epg_listings: programmesFor(c.tvg, currentAnchor(now), now - 4 * HOUR, now + 24 * HOUR).filter(p => p.stop > now).slice(0, limit)
            .map((p, i) => ({ id: String(p.start / 1000 + i), epg_id: '1', title: b64(p.title), lang: 'en', start: sqlTime(p.start), end: sqlTime(p.stop),
                description: b64(p.desc), channel_id: c.tvg, start_timestamp: String(p.start / 1000), stop_timestamp: String(p.stop / 1000) })) };
    }

    function playerApi(req, res, q) {
        requests.api++;
        if (!authed(q.get('username'), q.get('password'))) return json(res, { user_info: { auth: 0 } });
        const base = baseOf(req);
        switch (q.get('action') || '') {
            case '': return json(res, accountBody(req));
            case 'get_live_categories': return json(res, CATEGORY_ORDER
                .filter(k => lineup.some(c => c.catKey === k))
                .map(k => ({ category_id: lineup.find(c => c.catKey === k).catId, category_name: profile.categories[k], parent_id: 0 })));
            case 'get_live_streams': return json(res, liveStreams(base, q.get('category_id')));
            case 'get_short_epg': return json(res, shortEpg(q.get('stream_id'), Math.max(1, Math.min(50, Number(q.get('limit')) || 4))));
            default: return json(res, []); // VOD, series, anything else: none carried
        }
    }

    function m3u(req, res, q, { epgenius = false } = {}) {
        requests.m3u++;
        if (!authed(q.get('username'), q.get('password'))) return send(res, 401, 'text/plain', 'Unauthorized');
        const base = baseOf(req);
        const ext = /^(m3u8|hls)$/i.test(q.get('output') || '') ? 'm3u8' : 'ts';
        const plus = epgenius || q.get('type') !== 'm3u';
        const lines = [`#EXTM3U url-tvg="${base}/xmltv.php?username=${encodeURIComponent(o.user)}&password=${encodeURIComponent(o.pass)}"`];
        if (epgenius) lines.push(`#EXT-X-CREDENTIALS:${JSON.stringify([{ provider: `fake-${o.profile}`, dns: base, username: o.user, password: o.pass }])}`);
        // The EPGenius cut is curated: the sport channels only, with their guide ids.
        for (const c of lineup.filter(ch => !epgenius || (/Sport$/.test(ch.catKey) && ch.tvg))) {
            lines.push(plus
                ? `#EXTINF:-1 tvg-id="${c.tvg || ''}" tvg-name="${c.name}" tvg-logo="${c.kind === 'separator' ? '' : `${base}/logos/${c.id}.png`}" group-title="${c.catName}",${c.name}`
                : `#EXTINF:-1,${c.name}`);
            lines.push(streamUrl(base, c, ext));
        }
        send(res, 200, 'audio/x-mpegurl; charset=utf-8', lines.join('\n') + '\n');
    }

    function live(req, res, user, pass, file) {
        requests.live++;
        const m = /^(\d+)(?:\.(ts|m3u8))?$/.exec(file);
        if (!authed(user, pass)) return send(res, 401, 'text/plain', 'Unauthorized');
        const channel = m && byId.get(m[1]);
        if (!channel) return send(res, 404, 'text/plain', 'Not Found');
        const override = overrides.get(channel.id);
        if (channel.kind === 'offline' || channel.kind === 'separator' || override === '404') return send(res, 404, 'text/plain', 'Not Found');
        if (!caps.ffmpeg) return send(res, 503, 'text/plain', 'This fake provider has no ffmpeg');
        if ((channel.kind === 'heaac' || channel.kind === 'aacmain') && !heaacOk) return send(res, 503, 'text/plain', 'HE-AAC fixture missing');
        const ext = m[2] || 'ts';
        if (ext === 'm3u8') return hlsPlaylist(req, res, channel);
        if (o.enforceLimit && connectionCount() >= o.maxConnections) {
            requests.refused++;
            ctx.log(`refused ${channel.id}: ${connectionCount()} of ${o.maxConnections} connections in use`);
            return send(res, 403, 'text/plain', 'Maximum connections reached');
        }
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
        const feed = feedOf(channel);
        const kind = override === 'stall' ? 'stall-now' : channel.kind;
        const conn = { channel: channel.id, since: Date.now(), bytes: 0, res };
        tsConnections.add(conn);
        const reader = tsReader({
            kind: kind === 'stall-now' ? 'stall' : kind,
            ctx: kind === 'stall-now' ? { ...ctx, stallAfterMs: 0 } : ctx,
            write: (buf) => {
                conn.bytes += buf.length;
                res.write(buf);
                // A reader this far behind is dropped rather than buffered without end.
                if (res.writableLength > 8 * 1024 * 1024) res.destroy();
            },
            end: () => res.destroy()
        });
        conn.reader = reader;
        const done = () => { if (tsConnections.delete(conn)) feed.remove(reader); };
        res.on('close', done);
        feed.add(reader);
    }

    function hlsPlaylist(req, res, channel) {
        let session = ctx.hls.get(channel.id);
        if (!session) {
            if (o.enforceLimit && connectionCount() >= o.maxConnections) { requests.refused++; return send(res, 403, 'text/plain', 'Maximum connections reached'); }
            session = new HlsSession(feedOf(channel), ctx);
            ctx.hls.set(channel.id, session);
        }
        session.lastUsed = Date.now();
        const file = path.join(session.dir, 'index.m3u8');
        const deadline = Date.now() + 15000;
        const attempt = () => {
            if (session.closed) return send(res, 502, 'text/plain', 'The stream ended');
            let text = null;
            try { text = fs.readFileSync(file, 'utf8'); } catch { /* not written yet */ }
            if (text && /#EXTINF/.test(text)) {
                const prefix = `/hls/${encodeURIComponent(o.user)}/${encodeURIComponent(o.pass)}/${channel.id}/`;
                return send(res, 200, 'application/vnd.apple.mpegurl', text.replace(/^(seg\d+\.ts)$/gm, `${prefix}$1`));
            }
            if (Date.now() > deadline) return send(res, 504, 'text/plain', 'No segment yet');
            setTimeout(attempt, 250);
        };
        attempt();
    }

    function hlsSegment(res, user, pass, id, seg) {
        if (!authed(user, pass)) return send(res, 401, 'text/plain', 'Unauthorized');
        const session = ctx.hls.get(Number(id));
        if (!session || !/^seg\d+\.ts$/.test(seg)) return send(res, 404, 'text/plain', 'Not Found');
        session.lastUsed = Date.now();
        fs.readFile(path.join(session.dir, seg), (err, data) => err ? send(res, 404, 'text/plain', 'Not Found') : send(res, 200, 'video/mp2t', data));
    }

    function status() {
        return {
            profile: o.profile, title: profile.title, uptimeSec: Math.round((Date.now() - startedAt) / 1000), anchor: new Date(anchor).toISOString(),
            ffmpeg: caps, channels: lineup.length, maxConnections: o.maxConnections, connections: connectionCount(), requests,
            overrides: Object.fromEntries(overrides),
            generators: [...feeds.values()].filter(f => f.proc).map(f => ({ id: f.channel.id, name: f.channel.name, pid: f.proc.pid,
                readers: f.readers.size, runningSec: Math.round((Date.now() - f.startedAt) / 1000), bytes: f.bytes, starts: f.starts })),
            readers: [...tsConnections].map(c => ({ id: c.channel, sec: Math.round((Date.now() - c.since) / 1000), bytes: c.bytes, stalled: !!c.reader?.stalled })),
            hls: [...ctx.hls.values()].map(s => ({ id: s.feed.channel.id, idleSec: Math.round((Date.now() - s.lastUsed) / 1000) }))
        };
    }

    function fail(res, q) {
        const c = byId.get(String(q.get('stream')));
        const mode = q.get('mode');
        if (!c || !['close', 'stall', '404', 'ok'].includes(mode)) return send(res, 400, 'text/plain', 'stream=<id>&mode=close|stall|404|ok');
        if (mode === 'ok') overrides.delete(c.id); else if (mode !== 'close') overrides.set(c.id, mode);
        for (const conn of [...tsConnections].filter(x => x.channel === c.id)) {
            if (mode === 'stall') conn.reader.stalled = true; else if (mode !== 'ok') conn.res.destroy();
        }
        if (mode === 'close' || mode === '404') ctx.hls.get(c.id)?.close(`failed by request (${mode})`);
        ctx.log(`fail ${c.id}: ${mode}`);
        json(res, { stream: c.id, mode, overrides: Object.fromEntries(overrides) });
    }

    const server = http.createServer((req, res) => {
        let u;
        try { u = new URL(req.url, 'http://local'); } catch { return send(res, 400, 'text/plain', 'Bad request'); }
        const q = u.searchParams;
        const p = u.pathname;
        if (p === '/player_api.php') return playerApi(req, res, q);
        if (p === '/get.php') return m3u(req, res, q);
        if (p === '/epgenius.m3u') return m3u(req, res, q, { epgenius: true });
        if (p === '/xmltv.php') {
            requests.xmltv++;
            if (!authed(q.get('username'), q.get('password'))) return send(res, 401, 'text/plain', 'Unauthorized');
            const now = Date.now();
            return send(res, 200, 'application/xml; charset=utf-8', xmltvDocument(lineup, baseOf(req), currentAnchor(now), now));
        }
        if (p === '/fake/status') return json(res, status());
        if (p === '/fake/fail') return req.method === 'POST' ? fail(res, q) : send(res, 405, 'text/plain', 'POST only');
        let m = /^\/logos\/(\d+)\.png$/.exec(p);
        if (m) return byId.has(m[1]) ? send(res, 200, 'image/png', logoPng(m[1])) : send(res, 404, 'text/plain', 'Not Found');
        m = /^\/hls\/([^/]+)\/([^/]+)\/(\d+)\/([^/]+)$/.exec(p);
        if (m) return hlsSegment(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]), m[3], m[4]);
        m = /^\/(?:live\/)?([^/]+)\/([^/]+)\/([^/]+)$/.exec(p);
        if (m) return live(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]), m[3]);
        send(res, 404, 'text/plain', 'Not Found');
    });

    return {
        server, lineup, ctx, status,
        listen(port = 8090, host = '127.0.0.1') {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    const a = server.address();
                    resolve(`http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${a.port}`);
                });
            });
        },
        async close() {
            clearInterval(hlsReaper);
            for (const s of [...ctx.hls.values()]) s.close('shutdown');
            for (const conn of tsConnections) conn.res.destroy();
            const exits = [...ctx.procs].map(p => new Promise(r => p.once('close', r)));
            for (const f of feeds.values()) f.stop('shutdown');
            await Promise.race([Promise.all(exits), new Promise(r => setTimeout(r, 3000))]);
            server.closeAllConnections?.();
            await new Promise(r => server.close(() => r()));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    };
}

// ---- the command line ------------------------------------------------------------------------------------

const USAGE = `Usage: node scripts/fake-provider.js [options]
  --port N             listen port (8090; 0 = any free port)
  --host H             bind address (127.0.0.1; 0.0.0.0 in a container)
  --profile a|b        which made-up provider (a: "UK| SKY SPORTS F1 HD" names; b: "VIP: ..." names, other ids)
  --user U --pass P    the login (pigtv / fake)
  --channels N         extra filler channels after the fixed lineup (4)
  --max-connections N  the account's connection limit (4); --no-enforce advertises it without refusing
  --expires-days D     subscription end, days from now (365; negative = expired)
  --size WxH           picture size (640x360); --uhd-size for the UHD/4K-named channels (960x540)
  --fps N              frame rate (25); --video-kbps N (600, constant bit rate)
  --linger-ms N        keep a generator this long after its last reader (5000)
  --stall-after S      the stalling test channel stops sending after S s (20); --close-after S (20)
  --reanchor H         move the sport schedule to the current half hour every H hours (3; 0 = never)
  --anchor ISO         fix the sport schedule's anchor (implies no re-anchoring)
  --public-url URL     the address written into listings (default: the request's Host)
  --ffmpeg PATH        ffmpeg binary (ffmpeg); --font FILE a TTF for drawtext if ffmpeg has no default
  --quiet              no log lines`;

function parseArgs(argv) {
    const o = {};
    const num = (v, flag) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${flag} needs a number`); return n; };
    const map = { '--port': ['port', num], '--host': ['host'], '--profile': ['profile'], '--user': ['user'], '--pass': ['pass'],
        '--channels': ['channels', num], '--max-connections': ['maxConnections', num], '--expires-days': ['expiresDays', num],
        '--size': ['size'], '--uhd-size': ['uhdSize'], '--fps': ['fps', num], '--video-kbps': ['videoKbps', num], '--linger-ms': ['lingerMs', num],
        '--stall-after': ['stallAfter', num], '--close-after': ['closeAfter', num], '--reanchor': ['reanchorHours', num], '--anchor': ['anchor'],
        '--public-url': ['publicUrl'], '--ffmpeg': ['ffmpegPath'], '--font': ['fontFile'] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { o.help = true; continue; }
        if (a === '--quiet') { o.quiet = true; continue; }
        if (a === '--no-enforce') { o.enforceLimit = false; continue; }
        const spec = map[a];
        if (!spec) throw new Error(`Unknown option ${a}`);
        if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
        o[spec[0]] = spec[1] ? spec[1](argv[++i], a) : argv[++i];
    }
    return o;
}

async function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(USAGE); process.exit(2); }
    if (opts.help) { console.log(USAGE); return; }
    const { port = 8090, host = '127.0.0.1', ...rest } = opts;
    const fake = createFakeProvider(rest);
    const base = await fake.listen(port, host);
    const o = { ...DEFAULTS, ...rest };
    const caps = fake.ctx.caps;
    console.log(`${fake.ctx.title}: ${fake.lineup.length} channels on ${base} (listening on ${host})`);
    console.log(`  Xtream source: URL ${base}  username ${o.user}  password ${o.pass}`);
    console.log(`  M3U:   ${base}/get.php?username=${o.user}&password=${o.pass}&type=m3u_plus&output=ts`);
    console.log(`  XMLTV: ${base}/xmltv.php?username=${o.user}&password=${o.pass}`);
    console.log(`  status: ${base}/fake/status`);
    if (!caps.ffmpeg) console.log('  WARNING: no ffmpeg found: the API, M3U and guide work, streams answer 503');
    else if (!caps.drawtext) console.log('  note: this ffmpeg has no drawtext: pictures are plain test patterns (no channel name or clock); each channel has its own tone');
    const shutdown = async (sig) => { console.log(`${sig}: stopping`); await fake.close(); process.exit(0); };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { createFakeProvider, buildLineup, programmesFor, xmltvDocument, relabelAdtsMain, generatorArgs, parseArgs, EVENTS, PROFILES };
