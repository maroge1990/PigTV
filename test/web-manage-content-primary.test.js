const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #63: Settings › Channels › Manage content opened on "Select a provider…" and listed the backups too, whose catalogue
// is always empty (backups never write playlist_items). It now lists the primary only and opens on it.
// The real SourceManager script, API stubbed, no DOM.
function setup(providers) {
    const select = { innerHTML: '', value: '' };
    const tree = { innerHTML: '' };
    const states = [];
    const context = vm.createContext({
        window: { app: {} },
        console: { ...console, log() {}, warn() {}, error() {} },
        document: { getElementById: (id) => (id === 'content-source-select' ? select : null), querySelector: () => null },
        Icons: { chevronDown: '' },
        API: { sources: {
            providers: async () => providers,
            getAll: async () => providers.map(({ id, type, name, enabled }) => ({ id, type, name, enabled }))
        } }
    });
    loadUi(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/SourceManager.js'), 'utf8'), context);
    context.recordState = (el, kind, text) => states.push([kind, text]);
    vm.runInContext('UI.setState = recordState;', context);
    const manager = Object.create(context.window.SourceManager.prototype);
    const loaded = [];
    Object.assign(manager, { treeData: null, contentTree: tree, loadContentTree(id) { loaded.push(id); } });
    return { manager, select, loaded, states };
}

const PROVIDERS = [
    { id: 4, type: 'xtream', name: 'Spare', role: 'backup', priority: 1, enabled: true },
    { id: 7, type: 'm3u', name: 'Main', role: 'primary', enabled: true },
    { id: 9, type: 'epg', name: 'Guide', enabled: true }
];

test('#63: Manage content opens on the primary, with no backup in the picker', async () => {
    const { manager, select, loaded } = setup(PROVIDERS);
    await manager.loadContentSources();
    assert.equal(select.value, '7', 'the primary is selected');
    assert.deepEqual(loaded, [7], 'its groups and channels load at once');
    assert.ok(select.innerHTML.includes('Main (M3U)'), select.innerHTML);
    assert.ok(!select.innerHTML.includes('Spare'), 'the backup is left out');
    assert.ok(!/Select a provider/.test(select.innerHTML), 'no "Select a provider…" placeholder');
});

test('#63: coming back to the tab keeps the provider on screen, without reloading it', async () => {
    const { manager, select, loaded } = setup(PROVIDERS);
    manager.treeData = { sourceId: 7, groups: [{ id: 'g', items: [] }] };
    await manager.loadContentSources();
    assert.equal(select.value, '7');
    assert.deepEqual(loaded, [], 'unsaved ticks are not thrown away');
});

test('#63: with no provider yet, it says where to add one', async () => {
    const { manager, loaded, states } = setup([]);
    await manager.loadContentSources();
    assert.deepEqual(loaded, []);
    assert.equal(states.length, 1);
    assert.equal(states[0][0], 'empty');
    assert.match(states[0][1].detail, /Settings → Providers/);
});
