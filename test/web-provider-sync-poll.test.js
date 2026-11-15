const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');

// #63: Settings › Providers polled a running sync 40 times, 3 s apart, and then stopped: a large first sync (well over
// 2 minutes) was left saying "Syncing…" for ever. It now polls while the server says the sync runs, every 3 s for the
// first minute and then gently less often (to 15 s). The real ProvidersSettings script; timers and API stubbed.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

function setup({ syncingPolls }) {
    const timers = [];
    let statusReads = 0;
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        document: { getElementById: () => null, querySelectorAll: () => [] },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        API: { sources: {
            getStatus: async () => {
                statusReads++;
                return [{ source_id: 5, type: 'all', status: statusReads <= syncingPolls ? 'syncing' : 'success', last_sync: 0 }];
            },
            account: async () => null,
            providers: async () => [{ id: 5, role: 'primary' }]
        } }
    });
    context.window = context;
    loadUi(context);
    vm.runInContext(js('pages/ProvidersSettings.js'), context);
    const page = Object.create(context.ProvidersSettings.prototype);
    Object.assign(page, { providers: [{ id: 5, role: 'primary' }], polls: new Map(), syncRows: new Map(), accounts: new Map() });
    let refreshed = 0;
    page.refreshChannels = () => { refreshed++; };
    const run = async () => {
        // Fire timers one at a time until none is left (or a ceiling a stuck loop would hit).
        const delays = [];
        for (let i = 0; i < 1000 && timers.length; i++) {
            const t = timers.shift();
            delays.push(t.ms);
            await t.fn();
        }
        return delays;
    };
    return { page, run, F: context.ProviderFormat, reads: () => statusReads, refreshed: () => refreshed };
}

test('#63: a sync that runs for longer than 40 polls is followed to its end', async () => {
    const { page, run, reads, refreshed } = setup({ syncingPolls: 70 });
    page.pollSync(5);
    const delays = await run();
    assert.equal(reads(), 71, 'polled every time the server said "syncing", and once more to see it finish');
    assert.equal(page.polls.has(5), false, 'and then stopped');
    assert.equal(refreshed(), 1, 'Live TV is told the channels changed');
    assert.ok(delays.slice(0, 20).every(ms => ms === 3000), 'every 3 s for the first minute');
    assert.ok(delays[30] > 3000 && delays[30] <= 15000, `then less often (${delays[30]} ms)`);
    assert.ok(delays.every(ms => ms <= 15000), 'never more than 15 s apart');
});

test('#63: asked again while it polls, it does not start a second loop', async () => {
    const { page, run, reads } = setup({ syncingPolls: 3 });
    page.pollSync(5);
    page.pollSync(5);
    await run();
    assert.equal(reads(), 4, 'one loop only');
});

test('#63: the poll goes on while a sync runs, and gives up on one that never starts after a minute', () => {
    const { F } = setup({ syncingPolls: 0 });
    assert.equal(F.keepPolling({ all: { status: 'syncing' } }, 500), true);
    assert.equal(F.keepPolling({ all: { status: 'success' }, epg: { status: 'syncing' } }, 500), true, 'the guide part still runs');
    assert.equal(F.keepPolling({ all: { status: 'success' } }, 0), false);
    assert.equal(F.keepPolling({}, 5), true, 'no row yet: the sync is starting');
    assert.equal(F.keepPolling({}, 19), false);
});

test('#63: a running sync says how long it has been going', () => {
    const { F } = setup({ syncingPolls: 0 });
    const now = 10 * 60000;
    assert.equal(F.formatSync({ status: 'syncing', last_sync: now - 4 * 60000 }, now).text, 'Syncing… started 4 minutes ago');
    assert.equal(F.formatSync({ status: 'syncing', last_sync: now }, now).text, 'Syncing… started just now');
});
