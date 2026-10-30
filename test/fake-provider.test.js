const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

// scripts/fake-provider.js (docs/FAKE-PROVIDER.md): a local Xtream look-alike for end-to-end testing.
// (a) What it serves goes through the server's OWN ingest: a real syncSource() of an Xtream primary
// and an Xtream backup (two instances, overlapping names), the M3U and XMLTV parsers, the account
// parser, sport events and provider routing. (b) Its streams are real MPEG-TS from ffmpeg, probed by
// the server's probe, shared between readers, stopped when idle, and its failure channels fail the way
// they say. (b) skips without ffmpeg. Sandbox copy of the server, as in backup-sync.test.js.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-fake-provider-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.env.PIGTV_SPORT_FIXTURES = '0'; // no ESPN: nothing here may leave the machine
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');
const xtreamApi = load('services/xtreamApi');
const m3uParser = load('services/m3uParser');
const epgParser = load('services/epgParser');
const providerAccounts = load('services/providerAccounts');
const providerRouting = load('services/providerRouting');
const sportsEvents = load('services/sportsEvents');
const { providerStreamId } = load('services/stableIds');
const { probeStream, analyzeProbeResult } = load('services/streamProbe');
const { adtsObjectType } = load('services/adtsProfile');
sportsEvents._buildInline(true);

const { createFakeProvider } = require('../scripts/fake-provider');

const HOUR = 3600 * 1000;
const STALL_S = 5;
const CLOSE_S = 5;
let fakeA, fakeB, baseA, baseB, sourceA, sourceB;
const LOGIN = { user: 'tester', pass: 'secret' };

const until = async (fn, ms = 15000, every = 100) => {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) return v;
        await new Promise(r => setTimeout(r, every));
    }
};
const getJson = async (url) => (await fetch(url)).json();

/** Open a stream and keep reading; returns { status, chunks(), bytes(), ended(), close() }. */
function openStream(url) {
    return new Promise((resolve, reject) => {
        const parts = [];
        let total = 0;
        let endedAt = null;
        const req = http.get(url, res => {
            res.on('data', d => { parts.push(d); total += d.length; });
            const end = () => { if (endedAt === null) endedAt = Date.now(); };
            res.on('end', end); res.on('close', end); res.on('error', end);
            resolve({ status: res.statusCode, data: () => Buffer.concat(parts), bytes: () => total, ended: () => endedAt !== null, close: () => req.destroy() });
        });
        req.on('error', reject);
    });
}

before(async () => {
    fakeA = createFakeProvider({ profile: 'a', ...LOGIN, channels: 2, quiet: true, maxConnections: 20, lingerMs: 1000, stallAfter: STALL_S, closeAfter: CLOSE_S });
    // the same failure timings, so B's test channels carry the names A's link to
    fakeB = createFakeProvider({ profile: 'b', ...LOGIN, channels: 0, quiet: true, maxConnections: 20, lingerMs: 1000, stallAfter: STALL_S, closeAfter: CLOSE_S });
    baseA = await fakeA.listen(0, '127.0.0.1');
    baseB = await fakeB.listen(0, '127.0.0.1');
    sourceA = await db.sources.create({ type: 'xtream', name: 'Fake A', url: baseA, username: LOGIN.user, password: LOGIN.pass });
    await sync.syncSource(sourceA.id);
    sourceB = await db.sources.create({ type: 'xtream', name: 'Fake B', url: baseB, username: LOGIN.user, password: LOGIN.pass, role: 'backup', priority: 1 });
    await sync.syncSource(sourceB.id);
});

