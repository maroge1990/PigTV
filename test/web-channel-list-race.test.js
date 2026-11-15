const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #292 (1): ChannelList.loadChannels ignored a selection made while a load was in flight and drew the earlier load's
// rows. The real loader, with API calls that are answered when the test says so.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

function setup() {
    const pending = [];
    const API = { library: {
        categories: () => new Promise(res => pending.push(() => res([]))),
        allChannels: () => Promise.resolve([
            { sourceId: 1, id: 'a1', name: 'One A', category: 'x' },
            { sourceId: 2, id: 'b1', name: 'Two B', category: 'x' }]),
        favourites: () => Promise.resolve([])
    } };
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        window: {}, API,
        document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ dataset: {}, style: {}, className: '', querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }) },
        Icons: { favorite: '', favoriteOutline: '' }, localStorage: { getItem: () => null, setItem() {} }
    });
    loadUi(context);
    vm.runInContext(read('js/components/ChannelList.js'), context);
    const ChannelList = vm.runInContext('ChannelList', context);
    const list = Object.create(ChannelList.prototype);
    const drawn = [];
    Object.assign(list, {
        sources: [{ id: 1, enabled: true, type: 'm3u' }, { id: 2, enabled: true, type: 'm3u' }],
        sourceSelect: { value: '' }, container: {}, favoriteKeys: new Set(), favoriteRows: [],
        render() { drawn.push(this.channels.map(c => c.name)); }
    });
    return { list, pending, drawn };
}
const settle = () => new Promise(r => setImmediate(r));

test('a selection made while a load is in flight is the one drawn, not the earlier load', async () => {
    const { list, pending, drawn } = setup();
    list.sourceSelect.value = 'source:1';
    const first = list.loadChannels();
    list.sourceSelect.value = 'source:2';
    const second = list.loadChannels();
    await settle();
    assert.equal(pending.length, 2, 'the second selection started its own load');
    pending[1](); // the newer load answers first
    await second;
    pending[0](); // the earlier one answers late
    await first;
    assert.deepEqual(drawn, [['Two B']], 'only the latest selection is drawn');
    assert.equal(list.isLoading, false);
});

test('an earlier load that answers first is dropped too', async () => {
    const { list, pending, drawn } = setup();
    list.sourceSelect.value = 'source:1';
    const first = list.loadChannels();
    list.sourceSelect.value = 'source:2';
    const second = list.loadChannels();
    await settle();
    pending[0]();
    await first;
    assert.deepEqual(drawn, [], 'the stale rows are not drawn');
    pending[1]();
    await second;
    assert.deepEqual(drawn, [['Two B']]);
});
