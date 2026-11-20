'use strict';
// Codex review of #327 (high): the record page is opened on a game not set to record; meanwhile another tab, person or
// rule sets it to record. Record game then must not make a second recording (the server tells schedules apart by
// channel and start only, not by game): the list is read again at the press and the person's padding goes to the
// recording that is there (0662). A list that cannot be read records nothing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, page, stepTo, pressIn } = require('./helpers/sportWeb');

const H = 3600000;
async function harness() {
    const calls = [];
    const f = answer();
    const nxt = f.games.find(g => g.id === 'nxt');
    delete nxt.recording;
    nxt.channels.push({ sourceId: 2, stableId: 'k5', id: '505', name: 'Kayo 5', start: nxt.start, end: nxt.start + 2 * H });
    const state = { scheduled: [], fail: false, made: {} };
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/recordings/scheduled') { if (state.fail) throw new Error('offline'); return state.scheduled; }
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); return state.made; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    p.openRecord('nxt');
    const body = () => b.document.body.querySelector('dialog .ui-dialog-body')?.innerHTML || '';
    const choose = (id, v) => stepTo(b, p, id, v);
    // #358: the Channel page's rows (opened, read, then Back)
    const channels = () => { pressIn(b, { 'data-act': 'r-screen', 'data-to': 'channel' }); const html = body(); pressIn(b, { 'data-act': 'r-screen', 'data-to': 'main' }); return html; };
    const pick = (index) => { const el = b.document.createElement('button'); el.setAttribute('data-act', 'r-on'); el.setAttribute('data-index', String(index)); b.document.body.querySelector('dialog .ui-dialog-body').appendChild(el); el.click(); };
    const save = async () => { b.document.body.querySelector('dialog [data-act="r-save"]').click(); await new Promise(setImmediate); await new Promise(setImmediate); };
    return { b, p, f, nxt, calls, state, body, channels, choose, pick, save };
}
const row = (o) => ({ id: 4, status: 'scheduled', pre_buffer_min: 2, post_buffer_min: 15, endsWith: 'event', source_id: 1, channel_item_id: '102', channel_stable_id: 's2',
    channel_name: 'Stan Sport 2', ...o });

test('set to record on its best channel while the page is open, another channel chosen: no second recording, the padding goes to it', async () => {
    const h = await harness();
    h.pick(1);
    assert.match(h.channels(), /aria-checked="true" data-act="r-on" data-index="1"/, 'Kayo 5 chosen');
    h.choose('sp-rec-post', '30');
    h.state.scheduled = [row({ program_start: h.nxt.start, program_end: h.nxt.start + 2 * H })];
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0, 'no POST /recordings/schedule');
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c[0] === 'PUT'))), ['PUT', '/recordings/scheduled/4', { postBufferMin: 30 }]);
    assert.equal(h.b.document.body.querySelector('dialog'), null);
    assert.equal(h.b.context.toasts.at(-1)[0], 'This game was already set to record, so your changes went to that recording.');
});

test('set to record as C-R now says (a refresh while the page is open): found by its schedule id, nothing new', async () => {
    const h = await harness();
    h.nxt.recording = { scheduleId: 9, status: 'scheduled' };
    // #347: on a channel not the game's, during the airing chosen: C-R's schedule id says it is this game's
    h.state.scheduled = [row({ id: 9, source_id: 3, channel_stable_id: 'zz', channel_item_id: '9', program_start: h.nxt.start, program_end: h.nxt.start + 2 * H })];
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0);
    assert.equal(h.calls.filter(c => c[0] === 'PUT').length, 0, 'Usual padding: nothing to change');
    assert.equal(h.b.context.toasts.at(-1)[0], 'This game is already set to record.');
});

test('the list cannot be read: nothing is recorded, the page stays open and says so', async () => {
    const h = await harness();
    h.state.fail = true;
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0, 'never a blind POST');
    assert.ok(h.b.document.body.querySelector('dialog'));
    assert.match(h.body(), /<p class="rerr" role="alert">PigTV couldn’t check whether this game is already set to record, so nothing was recorded\. Try again\.<\/p>/);
});

test('another programme on the same channel, or a cancelled schedule, is not this game: it records', async () => {
    const h = await harness();
    h.state.scheduled = [row({ program_start: h.nxt.start + 3 * H, program_end: h.nxt.start + 4 * H }), row({ id: 5, status: 'cancelled', program_start: h.nxt.start, program_end: h.nxt.start + 2 * H })];
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 1);
});

test('#329: the server answers alreadyScheduled (set to record between the read and the press): the page says where', async () => {
    const h = await harness();
    h.state.made = row({ alreadyScheduled: true, program_start: h.nxt.start, program_end: h.nxt.start + 2 * H });
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 1);
    assert.equal(h.b.document.body.querySelector('dialog'), null);
    assert.equal(h.b.context.toasts.at(-1)[0], 'Already set to record on Stan Sport 2.');
});

