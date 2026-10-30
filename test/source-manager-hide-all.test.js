const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Settings → Manage content (the real SourceManager script, API stubbed, no DOM).
// #16 (0357): Show all / Hide all act on what the filter shows, as pending edits that Save applies (asking with counts
// when it is many), and the last save can be undone. Before, they saved at once, ignored the filter, threw pending
// edits away and could not be undone. #59: ticking a channel inside a hidden group shows the group and keeps its other
// channels hidden; groups are keyed by id, not name. #128: unsaved ticks are known.
let gate = null; // #175: holds a bulk hide open while a test ticks more
function makeManager({ groups, confirmAnswer = true, newGroups = [] } = {}) {
    const calls = [];
    const confirms = [];
    let listed = newGroups;
    const box = { hidden: true, innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
    const context = vm.createContext({
        window: { app: {}, confirm: (msg) => { confirms.push(msg); return confirmAnswer; } },
        console: { ...console, log() {}, warn() {}, error() {} },
        alert() {}, setTimeout: () => 0,
        document: { getElementById: (id) => (id === 'content-new-groups' ? box : null), querySelector: () => null },
        Icons: { chevronDown: '' },
        CSS: { escape: (s) => s },
        API: { channels: {
            hideAll: async () => { calls.push(['hideAll']); },
            showAll: async () => { calls.push(['showAll']); },
            bulkShow: async (items) => { calls.push(['bulkShow', items.map(i => `${i.itemType}:${i.itemId}`)]); },
            bulkHide: async (items) => { calls.push(['bulkHide', items.map(i => `${i.itemType}:${i.itemId}`)]); if (gate) await gate; },
            newGroups: async () => listed,
            show: async (sourceId, type, id) => { calls.push(['show', sourceId, type, id]); listed = listed.filter(g => g.categoryId !== id); },
            dismissNewGroups: async (sourceId) => { calls.push(['dismiss', sourceId]); listed = []; }
        } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/SourceManager.js'), 'utf8'), context);
    const manager = Object.create(context.window.SourceManager.prototype);
    Object.assign(manager, {
        treeData: {
            type: 'channels', sourceId: 7,
            groups: groups || [
                { id: '10', name: 'US TV Guide', categoryId: '10', items: [{ type: 'channel', id: 'a', name: 'ABC' }, { type: 'channel', id: 'b', name: 'BBC' }] },
                { id: '11', name: 'NFL Sunday Ticket', categoryId: '11', items: [{ type: 'channel', id: 'c', name: 'CBS Sports' }] },
                { id: 'Uncategorized', name: 'No category id', categoryId: null, items: [{ type: 'channel', id: 'd', name: 'Dave' }] }
            ]
        },
        hiddenSet: new Set(), originalHiddenSet: new Set(), expandedGroups: new Set(), searchQuery: '', undoSnapshot: null, saving: false,
        contentTree: { querySelector: () => null },
        renderTree() { this.rendered = (this.rendered || 0) + 1; }
    });
    return { manager, calls, confirms, box };
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const groupChecked = (manager, index) => /group-checkbox[^>]*\bchecked\b/.test(manager.getGroupHtml(manager.treeData.groups[index]));

test('#16: Hide all is a pending edit: the boxes untick at once, nothing is sent until Save', async () => {
    const { manager, calls } = makeManager();
    manager.setAllVisibility(false);
    assert.deepEqual(calls, [], 'no server call');
    assert.equal(groupChecked(manager, 0), false);
    assert.equal(groupChecked(manager, 2), false, 'a group with no category id follows its channels');
    assert.equal(manager.isDirty(), true, '#128: unsaved');
    await manager.saveContentChanges();
    assert.deepEqual(plain(calls), [['bulkHide', ['group:10', 'group:11', 'channel:d']]]);
    assert.equal(manager.isDirty(), false);
});

test('#16: with a filter, Show all and Hide all touch only what the filter lists', async () => {
    const { manager, calls } = makeManager();
    manager.searchQuery = 'bbc';
    manager.setAllVisibility(false);
    assert.deepEqual([...manager.hiddenSet].sort(), ['channel:b'], 'only BBC: its group keeps ABC');
    await manager.saveContentChanges();
    assert.deepEqual(plain(calls), [['bulkHide', ['channel:b']]]);
});

test('#16: a large change asks first with the counts; Cancel sends nothing', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ type: 'channel', id: `x${i}`, name: `Channel ${i}` }));
    const { manager, calls, confirms } = makeManager({ groups: [{ id: '20', name: 'Big', categoryId: '20', items: many }], confirmAnswer: false });
    manager.setAllVisibility(false);
    await manager.saveContentChanges();
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /^Hide 60 shown channels\? .* You now show 60 channels; this makes 0\.$/);
    assert.deepEqual(calls, [], 'cancelled');
    assert.equal(manager.isDirty(), true, 'the edits are kept for another try');
});

