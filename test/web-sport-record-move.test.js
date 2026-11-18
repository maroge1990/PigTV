'use strict';
// Opus review of #327: "Record on B" for a game set to record on A shows Change recording of A (never a second recording)
// with "Set to record on A." and "Record on B instead": since #329 (Codex round 1) the server moves the schedule in one
// step (POST /recordings/scheduled/:id/move); a refused move leaves A as it was.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, page } = require('./helpers/sportWeb');

const H = 3600000;
async function harness({ fail = null, status = 'scheduled' } = {}) {
    const calls = [];
    const f = answer();
    const nxt = f.games.find(g => g.id === 'nxt'); // C-R: set to record (scheduleId 4) on Stan Sport 2
    nxt.recording = { scheduleId: 4, status };
    nxt.channels.push({ sourceId: 2, stableId: 'k5', id: '505', name: 'Kayo 5', start: nxt.start + H, end: nxt.start + 3 * H });
    const rows = [{ id: 4, status, pre_buffer_min: 3, post_buffer_min: 20, endsWith: 'event', source_id: 1, channel_item_id: '102', channel_stable_id: 's2', channel_name: 'Stan Sport 2' }];
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/recordings/scheduled') return rows;
        if (url.endsWith('/move')) { if (fail) throw fail; return { ...rows[0], channel_name: 'Kayo 5', channel_item_id: '505' }; }
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); return { id: 5 }; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    p.openRecord('nxt', { channel: '2:k5' });
    const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
    await settle();
    const body = () => b.document.body.querySelector('dialog .ui-dialog-body')?.innerHTML || '';
    const move = async () => {
        const el = b.document.createElement('button'); el.setAttribute('data-act', 'r-move');
        b.document.body.querySelector('dialog .ui-dialog-body').appendChild(el); el.click(); await settle();
    };
    return { b, p, nxt, calls, body, move };
}
const writes = (h) => h.calls.filter(c => c[0] === 'schedule' || c[0] === 'DELETE' || (c[0] === 'POST'));

test('Record on Kayo 5 for a game set on Stan Sport 2: Change recording of it; Record on Kayo 5 instead moves it in one request', async () => {
    const h = await harness();
    assert.match(h.body(), /CHANGE RECORDING · RECORDING SCHEDULED/);
    assert.match(h.body(), /<div class="rmove"><p>Set to record on Stan Sport 2\.<\/p><button type="button" class="pill" data-act="r-move" data-key="r:move"><svg[\s\S]*?<\/svg>Record on Kayo 5 instead<\/button><\/div>/);
    await h.move();
    assert.deepEqual(JSON.parse(JSON.stringify(writes(h))), [['POST', '/recordings/scheduled/4/move',
        { sourceId: 2, channelItemId: '505', channelName: 'Kayo 5', programStart: h.nxt.start + H, programEnd: h.nxt.start + 3 * H }]],
    '#329: the server moves the schedule (game and padding kept); never a schedule then a cancel');
    assert.equal(h.b.document.body.querySelector('dialog'), null);
    assert.equal(h.b.context.toasts.at(-1)[0], 'Now recording on Kayo 5 instead of Stan Sport 2.');
});

test('the move is refused: nothing else is sent, the recording on Stan Sport 2 stays, and the page says so', async () => {
    const h = await harness({ fail: Object.assign(new Error('That channel is not available.'), { status: 400 }) });
    await h.move();
    assert.equal(writes(h).length, 1, 'the move alone: no cancel, no schedule');
    assert.ok(h.b.document.body.querySelector('dialog'));
    assert.match(h.body(), /<p class="rerr" role="alert">It couldn’t be set to record on Kayo 5\. That channel is not available\. It still records on Stan Sport 2\.<\/p>/);
});

test('#329: it started recording meanwhile (409): the server\'s words, nothing changed', async () => {
    const h = await harness({ fail: Object.assign(new Error('It is already recording on Stan Sport 2; stop it first to record on another channel.'), { status: 409 }) });
    await h.move();
    assert.equal(writes(h).length, 1);
    assert.match(h.body(), /<p class="rerr" role="alert">It couldn’t be set to record on Kayo 5\. It is already recording on Stan Sport 2; stop it first to record on another channel\.<\/p>/);
});

test('while it records, no move is offered (it would stop the recording)', async () => {
    const h = await harness({ status: 'recording' });
    assert.doesNotMatch(h.body(), /r-move/);
});
