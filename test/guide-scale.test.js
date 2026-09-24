const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// 0111 (roadmap S1.3): the guide API has to hold up at scale - several
// thousand channels, paged cheaply, with a client able to ask "did anything
// change?" instead of re-fetching everything. Same sandboxed-real-sqlite
// approach as guide-bounds.test.js / favourites-stable.test.js.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-guide-scale-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');

let server, base, token, source;

async function get(route) {
    const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
    return response.json();
}

function insertChannel(pos, name, sortOrder) {
    sqlite.getDb().prepare(`
        INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, data)
        VALUES (?, ?, ?, 'live', ?, 'All', ?, '{}')
    `).run(`${source.id}:${pos}`, source.id, pos, name, sortOrder);
}

before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken({ ...user, id: 1 });
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'https://provider.invalid/list.m3u' });

    // 600 channels: most with a sort_order (some sharing the same value, to
    // exercise the tiebreaker), a chunk with NULL sort_order (Xtream-shaped,
    // sorts last), and names that are not already in a unique order.
    for (let i = 0; i < 500; i++) {
        // Every 10th channel shares its sort_order with its neighbour.
        insertChannel(`pos_${i}`, `Channel ${String(i).padStart(4, '0')}`, Math.floor(i / 2));
    }
    for (let i = 500; i < 600; i++) {
        insertChannel(`pos_${i}`, `Unordered ${String(i).padStart(4, '0')}`, null);
    }

    const app = express();
    app.use(express.json());
    app.use('/api/auth', load('routes/auth'));
    app.use('/api/info', load('routes/info'));
    app.use('/api/library', load('routes/library'));
    app.use('/api/channels', load('routes/channels'));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

test('/api/info advertises the guide-scale flags', async () => {
    const info = await get('/api/info');
    assert.equal(info.features.guideCursor, true);
    assert.equal(info.features.guideVersion, true);
});

test('limit is clamped to 500 even when a client asks for more', async () => {
    const page = await get('/api/library/guide?limit=99999');
    assert.equal(page.limit, 500);
    assert.equal(page.channels.length, 500);
});

test('cursor pages concatenate to exactly the offset result - same order, no gaps or duplicates', async () => {
    // limit is clamped to 500, so the "whole" reference list is built from two
    // offset pages rather than one over-sized request.
    const p1 = await get('/api/library/guide?limit=500&offset=0');
    const p2 = await get('/api/library/guide?limit=500&offset=500');
    const whole = { channels: [...p1.channels, ...p2.channels], total: p1.total };
    assert.equal(whole.channels.length, 600, 'sanity: fixture has 600 channels');
    assert.equal(whole.total, 600);

    // Walk the cursor in small pages that do not evenly divide 600, so a
    // boundary lands mid-tie at least once.
    const collected = [];
    let cursor = null;
    let guard = 0;
    do {
        const qs = cursor ? `?limit=37&cursor=${encodeURIComponent(cursor)}` : '?limit=37';
        const page = await get(`/api/library/guide${qs}`);
        assert.ok(page.channels.length <= 37);
        collected.push(...page.channels);
        cursor = page.nextCursor;
        guard++;
        assert.ok(guard < 50, 'runaway pagination - something is not terminating');
    } while (cursor);

    assert.equal(collected.length, 600, 'no gaps or duplicates across pages');
    assert.deepEqual(
        collected.map(c => c.id),
        whole.channels.map(c => c.id),
        'cursor paging must produce exactly the same order as the offset page'
    );
});

test('an invalid cursor is rejected rather than silently mishandled', async () => {
    const res = await fetch(`${base}/api/library/guide?cursor=not-valid-base64!!`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 400);
});

test('offset paging still works exactly as before', async () => {
    const first = await get('/api/library/guide?limit=10&offset=0');
    const second = await get('/api/library/guide?limit=10&offset=10');
    assert.equal(first.channels.length, 10);
    assert.equal(second.channels.length, 10);
    assert.notEqual(first.channels[0].id, second.channels[0].id);
});

test('GET /library/guide/version answers a string, stable when nothing changed', async () => {
    const v1 = await get('/api/library/guide/version');
    assert.equal(typeof v1.version, 'string');
    const v2 = await get('/api/library/guide/version');
    assert.equal(v2.version, v1.version, 'asking twice with no change must answer the same thing');
});

test('the version changes after a hide, and again after a show', async () => {
    const before1 = (await get('/api/library/guide/version')).version;

    const hideResp = await fetch(`${base}/api/channels/hide`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, itemType: 'channel', itemId: 'pos_0' })
    });
    assert.equal(hideResp.status, 200, await hideResp.text());
    const afterHide = (await get('/api/library/guide/version')).version;
    assert.notEqual(afterHide, before1, 'hiding a channel must change the guide version');

    const showResp = await fetch(`${base}/api/channels/show`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, itemType: 'channel', itemId: 'pos_0' })
    });
    assert.equal(showResp.status, 200, await showResp.text());
    const afterShow = (await get('/api/library/guide/version')).version;
    assert.notEqual(afterShow, afterHide, 'showing it again must change the version again');
});
