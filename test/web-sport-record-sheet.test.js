'use strict';
// #358 (Mark, 20 Nov 2026, final design): the web Sport Record window. Main page: a header with the date and time once,
// What as a switch, then two rows (Channel, Extra time) and Cancel + Record game. Channel opens a page (Back) with a row
// per channel (tick, BEST, quality); choosing one returns. Extra time opens Start early and Finish late steppers (one
// minute a press, held: repeats) starting at the usual: Settings' Start early, and Finish late 0 for a game ESPN follows
// (the server's default since #358), else Settings'. Set to record: "Set to record", the same rows, Cancel recording +
// Done (a PUT of what changed). While it records Start early is "Started", with no − or +.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FakeEvent } = require('./helpers/fakeDom');
const { browser, answer, NOW, page, pressIn, stepTo } = require('./helpers/sportWeb');

const H = 3600000;
const SETTINGS = { defaultPreBufferMin: 3, defaultPostBufferMin: 7 };
async function harness({ scheduled = [], settings = SETTINGS, oneChannel = false } = {}) {
    const calls = [];
    const f = answer();
    const nxt = f.games.find(g => g.id === 'nxt');
    delete nxt.recording;
    nxt.followed = true; nxt.followedSides = [1];
    if (!oneChannel) nxt.channels.push({ sourceId: 2, stableId: 'k5', id: '505', name: 'Kayo 5', measured: { label: '1080', fps: 50 }, start: nxt.start, end: nxt.end || nxt.start + 2 * H });
    f.follows.push({ league: 'EPL', sport: 'Football', name: 'Tottenham', logo: null, state: 'next', gameId: 'nxt', start: nxt.start });
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/sports/front') return f;
        if (url === '/sports/pages/preferences') return { spoilerFree: false };
        if (url === '/recordings/scheduled') return scheduled;
        if (url === '/settings') return typeof settings === 'function' ? settings() : settings;
        return {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); return {}; }, addRule: async (r) => { calls.push(['rule', r]); return { id: 7 }; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    p.labels = { EPL: 'Premier League' };
    const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
    const body = () => b.document.body.querySelector('dialog .ui-dialog-body')?.innerHTML || '';
    const footer = (act) => b.document.body.querySelector(`dialog [data-act="${act}"]`);
    const press = (attrs) => pressIn(b, attrs);
    const value = (id) => { press({ 'data-act': 'r-screen', 'data-to': 'extra' }); const m = new RegExp(`id="${id}" aria-live="polite">([^<]+)<`).exec(body()); press({ 'data-act': 'r-screen', 'data-to': 'main' }); return m && m[1]; };
    return { b, p, f, nxt, calls, settle, body, footer, press, value };
}
const plain = (o) => JSON.parse(JSON.stringify(o));
const row = (o) => ({ id: 4, status: 'scheduled', pre_buffer_min: 2, post_buffer_min: 15, endsWith: 'event', gameId: 'nxt', source_id: 1,
    channel_item_id: '102', channel_stable_id: 's2', channel_name: 'Stan Sport 2', ...o });

test('#358 main page: the date and time once, the switch, the two rows, Cancel and Record game; no section of old', async () => {
    const h = await harness();
    h.p.openRecord('nxt');
    await h.settle();
    const html = h.body(), UI = h.b.context.window.UI;
    const range = `${UI.clock(h.nxt.start)} – ${UI.clock(h.nxt.start + 2 * H)}`;
    assert.equal(html.split(h.b.context.window.SportView.e(range)).length - 1, 1, 'the time once');
    assert.equal(html.split(h.b.context.window.SportsPage.day(h.nxt.start, h.p.now())).length - 1, 1, 'the day once');
    assert.match(html, /<span class="rk">RECORD · PREMIER LEAGUE<\/span>/);
    assert.match(html, /<div class="rseg" role="radiogroup" aria-label="What to record" style="--n:3">/);
    assert.deepEqual([...html.matchAll(/data-act="r-what"[^>]*>([^<]+)<\/button>/g)].map(m => m[1]), ['This game', 'Every Tottenham game', 'Every Premier League game']);
    assert.match(html, /<div class="rlist"><button type="button" class="rrow" data-act="r-screen" data-to="channel" data-key="r:row:channel"><span class="rrn">Channel<\/span><span class="rrv"><b>Stan Sport 2<\/b><\/span><span class="rchev"/);
    assert.match(html, /data-to="extra" data-key="r:row:extra"><span class="rrn">Extra time<\/span><span class="rrv"><b>Usual<\/b><\/span><span class="rchev"/);
    assert.doesNotMatch(html, /When it stops|Record on|Start early|Finish late|<select|Best channel|Same times/, 'nothing of the old layout');
    assert.deepEqual([h.footer('r-close').textContent, h.footer('r-save').textContent], ['Cancel', 'Record game']);
});

