const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #275: the web app's minute timers run only while what they redraw can be seen: Live TV's now/next text while Live TV
// is the page shown, the Guide's now-line while the Guide is, and neither while the tab is hidden.
const js = (f) => fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf8');

function browser(files) {
    const timers = new Map();
    let next = 1;
    const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], getElementById: () => null };
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        window: {}, document,
        setTimeout, clearTimeout,
        setInterval: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
        clearInterval: (id) => { timers.delete(id); }
    });
    loadUi(context);
    for (const f of files) vm.runInContext(js(f), context);
    return { c: context, document, timers, tick: () => [...timers.values()].forEach((t) => t.fn()) };
}

function channelList() {
    const b = browser(['components/ChannelList.js']);
    const list = Object.create(b.c.window.ChannelList.prototype);
    let redraws = 0;
    list.updateVisibleEpgInfo = () => { redraws++; };
    return { ...b, list, redraws: () => redraws };
}

test('Live TV now/next: no timer until Live TV is shown; it stops when the page is left', () => {
    const { list, timers } = channelList();
    list.syncEpgRefreshTimer();
    assert.equal(timers.size, 0, 'nothing runs before Live TV is shown');
    list.setEpgRefreshActive(true);
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].ms, 60000);
    list.setEpgRefreshActive(true);
    assert.equal(timers.size, 1, 'showing it twice does not stack timers');
    list.setEpgRefreshActive(false);
    assert.equal(timers.size, 0);
});

test('Live TV now/next: a hidden tab stops the timer, and coming back redraws at once', () => {
    const { list, document, timers, redraws } = channelList();
    list.setEpgRefreshActive(true);
    const atStart = redraws();
    document.visibilityState = 'hidden';
    list.syncEpgRefreshTimer();
    assert.equal(timers.size, 0, 'no timer while hidden');
    document.visibilityState = 'visible';
    list.syncEpgRefreshTimer();
    assert.equal(timers.size, 1);
    assert.equal(redraws(), atStart + 1, 'redrawn on return');
});

test('Live TV now/next: a hidden tab does not start the timer when the page is shown', () => {
    const { list, document, timers } = channelList();
    document.visibilityState = 'hidden';
    list.setEpgRefreshActive(true);
    assert.equal(timers.size, 0);
});

function guide() {
    const b = browser(['components/EpgGuide.js']);
    const epg = Object.create(b.c.window.EpgGuide.prototype);
    let moves = 0;
    epg.updateNowIndicator = () => { moves++; };
    return { ...b, epg, moves: () => moves };
}

test('Guide now-line: the minute timer runs only while the Guide is shown, and a redraw never adds another', () => {
    const { epg, timers } = guide();
    epg.syncNowIndicatorTimer(); // what every render ends with
    assert.equal(timers.size, 0, 'a render while the Guide is not shown arms nothing');
    epg.setNowIndicatorActive(true);
    assert.equal(timers.size, 1);
    epg.syncNowIndicatorTimer(); epg.syncNowIndicatorTimer();
    assert.equal(timers.size, 1, 'renders re-sync, they do not stack timers');
    epg.setNowIndicatorActive(false);
    assert.equal(timers.size, 0);
});

test('Guide now-line: a hidden tab stops the timer and coming back moves the line at once', () => {
    const { epg, document, timers, moves } = guide();
    epg.setNowIndicatorActive(true);
    const atStart = moves();
    document.visibilityState = 'hidden';
    epg.syncNowIndicatorTimer();
    assert.equal(timers.size, 0);
    document.visibilityState = 'visible';
    epg.syncNowIndicatorTimer();
    assert.equal(timers.size, 1);
    assert.equal(moves(), atStart + 1);
});

test('LivePage and GuidePage switch their timers on show and off hide; both components listen for visibilitychange', async () => {
    const calls = [];
    const b = browser(['pages/LivePage.js', 'pages/Guide.js']);
    const app = {
        channelList: { channels: [1], setEpgRefreshActive: (a) => calls.push(['list', a]) },
        epgGuide: { loaded: true, setNowIndicatorActive: (a) => calls.push(['guide', a]), render() {}, refreshTick() {}, ensureLoaded: async () => {} }
    };
    const live = new b.c.window.LivePage(app), guidePage = new b.c.window.GuidePage(app);
    await live.show(); live.hide();
    await guidePage.show(); guidePage.hide();
    assert.deepEqual(calls, [['list', true], ['list', false], ['guide', true], ['guide', false]]);
    for (const f of ['components/ChannelList.js', 'components/EpgGuide.js']) assert.match(js(f), /addEventListener\?\.\('visibilitychange'/);
});

test('EpgGuide background refresh: starting it twice leaves one interval and one visibility listener', () => {
    const b = browser(['components/EpgGuide.js']);
    let listeners = 0;
    b.document.addEventListener = () => { listeners++; };
    const epg = Object.create(b.c.window.EpgGuide.prototype);
    epg.startBackgroundRefresh(); epg.startBackgroundRefresh();
    assert.equal(b.timers.size, 1);
    assert.equal(listeners, 1);
});
