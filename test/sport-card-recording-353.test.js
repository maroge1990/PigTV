'use strict';
// #353 (Codex, #347's third sign-off): which recording a Sport card names, and which airings Record can choose.
// 1. [high] annotateRecordings matched a schedule by channel and by its guide-moved `program_end`, whatever game it named:
//    an unrelated programme overrunning into the game's later airing became the card's recording, so More options padded
//    it in place of scheduling the airing chosen, and Change recording edited or cancelled it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { annotateRecordings } = require('../server/services/sportFront');
const { FakeEvent } = require('./helpers/fakeDom');
const { browser, answer, NOW, page } = require('./helpers/sportWeb');

const H = 3600000;

/** The web page on a front answer `f`, with the schedules `rows` listed; every request recorded. */
async function harness(f, rows = []) {
    const calls = [];
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/recordings/scheduled') return rows;
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); return {}; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    const el = (act, attrs = {}) => { const n = b.document.createElement('button'); n.setAttribute('data-act', act);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        b.document.body.querySelector('dialog .ui-dialog-body').appendChild(n); return n; };
    const save = async () => { b.document.body.querySelector('dialog [data-act="r-save"]').click(); await new Promise(setImmediate); await new Promise(setImmediate); };
    const choose = (id, v) => { const n = b.document.getElementById(id); n.value = v; n.dispatchEvent(new FakeEvent('change')); };
    return { b, p, calls, el, save, choose, body: () => b.document.body.querySelector('dialog .ui-dialog-body')?.innerHTML || '' };
}

// The game airs first on Stan Sport 2 (A), then again later on Kayo 5 (B).
const START = NOW + 2 * H;
const A = { sourceId: 1, stableId: 's2', id: '102', name: 'Stan Sport 2', start: START, end: START + 2 * H };
const B = { sourceId: 2, stableId: 'k5', id: '505', name: 'Kayo 5', start: START + 3 * H, end: START + 5 * H };
// An unrelated programme on B, made for its guide slot (during the game's airing on A, never B's), since overrunning
// into B's airing by the guide; and another game's recording on A during the airing.
const unrelated = { id: 9, title: 'The News Hour', status: 'scheduled', rule_id: null, gameId: null, source_id: 2, channel_item_id: '505',
    channel_stable_id: 'k5', channel_name: 'Kayo 5', program_start: START + H, program_end: START + 4 * H, program_end_original: START + 2.5 * H,
    pre_buffer_min: 2, post_buffer_min: 15 };
const otherGame = { id: 11, title: 'Arsenal v Chelsea', status: 'scheduled', rule_id: null, gameId: 'espn:soccer/eng.1:2', source_id: 1,
    channel_item_id: '102', channel_stable_id: 's2', channel_name: 'Stan Sport 2', program_start: START, program_end: START + 2 * H,
    program_end_original: null, pre_buffer_min: 2, post_buffer_min: 15 };
const cardOf = () => ({ id: 'nxt', channels: [{ ...A }, { ...B }], events: [{ id: 'e1', start: A.start, end: A.end }, { id: 'e2', start: B.start, end: B.end }] });

test('#353: a card never names a schedule of another game, nor one overlapping its airing only through a guide-moved end', () => {
    const card = cardOf();
    annotateRecordings([card], [unrelated, otherGame]);
    assert.equal(card.recording, undefined);
    // what still is the card's: an untagged schedule of its own guide slot on B; one naming this game, kept to its end
    const own = cardOf();
    annotateRecordings([own], [unrelated, otherGame, { ...unrelated, id: 12, title: 'Newcastle v Tottenham', program_start: B.start,
        program_end: B.end, program_end_original: null }]);
    assert.equal(own.recording?.scheduleId, 12);
    const linked = cardOf();
    annotateRecordings([linked], [unrelated, { ...otherGame, id: 13, gameId: 'nxt', program_end: START + 3 * H, program_end_original: START + 2 * H }]);
    assert.equal(linked.recording?.scheduleId, 13, 'a schedule naming this game comes first');
});

test('#353: the annotated card through the web: Record, not Change recording; More options schedules the airing chosen, the unrelated one untouched', async () => {
    const f = answer();
    const nxt = f.games.find(g => g.id === 'nxt');
    delete nxt.recording;
    Object.assign(nxt, cardOf(), { start: START });
    annotateRecordings([nxt], [unrelated, otherGame]);
    const h = await harness(f, [unrelated]);
    h.p.openMenu(h.p.game('nxt'), (() => { const n = h.b.document.createElement('button'); h.b.document.body.appendChild(n); return n; })());
    const menu = h.b.document.body.querySelector('.sp-menu').innerHTML;
    assert.match(menu, /data-act="record" data-id="nxt"/, 'Record this game');
    assert.doesNotMatch(menu, /change-recording/, 'no Change recording of another programme');
    h.p.closeMenu();
    // More options on A, Finish late 30: a new schedule of A, never a PUT (or DELETE) of the unrelated programme
    h.p.act('record-options', { getAttribute: (k) => ({ 'data-id': 'nxt' })[k] ?? null });
    assert.match(h.body(), /aria-checked="true" data-act="r-on" data-index="0"/, 'A chosen');
    h.choose('sp-rec-post', '30');
    await h.save();
    assert.equal(h.calls.filter(c => c[0] === 'PUT' || c[0] === 'DELETE').length, 0);
    const made = h.calls.filter(c => c[0] === 'schedule').map(c => c[1]);
    assert.equal(made.length, 1);
    assert.deepEqual([made[0].channelItemId, made[0].programStart, made[0].programEnd, made[0].postBufferMin], ['102', A.start, A.end, 30]);
});