test('#358 Channel page: tick on the chosen one, BEST on the top one, quality; no times when the airings agree; a choice returns and names it', async () => {
    const h = await harness();
    h.p.openRecord('nxt');
    h.press({ 'data-act': 'r-screen', 'data-to': 'channel' });
    const html = h.body();
    assert.match(html, /^<div class="sp sp-win"><button type="button" class="rback" data-act="r-screen" data-to="main" data-key="r:back"><svg[^>]*>[\s\S]*?<\/svg>Back<\/button><h3 class="rsub">Channel<\/h3>/);
    assert.match(html, /aria-checked="true" data-act="r-on" data-index="0" data-key="r:on:0"><span class="rtick" aria-hidden="true"><svg[\s\S]*?<\/svg><\/span><span class="rcht"><b>Stan Sport 2<\/b><\/span><span class="rbest">BEST<\/span>/);
    assert.match(html, /aria-checked="false" data-act="r-on" data-index="1" data-key="r:on:1"><span class="rtick" aria-hidden="true"><\/span><span class="rcht"><b>Kayo 5<\/b><\/span><span class="qb[^"]*"[^>]*>1080<i class="pig-amount">50<\/i><\/span><\/button>/);
    assert.doesNotMatch(html, /pig-amount">(Today|Tomorrow|Sat|Sun)/, 'no dates on the rows');
    assert.equal(h.footer('r-save'), null, 'no buttons on the page');
    h.press({ 'data-act': 'r-on', 'data-index': '1' });
    assert.match(h.body(), /<span class="rrn">Channel<\/span><span class="rrv"><b>Kayo 5<\/b><span class="qb[^"]*"[^>]*>1080/, 'back on the main page, the row names it');
    h.footer('r-save').click();
    await h.settle();
    assert.equal(h.calls.find(c => c[0] === 'schedule')[1].channelItemId, '505');
});

test('#358 one channel: the Channel row opens nothing (no ›)', async () => {
    const h = await harness({ oneChannel: true });
    h.p.openRecord('nxt');
    assert.match(h.body(), /<div class="rrow"><span class="rrn">Channel<\/span><span class="rrv"><b>Stan Sport 2<\/b><\/span><\/div>/);
    assert.doesNotMatch(h.body(), /data-to="channel"/);
});

test('#358 Extra time: steppers start at the usual (Settings\' Start early; Finish late 0 for a followed game, Settings\' for a league rule), one minute a press, in range', async () => {
    const h = await harness();
    h.p.openRecord('nxt');
    await h.settle();
    h.press({ 'data-act': 'r-screen', 'data-to': 'extra' });
    let html = h.body();
    assert.match(html, /<h3 class="rsub">Extra time<\/h3><div class="rstepper"><span class="rrn">Start early<\/span><button type="button" class="rstep" data-act="r-step" data-field="pre" data-delta="-1"[^>]*>−<\/button><span class="rval pig-amount" id="sp-rec-pre" aria-live="polite">3 min<\/span><button type="button" class="rstep" data-act="r-step" data-field="pre" data-delta="1"[^>]*>\+<\/button><\/div>/);
    assert.match(html, /id="sp-rec-post" aria-live="polite">0 min</, 'ESPN\'s end: 0');
    assert.match(html, /data-field="post" data-delta="-1"[^>]*disabled>−/, 'nothing below 0');
    assert.doesNotMatch(html, /rnote|<p /, 'no words besides');
    h.press({ 'data-act': 'r-step', 'data-field': 'pre', 'data-delta': '-1' });
    h.press({ 'data-act': 'r-step', 'data-field': 'post', 'data-delta': '1' });
    h.press({ 'data-act': 'r-step', 'data-field': 'post', 'data-delta': '1' });
    html = h.body();
    assert.match(html, /id="sp-rec-pre" aria-live="polite">2 min</);
    assert.match(html, /id="sp-rec-post" aria-live="polite">2 min</);
    h.press({ 'data-act': 'r-screen', 'data-to': 'main' });
    assert.match(h.body(), /<b>2 min early, 2 min late<\/b>/);
    h.footer('r-save').click();
    await h.settle();
    const sent = plain(h.calls.find(c => c[0] === 'schedule')[1]);
    assert.deepEqual([sent.preBufferMin, sent.postBufferMin, sent.gameId], [2, 2, 'nxt'], 'the POST sends them');

    // the server's ranges: Start early 0-60, Finish late 0-180
    const top = await harness();
    top.p.openRecord('nxt');
    await top.settle();
    stepTo(top.b, top.p, 'sp-rec-pre', 60);
    top.press({ 'data-act': 'r-screen', 'data-to': 'extra' });
    assert.match(top.body(), /data-field="pre" data-delta="1"[^>]*disabled>\+/, '60 is the most');
    top.press({ 'data-act': 'r-step', 'data-field': 'pre', 'data-delta': '1' });
    assert.match(top.body(), /id="sp-rec-pre" aria-live="polite">60 min</);
    assert.equal(top.p.window.st.pre, 60);
    stepTo(top.b, top.p, 'sp-rec-post', 180);
    assert.equal(top.p.recordPad(top.p.window.st).post, 180);
    top.p.stepPad(top.p.window.st, 'post', 1);
    assert.equal(top.p.recordPad(top.p.window.st).post, 180, '180 is the most');

    // every Premier League game is a keyword rule (no game linked): Finish late starts at Settings'; untouched, none sent
    const lg = await harness();
    lg.p.openRecord('nxt');
    await lg.settle();
    lg.press({ 'data-act': 'r-what', 'data-index': '2' });
    assert.equal(lg.value('sp-rec-post'), '7 min');
    lg.press({ 'data-act': 'r-what', 'data-index': '1' });
    assert.equal(lg.value('sp-rec-post'), '0 min', 'a team rule records its games from the fixture: ESPN\'s end');
    lg.footer('r-save').click();
    await lg.settle();
    assert.deepEqual(plain(lg.calls.find(c => c[0] === 'rule')[1]), { kind: 'team', match: 'Tottenham', sport: 'Football' }, 'Usual: nothing sent');
});

test('#358 Extra time: a held − or + repeats until let go; the click that ends the hold adds nothing', async () => {
    const h = await harness();
    const SP = h.b.context.window.SportsPage;
    SP.HOLD_MS = 20; SP.STEP_REPEAT_MS = 5;
    h.p.openRecord('nxt');
    await h.settle();
    h.press({ 'data-act': 'r-screen', 'data-to': 'extra' });
    const plus = h.b.document.createElement('button');
    plus.setAttribute('data-act', 'r-step'); plus.setAttribute('data-field', 'post'); plus.setAttribute('data-delta', '1');
    h.b.document.body.querySelector('dialog .ui-dialog-body').appendChild(plus);
    plus.dispatchEvent(new FakeEvent('pointerdown'));
    await new Promise(r => setTimeout(r, 120));
    // let go: the pressed button has been redrawn meanwhile, so the release reaches the document, not it
    h.b.document.dispatchEvent(new FakeEvent('pointerup'));
    const held = h.p.window.st.post;
    assert.ok(held >= 3, `repeated while held (${held})`);
    h.b.document.body.querySelector('dialog .ui-dialog-body').appendChild(plus);
    plus.click();
    assert.equal(h.p.window.st.post, held, 'the click ending the hold adds nothing');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(h.p.window.st.post, held, 'stops when let go');
    plus.click();
    assert.equal(h.p.window.st.post, held + 1, 'the next press (or a key) does');
});

test('#358 set to record: "Set to record", the same rows (Channel fixed), Cancel recording + Done; Done PUTs only what changed, else closes', async () => {
    const h = await harness({ scheduled: [row()] });
    h.nxt.recording = { scheduleId: 4, status: 'scheduled' };
    h.p.openRecord('nxt');
    await h.settle();
    const html = h.body();
    assert.match(html, /<p class="rset"><span class="rdot" aria-hidden="true"><\/span>Set to record<\/p>/);
    assert.doesNotMatch(html, /r-what/, 'no switch');
    assert.match(html, /<div class="rrow"><span class="rrn">Channel<\/span><span class="rrv"><b>Stan Sport 2<\/b>/);
    assert.match(html, /<b>2 min early, 15 min late<\/b>/);
    assert.deepEqual([h.footer('r-cancel').textContent, h.footer('r-save').textContent], ['Cancel recording', 'Done']);
    h.footer('r-save').click();
    await h.settle();
    assert.equal(h.b.document.body.querySelector('dialog'), null, 'nothing changed: Done closes');
    assert.equal(h.calls.filter(c => c[0] === 'PUT').length, 0);

    h.p.openRecord('nxt');
    await h.settle();
    stepTo(h.b, h.p, 'sp-rec-pre', 4);
    h.footer('r-save').click();
    await h.settle();
    assert.deepEqual(plain(h.calls.find(c => c[0] === 'PUT')), ['PUT', '/recordings/scheduled/4', { preBufferMin: 4 }]);

    // a game-linked schedule on the usual padding (Settings' Start early, Finish late 0) reads Usual
    const u = await harness({ scheduled: [row({ pre_buffer_min: 3, post_buffer_min: 0 })] });
    u.nxt.recording = { scheduleId: 4, status: 'scheduled' };
    u.p.openRecord('nxt');
    await u.settle();
    assert.match(u.body(), /<span class="rrn">Extra time<\/span><span class="rrv"><b>Usual<\/b>/);
});

test('#358 while it records: Start early greyed "Started" with no − or +; Finish late still changes; Stop recording', async () => {
    const h = await harness({ scheduled: [row({ status: 'recording' })] });
    h.nxt.recording = { scheduleId: 4, status: 'recording' };
    h.p.openRecord('nxt');
    await h.settle();
    assert.match(h.body(), /Recording now<\/p>/);
    h.press({ 'data-act': 'r-screen', 'data-to': 'extra' });
    assert.match(h.body(), /<div class="rstepper off"><span class="rrn">Start early<\/span><span class="rval pig-amount" id="sp-rec-pre" aria-live="polite">Started<\/span><\/div>/);
    h.press({ 'data-act': 'r-step', 'data-field': 'pre', 'data-delta': '1' });
    assert.equal(h.p.window.st.pre, 2, 'a press that reaches it changes nothing');
    h.press({ 'data-act': 'r-step', 'data-field': 'post', 'data-delta': '1' });
    assert.match(h.body(), /id="sp-rec-post" aria-live="polite">16 min</);
    h.press({ 'data-act': 'r-screen', 'data-to': 'main' });
    assert.equal(h.footer('r-cancel').textContent, 'Stop recording');
    h.footer('r-save').click();
    await h.settle();
    assert.deepEqual(plain(h.calls.find(c => c[0] === 'PUT')), ['PUT', '/recordings/scheduled/4', { postBufferMin: 16 }]);
});

test('Codex #358: Settings not read yet: the steppers that count from it are off ("—") until this window\'s answer; a failed read leaves them off and sends no padding', async () => {
    let answerIt;
    const h = await harness({ settings: () => new Promise(r => { answerIt = r; }) });
    h.p.openRecord('nxt');
    await h.settle();
    h.press({ 'data-act': 'r-what', 'data-index': '2' });
    h.press({ 'data-act': 'r-screen', 'data-to': 'extra' });
    let html = h.body();
    assert.match(html, /data-field="pre" data-delta="-1"[^>]*disabled>−<\/button><span class="rval pig-amount" id="sp-rec-pre" aria-live="polite">—<\/span><button[^>]*data-delta="1"[^>]*disabled>\+/);
    assert.match(html, /id="sp-rec-post" aria-live="polite">—<\/span><button[^>]*disabled>\+/);
    h.press({ 'data-act': 'r-step', 'data-field': 'pre', 'data-delta': '1' });
    h.press({ 'data-act': 'r-step', 'data-field': 'post', 'data-delta': '1' });
    assert.deepEqual([h.p.window.st.pre, h.p.window.st.post], [null, null], 'a press before the answer changes nothing');
    answerIt({ defaultPreBufferMin: 15, defaultPostBufferMin: 15 });
    await h.settle();
    assert.match(h.body(), /id="sp-rec-pre" aria-live="polite">15 min</);
    h.press({ 'data-act': 'r-step', 'data-field': 'pre', 'data-delta': '1' });
    assert.match(h.body(), /id="sp-rec-pre" aria-live="polite">16 min</, 'counts from Settings\' 15');

    // a game's Finish late (0, ESPN's end) needs no Settings
    const g = await harness({ settings: () => new Promise(() => {}) });
    g.p.openRecord('nxt');
    await g.settle();
    assert.equal(g.value('sp-rec-post'), '0 min');

    // a failed read: off, and Record sends no padding
    const f = await harness({ settings: async () => { throw new Error('nope'); } });
    f.p.openRecord('nxt');
    await f.settle();
    f.press({ 'data-act': 'r-what', 'data-index': '2' });
    f.press({ 'data-act': 'r-screen', 'data-to': 'extra' });
    assert.match(f.body(), /id="sp-rec-pre" aria-live="polite">—</);
    f.press({ 'data-act': 'r-step', 'data-field': 'pre', 'data-delta': '1' });
    f.press({ 'data-act': 'r-step', 'data-field': 'post', 'data-delta': '1' });
    f.press({ 'data-act': 'r-screen', 'data-to': 'main' });
    f.footer('r-save').click();
    await f.settle();
    const rule = plain(f.calls.find(c => c[0] === 'rule')[1]);
    assert.ok(!('preBufferMin' in rule) && !('postBufferMin' in rule), JSON.stringify(rule));

    // read afresh each time the window opens: a later window shows Settings' new value
    let n = 0;
    const r = await harness({ settings: async () => (++n === 1 ? { defaultPreBufferMin: 3, defaultPostBufferMin: 7 } : { defaultPreBufferMin: 9, defaultPostBufferMin: 7 }) });
    r.p.openRecord('nxt');
    await r.settle();
    assert.equal(r.value('sp-rec-pre'), '3 min');
    r.press({ 'data-act': 'r-close' });
    r.p.openRecord('nxt');
    await r.settle();
    assert.equal(r.value('sp-rec-pre'), '9 min');
});

test('Codex #358: + then − back to the usual clears the change, so a later switch of What sends no padding for it', async () => {
    const h = await harness({ settings: { defaultPreBufferMin: 3, defaultPostBufferMin: 15 } });
    h.p.openRecord('nxt');
    await h.settle();
    h.press({ 'data-act': 'r-screen', 'data-to': 'extra' });
    h.press({ 'data-act': 'r-step', 'data-field': 'post', 'data-delta': '1' });
    h.press({ 'data-act': 'r-step', 'data-field': 'post', 'data-delta': '-1' });
    h.press({ 'data-act': 'r-step', 'data-field': 'pre', 'data-delta': '1' });
    h.press({ 'data-act': 'r-step', 'data-field': 'pre', 'data-delta': '-1' });
    assert.deepEqual([h.p.window.st.pre, h.p.window.st.post], [null, null], 'back on the usual: no change kept');
    h.press({ 'data-act': 'r-screen', 'data-to': 'main' });
    h.press({ 'data-act': 'r-what', 'data-index': '2' });
    assert.match(h.body(), /<span class="rrn">Extra time<\/span><span class="rrv"><b>Usual<\/b>/);
    assert.equal(h.value('sp-rec-post'), '15 min', 'the rule\'s usual: Settings\'');
    h.footer('r-save').click();
    await h.settle();
    const rule = plain(h.calls.find(c => c[0] === 'rule')[1]);
    assert.ok(!('postBufferMin' in rule) && !('preBufferMin' in rule), JSON.stringify(rule));
});
