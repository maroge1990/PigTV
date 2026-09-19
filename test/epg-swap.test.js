const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

// A sandbox copy of the server, so its relative data paths never touch real
// data (same approach as access.test.js; a junction so it works on Windows).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-epg-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');

// A database as an older PigTV would have left it: programmes with no
// generation column. Opening it must make them live, not lose them.
fs.mkdirSync(path.join(sandbox, 'data'));
{
    const legacy = new Database(path.join(sandbox, 'data/content.db'));
    legacy.exec(`CREATE TABLE epg_programs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, source_id INTEGER NOT NULL,
        start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, title TEXT, description TEXT, data JSON)`);
    const ins = legacy.prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, data) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 3; i++) ins.run('bbc1', 1, 1000 + i, 2000 + i, `Legacy ${i}`, '{"big":"blob"}');
    legacy.close();
}

const load = p => require(path.join(sandbox, 'server', p));
const { getDb } = load('db/sqlite');
const epgParser = load('services/epgParser');
const sync = load('services/syncService');

const live = (sourceId) => getDb().prepare('SELECT title FROM epg_live WHERE source_id = ? ORDER BY start_time').all(sourceId).map(r => r.title);
const stored = (sourceId) => getDb().prepare('SELECT COUNT(*) n FROM epg_programs WHERE source_id = ?').get(sourceId).n;

const prog = (title, i) => ({ channelId: 'bbc1', start: new Date(5000 + i), stop: new Date(6000 + i), title, description: `about ${title}` });

// Stand in for the feed: yield the given batches, optionally pausing between the
// first and second so the test can look at the database mid-sync.
function feed(batches, { gate, failAfterFirst } = {}) {
    epgParser.fetchAndParseStreaming = async function* () {
        for (let i = 0; i < batches.length; i++) {
            if (i === 1 && gate) await gate;
            if (i === 1 && failAfterFirst) throw new Error('feed dropped mid-stream');
            yield { channels: i === 0 ? [] : null, programmes: batches[i] };
        }
    };
}

before(() => { /* modules above have already opened and migrated the legacy database */ });

after(() => {
    try { getDb().close(); } catch { /* already closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* still open on Windows; leave it to the OS temp cleaner */ }
});

test('programmes that predate generations survive the upgrade and are live', () => {
    assert.deepEqual(live(1), ['Legacy 0', 'Legacy 1', 'Legacy 2']);
});

test('a source with no epg_state row is live at generation 0, so a direct insert is visible', () => {
    getDb().prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title) VALUES (?, ?, ?, ?, ?)')
        .run('x', 77, 1, 2, 'Inserted directly');
    assert.deepEqual(live(77), ['Inserted directly']);
    getDb().prepare('DELETE FROM epg_programs WHERE source_id = 77').run();
});

test('a sync replaces the guide, and stores no per-programme JSON blob', async () => {
    feed([[prog('New A', 0), prog('New B', 1)], [prog('New C', 2)]]);
    await sync.syncEpgFromUrl(1, 'http://feed.invalid/epg.xml');
    assert.deepEqual(live(1), ['New A', 'New B', 'New C']);
    assert.equal(stored(1), 3, 'the superseded generation is deleted, not left to accumulate');
    const blobs = getDb().prepare('SELECT COUNT(*) n FROM epg_programs WHERE source_id = 1 AND data IS NOT NULL').get().n;
    assert.equal(blobs, 0, 'the full programme JSON is no longer stored');
});

test('the guide is never empty while a new feed loads, and the swap is all-at-once', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    feed([[prog('Next A', 10)], [prog('Next B', 11), prog('Next C', 12)]], { gate });

    const syncing = sync.syncEpgFromUrl(1, 'http://feed.invalid/epg.xml');
    // Let the first batch be written, then look while the sync is paused.
    for (let i = 0; i < 50 && stored(1) < 4; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(stored(1) > 3, 'the new generation is being written alongside the old');
    assert.deepEqual(live(1), ['New A', 'New B', 'New C'], 'readers still see the complete old guide mid-sync');

    release();
    await syncing;
    assert.deepEqual(live(1), ['Next A', 'Next B', 'Next C']);
    assert.equal(stored(1), 3, 'nothing left behind once the swap is done');
});

test('a feed that fails half-way leaves the live guide untouched and cleans up after itself', async () => {
    feed([[prog('Bad A', 20)], [prog('Bad B', 21)]], { failAfterFirst: true });
    await assert.rejects(sync.syncEpgFromUrl(1, 'http://feed.invalid/epg.xml'), /feed dropped/);
    assert.deepEqual(live(1), ['Next A', 'Next B', 'Next C']);
    assert.equal(stored(1), 3, 'the partial load was discarded');
});

test('an empty feed is treated as a broken feed, not as an empty guide', async () => {
    feed([[]]);
    await sync.syncEpgFromUrl(1, 'http://feed.invalid/epg.xml');
    assert.deepEqual(live(1), ['Next A', 'Next B', 'Next C']);
    assert.equal(stored(1), 3);
});

test('syncing one source never disturbs another', async () => {
    feed([[prog('Other A', 30)]]);
    await sync.syncEpgFromUrl(2, 'http://feed2.invalid/epg.xml');
    assert.deepEqual(live(2), ['Other A']);

    feed([[prog('Again A', 31)]]);
    await sync.syncEpgFromUrl(1, 'http://feed.invalid/epg.xml');
    assert.deepEqual(live(1), ['Again A']);
    assert.deepEqual(live(2), ['Other A'], 'source 2 keeps its own guide');
});

test('debris from an interrupted earlier sync is swept, not shown', async () => {
    // A crash after writing the next generation but before the swap.
    getDb().prepare('INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, gen) VALUES (?, ?, ?, ?, ?, ?)')
        .run('bbc1', 2, 1, 2, 'Half-written', 99);
    assert.deepEqual(live(2), ['Other A'], 'an unpublished generation is invisible to readers');

    feed([[prog('Clean A', 40)]]);
    await sync.syncEpgFromUrl(2, 'http://feed2.invalid/epg.xml');
    assert.deepEqual(live(2), ['Clean A']);
    assert.equal(stored(2), 1, 'the leftover rows were removed');
});
