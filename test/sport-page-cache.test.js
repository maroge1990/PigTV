const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// #272 (D-3): the five sport pages kept their own copy of the stale-while-refreshing cache and cleared `refreshing` three
// different ways. NFL and F1 set it to null blindly, so a refresh that outlived a reset() cleared the NEWER refresh's
// marker and let a third build start while the second was still running; League, Cricket and Events compared by
// identity or generation. The one cache (server/services/sportPageCache.js) clears by identity, in a finally.
const { createPageCache } = require('../server/services/sportPageCache');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

function cacheOf(extra = {}) {
    return createPageCache({ label: 'test', ttlOf: (value) => value.ttl ?? 1000, coldWaitMs: 5000, ...extra });
}

test('concurrent callers share one build', async () => {
    const c = cacheOf();
    let builds = 0;
    const gate = deferred();
    const build = () => { builds++; return gate.promise; };
    const a = c.get('k', 0, build), b = c.get('k', 0, build), d = c.get('k', 10, build);
    gate.resolve({ n: 1 });
    const [x, y, z] = await Promise.all([a, b, d]);
    assert.equal(builds, 1);
    assert.deepEqual([x.value.n, y.value.n, z.value.n], [1, 1, 1]);
});

test('TTL: fresh until now - at reaches the ttl, then rebuilt; the ttl comes from the value and the build time', async () => {
    const c = cacheOf({ ttlOf: (value, now) => value.ttl + now });
    let builds = 0;
    const build = () => { builds++; return Promise.resolve({ ttl: 1000 }); };
    await c.get('k', 100, build);                 // ttl 1100
    await c.get('k', 1199, build);
    assert.equal(builds, 1, 'still fresh 1099 ms on');
    await c.get('k', 1200, build);                // stale: served, rebuilt in the background
    await tick();
    assert.equal(builds, 2);
});

test('stale-while-refreshing: a stale entry is returned at once while the rebuild runs; the next call sees the new one', async () => {
    const c = cacheOf();
    await c.get('k', 0, () => Promise.resolve({ v: 'old' }));
    const gate = deferred();
    let prior;
    const stale = await c.get('k', 5000, (p) => { prior = p; return gate.promise; });
    assert.equal(stale.value.v, 'old', 'not held up by the rebuild');
    assert.equal(prior.value.v, 'old', 'the build is handed the stale entry');
    assert.equal(c.inFlight(), 1);
    gate.resolve({ v: 'new' });
    await tick();
    assert.equal((await c.get('k', 5001, () => assert.fail('fresh'))).value.v, 'new');
    assert.equal(c.inFlight(), 0);
});

test('cold: the first caller waits for the build, but only coldWaitMs; the build carries on and is cached', async () => {
    const c = cacheOf({ coldWaitMs: 20 });
    const gate = deferred();
    const t0 = Date.now();
    assert.equal(await c.get('k', 0, () => gate.promise), null, 'nothing yet when the wait ends');
    assert.ok(Date.now() - t0 >= 15);
    assert.equal(c.inFlight(), 1);
    gate.resolve({ v: 1 });
    await tick();
    assert.equal(c.inFlight(), 0);
    assert.equal((await c.get('k', 1, () => assert.fail('cached'))).value.v, 1);
});

test('a build that throws, rejects or returns nothing stores nothing, clears the in-flight marker and is retried', async () => {
    const c = cacheOf();
    const warn = console.warn; const lines = []; console.warn = (...a) => lines.push(a.join(' '));
    try {
        assert.equal(await c.get('k', 0, () => { throw new Error('sync boom'); }), null);
        assert.equal(c.inFlight(), 0, 'cleared after a synchronous throw');
        assert.equal(await c.get('k', 0, () => Promise.reject(new Error('async boom'))), null);
        assert.equal(c.inFlight(), 0, 'cleared after a rejection');
        assert.equal(await c.get('k', 0, () => Promise.resolve(null)), null);
        assert.equal(c.size(), 0, 'ESPN not answering is not cached as success');
    } finally { console.warn = warn; }
    assert.equal(lines.filter(l => /test page refresh failed: (sync|async) boom/.test(l)).length, 2);
    assert.equal((await c.get('k', 0, () => Promise.resolve({ v: 1 }))).value.v, 1, 'the next call tries again');
});

test('a failed rebuild keeps serving the stale entry', async () => {
    const c = cacheOf();
    await c.get('k', 0, () => Promise.resolve({ v: 'kept' }));
    const warn = console.warn; console.warn = () => {};
    try {
        assert.equal((await c.get('k', 5000, () => Promise.reject(new Error('x')))).value.v, 'kept');
        await tick();
    } finally { console.warn = warn; }
    assert.equal(c.inFlight(), 0);
    assert.equal((await c.get('k', 5001, () => Promise.resolve({ v: 'again' }))).value.v, 'kept', 'stale again: served, and rebuilt behind it');
});

test('reset(): a build that outlives it neither stores nor clears the newer build\'s marker', async () => {
    const c = cacheOf();
    const g1 = deferred(), g2 = deferred();
    let builds = 0;
    c.get('k', 0, () => { builds++; return g1.promise; });
    c.reset();
    c.get('k', 0, () => { builds++; return g2.promise; });
    assert.equal(builds, 2);
    g1.resolve({ v: 'old generation' });
    await tick();
    assert.equal(c.size(), 0, 'the old build is not stored');
    assert.equal(c.inFlight(), 1, 'and did not clear the second build\'s marker');
    c.get('k', 0, () => { builds++; return Promise.resolve({ v: 'third' }); });
    assert.equal(builds, 2, 'a third caller joins the second build');
    g2.resolve({ v: 'second' });
    await tick(); await tick();
    assert.equal((await c.get('k', 1, () => assert.fail('cached'))).value.v, 'second');
});