after(async () => {
    await fakeA?.close();
    await fakeB?.close();
    try { await sportsEvents.shutdown?.(); } catch { /* no worker */ }
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// ---- (a) the server's own ingest ---------------------------------------------------------------------

test('the account reply parses with the server\'s account parser', async () => {
    const reply = await xtreamApi.authenticate(baseA, LOGIN.user, LOGIN.pass);
    const account = providerAccounts.parseAccountReply(reply);
    assert.equal(account.status, 'Active');
    assert.equal(account.max_connections, 20);
    assert.ok(account.exp_date > Date.now() + 300 * 24 * HOUR, 'a subscription a year out');
    // A wrong password is an auth:0 reply, as real panels give
    const refused = await getJson(`${baseA}/player_api.php?username=x&password=y`);
    assert.throws(() => providerAccounts.parseAccountReply(refused), /rejected the login/);
});

test('a real Xtream sync of the primary fills the library, categories and guide', async () => {
    const d = sqlite.getDb();
    const statuses = Object.fromEntries(d.prepare('SELECT type, status FROM sync_status WHERE source_id = ?').all(sourceA.id).map(r => [r.type, r.status]));
    assert.deepEqual(statuses, { all: 'success', epg: 'success' });
    const rows = d.prepare(`SELECT item_id, name, category_id, stable_id, tvg_id FROM playlist_items WHERE source_id = ? AND type = 'live'`).all(sourceA.id);
    assert.equal(rows.length, fakeA.lineup.length);
    const f1 = rows.find(r => r.name === 'UK| SKY SPORTS F1 UHD/4K');
    assert.ok(f1, 'the UHD channel by its provider name');
    assert.equal(f1.stable_id, `s${f1.item_id}`);
    assert.equal(f1.tvg_id, 'skysportsf1.uk');
    assert.equal(d.prepare(`SELECT COUNT(*) n FROM categories WHERE source_id = ? AND type = 'live'`).get(sourceA.id).n, 7);
    // Guide: the 24 h behind to 72 h ahead, from the epg_live view (never epg_programs)
    const span = d.prepare(`SELECT MIN(start_time) a, MAX(end_time) b, COUNT(*) n FROM epg_live WHERE source_id = ? AND channel_id = 'skysportsf1.uk'`).get(sourceA.id);
    assert.ok(span.n > 50, `${span.n} programmes`);
    assert.ok(span.a <= Date.now() - 23 * HOUR && span.b >= Date.now() + 71 * HOUR, 'covers now-24h to now+72h');
});

test('the M3U and XMLTV parse with the server\'s parsers, ids agree, no programme overlaps', async () => {
    const q = `username=${LOGIN.user}&password=${LOGIN.pass}`;
    const channels = [];
    for await (const batch of m3uParser.fetchAndParseStreaming(`${baseA}/get.php?${q}&type=m3u_plus&output=ts`)) channels.push(...batch.channels);
    assert.equal(channels.length, fakeA.lineup.length);
    for (const c of channels) {
        const lined = fakeA.lineup.find(l => String(l.id) === providerStreamId(c.url));
        assert.ok(lined, `stream id from ${c.name}`);
        assert.equal(c.groupTitle, lined.catName);
        if (lined.tvg) assert.equal(c.tvgId, lined.tvg); // (the parser invents an id for a line without one)
    }
    const programmes = [];
    let guideChannels = [];
    for await (const batch of epgParser.fetchAndParseStreaming(`${baseA}/xmltv.php?${q}`)) {
        if (batch.channels?.length) guideChannels = batch.channels;
        programmes.push(...batch.programmes);
    }
    const guideIds = new Set(guideChannels.map(c => c.id));
    for (const l of fakeA.lineup) if (l.tvg) assert.ok(guideIds.has(l.tvg), `guide carries ${l.tvg}`);
    const byChannel = new Map();
    for (const p of programmes) (byChannel.get(p.channelId) || byChannel.set(p.channelId, []).get(p.channelId)).push(p);
    for (const [id, list] of byChannel) {
        list.sort((x, y) => x.start - y.start);
        for (let i = 1; i < list.length; i++) assert.ok(list[i].start >= list[i - 1].stop, `${id}: ${list[i - 1].title} overlaps ${list[i].title}`);
    }
    // the M3U variant names .m3u8 streams
    const hls = [];
    for await (const batch of m3uParser.fetchAndParseStreaming(`${baseA}/get.php?${q}&type=m3u_plus&output=m3u8`)) hls.push(...batch.channels);
    assert.ok(hls.every(c => /\.m3u8$/.test(c.url)));
});

test('sport: live now and starting within the hour, quality-ordered channels, replays told apart', async () => {
    // The fake anchors its sport schedule on the half hour it started in; 5 min after that keeps the
    // "starts within the hour" games in the future even when the run straddles a half hour.
    const now = Date.parse(fakeA.status().anchor) + 5 * 60 * 1000;
    const { events } = await sportsEvents.eventsFor({ hours: 6, now });
    // titles are cleaned ("Mexico City Grand Prix"); the guide's own titles are the aliases
    const find = (re, kind = 'event') => events.find(e => e.kind === kind && e.aliases.some(t => re.test(t)));
    const race = find(/Mexico City Grand Prix - Race$/);
    assert.ok(race, `an F1 race among: ${events.map(e => e.title).join(' | ')}`);
    assert.equal(race.live, true);
    assert.equal(race.kind, 'event');
    // UHD first, SD last (sportsEvents.qualityFromName: FHD counts as HD)
    const qualities = race.channels.map(c => c.quality);
    assert.equal(qualities[0], 'UHD', JSON.stringify(race.channels.map(c => c.name)));
    assert.equal(qualities[qualities.length - 1], 'SD');
    assert.ok(race.channels.length >= 5, 'four F1 channels and Main Event merged into one event');
    assert.equal(find(/Collingwood/).live, true);
    assert.equal(find(/Australia v India/).live, true);
    const nfl = find(/Chiefs/);
    assert.ok(nfl && !nfl.live && nfl.start > now && nfl.start <= now + HOUR, 'the NFL game starts within the hour');
    const epl = find(/Arsenal/);
    assert.ok(epl && !epl.live && epl.start <= now + HOUR);
    assert.ok(find(/NFL Replay/, 'replay'), 'a replay is a replay');
    // the same game later on another channel, titled "(Live)": a replay by the first-airing rule
    assert.ok(find(/Arsenal v Chelsea \(Live\)/, 'replay'));
    assert.ok(find(/Race Replay/, 'replay'));
});

test('a second instance (profile b) syncs as a backup and is linked to the primary\'s channels', async () => {
    const d = sqlite.getDb();
    assert.equal(d.prepare(`SELECT COUNT(*) n FROM playlist_items WHERE source_id = ?`).get(sourceB.id).n, 0, 'a backup is not in the library');
    assert.equal(d.prepare(`SELECT COUNT(*) n FROM backup_channels WHERE source_id = ?`).get(sourceB.id).n, fakeB.lineup.length);
    const hd = fakeA.lineup.find(c => c.name === 'UK| SKY SPORTS F1 HD');
    const route = await providerRouting.plan(sourceA.id, String(hd.id));
    assert.equal(route.candidates[0].providerId, sourceA.id);
    assert.match(route.candidates[0].url, new RegExp(`/live/${LOGIN.user}/${LOGIN.pass}/${hd.id}\\.ts$`));
    assert.ok(route.candidates.some(c => c.providerId === sourceB.id), `B backs it up: ${JSON.stringify(route.candidates.map(c => c.via))}`);
    // every failure channel is linked to B's at once (no admin approval), so it can fail over
    for (const name of ['UK| TEST OFFLINE 404', `UK| TEST STALLS AFTER ${STALL_S}S`, `UK| TEST CLOSES AFTER ${CLOSE_S}S`, 'UK| TEST BLACK SCREEN HD']) {
        const plan = await providerRouting.plan(sourceA.id, String(fakeA.lineup.find(c => c.name === name).id));
        assert.ok(plan.candidates.some(c => c.providerId === sourceB.id), `${name} -> B`);
    }
});

// ---- (b) the streams ----------------------------------------------------------------------------------

const live = (fake, base, name, ext = 'ts') => `${base}/live/${LOGIN.user}/${LOGIN.pass}/${fake.lineup.find(c => c.name === name).id}.${ext}`;

test('a live stream is MPEG-TS the server\'s probe reads as H.264 + AAC', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    const raw = await probeStream(live(fakeA, baseA, 'UK| SKY SPORTS F1 HD'), 'ffprobe', null, 20000);
    const info = analyzeProbeResult(raw, 'x', {});
    assert.equal(info.video, 'h264', JSON.stringify(info));
    assert.equal(info.audio, 'aac', JSON.stringify(info));
    assert.equal(info.height, 360);
});

test('readers share one generator, a late joiner starts on a packet boundary, idle stops it', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    const url = live(fakeA, baseA, 'AU| FOX FOOTY HD');
    const first = await openStream(url);
    assert.equal(first.status, 200);
    assert.ok(await until(() => first.bytes() > 50000), 'the first reader gets data');
    const second = await openStream(url);
    assert.ok(await until(() => second.bytes() > 20000), 'the second reader gets data');
    const id = fakeA.lineup.find(c => c.name === 'AU| FOX FOOTY HD').id;
    const gens = fakeA.status().generators.filter(g => g.id === id);
    assert.equal(gens.length, 1);
    assert.equal(gens[0].readers, 2);
    assert.equal(gens[0].starts, 1, 'one ffmpeg for both');
    const data = second.data();
    for (let i = 0; i + 188 <= data.length; i += 188) assert.equal(data[i], 0x47, `sync byte at ${i}`);
    first.close(); second.close();
    assert.ok(await until(() => !fakeA.status().generators.some(g => g.id === id), 8000), 'stopped after the linger');
});

