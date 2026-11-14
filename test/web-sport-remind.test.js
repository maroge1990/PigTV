const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, page } = require('./helpers/sportWeb');

// #323 review of step 1 (medium): "Remind me" plays the game when its channel starts showing it, while Sport is open.
// Cancel, leaving Sport or a newer Remind me ends it: a timer, or the refresh it waits for, that finds it ended does
// nothing (before, it still jumped to Live TV, or threw on the cleared reminder).
const deferred = () => { let resolve; const promise = new Promise((a) => { resolve = a; }); return { promise, resolve }; };
const tick = () => new Promise(setImmediate);

async function harness(front = answer()) {
    let hold = null;
    const b = browser({ request: (m, url) => {
        if (url === '/sports/pages/preferences') return Promise.resolve({ spoilerFree: false });
        if (url === '/sports/front') return hold ? hold.promise.then(() => front) : Promise.resolve(front);
        return new Promise(() => {});
    } });
    const p = page(b, {});
    await p.show('');
    const timers = [];
    b.context.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    const watched = [];
    p.watch = (id) => { watched.push(id); };
    return { b, p, timers, watched, holdNext: () => { hold = deferred(); return hold; }, release: () => { const h = hold; hold = null; h.resolve(); } };
}
const cancelOf = (b) => b.context.toasts.at(-1)[1].action.run;

test('Cancel on the notice ends the reminder: its timer does nothing', async () => {
    const h = await harness();
    h.p.remind('nxt');
    const fire = h.timers.find(t => t.ms > 60000).fn;
    cancelOf(h.b)();
    await fire();
    assert.deepEqual(h.watched, []);
    assert.equal(h.p.waiting, null);
});

test('Cancel, or leaving Sport, while the timer\'s refresh is out: nothing plays and nothing throws', async () => {
    for (const end of ['cancel', 'leave']) {
        const h = await harness();
        h.p.remind('nxt');
        const fire = h.timers.find(t => t.ms > 60000).fn;
        h.holdNext();
        const running = fire();
        await tick();
        if (end === 'cancel') cancelOf(h.b)(); else h.p.hide();
        h.release();
        await running;
        assert.deepEqual(h.watched, [], `${end}: no jump to Live TV`);
    }
});

test('a newer Remind me replaces the older one: the older timer does nothing', async () => {
    const h = await harness();
    h.p.remind('nxt');
    const first = h.timers.find(t => t.ms > 60000).fn;
    h.p.remind('nxt');
    await first();
    assert.deepEqual(h.watched, []);
    assert.ok(h.p.waiting, 'the newer one still waits');
});

test('Remind me less than a minute before the start waits for it, rather than failing to Watch too early', async () => {
    const front = answer();
    const g = front.games.find(x => x.id === 'nxt');
    g.start = NOW + 30000; g.channels[0].start = NOW + 30000; g.channels[0].end = NOW + 7230000;
    const h = await harness(front);
    h.p.remind('nxt');
    assert.deepEqual(h.watched, [], 'not played before its channel shows it');
    assert.ok(h.p.waiting, 'it waits');
    const wait = h.timers.at(-1).ms;
    assert.ok(wait > 0 && wait <= 30000, `the timer is set for the start (${wait} ms)`);
    assert.match(h.b.context.toasts.at(-1)[0], /plays on Stan Sport 2 at /);
});
