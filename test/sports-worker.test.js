const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// R09: the sport event build (0.3-1.1 s on 1,000 channels, synchronous) used to run on the event
// loop that also serves live HLS segments - first inline in a request, then (0159) on
// setImmediate, which is the same loop. It now runs on a worker thread with its own read-only
// database connection. These tests build against 1,000 channels x 30 hourly programmes (a ~0.7 s build) and
// assert the serving loop is never blocked for long meanwhile, that the worker's result is the
// one an inline build gives, that a stale cache is served at once while the rebuild runs, and
// that decorateChannels (which writes the logo cache, so stays on the main thread) still runs.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sports-worker-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const svc = load('services/sportsEvents');

const H = 60 * 60 * 1000;
const NOW = Date.now();
const CHANNELS = 1000;
// The aim is ~50 ms. The margin is for a loaded machine: the whole suite runs files in parallel, and
// a heartbeat that is starved of CPU looks like a stall; inline, this build blocks for 700+ ms.
const MAX_STALL_MS = 150;
const PROGRAMMES = 30;

before(() => {
    const d = sqlite.getDb();
    const insItem = d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, tvg_id, is_hidden)
                               VALUES (?, 701, ?, 'live', ?, 'Bulk', ?, ?, ?, 0)`);
    const insProg = d.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, categories) VALUES (?, 701, ?, ?, ?, ?)');
    const cats = ['["Sport","Football"]', '["Movie"]', '["News"]', '["Sport","Tennis"]', null];
    d.transaction(() => {
        for (let c = 0; c < CHANNELS; c++) {
            insItem.run(`701:w${c}`, `w${c}`, `Weekend ${c}${c % 3 === 0 ? ' HD' : ''}`, c, `sw${c}`, `wknd${c}`);
            for (let p = 0; p < PROGRAMMES; p++) {
                const start = NOW - 6 * H + p * H;
                insProg.run(`wknd${c}`, start, start + H, `Programme ${(c * 7 + p) % 400} v Team ${p % 11}`, cats[(c + p) % cats.length]);
            }
        }
    })();
});

after(() => {
    svc.shutdown();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

/** The longest gap between two ticks of a 5 ms timer while `fn` runs: how long the loop was blocked. */
async function worstStall(fn) {
    let last = performance.now();
    let worst = 0;
    const beat = setInterval(() => {
        const t = performance.now();
        worst = Math.max(worst, t - last - 5);
        last = t;
    }, 5);
    try { await fn(); } finally { clearInterval(beat); }
    return Math.max(worst, performance.now() - last - 5);
}

test('a 1,000-channel build never blocks the event loop (cold start included)', async () => {
    // the build and its hand-over; what a request then does with 3,500+ events (eventsFor's filter
    // and sort) is the request's own cost, not the build's, and is not measured here. A heartbeat
    // starved by an overloaded machine looks like a stall, but a build that really blocks the loop
    // does so every time: pass on the best of three (the first is the cold one, worker start included).
    let stall = Infinity;
    let loopMax = Infinity; // the same, as monitorEventLoopDelay saw it (stats.lastMaxLoopDelayMs)
    for (let attempt = 0; attempt < 3 && !(stall < MAX_STALL_MS && loopMax < MAX_STALL_MS); attempt++) {
        svc.reset();
        stall = Math.min(stall, await worstStall(async () => { await svc.scheduleRebuild(NOW); }));
        loopMax = Math.min(loopMax, svc.stats.lastMaxLoopDelayMs);
    }
    const result = await svc.eventsFor({ hours: 72, now: NOW });
    console.log(`# worker build, ${CHANNELS} channels: ${result.events.length} events; build ${svc.stats.lastBuildMs.toFixed(0)} ms, `
        + `total ${svc.stats.lastTotalMs.toFixed(0)} ms, worst heartbeat stall ${stall.toFixed(1)} ms, `
        + `monitorEventLoopDelay max ${loopMax.toFixed(1)} ms`);
    assert.ok(result.events.length > 1000, 'a real result');
    assert.ok(svc.stats.lastBuildMs > 100, 'a build of this size takes a while, so the stall below means something');
    assert.equal(svc.stats.inlineBuilds, 0, 'built on the worker');
    assert.ok(stall < MAX_STALL_MS, `the event loop stalled for ${stall} ms`);
    assert.ok(loopMax < MAX_STALL_MS, `monitorEventLoopDelay saw ${loopMax} ms`);
});

