const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #239 (0485): /api/recordings/active was polled by the recording banner (every 30 s) and by the Sport page (every
// 20-60 s), each on its own timer. One feed now: every subscriber shares one request per interval, none while the tab
// is hidden, one at once when it is shown again.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

function feed({ hidden = false } = {}) {
    const doc = { hidden, listeners: [], addEventListener(t, fn) { this.listeners.push([t, fn]); } };
    const timers = { active: new Map(), next: 1 };
    const context = vm.createContext({ console });
    context.window = context;
    vm.runInContext(js('recordingsFeed.js'), context);
    let asked = 0;
    const f = new context.RecordingsFeed({
        fetch: async () => { asked++; return [{ id: asked }]; }, interval: 30000, doc,
        timers: { setInterval: (fn) => { const id = timers.next++; timers.active.set(id, fn); return id; },
                  clearInterval: (id) => timers.active.delete(id) }
    });
    const tick = async () => { for (const fn of [...timers.active.values()]) fn(); await new Promise(r => setImmediate(r)); };
    const visibility = (value) => { doc.hidden = value; for (const [t, fn] of doc.listeners) if (t === 'visibilitychange') fn(); };
    return { f, asked: () => asked, tick, visibility, timers };
}
const settle = () => new Promise(r => setImmediate(r));

test('two subscribers make one request per interval, and both are told', async () => {
    const h = feed();
    const seen = { banner: 0, sport: 0 };
    h.f.subscribe(() => seen.banner++);
    h.f.subscribe(() => seen.sport++);
    await settle();
    assert.equal(h.asked(), 1, 'one request at once for both');
    await h.tick(); await h.tick();
    assert.equal(h.asked(), 3, 'then one per interval, not one per subscriber');
    assert.equal(h.timers.active.size, 1, 'one timer');
    assert.ok(seen.banner >= 3 && seen.sport >= 3);
});

test('nothing while the tab is hidden; at once when it is shown; a refresh in flight is shared', async () => {
    const h = feed({ hidden: true });
    h.f.subscribe(() => {});
    await settle();
    assert.equal(h.asked(), 0, 'hidden: not asked');
    assert.equal(h.timers.active.size, 0);
    h.visibility(false); await settle();
    assert.equal(h.asked(), 1, 'shown: asked at once');
    await Promise.all([h.f.refresh(), h.f.refresh()]);
    assert.equal(h.asked(), 2, 'two refreshes at the same moment: one request');
    h.visibility(true);
    assert.equal(h.timers.active.size, 0, 'hidden again: the timer stops');
});

test('the last subscriber leaving stops the poll; a late subscriber gets the latest answer at once', async () => {
    const h = feed();
    const off = h.f.subscribe(() => {});
    await settle();
    let late = null;
    h.f.subscribe((rows) => { late = rows; })();
    assert.deepEqual(late && late.map(r => r.id), [1], 'the latest rows, without a request');
    off();
    assert.equal(h.timers.active.size, 0);
});

test('the Sport page and the banner ask through the feed, never on a timer of their own', () => {
    const sports = js('pages/SportsPage.js');
    assert.doesNotMatch(sports, /API\.recordings\.getActive/);
    assert.match(sports, /const feed=this\.app\.recordingsFeed[\s\S]{0,600}feed\.subscribe\(/);
    // the player's conflict check asks nothing while paused or in a hidden tab
    assert.match(js('components/VideoPlayer.js'), /async checkConflict\(\) \{[\s\S]{0,200}if \(this\.video\.paused \|\| document\.hidden/);
    const app = js('app.js');
    assert.doesNotMatch(app, /API\.recordings\.getActive/);
    assert.match(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), /<script src="\/js\/recordingsFeed\.js[^"]*"><\/script>\s*<script src="\/js\/app\.js/);
});

test("the Sport page keeps taking the feed's rows across dashboard reloads, and stops on another account or after leaving (0485 Codex round 1)", () => {
    let token = 'account-a';
    const root = { replaceChildren() {}, querySelector: () => null, textContent: '' };
    const context = vm.createContext({ console, setTimeout, clearTimeout, performance: { now: () => 0 }, localStorage: { getItem: () => token },
        window: { addEventListener() {} }, document: { hidden: false, addEventListener() {}, getElementById: () => root },
        API: { sports: {}, request: async () => ({}) } });
    vm.runInContext(js('pages/SportsPage.js') + '\nglobalThis.SportsPage = SportsPage;', context);
    const feed = { fn: null, subscribe(fn) { this.fn = fn; return () => { this.fn = null; }; } };
    const page = new context.SportsPage({ recordingsFeed: feed, currentPage: 'sports' });
    let renders = 0;
    page.render = () => { renders++; };
    page.state.active = true;
    page.watchRecordings();
    feed.fn([{ id: 1 }]);
    assert.deepEqual(page.recordings.map(r => r.id), [1]);
    page.state.serial += 3; // three dashboard loads (each 20 s) between two feed updates
    feed.fn([{ id: 1 }, { id: 2 }]);
    assert.deepEqual(page.recordings.map(r => r.id), [1, 2], 'still current after the dashboard reloads');
    const keep = feed.fn;
    token = 'account-b';
    keep([{ id: 9 }]);
    assert.deepEqual(page.recordings.map(r => r.id), [1, 2], 'another account: ignored');
    token = 'account-a';
    page.suspend();
    assert.equal(feed.fn, null, 'leaving Sport unsubscribes');
    keep([{ id: 7 }]);
    assert.ok(!page.recordings.some(r => r.id === 7), 'a late answer after leaving is ignored');
    assert.ok(renders >= 2);
});