test('the failure channels: stall keeps the connection silent, close drops it, offline is a 404', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    const stall = await openStream(live(fakeA, baseA, `UK| TEST STALLS AFTER ${STALL_S}S`));
    const close = await openStream(live(fakeA, baseA, `UK| TEST CLOSES AFTER ${CLOSE_S}S`));
    const opened = Date.now();
    assert.equal((await fetch(live(fakeA, baseA, 'UK| TEST OFFLINE 404'))).status, 404);
    assert.ok(await until(() => close.ended(), (CLOSE_S + 10) * 1000), 'the closing channel closed');
    assert.ok(close.bytes() > 0, 'after sending something');
    assert.ok(Date.now() - opened >= (CLOSE_S - 1) * 1000, 'not before its time');
    await until(() => Date.now() - opened > (STALL_S + 1.5) * 1000, 20000);
    const n = stall.bytes();
    assert.ok(n > 0, 'the stalling channel sent first');
    await new Promise(r => setTimeout(r, 2000));
    assert.equal(stall.bytes(), n, 'then nothing');
    assert.equal(stall.ended(), false, 'with the connection still open');
    stall.close();
    // B's channel of the same name plays: something for A to fail over to
    const b = await openStream(live(fakeB, baseB, `UK: TEST STALLS AFTER ${STALL_S}S`));
    assert.equal(b.status, 200);
    b.close();
});

