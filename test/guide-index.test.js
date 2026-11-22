const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// #361 (0888): the guide pages from an in-memory index of the visible order instead of filtering and sorting every
// visible playlist row twice per page (COUNT, then ORDER BY ... LIMIT). The answers must be the same, byte for byte,
// for every limit, offset, cursor and category, including sort_order ties, name ties, NULL sort_order and names whose
// UTF-16 order differs from SQLite's UTF-8 byte order.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-guide-index-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const auth = load('auth');
const sqlite = load('db/sqlite');
const { bumpLibraryRev } = load('services/libraryRev');
const library = load('routes/library');

let server, base, token, source;
const HOUR = 3600000;
const START = Date.now() - HOUR, END = START + 6 * HOUR;

async function getRaw(route) {
    const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, text: await response.text() };
}
// Everything in the answer but `now` (the clock moves between two requests).
function body(text) { const j = JSON.parse(text); delete j.now; return JSON.stringify(j); }

const NAMES = ['Alpha', 'alpha', 'Beta', 'Été', 'Zulu', 'émoji \u{1F600}', 'private ', 'ｆｕｌｌ', 'Same', 'Same', 'Same', '', 'Ω'];
function insertChannel(i, { name, sortOrder, category, hidden = 0 }) {
    sqlite.getDb().prepare(`
        INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, data, stable_id, tvg_id, is_hidden)
        VALUES (?, ?, ?, 'live', ?, ?, ?, '{}', ?, ?, ?)
    `).run(`${source.id}:${i}`, source.id, String(i), name, category, sortOrder, `s${i}`, `t${i % 20}.invalid`, hidden);
}