test('a background rebuild of a warm 1,000-channel cache never blocks the event loop either', async () => {
    svc.reset();
    await svc.eventsFor({ hours: 72, now: NOW });
    const revision = svc.stats.revision;
    let stall = Infinity; // best of three, as above
    for (let attempt = 0; attempt < 3 && !(stall < MAX_STALL_MS); attempt++) {
        stall = Math.min(stall, await worstStall(async () => {
            svc.setFollow(attempt % 2 ? [] : ['Zzyzx Open']); // the key changes: a rebuild starts
            await svc.idle();
        }));
    }
    assert.ok(svc.stats.revision > revision, 'the rebuilds published');
    assert.ok(stall < MAX_STALL_MS, `the event loop stalled for ${stall} ms`);
});

test('the worker\'s events are the ones an inline build gives', async () => {
    svc.reset();
    const viaWorker = (await svc.eventsFor({ hours: 72, now: NOW, include: 'all', withRule: true })).events;
    const bucket = Math.floor(NOW / (5 * 60 * 1000)) * 5 * 60 * 1000;
    const inline = svc.buildEvents({ from: bucket }).events;
    assert.equal(viaWorker.length, inline.filter(e => e.end > NOW && e.start < NOW + 72 * H).length);
    const byId = new Map(inline.map(e => [e.id, e]));
    for (const ev of viaWorker.slice(0, 500)) {
        const mine = byId.get(ev.id);
        assert.ok(mine, `event ${ev.id} also built inline`);
        assert.deepEqual([ev.title, ev.kind, ev.league, ev.start, ev.end, ev.rule, ev.match, ev.kindRule],
            [mine.title, mine.kind, mine.league, mine.start, mine.end, mine.rule, mine.match, mine.kindRule]);
        assert.deepEqual(ev.aliases, mine.aliases);
        assert.equal(ev.channels.length, mine.channels.length);
    }
});

test('a stale cache is served at once while the rebuild runs, then the fresh result is served', async () => {
    svc.reset();
    const before = await svc.eventsFor({ hours: 72, now: NOW });
    const { revision, builds } = svc.stats;

    svc.setFollow(['Zzyzx Open']); // stale: the follow list is part of the key
    const t0 = performance.now();
    const during = await svc.eventsFor({ hours: 72, now: NOW });
    const waited = performance.now() - t0;
    assert.deepEqual(during, before, 'the previous result');
    // answering from the cache is the request's own filter and sort; the rebuild it did not wait for
    // takes several times that, and was still running afterwards (below)
    assert.ok(waited < svc.stats.lastBuildMs, `served in ${waited} ms, a build takes ${svc.stats.lastBuildMs} ms: it did not wait for the rebuild`);
    assert.equal(svc.stats.revision, revision, 'the rebuild had not finished');
    assert.ok(svc.status().building, 'it is running');
    assert.ok(svc.status().staleSinceMs >= 0);

    await svc.idle();
    assert.equal(svc.stats.revision, revision + 1);
    assert.equal(svc.stats.builds, builds + 1);
    assert.equal(svc.status().staleSinceMs, 0, 'current again');
    const after = await svc.eventsFor({ hours: 72, now: NOW });
    assert.ok(after.events.length > 0);
    assert.equal(svc.stats.revision, revision + 1, 'no further build');
    svc.setFollow([]);
    await svc.idle();
});

test('decorateChannels runs on the main thread, once per channel the events name, in slices', async () => {
    svc.reset();
    const calls = [];
    const seen = new Set();
    const mainThread = require('node:worker_threads').isMainThread;
    const decorate = (channels) => {
        calls.push(channels.length);
        for (const ch of channels) { assert.ok(!seen.has(ch), 'each channel once'); seen.add(ch); ch.logo = `/logo/${ch.id}`; }
    };
    const { events } = await svc.eventsFor({ hours: 72, now: NOW, decorateChannels: decorate });
    assert.ok(mainThread);
    assert.ok(calls.length > 1, 'more than one slice');
    assert.ok(calls.every(n => n <= 100), 'bounded slices');
    assert.ok(events.length && events.every(e => e.channels.every(ch => ch.logo === `/logo/${ch.id}`)), 'the decorated logo is in the response');
});

