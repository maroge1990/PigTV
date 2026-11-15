'use strict';
// Codex sign-off of #327 (high): a schedule is this game's only on the game's channel by identity (ARCHITECTURE › Channel
// identity): a schedule with a stable id never falls back to its stored pos_N. After a playlist reorder another channel's
// schedule can carry this channel's position: it is not this game's, and Record game records the game.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, page } = require('./helpers/sportWeb');

const H = 3600000;
async function harness(rows) {
    const calls = [];
    const f = answer();
    const nxt = f.games.find(g => g.id === 'nxt'); // on Stan Sport 2: stable id s2, position 102
    delete nxt.recording;
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/recordings/scheduled') return rows(nxt);
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); return { id: 9 }; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    p.openRecord('nxt');
    b.document.body.querySelector('dialog [data-act="r-save"]').click();
    for (let i = 0; i < 4; i++) await new Promise(setImmediate);
    return { calls, toasts: b.context.toasts };
}
const other = (nxt, o) => ({ id: 8, title: 'Another programme', status: 'scheduled', pre_buffer_min: 0, post_buffer_min: 0, source_id: 1, channel_item_id: '102',
    channel_stable_id: 'zz', channel_name: 'Another channel', program_start: nxt.start, program_end: nxt.start + 2 * H, ...o });

test('another channel\'s schedule sharing this channel\'s position (different stable ids): the game is recorded', async () => {
    const h = await harness((nxt) => [other(nxt)]);
    assert.equal(h.calls.filter(c => c[0] === 'PUT').length, 0, 'the other recording is never changed');
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 1, 'the game is scheduled');
    assert.equal(h.calls.find(c => c[0] === 'schedule')[1].gameId, 'nxt');
});

test('the same channel by its stable id, whatever its stored position: already set to record', async () => {
    const h = await harness((nxt) => [other(nxt, { channel_stable_id: 's2', channel_item_id: '555' })]);
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0);
    assert.equal(h.toasts.at(-1)[0], 'This game is already set to record.');
});

test('a schedule without a stable id matches by its position', async () => {
    const h = await harness((nxt) => [other(nxt, { channel_stable_id: null })]);
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0);
});
