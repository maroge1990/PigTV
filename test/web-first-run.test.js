const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #63: first run. With no channels, Live TV said only "Add a provider in Settings to get started" (to everyone), and
// nothing led on to testing the provider, its first sync, guide matching or pairing. An admin now gets a checklist
// there (components/FirstRun.js), each step ticking off from what the server says; someone who is not an admin is told
// to ask their admin. The real ChannelList, FirstRun and ProvidersSettings (for ProviderFormat); API and timers stubbed.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

function setup({ role = 'admin', replies = {}, stored = null } = {}) {
    const timers = [];
    const storage = new Map(stored ? [['pigtv_first_run_tested', stored]] : []);
    const calls = [];
    const navigations = [];
    const reply = (key, fallback) => {
        calls.push(key);
        const r = replies[key];
        if (r instanceof Error) return Promise.reject(r);
        return Promise.resolve(typeof r === 'function' ? r() : r === undefined ? fallback : r);
    };
    const API = {
        sources: {
            providers: () => reply('providers', []),
            getStatus: () => reply('status', []),
            test: (id) => reply(`test ${id}`, { success: true }),
            sync: (id) => reply(`sync ${id}`, { success: true })
        },
        epg: { mappings: () => reply('mappings', []) },
        request: (method, url) => reply(`${method} ${url}`, null),
        library: { categories: async () => [], allChannels: async () => [], favourites: async () => [] }
    };
    const element = () => ({ dataset: {}, style: {}, innerHTML: '', className: '', value: '', querySelector: () => null, querySelectorAll: () => [], addEventListener() {} });
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        window: { app: { currentUser: { role }, navigateTo: (...a) => navigations.push(a) } },
        API,
        document: { addEventListener() {}, getElementById: () => null, createElement: element, visibilityState: 'visible' },
        Icons: { favorite: '', favoriteOutline: '' },
        localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: () => {}
    });
    loadUi(context);
    for (const f of ['js/pages/ProvidersSettings.js', 'js/components/FirstRun.js', 'js/components/ChannelList.js']) vm.runInContext(read(f), context);
    const ChannelList = vm.runInContext('ChannelList', context);
    const list = Object.create(ChannelList.prototype);
    const container = element();
    Object.assign(list, {
        channels: [], categories: [], sources: [], container, searchInput: { value: '' }, sourceSelect: { value: '' },
        favoriteKeys: new Set(), favoriteRows: [], collapsedGroups: new Set(), _userExpandedGroups: new Set(), _hasCollapsedState: true,
        focusIdentity: () => null
    });
    return { context, list, container, timers, calls, navigations, storage, FirstRun: vm.runInContext('FirstRun', context) };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const steps = (html) => [...html.matchAll(/class="first-run-step ([a-z- ]+)" data-step="([a-z]+)"/g)].map(m => `${m[2]}:${m[1].trim()}`);

const PRIMARY = { id: 5, type: 'xtream', name: 'Main', role: 'primary', enabled: true };