test('the worker\'s database connection is read-only', async () => {
    const { Worker } = require('node:worker_threads');
    const w = new Worker(`
        const { parentPort } = require('worker_threads');
        const { getDb } = require(${JSON.stringify(path.join(sandbox, 'server/db/sqlite'))});
        try { getDb().prepare("INSERT INTO meta (key, value) VALUES ('r09', '1')").run(); parentPort.postMessage('wrote'); }
        catch (e) { parentPort.postMessage(e.code || e.message); }
    `, { eval: true, workerData: { pigtvReadOnlyDb: true } });
    const [message] = await require('node:events').once(w, 'message');
    await w.terminate();
    assert.match(message, /READONLY/);
});

// ---- the per-minute serialised answer: /events costs the serving loop a few ms ----------------
//
// eventsFor() stays as the reference (it is the path /preview takes). eventsResponse() must give the
// bytes of JSON.stringify(eventsFor({ now: <the minute's start> })) for every input that matters:
// hours, include, the user's favourites; and must notice when any of them, or the build, or the
// clock, changes. A request is "the Apple client's": hours=72, a user with a handful of favourites.
const MIN = 60 * 1000;
const MINUTE = Math.floor(NOW / MIN) * MIN;
const insertFavourites = (userId, names) => {
    const d = sqlite.getDb();
    for (const name of names) {
        const row = d.prepare('SELECT item_id, stable_id FROM playlist_items WHERE name = ? AND source_id = 701').get(name);
        d.prepare(`INSERT INTO favorites (user_id, source_id, item_id, item_type, stable_id) VALUES (?, 701, ?, 'channel', ?)`)
            .run(String(userId), row.item_id, row.stable_id);
    }
};
const clearFavourites = (userId) => sqlite.getDb().prepare('DELETE FROM favorites WHERE user_id = ?').run(String(userId));
const reference = async (opts) => JSON.stringify(await svc.eventsFor({ ...opts, now: MINUTE }));
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timeIt = async (fn, n = 5) => { const t = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(); t.push(performance.now() - t0); } return median(t); };

test('the serialised answer is the bytes of eventsFor + JSON.stringify, for several hours, kinds and users', async () => {
    svc.reset();
    insertFavourites('bob', ['Weekend 401', 'Weekend 12 HD', 'Weekend 404', 'Weekend 407']);
    try {
        for (const hours of [1, 6, 24, 72]) {
            for (const include of [undefined, 'all']) {
                for (const userId of [undefined, 'nobody', 'bob']) {
                    const r = await svc.eventsResponse({ hours, userId, include, now: NOW });
                    const want = await reference({ hours, userId, include });
                    assert.equal(r.body.toString(), want, `hours=${hours} include=${include} user=${userId}`);
                }
            }
        }
        // the favourites really do change the order for bob (otherwise the above proves little)
        const plain = await svc.eventsResponse({ hours: 72, userId: 'nobody', now: NOW });
        const bobs = await svc.eventsResponse({ hours: 72, userId: 'bob', now: NOW });
        assert.notEqual(plain.body.toString(), bobs.body.toString());
        assert.notEqual(plain.etag, bobs.etag);
    } finally { clearFavourites('bob'); }
});