test('keys are separate, and maxEntries drops the oldest stored', async () => {
    const c = cacheOf({ maxEntries: 2 });
    for (const k of ['a', 'b', 'c']) await c.get(k, 0, () => Promise.resolve({ v: k }));
    assert.equal(c.size(), 2);
    let rebuilt = false;
    await c.get('a', 0, () => { rebuilt = true; return Promise.resolve({ v: 'a2' }); });
    assert.equal(rebuilt, true, 'a was dropped');
});

// #297: the score collector has seen a session or event move on from what a page's entry says; the page renews its read.
test('renew(): rebuilds a fresh entry at once and waits for it; at most one build per gap per key, whatever the requests', async () => {
    const c = cacheOf({ ttlOf: () => 600000 });
    let builds = 0;
    const build = () => { builds++; return Promise.resolve({ n: builds }); };
    await c.get('k', 0, build);
    assert.equal((await c.get('k', 1000, build)).value.n, 1, 'fresh for 10 minutes');
    assert.equal((await c.renew('k', 1000, build)).value.n, 2, 'renewed although fresh, and the caller gets the new read');
    for (let t = 1000; t < 31000; t += 1000) await c.renew('k', t, build);
    assert.equal(builds, 2, 'a feed still disagreeing costs no build per request: one per 30 s gap');
    assert.equal((await c.renew('k', 31000, build)).value.n, 3, 'the next gap');
    assert.equal((await c.renew('j', 31000, build)).value.n, 4, 'keys are separate');
});

test('renew(): a slow build is waited for at most waitMs, the old entry returned meanwhile; a failed one keeps it', async () => {
    const c = cacheOf({ ttlOf: () => 600000 });
    await c.get('k', 0, () => Promise.resolve({ v: 'old' }));
    const gate = deferred();
    const r = await c.renew('k', 1000, () => gate.promise, { waitMs: 5 });
    assert.equal(r.value.v, 'old', 'not waited for past waitMs');
    assert.equal((await c.renew('k', 2000, () => assert.fail('one build in flight'))).value.v, 'old', 'a renew joins the build in flight');
    gate.resolve({ v: 'new' });
    await tick();
    assert.equal((await c.get('k', 3000, () => assert.fail('fresh'))).value.v, 'new');
    const warn = console.warn; console.warn = () => {};
    try { assert.equal((await c.renew('k', 40000, () => Promise.reject(new Error('down')))).value.v, 'new', 'a failed renew keeps the entry'); }
    finally { console.warn = warn; }
});

// ---- each page: a build that fails clears its marker, and a refresh outliving reset() leaves the newer one alone ----

const nfl = require('../server/services/sportPageNFL');
const f1 = require('../server/services/sportPageF1');
const league = require('../server/services/sportPageLeague');
const cricket = require('../server/services/sportPageCricket');
const events = require('../server/services/sportPageEvents');
const NOW = Date.parse('2026-10-30T21:42:00Z');
const pages = {
    NFL: { mod: nfl, call: () => nfl.page(NOW, {}) },
    F1: { mod: f1, call: () => f1.page(NOW, {}) },
    League: { mod: league, call: () => league.page('NBA', NOW, {}) },
    Cricket: { mod: cricket, call: () => cricket.page(NOW, { followed: [], leagues: [] }) },
    Events: { mod: events, call: () => events.page('ATP Tour', NOW, { names: [] }) }
};
const originals = Object.fromEntries(Object.entries(pages).map(([k, p]) => [k, p.mod.fetcher.get]));
beforeEach(() => { for (const [k, p] of Object.entries(pages)) { p.mod.reset(); p.mod.fetcher.get = originals[k]; } });

for (const [name, { mod, call }] of Object.entries(pages)) {
    test(`${name} page: a build whose ESPN request throws is not cached and the next request builds again`, async () => {
        const warn = console.warn; console.warn = () => {};
        let asked = 0;
        mod.fetcher.get = () => { asked++; throw new Error('provider exploded'); };
        try {
            assert.deepEqual(await call(), { available: false });
            const first = asked;
            assert.ok(first > 0);
            await tick();
            assert.deepEqual(await call(), { available: false });
            assert.ok(asked > first, 'refreshing was cleared: the second request asked ESPN again');
        } finally { console.warn = warn; }
    });

    test(`${name} page: a refresh that outlives reset() does not clear the newer refresh's marker (no third build)`, async () => {
        const first = deferred(), second = deferred();
        let hold = first.promise, asked = 0;
        mod.fetcher.get = () => { asked++; return hold; };
        const p1 = call();
        const afterFirst = asked;
        assert.ok(afterFirst > 0, 'build 1 asked ESPN');
        mod.reset();
        hold = second.promise;
        const p2 = call();
        const afterSecond = asked;
        assert.ok(afterSecond > afterFirst, 'build 2 asked ESPN');
        first.resolve({ ok: false, error: 'late' });
        for (let i = 0; i < 20; i++) await tick();
        const p3 = call();
        assert.equal(asked, afterSecond, 'a third request joined build 2 instead of starting a third build');
        second.resolve({ ok: false, error: 'late' });
        await Promise.all([p1, p2, p3]);
    });
}