test('#16: Undo last save puts back exactly what was hidden before it, once', async () => {
    const { manager, calls } = makeManager();
    manager.hiddenSet = new Set(['channel:b']);
    manager.originalHiddenSet = new Set(['channel:b']);
    manager.setAllVisibility(true);
    await manager.saveContentChanges();
    assert.deepEqual(plain(calls), [['bulkShow', ['channel:b']]]);
    await manager.undoLastSave();
    assert.deepEqual(plain(calls[1]), ['bulkHide', ['channel:b']]);
    assert.deepEqual([...manager.hiddenSet], ['channel:b']);
    assert.equal(manager.undoSnapshot, null, 'an undo is not itself undone');
});

test('#59: ticking one channel of a hidden group shows the group and keeps its other channels hidden', async () => {
    const { manager, calls } = makeManager();
    manager.hiddenSet = new Set(['group:10', 'channel:a', 'channel:b']);
    manager.originalHiddenSet = new Set(manager.hiddenSet);
    manager.toggleVisibility({ dataset: { type: 'channel', id: 'b' }, checked: true, closest: () => null });
    assert.equal(manager.hiddenSet.has('group:10'), false, 'the group is shown too');
    await manager.saveContentChanges();
    assert.deepEqual(plain(calls), [['bulkShow', ['group:10']], ['bulkHide', ['channel:a']]],
        'the group shows (cascading on the server), then ABC is hidden again');
});

test('#59: two groups with the same name are two groups', () => {
    const { manager } = makeManager({ groups: [
        { id: '30', name: 'Sport', categoryId: '30', items: [{ type: 'channel', id: 'p', name: 'P' }] },
        { id: '31', name: 'Sport', categoryId: '31', items: [{ type: 'channel', id: 'q', name: 'Q' }] }
    ] });
    assert.match(manager.getGroupHtml(manager.treeData.groups[1]), /group-checkbox[^>]*data-id="31"/);
    manager.toggleGroupChildren({ dataset: { id: '31' }, checked: false });
    assert.deepEqual([...manager.hiddenSet].sort(), ['channel:q', 'group:31']);
});


test("#10 (0359): the provider's new groups are listed; Show shows the group at once and takes it off the list", async () => {
    const { manager, calls, box } = makeManager({ newGroups: [{ sourceId: 7, categoryId: '11', name: 'NFL Sunday Ticket', channels: 1, foundAt: 1 }] });
    manager.hiddenSet = new Set(['group:11', 'channel:c']);
    manager.originalHiddenSet = new Set(manager.hiddenSet);
    await manager.loadNewGroups(7);
    assert.equal(box.hidden, false);
    assert.match(box.innerHTML, /New on the provider[\s\S]*NFL Sunday Ticket[\s\S]*1 channel ·[\s\S]*data-new-group-show="11"/);
    await manager.showNewGroup('11');
    assert.deepEqual(plain(calls), [['show', 7, 'group', '11']]);
    assert.equal(manager.hiddenSet.size, 0, 'the group and its channel are shown in the tree too');
    assert.equal(manager.isDirty(), false, 'nothing left to save: the server already has it');
    assert.equal(box.hidden, true, 'the list is empty now');
});

test('#10 (0359): Keep all hidden clears the list without showing anything', async () => {
    const { manager, calls, box } = makeManager({ newGroups: [{ sourceId: 7, categoryId: '11', name: 'NFL Sunday Ticket', channels: 1, foundAt: 1 }] });
    await manager.loadNewGroups(7);
    await manager.dismissNewGroups();
    assert.deepEqual(plain(calls), [['dismiss', 7]]);
    assert.equal(box.hidden, true);
});

test('#174: Undo belongs to the provider it was saved on; loading another provider drops it', async () => {
    const { manager, calls } = makeManager();
    manager.hiddenSet = new Set(['channel:b']);
    manager.originalHiddenSet = new Set(['channel:b']);
    manager.setAllVisibility(true);
    await manager.saveContentChanges();
    // Another provider's tree arrives (as loadContentTree leaves it), then Undo is pressed.
    manager.treeData = { type: 'channels', sourceId: 8, groups: [{ id: '50', name: 'Other', categoryId: '50', items: [{ type: 'channel', id: 'b', name: 'Same id' }] }] };
    manager.hiddenSet = new Set();
    manager.originalHiddenSet = new Set();
    await manager.undoLastSave();
    assert.deepEqual(plain(calls), [['bulkShow', ['channel:b']]], 'nothing more is sent: the snapshot was provider 7\'s');
    assert.equal(manager.undoSnapshot, null);
});

test('#175: ticks made while a save is running are not marked saved; a second Save sends them', async () => {
    const { manager, calls } = makeManager();
    let open;
    gate = new Promise(r => { open = r; });
    try {
        manager.toggleVisibility({ dataset: { type: 'channel', id: 'a' }, checked: false, closest: () => null });
        const first = manager.saveContentChanges();
        await new Promise(r => setTimeout(r, 0));
        manager.toggleVisibility({ dataset: { type: 'channel', id: 'b' }, checked: false, closest: () => null });
        const second = manager.saveContentChanges(); // refused: one save at a time
        open();
        await first;
        await second;
    } finally { gate = null; }
    assert.deepEqual(plain(calls), [['bulkHide', ['channel:a']]]);
    assert.equal(manager.isDirty(), true, 'BBC is still to save');
    await manager.saveContentChanges();
    assert.deepEqual(plain(calls[1]), ['bulkHide', ['channel:b']]);
    assert.equal(manager.isDirty(), false);
});