// #347 (Codex sign-off, high): Record options found "a" schedule of the game before reading the airing chosen, so with an
// earlier airing set to record (the front card's, or a rule's) a later, separate airing chosen PUT the earlier one's
// padding and never recorded the one chosen. Only a schedule of the chosen airing is this recording.
test('a later airing chosen while an earlier one of the game is set to record (its card\'s, a rule\'s): it records the one chosen', async () => {
    const h = await harness();
    const later = h.nxt.start + 26 * H;
    h.nxt.channels.push({ sourceId: 2, stableId: 'k6', id: '506', name: 'Kayo 6', start: later, end: later + 2 * H });
    h.p.closeWindow(); h.p.openRecord('nxt');
    h.nxt.recording = { scheduleId: 4, status: 'scheduled' }; // a refresh while the page is open: C-R names the earlier one
    const body = h.channels();
    const index = [...body.matchAll(/data-act="r-on" data-index="(\d+)"[^>]*>[\s\S]*?<\/button>/g)].find(m => m[0].includes('Kayo 6'));
    assert.ok(index, 'Kayo 6 is offered');
    h.pick(Number(index[1]));
    h.choose('sp-rec-post', '30');
    h.state.scheduled = [row({ program_start: h.nxt.start, program_end: h.nxt.start + 2 * H, gameId: 'nxt', rule_id: 3 })];
    h.state.made = { id: 7 };
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'PUT').length, 0, 'the earlier recording is left as it is');
    const made = h.calls.filter(c => c[0] === 'schedule').map(c => JSON.parse(JSON.stringify(c[1])));
    assert.deepEqual(made.map(d => [d.channelItemId, d.programStart, d.gameId, d.postBufferMin]), [['506', later, 'nxt', 30]]);
});

// #347 (Codex sign-off 2, high): staggered channels. The game airs on Stan Sport 2 now-ish and on Kayo 5 three hours later;
// another programme on Kayo 5 during the Stan Sport 2 airing, or another game's schedule, was taken for this recording and
// got the padding (a PUT on someone else's programme) while the chosen airing was never recorded.
test('staggered channels: a schedule of another programme on a channel that carries the game later, or of another game, is not this one', async () => {
    for (const other of [
        { source_id: 2, channel_stable_id: 'k5', channel_item_id: '505', channel_name: 'Kayo 5' }, // no game: another programme on Kayo 5
        { gameId: 'espn:soccer/eng.1:999' } // another game's schedule on Stan Sport 2 itself
    ]) {
        const h = await harness();
        const k5 = h.nxt.channels.find(c => c.id === '505');
        k5.start = h.nxt.start + 3 * H; k5.end = h.nxt.start + 5 * H;
        h.p.closeWindow(); h.p.openRecord('nxt');
        assert.match(h.channels(), /aria-checked="true" data-act="r-on" data-index="0"/, 'Stan Sport 2 chosen');
        h.choose('sp-rec-post', '30');
        h.state.scheduled = [row({ id: 8, program_start: h.nxt.start, program_end: h.nxt.start + 2 * H, ...other })];
        h.state.made = { id: 9 };
        await h.save();
        assert.equal(h.calls.filter(c => c[0] === 'PUT').length, 0, `not changed: ${JSON.stringify(other)}`);
        assert.deepEqual(h.calls.filter(c => c[0] === 'schedule').map(c => [c[1].channelItemId, c[1].programStart]), [['102', h.nxt.start]]);
    }
});

test('staggered channels: an older row with no game, on the later channel during ITS airing of the game, is still this game', async () => {
    const h = await harness();
    const k5 = h.nxt.channels.find(c => c.id === '505');
    k5.start = h.nxt.start + 1 * H; k5.end = h.nxt.start + 3 * H; // overlaps the Stan Sport 2 airing chosen
    h.p.closeWindow(); h.p.openRecord('nxt');
    h.choose('sp-rec-post', '30');
    h.state.scheduled = [row({ id: 8, source_id: 2, channel_stable_id: 'k5', channel_item_id: '505', channel_name: 'Kayo 5', program_start: k5.start, program_end: k5.end })];
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c[0] === 'PUT'))), ['PUT', '/recordings/scheduled/8', { postBufferMin: 30 }]);
});

// #347 (Codex sign-off 2, medium): More options opened Change recording when the card already named a schedule, so a
// second airing could not be picked from it.
test('More options with the card already set to record: the airings to choose; a later airing chosen records it', async () => {
    const h = await harness();
    const later = h.nxt.start + 26 * H;
    h.nxt.channels.push({ sourceId: 2, stableId: 'k6', id: '506', name: 'Kayo 6', start: later, end: later + 2 * H });
    h.nxt.recording = { scheduleId: 4, status: 'scheduled' };
    h.p.closeWindow();
    const el = h.b.document.createElement('button');
    el.setAttribute('data-act', 'record-options'); el.setAttribute('data-id', 'nxt');
    h.p.root.appendChild(el); el.click();
    await new Promise(setImmediate);
    assert.doesNotMatch(h.body(), /class="rset"/, 'not the Change recording window');
    const body = h.channels();
    const k6 = [...body.matchAll(/data-act="r-on" data-index="(\d+)"[^>]*>[\s\S]*?<\/button>/g)].find(m => m[0].includes('Kayo 6'));
    assert.ok(k6, 'the airings to choose, Kayo 6 among them');
    h.pick(Number(k6[1]));
    h.state.scheduled = [row({ program_start: h.nxt.start, program_end: h.nxt.start + 2 * H, gameId: 'nxt' })];
    h.state.made = { id: 7 };
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'PUT').length, 0);
    assert.deepEqual(h.calls.filter(c => c[0] === 'schedule').map(c => [c[1].channelItemId, c[1].programStart]), [['506', later]]);
    // Change recording still edits the named schedule
    h.p.closeWindow();
    const ch = h.b.document.createElement('button');
    ch.setAttribute('data-act', 'change-recording'); ch.setAttribute('data-id', 'nxt');
    h.p.root.appendChild(ch); ch.click();
    await new Promise(setImmediate);
    assert.match(h.body(), /<p class="rset"><span class="rdot" aria-hidden="true"><\/span>Set to record<\/p>/, 'Change recording: the named schedule\'s own window');

});
