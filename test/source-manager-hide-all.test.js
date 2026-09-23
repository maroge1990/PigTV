const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The real SourceManager script, with the API stubbed and no DOM.
function makeManager(type = 'channels') {
    const calls = [];
    const context = vm.createContext({
        window: { app: {} },
        console: { ...console, warn() {}, error() {} },
        alert() {}, setTimeout: (fn) => 0,
        document: { getElementById: () => null, querySelector: () => null },
        Icons: { chevronDown: '' },
        API: { channels: {
            hideAll: async (sourceId, contentType) => { calls.push(['hideAll', sourceId, contentType]); },
            showAll: async (sourceId, contentType) => { calls.push(['showAll', sourceId, contentType]); }
        } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/SourceManager.js'), 'utf8'), context);
    const manager = Object.create(context.window.SourceManager.prototype);
    Object.assign(manager, {
        treeData: {
            type, sourceId: 7,
            groups: [
                { id: 'g1', name: 'US TV Guide', categoryId: '10', items: [{ type: 'live', id: 'a', name: 'A' }, { type: 'live', id: 'b', name: 'B' }] },
                { id: 'g2', name: 'NFL Sunday Ticket', categoryId: '11', items: [{ type: 'live', id: 'c', name: 'C' }] },
                { id: 'g3', name: 'No category id', categoryId: null, items: [{ type: 'live', id: 'd', name: 'D' }] }
            ]
        },
        hiddenSet: new Set(), originalHiddenSet: new Set(), expandedGroups: new Set(), searchQuery: '',
        renderTree() { this.rendered = (this.rendered || 0) + 1; }
    });
    return { manager, calls };
}
const groupChecked = (manager, index) => /group-checkbox[^>]*\bchecked\b/.test(manager.getGroupHtml(manager.treeData.groups[index]));

test('Hide All unticks every group checkbox straight away, not only after a reload', async () => {
    const { manager, calls } = makeManager();
    assert.equal(groupChecked(manager, 0), true, 'starts visible');
    assert.equal(groupChecked(manager, 1), true);

    await manager.setAllVisibility(false);

    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['hideAll', 7, 'channels']], 'the server is asked once, as before');
    assert.equal(groupChecked(manager, 0), false, 'what the user sees now matches what the server did');
    assert.equal(groupChecked(manager, 1), false);
    assert.equal(manager.rendered, 1, 'and the tree is redrawn');
});

test('Show All ticks them again', async () => {
    const { manager } = makeManager();
    await manager.setAllVisibility(false);
    await manager.setAllVisibility(true);
    assert.equal(groupChecked(manager, 0), true);
    assert.equal(groupChecked(manager, 1), true);
    assert.equal(manager.hiddenSet.size, 0, 'nothing is left marked hidden');
});

test('the individual channels change too, and the saved baseline follows, so Save has nothing left to do', async () => {
    const { manager } = makeManager();
    await manager.setAllVisibility(false);
    for (const key of ['live:a', 'live:b', 'live:c', 'live:d']) assert.ok(manager.hiddenSet.has(key), key);
    assert.ok(manager.hiddenSet.has('group:10') && manager.hiddenSet.has('group:11'));
    assert.deepEqual([...manager.originalHiddenSet].sort(), [...manager.hiddenSet].sort(),
        'otherwise Save Changes would think there were unsaved edits and repeat the work');
});

test('a group with no category id still follows its channels', async () => {
    const { manager } = makeManager();
    await manager.setAllVisibility(false);
    assert.equal(groupChecked(manager, 2), false, 'no category key exists for it, so it is drawn from its items');
});

// 0121: the picker is live-only (the movie/series tabs went with the VOD pages), so
// the vod_category/series_category namespaces it used to write are no longer drawn.
