const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #320 review: signing out releases the playing stream while the token still works (the pagehide that follows would
// otherwise send its DELETE without a sign-in and be refused, holding the provider's connection to the idle timeout).
test('signOut gives the session back with the token, before the token is removed', async () => {
    const store = new Map([['authToken', 'tok']]);
    const calls = [];
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        document: { addEventListener() {} },
        localStorage: { getItem: (k) => store.get(k) ?? null, removeItem: (k) => store.delete(k) },
        fetch: async (url, init) => { calls.push([url, init.method, init.headers && init.headers.Authorization, store.has('authToken')]); return { ok: true }; },
        window: { location: { replace() {} } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    const app = Object.create(vm.runInContext('App', context).prototype);
    app.player = { handlePageHide() { context.fetch('/api/transcode/s1', { method: 'DELETE', headers: { Authorization: `Bearer ${store.get('authToken')}` }, keepalive: true }); } };
    await app.signOut();
    assert.deepEqual(calls.map(c => c.slice(0, 3)), [['/api/transcode/s1', 'DELETE', 'Bearer tok'], ['/api/auth/logout', 'POST', 'Bearer tok']]);
    assert.ok(calls[0][3], 'the token was still there');
});
