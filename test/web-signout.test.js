const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadApi } = require('./helpers/webApi');

// #130: Sign out awaited the logout request with no try/catch. With the server unreachable the request threw, the
// token was never removed and the click seemed to do nothing. Now this browser always forgets the sign-in and goes to
// the sign-in page; the server keeps nothing for a web sign-in, so nothing is said when it could not be told.
function signOutWith({ fetch, player = null }) {
    const store = new Map([['authToken', 'tok']]);
    const went = [];
    const warned = [];
    const context = vm.createContext({
        console: { ...console, log() {}, error: (...a) => warned.push(a.join(' ')), warn: (...a) => warned.push(a.join(' ')) },
        document: { addEventListener() {} },
        setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t),
        localStorage: { getItem: (k) => store.get(k) ?? null, removeItem: (k) => store.delete(k) },
        fetch, window: { location: { replace: (u) => went.push(u) } }
    });
    loadApi(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    const app = Object.create(vm.runInContext('App', context).prototype);
    app.player = player;
    return { app, store, went, warned };
}

test('no server: the sign-in is still forgotten and the browser goes to sign-in', async () => {
    const { app, store, went } = signOutWith({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    await app.signOut();
    assert.equal(store.has('authToken'), false);
    assert.deepEqual(went, ['/login.html']);
});

test('a server that answers with an error, or a player that throws, changes nothing', async () => {
    const { app, store, went } = signOutWith({
        fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
        player: { handlePageHide() { throw new Error('no video'); } }
    });
    await app.signOut();
    assert.equal(store.has('authToken'), false);
    assert.deepEqual(went, ['/login.html']);
});

test('a server that never answers holds sign-out for 3 s at most', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { app, store, went } = signOutWith({ fetch: () => new Promise(() => {}) });
        const out = app.signOut();
        await new Promise(setImmediate);
        assert.deepEqual(went, [], 'it waits for an answer first');
        mock.timers.tick(3000);
        for (let i = 0; i < 5; i++) await new Promise(setImmediate); // never awaits `out` itself: the old code hung here
        assert.equal(store.has('authToken'), false);
        assert.deepEqual(went, ['/login.html']);
    } finally {
        mock.timers.reset();
    }
});