test('HE-AAC channels: one labelled AAC-LC, one labelled AAC Main (the Strong8K FOX case)', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    for (const [name, objectType] of [['UK| TEST HE-AAC AUDIO HD', 2], ['UK| TEST HE-AAC LABELLED MAIN HD', 1]]) {
        const s = await openStream(live(fakeA, baseA, name));
        let type = null;
        await until(() => { type = s.bytes() > 30000 ? adtsObjectType(s.data()) : null; return type !== null; });
        s.close();
        assert.equal(type, objectType, name);
    }
});

test('the connection limit refuses the next stream with a 403, and the account counts it', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    const small = createFakeProvider({ profile: 'a', ...LOGIN, channels: 0, quiet: true, maxConnections: 1, lingerMs: 200 });
    const base = await small.listen(0, '127.0.0.1');
    try {
        const one = await openStream(live(small, base, 'UK| BBC ONE HD'));
        assert.equal(one.status, 200);
        assert.equal((await fetch(live(small, base, 'UK| ITV1 HD'))).status, 403);
        const reply = await getJson(`${base}/player_api.php?username=${LOGIN.user}&password=${LOGIN.pass}`);
        assert.equal(reply.user_info.active_cons, '1');
        one.close();
    } finally {
        await small.close();
    }
});

test('the .m3u8 variant is an HLS playlist of segments from the same generator', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    const r = await fetch(live(fakeA, baseA, 'UK| BBC ONE HD', 'm3u8'));
    assert.equal(r.status, 200);
    const text = await r.text();
    const seg = text.split('\n').find(l => l.startsWith('/hls/'));
    assert.ok(seg, text);
    const s = await fetch(baseA + seg);
    assert.equal(s.status, 200);
    const buf = Buffer.from(await s.arrayBuffer());
    assert.equal(buf[0], 0x47);
});
