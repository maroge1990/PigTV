const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The real player script, with timers we control instead of waiting fifteen seconds.
function makePlayer(videoOverrides = {}) {
    const timers = [];
    const context = vm.createContext({
        window: {}, URL, console: { ...console, warn() {}, error() {} },
        setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }),
        clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8'), context);
    const reports = [];
    const video = {
        currentSrc: 'http://pigtv.local/api/remux?url=http%3A%2F%2Fprovider.example%2Flive%2Fu%2Fp%2F1.ts&token=secret',
        getAttribute(name) { return name === 'src' ? this.currentSrc : null; },
        error: null, paused: false, currentTime: 0, networkState: 2, readyState: 0,
        buffered: { length: 0, end() { throw new Error('none'); } },
        ...videoOverrides
    };
    const player = Object.assign(Object.create(context.window.VideoPlayer.prototype), {
        video, hls: null, currentStrategy: 'remux', reportClientEvent: (p) => reports.push(p)
    });
    const fire = (i = timers.length - 1) => { if (!timers[i].cleared) timers[i].fn(); };
    return { player, video, timers, reports, fire };
}

test('loading a source starts a fifteen second watch; no source, no watch', () => {
    const { player, timers } = makePlayer();
    player.armStartWatch();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 15000);

    const empty = makePlayer({ currentSrc: '' });
    empty.player.armStartWatch();
    assert.equal(empty.timers.length, 0);
});

test('playing cancels it, and arming again replaces the previous watch', () => {
    const { player, timers, reports, fire } = makePlayer();
    player.armStartWatch();
    player.clearStartWatch(); // what the "playing" event does
    fire();
    assert.equal(reports.length, 0, 'it started playing in time');

    player.armStartWatch();
    player.armStartWatch();
    assert.equal(timers.filter(t => !t.cleared).length, 1, 'only the latest load is being watched');
});

test('a load that never starts is reported once, with what the element knows and no secrets', () => {
    const { player, reports, fire } = makePlayer({ networkState: 2, readyState: 0 });
    player.armStartWatch();
    fire();
    assert.equal(reports.length, 1);
    const report = reports[0];
    assert.equal(report.event, 'start-timeout');
    assert.equal(report.waitedSec, 15);
    assert.equal(report.strategy, 'remux');
    assert.equal(report.path, '/api/remux');
    assert.equal(report.readyState, 0);
    const everything = JSON.stringify(report);
    for (const secret of ['provider.example', 'secret', 'token=', 'url=']) assert.ok(!everything.includes(secret), secret);

    player.armStartWatch();
    fire(); // the same source again is not reported twice
    assert.equal(reports.length, 1);
});

test('innocent explanations are not reported: paused, already moving, source replaced or cleared', () => {
    let { player, reports, fire } = makePlayer({ paused: true });
    player.armStartWatch(); fire();
    assert.equal(reports.length, 0, 'paused: autoplay was refused, or the user paused');

    ({ player, reports, fire } = makePlayer({ currentTime: 3.2 }));
    player.armStartWatch(); fire();
    assert.equal(reports.length, 0, 'it has in fact been playing');

    let ctx = makePlayer();
    ctx.player.armStartWatch();
    ctx.video.currentSrc = 'http://pigtv.local/api/remux?url=other';
    ctx.fire();
    assert.equal(ctx.reports.length, 0, 'a different load is watched by its own timer');

    ctx = makePlayer();
    ctx.player.armStartWatch();
    ctx.video.getAttribute = () => '';
    ctx.fire();
    assert.equal(ctx.reports.length, 0, 'the source was cleared (channel change)');
});
