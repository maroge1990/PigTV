const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FakeEvent } = require('./helpers/fakeDom');
const { browser, answer, assertNoScores, page } = require('./helpers/sportWeb');

// #323 review of step 1 (high, Codex): the scores must leave the page as soon as a refresh's preference read says hidden or
// fails, and while the choice is unknown (a return to the page, the tab shown again), however long the answer takes; they
// come back only when this refresh's preference read and its answer have both finished.
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);

function harness() {
    const queue = { prefs: [], front: [] };
    const b = browser({ request: (m, url) => {
        if (url === '/sports/pages/preferences') { const d = deferred(); queue.prefs.push(d); return d.promise; }
        if (url === '/sports/front') { const d = deferred(); queue.front.push(d); return d.promise; }
        return new Promise(() => {}); // the catalogue, /info: never needed here
    } });
    const p = page(b, {});
    return { b, p, queue, html: () => p.root.innerHTML };
}
async function shown(h) {
    const first = h.p.show('');
    await tick();
    h.queue.prefs.shift().resolve({ spoilerFree: false });
    await tick();
    h.queue.front.shift().resolve(answer());
    await first;
    assert.match(h.html(), />47</, 'shown to begin with');
}

test('a refresh whose preference read says hidden takes the scores off at once, while its answer never comes', async () => {
    const h = harness();
    await shown(h);
    const again = h.p.refresh();
    await tick();
    assert.match(h.html(), />47</, 'nothing changes while the read is out (the choice was shown)');
    h.queue.prefs.shift().resolve({ spoilerFree: true });
    await tick(); await tick();
    assertNoScores(h.html(), 'hidden before the answer comes');
    assert.match(h.html(), /Scores hidden/);
    assert.equal(h.queue.front.length, 1, 'the answer is still out, and never comes');
    void again;
});

test('a refresh whose preference read fails takes the scores off at once', async () => {
    const h = harness();
    await shown(h);
    h.p.refresh();
    await tick();
    h.queue.prefs.shift().reject(new Error('offline'));
    await tick(); await tick();
    assertNoScores(h.html(), 'the read failed');
});

test('the tab shown again forgets the choice: hidden at once, shown again only when both reads have answered', async () => {
    const h = harness();
    await shown(h);
    h.b.document.hidden = true;
    h.b.document.dispatchEvent(new FakeEvent('visibilitychange'));
    h.b.document.hidden = false;
    h.b.document.dispatchEvent(new FakeEvent('visibilitychange'));
    await tick();
    assertNoScores(h.html(), 'resumed, the read not answered');
    h.queue.prefs.shift().resolve({ spoilerFree: false });
    await tick(); await tick();
    assertNoScores(h.html(), 'the read says shown but this refresh\'s answer has not come');
    h.queue.front.shift().resolve(answer());
    await tick(); await tick();
    assert.match(h.html(), />47</, 'both have answered: shown');
});

test('returning to Sport draws the cached answer hidden until this visit\'s reads answer', async () => {
    const h = harness();
    await shown(h);
    h.p.hide();
    h.p.show('');
    await tick();
    assertNoScores(h.html(), 'the cached answer, on return');
    h.queue.prefs.shift().resolve({ spoilerFree: false });
    await tick(); await tick();
    assertNoScores(h.html(), 'still waiting for the answer');
});
