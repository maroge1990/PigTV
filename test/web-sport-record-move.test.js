'use strict';
// Opus review of #327: "Record on B" for a game set to record on A shows Change recording of A (never a second recording)
// with "Set to record on A." and "Record on B instead": B is scheduled first (with the game's id and A's padding), and
// only once that succeeds is A cancelled; a failed schedule leaves A as it was.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, page } = require('./helpers/sportWeb');

const H = 3600000;
async function harness({ fail = false, status = 'scheduled', answers = null } = {}) {
    const calls = [];
    const f = answer();
    const nxt = f.games.find(g => g.id === 'nxt'); // C-R: set to record (scheduleId 4) on Stan Sport 2
    nxt.recording = { scheduleId: 4, status };
    nxt.channels.push({ sourceId: 2, stableId: 'k5', id: '505', name: 'Kayo 5', start: nxt.start + H, end: nxt.start + 3 * H });
    const rows = [{ id: 4, status, pre_buffer_min: 3, post_buffer_min: 20, endsWith: 'event', source_id: 1, channel_item_id: '102', channel_stable_id: 's2', channel_name: 'Stan Sport 2' }];
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/recordings/scheduled') return rows;
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: async (d) => {
        calls.push(['schedule', d]);
        if (fail) throw Object.assign(new Error('That channel is not available.'), { status: 400 });
        if (!answers) return { id: 5 };
        const a = answers.shift();
        return typeof a === 'function' ? a() : a;
    } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    p.openDetails('nxt');
    p.detailsAct('d-record-on', { getAttribute: (k) => (k === 'data-channel' ? '2:k5' : null) }, p.game('nxt'));
    const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
    await settle();
    const body = () => b.document.body.querySelector('dialog .ui-dialog-body')?.innerHTML || '';
    const move = async () => {
        const el = b.document.createElement('button'); el.setAttribute('data-act', 'r-move');
        b.document.body.querySelector('dialog .ui-dialog-body').appendChild(el); el.click(); await settle();
    };
    return { b, p, nxt, calls, body, move };
}

test('Record on Kayo 5 for a game set on Stan Sport 2: Change recording of it, with Record on Kayo 5 instead', async () => {
    const h = await harness();
    assert.match(h.body(), /CHANGE RECORDING · RECORDING SCHEDULED/);
    assert.match(h.body(), /<div class="rmove"><p>Set to record on Stan Sport 2\.<\/p><button type="button" class="pill" data-act="r-move" data-key="r:move"><svg[\s\S]*?<\/svg>Record on Kayo 5 instead<\/button><\/div>/);
    await h.move();
    const order = h.calls.filter(c => c[0] === 'schedule' || c[0] === 'DELETE');
    assert.deepEqual(JSON.parse(JSON.stringify(order)), [
        ['schedule', { sourceId: 2, channelItemId: '505', channelName: 'Kayo 5', title: 'Newcastle v Tottenham', programStart: h.nxt.start + H, programEnd: h.nxt.start + 3 * H,
            preBufferMin: 3, postBufferMin: 20, gameId: 'nxt' }],
        ['DELETE', '/recordings/scheduled/4', null]], 'Kayo 5 first, with the game\'s id and the same padding; then Stan Sport 2 cancelled');
    assert.equal(h.b.document.body.querySelector('dialog'), null);
    assert.equal(h.b.context.toasts.at(-1)[0], 'Now recording on Kayo 5 instead of Stan Sport 2.');
});

test('the schedule on Kayo 5 fails: the recording on Stan Sport 2 stays, and the page says so', async () => {
    const h = await harness({ fail: true });
    await h.move();
    assert.equal(h.calls.filter(c => c[0] === 'DELETE').length, 0, 'never cancelled');
    assert.ok(h.b.document.body.querySelector('dialog'));
    assert.match(h.body(), /<p class="rerr" role="alert">It couldn’t be set to record on Kayo 5\. That channel is not available\. It still records on Stan Sport 2\.<\/p>/);
});

test('while it records, no move is offered (it would stop the recording)', async () => {
    const h = await harness({ status: 'recording' });
    assert.doesNotMatch(h.body(), /r-move/);
});

test('#329: the server keeps one schedule per game (answers A, alreadyScheduled): A is cancelled, then Kayo 5 is set', async () => {
    const h = await harness({ answers: [{ id: 4, alreadyScheduled: true, channel_name: 'Stan Sport 2' }, { id: 5 }] });
    await h.move();
    const order = h.calls.filter(c => c[0] === 'schedule' || c[0] === 'DELETE').map(c => c[0] === 'schedule' ? ['schedule', c[1].channelItemId, c[1].gameId] : c.slice(0, 2));
    assert.deepEqual(order, [['schedule', '505', 'nxt'], ['DELETE', '/recordings/scheduled/4'], ['schedule', '505', 'nxt']]);
    assert.equal(h.b.context.toasts.at(-1)[0], 'Now recording on Kayo 5 instead of Stan Sport 2.');
});

test('#329: Kayo 5 then fails after A was cancelled: A is set again and the page says it still records there', async () => {
    const h = await harness({ answers: [{ id: 4, alreadyScheduled: true, channel_name: 'Stan Sport 2' }, () => { throw new Error('gone'); }, { id: 6 }] });
    await h.move();
    const order = h.calls.filter(c => c[0] === 'schedule' || c[0] === 'DELETE').map(c => c[0] === 'schedule' ? ['schedule', c[1].channelItemId] : c.slice(0, 2));
    assert.deepEqual(order, [['schedule', '505'], ['DELETE', '/recordings/scheduled/4'], ['schedule', '505'], ['schedule', '102']]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.b.context.toasts.at(-1))), ['It couldn’t be set to record on Kayo 5. It still records on Stan Sport 2.', { kind: 'error' }]);
});

test('#329: another schedule of the game records it already: nothing is cancelled, the page says where', async () => {
    const h = await harness({ answers: [{ id: 7, alreadyScheduled: true, channel_name: 'Fox Footy' }] });
    await h.move();
    assert.equal(h.calls.filter(c => c[0] === 'DELETE').length, 0);
    assert.equal(h.b.context.toasts.at(-1)[0], 'Already set to record on Fox Footy.');
});
