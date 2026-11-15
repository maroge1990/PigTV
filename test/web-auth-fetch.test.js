const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #64: one way to make a signed-in request. Before, there were four: API.request, API.streamFetch, a hand-built
// Authorization header on six raw fetches in VideoPlayer.js, and another two in app.js (the sign-in check and
// sign-out). Now API.authFetch (api.js) is the one place the header is made; everything else goes through it.
const PUBLIC = path.join(__dirname, '../public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const walk = (dir) => fs.readdirSync(path.join(PUBLIC, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    return d.isDirectory() ? (d.name === 'vendor' ? [] : walk(rel)) : d.name.endsWith('.js') ? [rel] : [];
});

test('only api.js builds the sign-in header or calls fetch for /api (the version badge needs no sign-in)', () => {
    const hits = [];
    for (const f of walk('js').filter((f) => f !== 'js/api.js')) {
        read(f).split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*)/.test(line)) return;
            if (/Bearer/.test(line)) hits.push(`${f}:${i + 1} header: ${line.trim()}`);
            const raw = line.match(/(?<![.\w])fetch\(\s*([`'"])([^`'"]*)/);
            if (raw && raw[2] !== '/api/version') hits.push(`${f}:${i + 1} fetch: ${line.trim()}`);
        });
    }
    assert.deepEqual(hits, []);
    assert.doesNotMatch(read('js/api.js'), /streamFetch/, 'one name for it');
});

function context(extra = {}) {
    const calls = [];
    const ctx = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        localStorage: { getItem: (k) => (k === 'authToken' ? 'tok' : null), removeItem() {}, setItem() {} },
        fetch: async (url, init) => { calls.push(['fetch', url, init]); return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) }; },
        ...extra
    });
    ctx.window = ctx;
    vm.runInContext(read('js/api.js'), ctx);
    return { ctx, calls };
}

test('API.authFetch adds the header and passes keepalive and signal through; API.request is built on it', async () => {
    const { ctx, calls } = context();
    const signal = { aborted: false };
    await vm.runInContext('API', ctx).authFetch('/api/transcode/s1', { method: 'DELETE', keepalive: true, signal, headers: { 'X-Test': '1' } });
    assert.equal(calls[0][1], '/api/transcode/s1');
    assert.equal(calls[0][2].keepalive, true);
    assert.equal(calls[0][2].signal, signal);
    assert.deepEqual({ ...calls[0][2].headers }, { 'X-Test': '1', Authorization: 'Bearer tok' });

    const via = [];
    vm.runInContext('API', ctx).authFetch = async (url, init) => { via.push([url, init.method, init.keepalive]); return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) }; };
    await vm.runInContext('API', ctx).request('DELETE', '/recordings/4', null, { keepalive: true });
    assert.deepEqual(via, [['/api/recordings/4', 'DELETE', true]]);
});

test('the player gives a session back through API.authFetch, with keepalive on pagehide (#320)', async () => {
    const via = [];
    const ctx = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        fetch: () => { throw new Error('a raw fetch'); },
        localStorage: { getItem: () => 'tok' },
        API: { authFetch: (url, init = {}) => { via.push([url, init.method, init.keepalive]); return Promise.resolve({ ok: true, status: 200, json: async () => ({}) }); } }
    });
    ctx.window = ctx;
    vm.runInContext(read('js/components/VideoPlayer.js'), ctx);
    const player = Object.create(vm.runInContext('VideoPlayer', ctx).prototype);
    player.currentSessionId = 'abc';
    await player.stopTranscodeSession({ keepalive: true });
    player.currentSessionId = 'def';
    await player.stopTranscodeSession();
    player.releaseSession('late');
    assert.deepEqual(via, [['/api/transcode/abc', 'DELETE', true], ['/api/transcode/def', 'DELETE', undefined], ['/api/transcode/late', 'DELETE', undefined]]);
    assert.equal(await player.sessionWasTakenOver('x y'), false);
    assert.equal(via[3][0], '/api/playback/x%20y/terminal-status');
});

test('the app checks the sign-in through API.authFetch', async () => {
    const via = [];
    const { ctx } = context({ document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] }, location: { replace() {} } });
    vm.runInContext(read('js/app.js'), ctx);
    vm.runInContext('API', ctx).authFetch = async (url) => { via.push(url); return { ok: true, status: 200, json: async () => ({ id: 1, role: 'admin' }) }; };
    const app = Object.create(vm.runInContext('App', ctx).prototype);
    app.addLogoutButton = () => {};
    await app.checkAuth();
    assert.deepEqual(via, ['/api/auth/me']);
    assert.equal(app.currentUser.role, 'admin');
});
