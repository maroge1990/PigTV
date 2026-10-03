/**
 * R09: the sport event build, run on a worker thread (see sportsEvents.js).
 *
 * buildEvents() reads every visible channel and 108 hours of its programmes and classifies each
 * - 0.3-1.1 s of synchronous work on a 1,000-channel guide. On the main thread that is a second
 * in which no live HLS segment is served. Here it blocks only this thread.
 *
 * The worker has its own READ-ONLY connection to the same SQLite file (db/sqlite.js, workerData
 * flag; WAL lets it read while the main thread writes), so nothing is copied across: the main
 * thread sends { id, from, follow } and gets back the finished events as plain data - in parts,
 * not one message: receiving a message costs the main thread a structured-clone of all of it
 * (tens of ms for 10,000 events), so the channels go first, then the events a slice at a time
 * naming their channels by key, then a closing message (sportsEvents.js puts them together).
 * What
 * cannot be done here stays on the main thread: the route's decorateChannels (it WRITES the
 * logo cache) runs there on the channels the events name.
 *
 * The services this build reads keep small in-memory caches (the marked sport categories, the
 * admin's EPG mappings, channel health) that the main thread invalidates when IT changes them;
 * this thread cannot see that, so every build starts by dropping them and reading afresh.
 */
const { parentPort } = require('worker_threads');
const sportsEvents = require('./sportsEvents');
const sportCategories = require('./sportCategories');
const epgMapping = require('./epgMapping');
const channelHealth = require('./channelHealth');

const PART = 250; // channels or events per message: a few ms to receive

parentPort.on('message', ({ id, from, follow }) => {
    try {
        sportCategories.reset();
        epgMapping.reset();
        channelHealth.reset();
        const t0 = process.hrtime.bigint();
        const built = sportsEvents.buildEvents({ from, follow });
        const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
        // the channels once each (events share them), then the events
        const channels = new Map();
        for (const ev of built.events) for (const ch of ev.channels) channels.set(ch.key, ch);
        const all = [...channels.values()];
        for (let i = 0; i < all.length; i += PART) parentPort.postMessage({ id, channels: all.slice(i, i + PART) });
        for (let i = 0; i < built.events.length; i += PART) {
            parentPort.postMessage({ id, events: built.events.slice(i, i + PART).map(ev => ({ ...ev, channels: ev.channels.map(ch => ch.key) })) });
        }
        parentPort.postMessage({ id, done: { from: built.from, channelCount: built.channelCount, programmeCount: built.programmeCount, buildMs } });
    } catch (err) {
        parentPort.postMessage({ id, error: err && err.message ? err.message : String(err) });
    }
});
