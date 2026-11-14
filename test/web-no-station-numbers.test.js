const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #320 (1): the channel number is not drawn in the Live TV list or the TV Guide rows, so the name and logo get the room.
// The number stays in the data (the line-up editor, typing a number to jump). The real ChannelList and EpgGuide scripts.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

function load(file, cls) {
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        window: {}, document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ dataset: {}, style: {}, className: '', querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }) },
        Icons: { favorite: '', favoriteOutline: '' }, localStorage: { getItem: () => null, setItem() {} }
    });
    loadUi(context);
    vm.runInContext(read(file), context);
    return vm.runInContext(cls, context);
}

const channel = { id: '7', sourceId: 's1', name: 'Seven News', number: '107', tvgLogo: '' };

test('a Live TV row has no station number, and keeps its logo, name and favourite button', () => {
    const ChannelList = load('js/components/ChannelList.js', 'ChannelList');
    const list = Object.create(ChannelList.prototype);
    list.favoriteKeys = new Set();
    list.getProgramInfo = () => '';
    const html = list.channelItemHtml(channel);
    assert.ok(!/channel-number/.test(html), 'no number element');
    assert.ok(!html.includes('107'), 'the number is not shown');
    assert.ok(html.includes('channel-logo') && html.includes('Seven News') && html.includes('favorite-btn'));
});

test('a TV Guide row has no station number, and keeps its logo, name and favourite button', () => {
    const EpgGuide = load('js/components/EpgGuide.js', 'EpgGuide');
    const guide = Object.create(EpgGuide.prototype);
    guide.filteredChannels = [channel];
    guide.favorites = new Set();
    guide.startTime = new Date(0); guide.endTime = new Date(1000);
    guide.renderProgrammes = () => '';
    guide.attachRowListeners = () => {};
    const row = guide.createChannelRow(0);
    const html = row.innerHTML;
    assert.ok(!/channel-number/.test(html), 'no number element');
    assert.ok(!html.includes('107'), 'the number is not shown');
    assert.ok(html.includes('epg-channel-logo') && html.includes('Seven News') && html.includes('favorite-btn'));
});

test('the guide row has no leftover number style', () => {
    assert.ok(!read('css/main.css').includes('epg-channel-number'));
});
