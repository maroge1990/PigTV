// D-6 (#274 item 3): one owner for "channel -> stream address", shared by playback (providerRouting.plan)
// and recording (recordingEngine.resolveStreamUrl). Pins the deliberate differences between the two callers
// (an unlisted Xtream id; a schedule's channel identity) and the fix that came with sharing: a composite id
// never reaches the Xtream address.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-chaddr-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);
const sqlite = require(path.join(sandbox, 'server/db/sqlite'));
const { sources } = require(path.join(sandbox, 'server/db'));
const routing = require(path.join(sandbox, 'server/services/providerRouting'));
const engine = require(path.join(sandbox, 'server/services/recordingEngine'));
const { bareChannelId } = require(path.join(sandbox, 'server/services/channelIds'));
const { MESSAGES: FAILURE_TEXT } = require(path.join(sandbox, 'server/services/playbackErrors'));

after(() => {
    process.chdir(os.tmpdir());
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* junction already gone */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left to the OS temp cleaner */ }
});

// Fake hosts only (provider.invalid): no real-looking address is built or printed.
let M3U, XT;
const URL_A = 'http://provider.invalid/m3u/a.ts';
const URL_B = 'http://provider.invalid/m3u/b.ts';

function row(sourceId, itemId, { url = null, data = null, stableId = null, order = 1, name = itemId } = {}) {
    sqlite.getDb().prepare(`
        INSERT INTO playlist_items (id, source_id, item_id, type, name, category_id, stream_url, data, sort_order, stable_id)
        VALUES (?, ?, ?, 'live', ?, 'News', NULL, ?, ?, ?)
    `).run(`${sourceId}:${itemId}`, sourceId, itemId, name, data ?? JSON.stringify(url ? { url } : {}), order, stableId);
}

before(async () => {
    M3U = (await sources.create({ name: 'Test M3U', type: 'm3u', url: 'http://provider.invalid/list.m3u' })).id;
    XT = (await sources.create({ name: 'Test Xtream', type: 'xtream', url: 'http://provider.invalid', username: 'u', password: 'p' })).id;
    row(M3U, 'pos_1', { url: URL_A, stableId: 's100', order: 1 });
    row(M3U, 'pos_2', { url: URL_B, stableId: 's200', order: 2 });
    row(M3U, 'pos_3', { data: '{}', order: 3 });          // no stream address
    row(XT, '123', { stableId: 'x-123' });
});

const streamIdOf = (url) => String(url).split('/').pop();

// ---------------------------------------------------------------- decision 3: the fix (fails on the old code) --

test('a composite Xtream id never reaches the provider address: playback', async () => {
    const url = await routing.streamUrlForChannel(XT, `xtream_${XT}_123`);
    assert.equal(streamIdOf(url), '123.ts');
    assert.ok(!url.includes('xtream_'), 'the composite spelling is not in the address');
    const plan = await routing.plan(XT, `xtream_${XT}_123`);
    assert.equal(streamIdOf(plan.candidates[0].url), '123.ts');
});

test('a composite Xtream id never reaches the provider address: recording, listed or not', async () => {
    assert.equal(streamIdOf(await engine.resolveStreamUrl(XT, `xtream_${XT}_123`)), '123.ts', 'a listed channel: its row\'s id');
    assert.equal(streamIdOf(await engine.resolveStreamUrl(XT, `xtream_${XT}_999`)), '999.ts', 'an unlisted one: the bare id');
});

// ------------------------------------------------------------- decision 1: an Xtream id not in the channel list --

test('playback refuses an Xtream id that is not in the channel list (#209), without building an address', async () => {
    for (const call of [() => routing.streamUrlForChannel(XT, '999'), () => routing.streamUrlFor({ sourceId: XT, channelId: '999' })]) {
        await assert.rejects(call(), (err) => {
            assert.equal(err.status, 404);
            assert.equal(err.message, FAILURE_TEXT.notInPlaylist());
            assert.ok(!/provider\.invalid/.test(err.message + (err.detail || '')), 'no address in the error');
            return true;
        });
    }
});

test('recording still builds the address for an Xtream id a sync dropped from the list', async () => {
    assert.equal(streamIdOf(await engine.resolveStreamUrl(XT, '999')), '999.ts');
    assert.equal(streamIdOf(await routing.streamUrlFor({ sourceId: XT, channelId: '999', buildUnlistedXtream: true })), '999.ts');
});

test('recording on Xtream ignores the schedule\'s identity, as before', async () => {
    assert.equal(streamIdOf(await engine.resolveStreamUrl(XT, '123', 'some-other-identity')), '123.ts');
});