before(async () => {
    const user = await db.users.create({ username: 'owner', role: 'admin' });
    token = auth.generateToken({ ...user, id: 1 });
    source = await db.sources.create({ type: 'm3u', name: 'Household', url: 'https://provider.invalid/list.m3u' });
    const d = sqlite.getDb();
    d.prepare("INSERT INTO categories (id, source_id, category_id, type, name, is_hidden, sort_order) VALUES (?, ?, 'X', 'live', 'Hidden', 1, 9)")
        .run(`${source.id}:X`, source.id);
    for (let i = 0; i < 260; i++) {
        insertChannel(i, {
            name: `${NAMES[i % NAMES.length]} ${i % 7}`,
            // ties on sort_order in threes, every fifth one NULL (sorts last, by name then id)
            sortOrder: i % 5 === 0 ? null : Math.floor(i / 3),
            category: i % 11 === 0 ? 'X' : (i % 2 ? 'A' : 'B'),
            hidden: i % 13 === 0 ? 1 : 0
        });
    }
    // programmes, so the bodies carry more than channel rows
    const prog = d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, gen) VALUES (?, ?, ?, ?, ?, 0)`);
    for (let c = 0; c < 20; c++) for (let h = 0; h < 6; h++) prog.run(`t${c}.invalid`, source.id, START + h * HOUR, START + (h + 1) * HOUR, `Show ${c}/${h}`);

    const app = express();
    app.use(express.json());
    app.use('/api/library', library);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    library._setGuideIndexEnabled(true);
    server?.closeAllConnections?.();
    server?.close();
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* leave it to the OS temp cleaner */ }
});

/** The same route answered with the index and without it (the SQL of before 0888). */
async function both(route) {
    library._setGuideIndexEnabled(false);
    const old = await getRaw(route);
    library._setGuideIndexEnabled(true);
    const now = await getRaw(route);
    return { old, now };
}

test('every limit, offset and category answers exactly as the SQL did', async () => {
    let compared = 0;
    for (const category of ['', 'A', 'B', 'X', 'missing']) {
        for (const limit of [1, 7, 50, 500]) {
            for (const offset of [0, 3, 117, 239, 240, 1000]) {
                const route = `/api/library/guide?start=${START}&end=${END}&limit=${limit}&offset=${offset}${category ? `&category=${category}` : ''}`;
                const { old, now } = await both(route);
                assert.equal(now.status, old.status, route);
                assert.equal(body(now.text), body(old.text), route);
                compared++;
            }
        }
    }
    assert.equal(compared, 120);
});

test('cursor paging walks the same pages, cursors and ends, with and without the index', async () => {
    for (const category of ['', 'A', 'B', 'missing']) {
        for (const limit of [1, 9, 64]) {
            let cursor = null, pages = 0, seen = 0;
            do {
                const route = `/api/library/guide?start=${START}&end=${END}&limit=${limit}${category ? `&category=${category}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
                const { old, now } = await both(route);
                assert.equal(now.status, 200, route);
                assert.equal(body(now.text), body(old.text), route);
                const j = JSON.parse(now.text);
                seen += j.channels.length;
                cursor = j.nextCursor;
                pages++;
            } while (cursor && pages < 400);
            const total = JSON.parse((await getRaw(`/api/library/guide?limit=1${category ? `&category=${category}` : ''}`)).text).total;
            assert.equal(seen, total, `${category || 'all'} limit ${limit}: every visible channel once`);
        }
    }
});

test('a cursor for a row that is not there, or between rows, lands where the SQL does; a bad one is still a 400', async () => {
    const cursors = [
        { sk: 10, name: 'M', id: 'zz' },
        { sk: 10, name: 'Same 3', id: '' },
        { sk: 999999999, name: 'émoji', id: 'x' },
        { sk: 999999999, name: 'private ', id: 'x' },
        { sk: 999999999, name: '\u{1F600}', id: '' },
        { sk: 12.5, name: '', id: '' },
        { sk: -1, name: '', id: '' },
        { sk: 1e12, name: '', id: '' }
    ];
    for (const key of cursors) {
        const cursor = Buffer.from(JSON.stringify(key)).toString('base64');
        for (const category of ['', 'A']) {
            const route = `/api/library/guide?start=${START}&end=${END}&limit=5&cursor=${encodeURIComponent(cursor)}${category ? `&category=${category}` : ''}`;
            const { old, now } = await both(route);
            assert.equal(now.status, 200);
            assert.equal(body(now.text), body(old.text), JSON.stringify(key));
        }
    }
    const bad = await both('/api/library/guide?cursor=not-a-cursor');
    assert.equal(bad.now.status, 400);
    assert.equal(bad.now.text, bad.old.text);
});

/** Count the statements run against the visible set (VISIBLE_SQL's hidden-category test) while `fn` runs. */
async function countVisibleScans(fn) {
    const d = sqlite.getDb();
    const prepare = d.prepare;
    let scans = 0;
    d.prepare = function (sql) {
        const stmt = prepare.call(this, sql);
        if (!/c\.is_hidden = 1/.test(sql)) return stmt;
        for (const m of ['all', 'get', 'iterate', 'run']) {
            const orig = stmt[m];
            stmt[m] = function (...args) { scans++; return orig.apply(this, args); };
        }
        return stmt;
    };
    try { await fn(); } finally { delete d.prepare; }
    return scans;
}

test('only the first page of a guide version scans the visible set: the next pages read none', async () => {
    library._setGuideIndexEnabled(true);
    bumpLibraryRev();
    const pages = [];
    let cursor = null;
    const first = await countVisibleScans(async () => {
        const j = JSON.parse((await getRaw(`/api/library/guide?limit=60&start=${START}&end=${END}`)).text);
        cursor = j.nextCursor;
    });
    assert.ok(first <= 1, `the first page builds the index with one scan (${first})`);
    for (let i = 0; i < 3; i++) {
        pages.push(await countVisibleScans(async () => {
            const j = JSON.parse((await getRaw(`/api/library/guide?limit=60&start=${START}&end=${END}&cursor=${encodeURIComponent(cursor)}`)).text);
            cursor = j.nextCursor;
        }));
    }
    pages.push(await countVisibleScans(() => getRaw(`/api/library/guide?limit=60&offset=120&category=A`)));
    assert.deepEqual(pages, [0, 0, 0, 0], 'no COUNT and no ORDER BY over the visible set on later pages');
});

test('a guide version change rebuilds the index; a row gone before the version moved is answered by SQL', async () => {
    const before = JSON.parse((await getRaw('/api/library/guide?limit=500')).text);
    const victim = before.channels[3];
    // A hide as routes/channels.js does it: the row's flag, then the version.
    sqlite.getDb().prepare('UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND item_id = ?').run(victim.sourceId, victim.id);
    bumpLibraryRev();
    const hidden = JSON.parse((await getRaw('/api/library/guide?limit=500')).text);
    assert.equal(hidden.total, before.total - 1);
    assert.ok(!hidden.channels.some(c => c.id === victim.id));

    // Deleted with no version change (a sync between its commit and its bump): still a whole, correct page.
    const gone = hidden.channels[0];
    sqlite.getDb().prepare('DELETE FROM playlist_items WHERE source_id = ? AND item_id = ?').run(gone.sourceId, gone.id);
    const { old, now } = await both(`/api/library/guide?limit=500&start=${START}&end=${END}`);
    assert.equal(body(now.text), body(old.text));
    assert.ok(!JSON.parse(now.text).channels.some(c => c.id === gone.id));
});
