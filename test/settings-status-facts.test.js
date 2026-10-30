const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #61: facts the server already had that the web never showed. The real Settings.js with a recorded fetch.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

function settingsPage(elements, routes, calls) {
    const ctx = vm.createContext({
        console: { ...console, error() {} }, localStorage: { getItem: () => 'tok' },
        document: { getElementById: (id) => elements[id] || null, querySelectorAll: () => [], querySelector: () => null },
        fetch: async (url, opts = {}) => {
            const key = `${opts.method || 'GET'} ${String(url).split('?')[0]}`;
            calls.push(key);
            const body = typeof routes[key] === 'function' ? routes[key]() : routes[key];
            const status = body === undefined ? 404 : 200;
            return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body ?? { error: 'No such API endpoint' } };
        }
    });
    ctx.window = ctx;
    vm.runInContext(js('api.js'), ctx);
    vm.runInContext(js('pages/Settings.js'), ctx);
    return Object.create(ctx.SettingsPage.prototype);
}

/** An element whose querySelector('[data-hw-redetect]') finds the button drawn into it. */
function box() {
    const el = { innerHTML: '', button: null };
    el.querySelector = (sel) => {
        if (sel !== '[data-hw-redetect]' || !el.innerHTML.includes('data-hw-redetect')) return null;
        el.button = { disabled: false, textContent: 'Re-detect GPU', listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } };
        return el.button;
    };
    return el;
}

// 0367: POST /api/settings/hw-info/refresh existed with no button (a GPU passed through after start was never seen).
test('#61: Settings → Playback has a Re-detect GPU button that probes again and redraws what it found', async () => {
    const container = box();
    const calls = [];
    let probes = 0;
    const page = settingsPage({ 'hw-info-container': container }, {
        'GET /api/settings/hw-info': { nvidia: { available: false }, amf: { available: false }, qsv: { available: false }, vaapi: { available: false }, recommended: 'software' },
        'POST /api/settings/hw-info/refresh': () => { probes++; return { nvidia: { available: false }, amf: { available: false }, qsv: { available: false }, vaapi: { available: true, device: '/dev/dri/renderD128' }, recommended: 'vaapi' }; }
    }, calls);
    await page.loadHardwareInfo();
    assert.match(container.innerHTML, /No GPU acceleration detected/);
    const button = container.button;
    assert.ok(button, 'the button is drawn');
    button.listeners.click();
    assert.equal(button.disabled, true);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.equal(probes, 1);
    assert.deepEqual(calls, ['GET /api/settings/hw-info', 'POST /api/settings/hw-info/refresh']);
    assert.match(container.innerHTML, /renderD128/);
    assert.match(container.innerHTML, /Detected again just now/);
});

// 0368: "Last full sync" was one time kept in memory ("Just now" after a restart, "Never" after a provider's own
// Sync now). It is now each source from the server's sync records, naming a failed or held feed.
test('#61: Settings → Providers shows when each source last synced, and a failed or held feed', async () => {
    const display = { textContent: '', title: '' };
    const now = Date.now();
    const page = settingsPage({ 'epg-last-refreshed': display }, {
        'GET /api/settings/sync-status': { lastSyncTime: null, sources: [
            { id: 8, name: 'Dream 4K', feeds: [{ type: 'all', status: 'success', at: now - 30 * 60e3 }, { type: 'epg', status: 'success', at: now - 3 * 3600e3 }] },
            { id: 7, name: 'Trex', feeds: [{ type: 'all', status: 'success', at: now - 60e3 }, { type: 'epg', status: 'error', at: now - 2 * 60e3 }] },
            { id: 6, name: 'Strong8K', feeds: [{ type: 'all', status: 'held', at: now - 5 * 60e3 }] },
            { id: 5, name: 'New one', feeds: [] }] }
    }, []);
    await page.updateEpgLastRefreshed();
    assert.equal(display.textContent, 'Dream 4K 3 hours ago · Trex: guide failed 2 minutes ago · Strong8K: channels held 5 minutes ago · New one: never');
    assert.match(display.title, /Dream 4K guide: success/);
});