// --------------------------------------------------------------------- decision 2: a schedule's channel identity --

test('recording with an identity on M3U finds that identity only (DVR-2); playback goes by the id', async () => {
    assert.equal(await engine.resolveStreamUrl(M3U, 'pos_1', 's200'), URL_B, 'the identity wins over the stale position');
    await assert.rejects(engine.resolveStreamUrl(M3U, 'pos_1', 's-gone'), /not found/, 'a gone identity never falls back to pos_N');
    assert.equal(await engine.resolveStreamUrl(M3U, 'pos_1', null), URL_A, 'a schedule without an identity: the position');
    assert.equal(await routing.streamUrlForChannel(M3U, 'pos_1'), URL_A);
    assert.equal(await routing.streamUrlForChannel(M3U, `m3u_${M3U}_pos_1`), URL_A, 'the composite spelling too');
});

// ------------------------------------------------------------------------------------------- errors, per caller --

test('playback errors are client-safe with a status; recording keeps the texts a failed schedule has always shown', async () => {
    await assert.rejects(routing.streamUrlForChannel(9999, 'pos_1'), (e) => e.status === 404 && e.message === FAILURE_TEXT.notInPlaylist());
    await assert.rejects(routing.streamUrlForChannel(M3U, 'pos_404'), (e) => e.status === 404 && e.message === FAILURE_TEXT.notInPlaylist());
    await assert.rejects(routing.streamUrlForChannel(M3U, 'pos_3'), (e) => e.status === 422 && e.message === FAILURE_TEXT.noStreamUrl());

    await assert.rejects(engine.resolveStreamUrl(9999, 'pos_1'), { message: 'Source 9999 not found' });
    await assert.rejects(engine.resolveStreamUrl(M3U, 'pos_404'), { message: `Channel pos_404 not found for source ${M3U}` });
    await assert.rejects(engine.resolveStreamUrl(M3U, 'pos_3'), { message: 'No stream URL available for channel pos_3' });
});

// ---------------------------------------------------------------------------------------------- identity, one lookup --

test('one channel identity serves both: the failover key and a schedule\'s stable id', () => {
    assert.deepEqual(routing.channelIdentity(M3U, `m3u_${M3U}_pos_2`), { key: 's200', name: 'pos_2', stableId: 's200' });
    assert.deepEqual(routing.channelIdentity(M3U, 'pos_3'), { key: 'pos_3', name: 'pos_3', stableId: null },
        'a row without an identity: keyed by its item id, and no stable id for a schedule');
    assert.equal(routing.channelIdentity(M3U, 'pos_404'), null);
});

// ----------------------------------------------------------------------------- the strip and the guide id, one copy --

test('bareChannelId is exactly the inline strip it replaced, for every input those sites see', () => {
    const inline = (id) => String(id).replace(new RegExp('^(?:m3u|xtream)_\\d+_'), '');
    for (const id of ['pos_9', 'm3u_5_pos_9', 'xtream_6_1042', 'xtream_6_1_2', '1042', 1042, '', 'm3u__x',
        'M3U_5_x', 'm3u_5_a\nb', 'm3u_5_m3u_5_x', null, undefined, 0]) {
        assert.equal(bareChannelId(id), inline(id), JSON.stringify(id));
    }
    // Except a prefix with nothing after it: kept as it came (as before 0573), never '' (a junk favourite, a shared key).
    assert.equal(bareChannelId('m3u_5_'), 'm3u_5_');
    assert.equal(bareChannelId('xtream_6_'), 'xtream_6_');
});

test('a row\'s guide id: the column, else the stored data, then the admin\'s mapping', () => {
    const { rowTvgId } = require(path.join(sandbox, 'server/services/epgMapping'));
    assert.equal(rowTvgId(M3U, { item_id: 'z1', stable_id: null, tvg_id: 'col.tv', data: '{"tvgId":"blob.tv"}' }), 'col.tv');
    assert.equal(rowTvgId(M3U, { item_id: 'z1', stable_id: null, tvg_id: null, data: '{"tvgId":"blob.tv"}' }), 'blob.tv');
    assert.equal(rowTvgId(M3U, { item_id: 'z1', stable_id: null, tvg_id: '', data: '{"epg_channel_id":"epg.tv"}' }), 'epg.tv');
    assert.equal(rowTvgId(M3U, { item_id: 'z1', stable_id: null, tvg_id: null, data: 'not json' }), null);
    assert.equal(rowTvgId(M3U, { item_id: 'z1', stable_id: null, tvg_id: null, data: 'null' }), null);
});
