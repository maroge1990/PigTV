const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0159 (D): sportsEvents' event list is built off the request path. buildEvents()
// is measured at ~0.3-1.1 s on 1,000 channels and runs synchronously, blocking the
// event loop that also serves live HLS segments - a request whose cache key had
// gone stale used to pay for that build inline. Requests are now always served the
// last built result; a rebuild for a new key runs in the background (setImmediate),
// triggered by an EPG sync landing, a follow-list change, and a timer aligned to
// the 5-minute bucket. The one case that still builds synchronously is the very
// first request ever (nothing cached at all yet).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sports-bg-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sportsEvents = load('services/sportsEvents');
const epgParser = load('services/epgParser');
const sync = load('services/syncService');

after(() => {
    sportsEvents.stopBackgroundRebuilds();
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

// A background rebuild is one setImmediate away; draining twice also lets whatever
// its own `finally` does (clearing buildInFlight) settle before the next test's
// assertions, so tests never see another test's still-pending rebuild land mid-way.
async function settle() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

test('a request during a background rebuild is served the previous result, not a blocking rebuild', async () => {
    sportsEvents.reset();
    const now = Date.now();
    const first = sportsEvents.eventsFor({ hours: 72, now });
    const builds = sportsEvents.stats.builds;

    // Exactly what setFollow() does: bumps the cache key and starts a background
    // rebuild (setImmediate) - which, before the next `await`, has definitely not
    // run yet.
    sportsEvents.setFollow(['Chiefs']);
    const duringRebuild = sportsEvents.eventsFor({ hours: 72, now });

    assert.deepEqual(duringRebuild, first, 'the previous result, not a fresh (blocking) build');
    assert.equal(sportsEvents.stats.builds, builds, 'no synchronous rebuild for this request');

    await settle();
    sportsEvents.setFollow([]); // cleanup
    await settle();
});

test('once the background rebuild finishes, the next request sees the fresh result', async () => {
    sportsEvents.reset();
    const now = Date.now();
    sportsEvents.eventsFor({ hours: 72, now });
    const builds = sportsEvents.stats.builds;

    sportsEvents.setFollow(['Chiefs']);
    await settle();
    assert.equal(sportsEvents.stats.builds, builds + 1, 'the background build ran exactly once');

    sportsEvents.eventsFor({ hours: 72, now });
    assert.equal(sportsEvents.stats.builds, builds + 1, 'the request found it already fresh; no second build');

    sportsEvents.setFollow([]);
    await settle();
});

test('scheduleRebuild never overlaps itself for the same key', async () => {
    sportsEvents.reset();
    const now = Date.now();
    sportsEvents.eventsFor({ hours: 72, now }); // caches `now`'s bucket
    const builds = sportsEvents.stats.builds;

    // A different 5-minute bucket, so the key really is stale and scheduleRebuild
    // has something to do (calling it again at `now`'s own, already-cached key
    // would just be a no-op for an unrelated reason).
    const laterBucket = now + 6 * 60 * 1000;
    sportsEvents.scheduleRebuild(laterBucket);
    sportsEvents.scheduleRebuild(laterBucket); // the same key, already in flight: must be a no-op
    await settle();

    assert.equal(sportsEvents.stats.builds, builds + 1, 'exactly one build for two scheduleRebuild calls at the same key');
});

test('an EPG sync landing schedules a background rebuild of the sport event list', async () => {
    sportsEvents.reset();
    sportsEvents.eventsFor({ hours: 72 }); // seed a cached result
    const builds = sportsEvents.stats.builds;

    epgParser.fetchAndParseStreaming = async function* () {
        yield {
            channels: [],
            programmes: [{ channelId: 'bbc1', start: new Date(Date.now() + 1000), stop: new Date(Date.now() + 2000), title: 'A Programme' }]
        };
    };
    await sync.syncEpgFromUrl(555, 'http://feed.invalid/epg.xml');
    await settle();

    assert.equal(sportsEvents.stats.builds, builds + 1, 'the sync triggered exactly one background rebuild, not a request-time one');
});

test('startBackgroundRebuilds/stopBackgroundRebuilds: the timer can be armed and stopped without error, idempotently', () => {
    sportsEvents.startBackgroundRebuilds();
    sportsEvents.startBackgroundRebuilds(); // idempotent: must not arm a second timer
    sportsEvents.stopBackgroundRebuilds();
    sportsEvents.stopBackgroundRebuilds(); // idempotent the other way too
});

test('reset() still clears everything, including any in-flight background rebuild marker', async () => {
    sportsEvents.reset();
    sportsEvents.eventsFor({ hours: 72 });
    sportsEvents.setFollow(['Chiefs']);
    sportsEvents.reset(); // right on top of the still-in-flight rebuild above
    const builds = sportsEvents.stats.builds;
    sportsEvents.eventsFor({ hours: 72 }); // nothing cached after reset(): builds synchronously, as always
    assert.equal(sportsEvents.stats.builds, builds + 1);

    await settle(); // let the earlier, now-orphaned 'Chiefs' rebuild land and get out of the way
    sportsEvents.setFollow([]);
    await settle();
});