test('#63: an admin with no provider gets the checklist on Live TV, opening on Add a provider', async () => {
    const { list, container, navigations } = setup();
    list.render();
    await settle();
    assert.match(container.innerHTML, /Set up PigTV/);
    assert.deepEqual(steps(container.innerHTML),
        ['provider:is-current', 'test:is-waiting', 'sync:is-waiting', 'guide:is-waiting', 'device:is-waiting']);
    assert.match(container.innerHTML, /btn-primary" data-first-run="provider">Add a provider</, 'the one rose button is the first step\'s');
    assert.equal((container.innerHTML.match(/btn-primary/g) || []).length, 1);
    // Its button opens Settings › Providers, whose add form is open while there is no provider.
    const firstRun = list.firstRun;
    await firstRun.act('provider', container);
    assert.deepEqual(JSON.parse(JSON.stringify(navigations)), [['settings', 'push', 'providers']]);
});

test('#63: someone who is not an admin is told to ask their admin, and reads nothing for the checklist', async () => {
    const { list, container, calls } = setup({ role: 'viewer' });
    list.render();
    await settle();
    assert.match(container.innerHTML, /No channels yet/);
    assert.match(container.innerHTML, /Ask your admin to add a provider\./);
    assert.doesNotMatch(container.innerHTML, /first-run/);
    assert.deepEqual(calls, []);
});

test('#63: once a provider is added, the next steps are its test and its first sync, with the sync\'s progress', async () => {
    const now = Date.now();
    const { list, container, timers, FirstRun } = setup({ replies: {
        providers: [PRIMARY, { id: 6, type: 'm3u', name: 'Spare', role: 'backup' }],
        status: [{ source_id: 5, type: 'all', status: 'syncing', last_sync: now - 3 * 60000 }]
    } });
    list.sources = [PRIMARY];
    list.render();
    await settle();
    assert.deepEqual(steps(container.innerHTML),
        ['provider:is-done', 'test:is-current', 'sync:is-waiting is-busy', 'guide:is-waiting', 'device:is-waiting']);
    assert.match(container.innerHTML, /Main is added\./);
    assert.match(container.innerHTML, /data-first-run="test">Test connection</);
    assert.match(container.innerHTML, /Syncing… started 3 minutes ago\. A large list can take a while/);
    assert.equal(timers.at(-1).ms, 3000, 'a running sync is read again in 3 s');
    assert.equal(FirstRun.primaryOf([{ id: 6, role: 'backup' }, PRIMARY]).id, 5);
});

test('#63: Test connection runs on the saved provider, and a pass is remembered', async () => {
    const { list, container, storage } = setup({ replies: { providers: [PRIMARY], 'test 5': { success: true } } });
    list.render();
    await settle();
    await list.firstRun.act('test', container);
    assert.equal(storage.get('pigtv_first_run_tested'), '5');
    assert.match(container.innerHTML, /data-step="test"/);
    assert.deepEqual(steps(container.innerHTML).slice(0, 3), ['provider:is-done', 'test:is-done', 'sync:is-current']);
    assert.match(container.innerHTML, /Connection successful\./);
});

test('#63: a failed test says so and can be run again; a failed sync offers Sync again', async () => {
    const { list, container, calls } = setup({ replies: {
        providers: [PRIMARY], 'test 5': { success: false, error: 'Account expired' },
        status: [{ source_id: 5, type: 'all', status: 'error', error: 'Bad login', last_sync: Date.now() }]
    } });
    list.render();
    await settle();
    await list.firstRun.act('test', container);
    assert.match(container.innerHTML, /first-run-detail error">Connection failed: Account expired\. Check the address and login/);
    assert.match(container.innerHTML, /data-first-run="test">Test connection</, 'the test can be run again');
    assert.match(container.innerHTML, /data-first-run="sync">Sync again</);
    await list.firstRun.act('sync', container);
    assert.ok(calls.includes('sync 5'));
});

test('#63: when the first sync finishes, the list is loaded and the checklist goes', async () => {
    let state = 'syncing';
    const { list, timers } = setup({ replies: {
        providers: [PRIMARY], status: () => [{ source_id: 5, type: 'all', status: state, last_sync: Date.now() }]
    } });
    let reloaded = 0;
    list.reloadAfterFirstSync = async () => { reloaded++; };
    list.render();
    await settle();
    assert.equal(reloaded, 0);
    state = 'success';
    timers.at(-1).fn();
    await settle();
    assert.equal(reloaded, 1, 'the channels it brought are listed');
});

test('#63: guide matching and pairing tick off from the server, and their buttons open their Settings', async () => {
    const { FirstRun } = setup();
    const done = (facts) => JSON.parse(JSON.stringify(FirstRun.steps(facts).filter(s => s.done).map(s => s.key)));
    const synced = { source_id: 5, type: 'all', status: 'success' };
    assert.deepEqual(done({ primary: PRIMARY, row: synced, tested: false, mappings: 0, unmatched: 12, devices: 0 }), ['provider', 'test', 'sync'],
        'a sync that worked proves the connection');
    assert.deepEqual(done({ primary: PRIMARY, row: synced, mappings: 0, unmatched: 0, devices: 1 }), ['provider', 'test', 'sync', 'guide', 'device']);
    assert.deepEqual(done({ primary: PRIMARY, row: null, mappings: 3, unmatched: null, devices: null }), ['provider', 'guide']);
    assert.equal(FirstRun.shouldShow({ primary: PRIMARY, row: synced }), false, 'after the first sync the list is Live TV as before');
    assert.equal(FirstRun.shouldShow({ primary: null, row: null }), true);

    const { list, container, navigations } = setup({ replies: { providers: [PRIMARY] } });
    list.render();
    await settle();
    await list.firstRun.act('guide', container);
    await list.firstRun.act('device', container);
    assert.deepEqual(JSON.parse(JSON.stringify(navigations)), [['settings', 'push', 'channels/epg'], ['settings', 'push', 'system']]);
});

test('#63: with channels listed, nothing of the checklist is drawn or read', async () => {
    const { list, container, calls } = setup();
    list.channels = [{ sourceId: 5, id: 'a', name: 'One', groupTitle: 'News' }];
    list.render = list.render.bind(list);
    try { list.render(); } catch { /* the batch drawing needs a fuller DOM than this stub; only the empty branch matters */ }
    await settle();
    assert.doesNotMatch(container.innerHTML, /first-run/);
    assert.deepEqual(calls, []);
});
