const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browserScript(file, extra = {}) {
    const context = vm.createContext({ window: {}, console, ...extra });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
    return context;
}

test('source edit fields escape markup and never prefill a saved password', () => {
    const ctx = browserScript('components/SourceManager.js');
    const manager = vm.runInContext('SourceManager.prototype', ctx);
    const form = manager.getSourceForm('xtream', { name: '<img onerror=bad()>', url: 'https://example.invalid/?x=" autofocus onfocus="bad()',
        username: '" onfocus="bad()', password: 'must-not-render', hasPassword: true });
    assert(!form.includes('<img'));
    assert(form.includes('&lt;img'));
    assert(form.includes('&quot;'));
    assert(!form.includes('must-not-render'));
    assert(form.includes('Leave blank to keep saved password'));
});

test('remembered volume stays local and never writes server settings', () => {
    const values = new Map();
    const ctx = browserScript('components/VideoPlayer.js', { localStorage: { setItem: (k, v) => values.set(k, v) },
        API: { settings: { update: () => { throw new Error('Volume must not update the server'); } } } });
    ctx.window.VideoPlayer.prototype.saveVolume.call({ settings: { lastVolume: 47 } });
    assert.equal(values.get('pigtv_last_volume'), '47');
});

test('API attaches bearer authentication and rejects instead of returning undefined after a 401', async () => {
    let options;
    const removed = [];
    const ctx = browserScript('api.js', { localStorage: { getItem: () => 'browser-token', removeItem: key => removed.push(key) },
        window: { location: {} }, fetch: async (url, opts) => {
            options = opts;
            return { ok: false, status: 401, headers: { get: () => 'text/plain' }, text: async () => 'Unauthorized' };
        } });
    await assert.rejects(ctx.window.API.settings.get(), /Authentication required/);
    assert.equal(options.headers.Authorization, 'Bearer browser-token');
    assert.equal(ctx.window.location.href, '/login.html');
    assert.deepEqual(removed, ['authToken']);
});
