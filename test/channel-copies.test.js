const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #332: same-provider copies. A provider often lists one channel more than once with no "(Backup)" marker; when one
// sends the provider's placeholder another often plays, but nothing linked them. A copy is another live item of the
// same source with a different identity and the same mapped guide id or the same normalised name (#331's audit rule);
// it is a candidate after the siblings and before the backups, for plays and for recordings (a channel with a copy is
// no longer a recording's 'single' route). The real plan over a sandboxed database; no provider is opened.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-copies-')));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const db = load('db');
const sqlite = load('db/sqlite');
const links = load('services/channelLinks');
const routing = load('services/providerRouting');
const engine = load('services/recordingEngine');

let A, B, C;
const URL_A = 'http://a.invalid/live';
before(async () => {
    A = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: 'http://a.invalid/list.m3u' });
    C = await db.sources.create({ type: 'm3u', name: 'Other primary', url: 'http://c.invalid/list.m3u' });
    const item = sqlite.getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, is_hidden, sort_order, stable_id, stream_url, tvg_id)
                                         VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?)`);
    const add = (src, itemId, name, { stable = null, tvg = null, hidden = 0, order, category = 'UK' } = {}) =>
        item.run(`${src.id}:${itemId}${category === 'UK' ? '' : `:${category}`}`, src.id, itemId, name, category, hidden, order, stable, `${URL_A}/${itemId}.ts`, tvg);
    add(A, 'pos_1', 'Sky Sports Main Event', { stable: 's1', tvg: 'skysportsmainevent.uk', order: 1 });
    add(A, 'pos_2', 'Sky Sports Main Event (Backup)', { stable: 's2', tvg: 'skysportsmainevent.uk', order: 2 }); // its sibling
    add(A, 'pos_3', 'SS Main Event FHD', { stable: 's3', tvg: 'other.uk', order: 3 }); // mapped to the same guide id below
    add(A, 'pos_4', 'ꜱᴋʏ ꜱᴘᴏʀᴛꜱ ᴍᴀɪɴ ᴇᴠᴇɴᴛ ᴴᴰ', { stable: 's4', order: 4, hidden: 1 }); // the same name, hidden
    add(A, 'pos_5', 'UK| Sky Sports Main Event 1080p50', { stable: null, order: 5 }); // a different name (its prefix)
    add(A, 'pos_6', 'Sky Sports Main Event', { stable: 's1', tvg: 'skysportsmainevent.uk', order: 6, category: 'Sport' }); // the same identity again
    add(A, 'pos_7', 'Sky Sports Cricket', { stable: 's7', tvg: 'skysportscricket.uk', order: 7 });
    add(A, 'pos_8', 'Sky Sports Main Event UHD', { stable: null, order: 8 }); // no stable_id: its item_id is its identity
    add(C, 'pos_1', 'Sky Sports Main Event', { stable: 'c1', tvg: 'skysportsmainevent.uk', order: 1 }); // another source
    sqlite.getDb().prepare(`INSERT INTO epg_mappings (source_id, channel_key, tvg_id, updated_at) VALUES (?, 's3', 'skysportsmainevent.uk', ?)`).run(A.id, Date.now());
    // The sibling link, as the linker writes it.
    sqlite.getDb().prepare(`INSERT INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, updated_at)
                            VALUES (?, 's1', ?, 's2', 'sibling', 'auto', 1, ?)`).run(A.id, A.id, Date.now());
});

afterEach(() => routing.reset());

after(() => {
    try { sqlite.getDb().close(); } catch { /* closed */ }
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS */ }
});

test('the normalised name: superscript and small capitals folded, "(backup)" and quality words gone, punctuation and spaces tidied', () => {
    for (const name of ['Sky Sports Main Event', 'Sky Sports Main Event FHD', 'ꜱᴋʏ ꜱᴘᴏʀᴛꜱ ᴍᴀɪɴ ᴇᴠᴇɴᴛ ᴴᴰ', 'SKY SPORTS MAIN EVENT (Backup)',
        'Sky Sports Main Event 1080p50', 'Sky Sports Main-Event  UHD', 'Sky Sports Main Event 4K HDR', 'Sky Sports Main Event ᵁᴴᴰ', 'Sky Sports Main Event 720p']) {
        assert.equal(links.copyName(name), 'sky sports main event', name);
    }
    assert.equal(links.copyName('Sky Sports Cricket'), 'sky sports cricket');
    assert.equal(links.copyName('UK| Sky Sports Main Event'), 'uk sky sports main event', 'a region prefix is part of the name');
    assert.equal(links.copyName('HD'), '', 'nothing left: never a match');
});

test('copies: the same mapped guide id or normalised name, a different identity, the same source, hidden ones too, in playlist order', () => {
    const copies = links.copiesOf(A.id, 's1').map(c => c.identity);
    // s2 (same guide id), s3 (mapped to the same guide id), s4 (hidden, same name), pos_8 (no stable_id, same name).
    assert.deepEqual(copies, ['s2', 's3', 's4', 'pos_8']);
    assert.ok(!copies.includes('s1'), 'never itself, however often it is listed');
    assert.ok(!copies.includes('s7'), 'another channel');
    assert.ok(!copies.includes('pos_5'), 'another name and no guide id');
    assert.ok(!copies.includes('c1'), 'never another source\'s');
    // The guide id the admin mapped wins over the row's own: s3's own (other.uk) does not make it a copy of something else.
    assert.deepEqual(links.copiesOf(A.id, 's7'), []);
    assert.deepEqual(links.copiesOf(A.id, 'nope'), [], 'not listed: none');
    // From a copy, the channel itself is a copy.
    assert.ok(links.copiesOf(A.id, 'pos_8').some(c => c.identity === 's1'));
});

test('the order: the primary, its sibling, one copy, then the backups; a quarantined copy gives way to the next', async () => {
    B = B || await db.sources.create({ type: 'm3u', name: 'Dream 4K', url: 'http://b.invalid/list.m3u', role: 'backup', priority: 1 });
    sqlite.getDb().prepare(`INSERT OR REPLACE INTO backup_channels (source_id, stream_id, name, url_data) VALUES (?, '901', 'Sky Sports Main Event', 'http://b.invalid/901.ts')`).run(B.id);
    sqlite.getDb().prepare(`INSERT OR REPLACE INTO channel_links (primary_source_id, primary_key, backup_source_id, backup_stream_id, method, status, rank, updated_at)
                            VALUES (?, 's1', ?, '901', 'exact', 'auto', 1, ?)`).run(A.id, B.id, Date.now());
    const plan = await routing.plan(A.id, 'pos_1');
    assert.deepEqual(plan.candidates.map(c => [c.via, c.providerId === A.id ? 'A' : 'B', c.channelKey]),
        [['primary', 'A', 's1'], ['sibling', 'A', 's2'], ['copy', 'A', 's3'], ['backup', 'B', '901']],
        'the sibling is not offered again as a copy; the first other copy (s3, by its mapped guide id) is');
    const copy = plan.candidates[2];
    assert.equal(copy.role, 'primary');
    assert.equal(copy.url, `${URL_A}/pos_3.ts`);
    assert.equal(plan.hasCopy, true);
    // Quarantine and breaker rules are a sibling's: a held-back copy is skipped, the next one is offered.
    routing.quarantine(A.id, 's3');
    const next = await routing.plan(A.id, 'pos_1');
    assert.deepEqual(next.candidates.map(c => c.channelKey), ['s1', 's2', 's4', '901']);
    // Every copy held back: none for a viewer; a recording's keepTrying still has one.
    for (const k of ['s4', 'pos_8']) routing.quarantine(A.id, k);
    assert.ok(!(await routing.plan(A.id, 'pos_1')).candidates.some(c => c.via === 'copy'));
    for (const k of ['s1', 's2', '901']) routing.quarantine(k === '901' ? B.id : A.id, k);
    const held = await routing.plan(A.id, 'pos_1', Date.now(), { keepTrying: true });
    assert.ok(held.candidates.some(c => c.via === 'copy' && c.channelKey === 's3'), held.candidates.map(c => c.channelKey).join(','));
    sqlite.getDb().prepare('DELETE FROM channel_links WHERE backup_source_id = ?').run(B.id);
    await db.sources.delete(B.id);
    B = null;
});

test('a recording of a channel with a copy is not single-candidate, with no backup configured', async () => {
    const route = await engine._routeFor({ id: 1, source_id: A.id, channel_item_id: 'pos_1', channel_stable_id: 's1' });
    assert.equal(route.multi, true);
    assert.deepEqual(route.candidates.map(c => [c.via, c.channelKey]), [['primary', 's1'], ['sibling', 's2'], ['copy', 's3']]);
    assert.equal(route.oneProvider, true, 'one provider: a stall stays off its breaker (#304)');
    // A channel with no copy and no backup stays single, as before.
    const single = await engine._routeFor({ id: 2, source_id: A.id, channel_item_id: 'pos_7', channel_stable_id: 's7' });
    assert.equal(single.multi, false);
    assert.equal(single.candidates.length, 1);
});
