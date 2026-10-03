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
