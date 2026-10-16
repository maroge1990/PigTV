const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// R6 (Wave 4): a recording's artwork is its programme's image from the guide (<icon src>), kept at
// ingest in epg_programs.data.img, found when the schedule is made, inherited by the recording, and
// listed only as /api/logo/<key> (the logo cache: registered, fetched and served by the server).
// The old code keeps no programme image and lists none.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-artwork-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const engine = load('services/recordingEngine');
const { keyForUrl } = load('services/logoCache');
const { programmeData } = load('services/syncService');
const { recordings, initSchema } = load('db/recordingsDb');

const IMG = 'https://images.example.invalid/afl/round-7.jpg';
const START = Date.now() + 3600e3;
let source;

before(async () => {
    initSchema();
    source = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://provider.invalid/get.php?username=u&password=p' });
    const d = sqlite.getDb();
    d.prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, sort_order, stable_id, tvg_id, is_hidden)
               VALUES (?, ?, 'pos_1', 'live', 'Fox Footy', 'Sport', 1, 'ff', 'ff', 0)`).run(`${source.id}:pos_1`, source.id);
    d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, data) VALUES ('ff', ?, ?, ?, ?, ?)`)
        .run(source.id, START, START + 3 * 3600e3, 'AFL: Collingwood v Carlton', programmeData({ icon: IMG, episodeNum: 'R7' }));
    d.prepare(`INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, data) VALUES ('ff', ?, ?, ?, ?, NULL)`)
        .run(source.id, START + 4 * 3600e3, START + 5 * 3600e3, 'Footy Talk');
});

after(() => {
    try { sqlite.getDb().close(); } catch { /* already closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('the guide sync keeps a programme\'s image, http(s) only', () => {
    assert.deepEqual(JSON.parse(programmeData({ icon: ` ${IMG} ` })), { img: IMG });
    assert.equal(programmeData({ icon: 'file:///etc/passwd' }), null);
    assert.equal(programmeData({ icon: `https://x.invalid/${'a'.repeat(600)}` }), null);
});

test('a schedule takes its programme\'s image; the lists give /api/logo/<key>, never the address; the recording inherits it', async () => {
    const s = await engine.scheduleFromProgram({ sourceId: source.id, channelItemId: `m3u_${source.id}_pos_1`, channelName: 'Fox Footy',
        title: 'AFL: Collingwood v Carlton', programStart: START, programEnd: START + 3 * 3600e3, createdBy: 1 });
    assert.equal(s.image_url, IMG);
    const listed = engine.listScheduled().find(r => r.id === s.id);
    assert.equal(listed.image, `/api/logo/${keyForUrl(IMG)}`);
    assert.equal('image_url' in listed, false);
    assert.ok(!JSON.stringify(engine.listScheduled({ includeRecent: true })).includes('images.example'), 'no address in any list');
    assert.equal(sqlite.getDb().prepare('SELECT url FROM logo_cache WHERE key = ?').get(keyForUrl(IMG)).url, IMG, 'registered, so /api/logo serves it');

    const none = await engine.scheduleFromProgram({ sourceId: source.id, channelItemId: 'pos_1', channelName: 'Fox Footy',
        title: 'Footy Talk', programStart: START + 4 * 3600e3, programEnd: START + 5 * 3600e3 });
    assert.equal(engine.listScheduled().find(r => r.id === none.id).image, null, 'no image in the guide: null');

    const rec = recordings.create({ scheduled_id: s.id, title: s.title, channel_name: 'Fox Footy', channel_logo: null, source_id: source.id,
        channel_item_id: 'pos_1', file_path: path.join(sandbox, 'x.ts'), started_at: Date.now(), part: 1 });
    recordings.setSegmentFields(rec.id, { image_url: IMG });
    const row = engine.listRecordings(1).find(r => r.id === rec.id);
    assert.equal(row.image, `/api/logo/${keyForUrl(IMG)}`);
    assert.equal('image_url' in row, false);
});