test('a second request in the same minute is the cached buffer; the minute rolling over, a favourite and a new build each invalidate', async () => {
    svc.reset();
    clearFavourites('amy');
    const first = await svc.eventsResponse({ hours: 72, userId: 'amy', now: MINUTE + 1000 });
    assert.equal(first.cached, false);
    const again = await svc.eventsResponse({ hours: 72, userId: 'amy', now: MINUTE + 59000 });
    assert.equal(again.cached, true);
    assert.equal(again.body, first.body, 'the same buffer');
    assert.equal(again.etag, first.etag);

    const next = await svc.eventsResponse({ hours: 72, userId: 'amy', now: MINUTE + MIN });
    assert.equal(next.cached, false, 'a new minute');
    assert.notEqual(next.etag, first.etag);
    assert.equal(JSON.parse(next.body).now, MINUTE + MIN);

    insertFavourites('amy', ['Weekend 401']);
    try {
        const fav = await svc.eventsResponse({ hours: 72, userId: 'amy', now: MINUTE + MIN });
        assert.equal(fav.cached, false, 'a favourite was added');
        assert.notEqual(fav.etag, next.etag);
        assert.equal(fav.body.toString(), JSON.stringify(await svc.eventsFor({ hours: 72, userId: 'amy', now: MINUTE + MIN })));
        clearFavourites('amy');
        const gone = await svc.eventsResponse({ hours: 72, userId: 'amy', now: MINUTE + MIN });
        assert.equal(gone.etag, next.etag, 'back to the same answer, the same ETag');
    } finally { clearFavourites('amy'); }

    const revision = svc.stats.revision;
    svc.setFollow(['Zzyzx Open']);
    await svc.idle();
    assert.ok(svc.stats.revision > revision, 'rebuilt (more than once if the request is in a later 5-minute bucket than the clock)');
    const rebuilt = await svc.eventsResponse({ hours: 72, userId: 'amy', now: MINUTE + MIN });
    assert.equal(rebuilt.cached, false, 'a new build');
    assert.notEqual(rebuilt.etag, next.etag);
    svc.setFollow([]);
    await svc.idle();
});

test('the response cache is bounded, and keeps only the current minute and build', async () => {
    svc.reset();
    for (let h = 1; h <= 40; h++) await svc.eventsResponse({ hours: (h % 72) + 1, userId: `u${h}`, now: MINUTE });
    assert.ok(svc.responseCacheSize().entries <= 12, `entries ${svc.responseCacheSize().entries}`);
    const old = svc.responseCacheSize().entries;
    await svc.eventsResponse({ hours: 72, now: MINUTE + MIN });
    assert.equal(svc.responseCacheSize().entries, 1, `the previous minute's ${old} entries are dropped`);
    assert.ok(svc.responseCacheSize().bytes > 0);
    svc.reset();
    assert.equal(svc.responseCacheSize().entries, 0);
});

test('benchmark: the Apple client\'s request (hours=72) on 1,000 channels', async () => {
    svc.reset();
    insertFavourites('apple', ['Weekend 3 HD', 'Weekend 401', 'Weekend 21 HD', 'Weekend 404', 'Weekend 99 HD', 'Weekend 407']);
    try {
        await svc.eventsFor({ hours: 72, userId: 'apple', now: MINUTE }); // built, cached
        const opts = { hours: 72, userId: 'apple', now: MINUTE };

        // before: what the route did on every request, on the main thread, broken down
        const built = (await svc.eventsFor({ ...opts, include: 'all' })).events; // ~ the window's events
        const filterMs = await timeIt(() => { let n = 0; for (const e of built) if (e.end > MINUTE && e.start < MINUTE + 72 * H) n++; return n; });
        const refMs = await timeIt(() => svc.eventsFor(opts)); // filter + live + per-user ordering + object building
        const events = await svc.eventsFor(opts);
        const stringifyMs = await timeIt(() => Buffer.from(JSON.stringify(events)));
        const before = refMs + stringifyMs;

        // after
        svc.reset();
        await svc.eventsFor(opts); // the build, with its prepared halves
        const cold = await timeIt(async () => { svc.clearResponses(); await svc.eventsResponse(opts); }, 5);
        await svc.eventsResponse(opts);
        const warm = await timeIt(() => svc.eventsResponse(opts), 20);
        const body = (await svc.eventsResponse(opts)).body;
        console.log(`# /events hours=72, ${events.events.length} events, ${(body.length / 1e6).toFixed(1)} MB: `
            + `before ${before.toFixed(1)} ms (eventsFor ${refMs.toFixed(1)} of which a bare window filter ${filterMs.toFixed(1)}, `
            + `JSON.stringify+Buffer ${stringifyMs.toFixed(1)}); after: once a minute ${cold.toFixed(1)} ms, repeats ${warm.toFixed(2)} ms`);
        assert.equal(body.toString(), await reference(opts), 'the same bytes');
        assert.ok(warm < 10, `a warm request took ${warm.toFixed(2)} ms of the main thread`);
        assert.ok(cold < before, `a cold miss (${cold.toFixed(1)} ms) is cheaper than before (${before.toFixed(1)} ms)`);
    } finally { clearFavourites('apple'); }
});
