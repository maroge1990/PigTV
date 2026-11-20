'use strict';
// #327 (Mark, 15 Nov 2026): iOS's game details (SportEventDetails, `presenter.open(event, .details)`) and record page
// (RecordPage, behind "More options…") on the web, so a person can choose the channel to watch or record. Details: every
// channel airing the game, each with Watch (only while it airs, checked at the press) and Record on it. Record page (#358,
// Mark's final design): What (this game, every <team> game, every <league> game), then Channel and Extra time rows that
// open a page of the window (Back); a game already set to record is changed with PUT (0662), never scheduled twice. Hard rule: with scores hidden no score, result or winner
// in either window.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, NOW, page, assertNoScores, stepTo } = require('./helpers/sportWeb');
const { rulesFor } = require('./helpers/sportCss');

const H = 3600000;
function front() {
    const a = answer();
    const ars = a.games.find(g => g.id === 'ars');
    ars.channels.push({ sourceId: 1, stableId: 's9', id: '109', name: 'Stan Sport 3 HD', quality: 'HD', start: NOW - H, end: NOW + 2 * H });
    const nxt = a.games.find(g => g.id === 'nxt');
    delete nxt.recording; nxt.followed = true; nxt.followedSides = [1];
    nxt.channels.push({ sourceId: 2, stableId: 'k5', id: '505', name: 'Kayo 5', start: nxt.start + H, end: nxt.start + 3 * H });
    a.follows.push({ league: 'EPL', sport: 'Football', name: 'Tottenham', logo: null, state: 'next', gameId: 'nxt', start: nxt.start });
    return a;
}
async function harness({ phone = false, scheduled = [], hide = false } = {}) {
    const calls = [];
    const f = front();
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/sports/front') return f;
        if (url === '/sports/pages/preferences') return { spoilerFree: hide };
        if (url === '/recordings/scheduled') return scheduled;
        // Settings' usual padding (the server's defaults): the Record window waits for it (Codex #358)
        if (url === '/settings') return { defaultPreBufferMin: 1, defaultPostBufferMin: 5 };
        return {};
    },
    recordings: { schedule: async (d) => { calls.push(['schedule', d]); return {}; }, addRule: async (r) => { calls.push(['rule', r]); return { id: 7 }; } } });
    b.context.matchMedia = (q) => ({ matches: phone && /max-width/.test(q), addEventListener() {} });
    b.context.window.matchMedia = b.context.matchMedia;
    const played = [];
    const app = { currentUser: { role: 'admin' }, navigateTo: () => {}, setLocation() {},
        channelList: { channels: [{ sourceId: 1, stableId: 's1', id: 'p1' }, { sourceId: 1, stableId: 's9', id: 'p9' }, { sourceId: 2, stableId: 'k5', id: 'p5' }],
            loadSources: async () => {}, loadChannels: async () => {}, selectChannel: async (d) => played.push(d.channelId) } };
    const p = page(b, app);
    await p.show('');
    p.labels = { EPL: 'Premier League' };
    const dialog = () => b.document.body.querySelector('dialog');
    const body = () => dialog()?.querySelector('.ui-dialog-body')?.innerHTML || '';
    // the windows' controls are markup (the fake DOM parses only ids): a pressed control is made with the same attributes
    const press = (attrs) => {
        const el = b.document.createElement('button');
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        dialog().querySelector('.ui-dialog-body').appendChild(el);
        el.click();
        return el;
    };
    const footer = (act) => dialog().querySelector(`[data-act="${act}"]`);
    const choose = (id, value) => stepTo(b, p, id, value);
    const settle = () => new Promise(setImmediate);
    return { b, p, f, calls, played, dialog, body, press, footer, choose, settle };
}
const plain = (o) => JSON.parse(JSON.stringify(o));

test('#345: pressing a game to come opens its menu (the record options), not a details window; a game on now still plays', async () => {
    const h = await harness();
    const card = h.b.document.createElement('button'); h.p.root.appendChild(card);
    h.p.select('nxt', card);
    assert.equal(h.dialog(), null, 'no details window');
    const menu = h.b.document.body.querySelector('.sp-menu');
    assert.ok(menu, 'the record options');
    assert.match(menu.innerHTML, /data-act="record" data-id="nxt"/);
    assert.doesNotMatch(menu.innerHTML, /data-act="details"|<b>Details<\/b>/, 'no Details in the menu');
    await h.p.select('ars', card);
    assert.deepEqual(h.played, ['p1']);
});

test('Watch on a channel is decided again at the press, on that channel\'s own airing', async () => {
    const h = await harness();
    h.p.received = Date.now() - 1.5 * H; // the page was left open: Stan Sport 1's airing has ended, the HD one's has not
    await h.p.watch('ars', '1:s1');
    assert.deepEqual(h.played, [], 'an airing that ended meanwhile plays nothing');
    assert.match(h.b.context.toasts.at(-1)[0], /That channel isn’t showing the game now/);
    await h.p.watch('ars', '1:s9');
    assert.deepEqual(h.played, ['p9'], 'another channel still airing it plays');
});

test('Record on the second channel opens the record page on it and records it there, with the game\'s id', async () => {
    const h = await harness();
    h.p.openRecord('nxt', { channel: '2:k5' });
    const rec = h.body();
    assert.equal(h.b.document.body.querySelectorAll('dialog').length, 1, 'one window at a time');
    assert.match(rec, /<span class="rk">RECORD · PREMIER LEAGUE<\/span><span class="rmeta pig-amount">[^<]+ · [^<]+<\/span>/);
    assert.match(rec, /<button type="button" class="rrow" data-act="r-screen" data-to="channel" data-key="r:row:channel"><span class="rrn">Channel<\/span><span class="rrv"><b>Kayo 5<\/b>/, 'the Channel row names it');
    h.press({ 'data-act': 'r-screen', 'data-to': 'channel' });
    const list = h.body();
    assert.match(list, /role="radio" aria-checked="true" data-act="r-on" data-index="1"[\s\S]*?<b>Kayo 5<\/b>/);
    assert.match(list, /data-index="0"[^>]*><span class="rtick" aria-hidden="true"><\/span><span class="rcht"><b>Stan Sport 2<\/b><span class="pig-amount">[^<]+<\/span><\/span><span class="rbest">BEST<\/span>/,
        'BEST on the first; the airings differ in time, so each row says when');
    h.press({ 'data-act': 'r-screen', 'data-to': 'main' });
    assert.equal(h.footer('r-save').textContent, 'Record game');
    h.footer('r-save').click();
    await h.settle();
    const sent = h.calls.find(c => c[0] === 'schedule')[1];
    const g = h.f.games.find(x => x.id === 'nxt');
    assert.deepEqual(plain(sent), { sourceId: 2, channelItemId: '505', channelName: 'Kayo 5', title: 'Newcastle v Tottenham',
        programStart: g.start + H, programEnd: g.start + 3 * H, gameId: 'nxt' }, 'that channel, on its own airing, linked to the game (ESPN\'s end)');
    assert.equal(h.dialog(), null);
    assert.match(h.b.context.toasts.at(-1)[0], /^Set to record on Kayo 5: Newcastle v Tottenham\.$/);
});

test('More options…: What (this game, every Tottenham game, every Premier League game), padding, then a team rule', async () => {
    const h = await harness();
    h.p.act('record-options', Object.assign(h.b.document.createElement('button'), { getAttribute: (k) => ({ 'data-id': 'nxt' })[k] ?? null }));
    const html = h.body();
    const whats = [...html.matchAll(/class="rsegb(?: on)?" role="radio" aria-checked="(true|false)" data-act="r-what" data-index="\d" data-key="[^"]+">([^<]+)<\/button>/g)].map(m => [m[2], m[1]]);
    assert.deepEqual(whats, [['This game', 'true'], ['Every Tottenham game', 'false'], ['Every Premier League game', 'false']]);
    assert.doesNotMatch(html, /When it stops|<select/, '#358: no When it stops, no selects');
    assert.match(html, /<span class="rrn">Extra time<\/span><span class="rrv"><b>Usual<\/b><\/span>/);
    assert.ok(!html.includes('provider connection'));
    await h.settle();
    h.press({ 'data-act': 'r-what', 'data-index': '1' });
    assert.equal(h.footer('r-save').textContent, 'Record every game');
    assert.doesNotMatch(h.body(), /data-to="channel"/, 'a rule records each game on its own channel: no Channel row');
    h.choose('sp-rec-pre', '5');
    assert.ok(!h.body().includes('the recording waits'), 'no provider-connection note');
    h.choose('sp-rec-post', '30');
    assert.match(h.body(), /<b>5 min early, 30 min late<\/b>/, 'the Extra time row says what was chosen');
    h.footer('r-save').click();
    await h.settle();
    assert.deepEqual(plain(h.calls.find(c => c[0] === 'rule')), ['rule', { kind: 'team', match: 'Tottenham', sport: 'Football', preBufferMin: 5, postBufferMin: 30 }]);
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0);
});

test('every Premier League game is a `sport` rule on the league; a failure stays in the window with its error', async () => {
    const h = await harness();
    h.b.context.API.recordings.addRule = async () => { throw Object.assign(new Error('nope'), { status: 400, data: { error: 'That rule is not valid.' } }); };
    h.p.openRecord('nxt');
    h.press({ 'data-act': 'r-what', 'data-index': '2' });
    h.footer('r-save').click();
    await h.settle();
    assert.ok(h.dialog(), 'it stays open');
    assert.match(h.body(), /<p class="rerr" role="alert">[^<]+<\/p>/);
});

test('a page game without a card (no game id): Settings\' Finish late, and no game id sent', async () => {
    const h = await harness();
    const g = { ...h.f.games.find(x => x.id === 'nxt'), id: 'fx:EPL:9', synthetic: true, followed: false };
    h.p.game = (id) => (id === g.id ? g : null);
    h.p.openRecord(g.id);
    await h.settle();
    h.press({ 'data-act': 'r-screen', 'data-to': 'extra' });
    assert.match(h.body(), /<span class="rval pig-amount" id="sp-rec-post" aria-live="polite">5 min<\/span>/, 'no game: Finish late starts at Settings\' usual');
    h.press({ 'data-act': 'r-screen', 'data-to': 'main' });
    h.footer('r-save').click();
    await h.settle();
    assert.equal(h.calls.find(c => c[0] === 'schedule')[1].gameId, undefined);
});

// 0662 (#323 Codex review of step 5): a game already set to record is changed, never scheduled a second time.
const row = (o) => ({ id: 4, status: 'scheduled', pre_buffer_min: 2, post_buffer_min: 15, endsWith: 'event', source_id: 1, channel_item_id: '102', channel_stable_id: 's2', channel_name: 'Stan Sport 2', ...o });
for (const [entry, how] of [['the record page on another channel', (h) => { h.p.openRecord('nxt', { channel: '2:k5' }); }]]) {
    test(`Change recording from ${entry}: Set to record, its own padding, Done sends only what changed with PUT`, async () => {
        const h = await harness({ scheduled: [row()] });
        h.f.games.find(x => x.id === 'nxt').recording = { scheduleId: 4, status: 'scheduled' };
        how(h);
        await h.settle();
        const html = h.body();
        assert.match(html, /<span class="rk">RECORD · PREMIER LEAGUE<\/span><span class="rmeta pig-amount">[^<]+<\/span>/);
        assert.match(html, /<p class="rset"><span class="rdot" aria-hidden="true"><\/span>Set to record<\/p>/);
        assert.match(html, /<div class="rrow"><span class="rrn">Channel<\/span><span class="rrv"><b>Stan Sport 2<\/b>/, 'the channel it records on, not a choice');
        assert.doesNotMatch(html, /r-what|data-to="channel"/, 'one schedule: no What, no channel to choose');
        assert.match(html, /<b>2 min early, 15 min late<\/b>/, 'its own padding');
        h.press({ 'data-act': 'r-screen', 'data-to': 'extra' });
        assert.match(h.body(), /id="sp-rec-pre" aria-live="polite">2 min</);
        assert.match(h.body(), /id="sp-rec-post" aria-live="polite">15 min</);
        h.press({ 'data-act': 'r-screen', 'data-to': 'main' });
        assert.equal(h.footer('r-save').textContent, 'Done');
        assert.equal(h.footer('r-cancel').textContent, 'Cancel recording');
        assert.equal(h.footer('r-close'), null, 'two buttons: Cancel recording and Done');
        h.choose('sp-rec-post', '30');
        h.footer('r-save').click();
        await h.settle();
        assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0, 'no second schedule');
        assert.deepEqual(plain(h.calls.find(c => c[0] === 'PUT')), ['PUT', '/recordings/scheduled/4', { postBufferMin: 30 }]);
    });
}

// #347 (Codex sign-off 2): More options… always picks an airing first, even with the game set to record; Save then
// changes the schedule of the airing chosen (0662: never a second schedule of it), or records another airing.
test('More options… on a game set to record: the airings to choose; the same airing chosen changes its schedule with PUT', async () => {
    const listed = [];
    const h = await harness({ scheduled: listed });
    const nxt = h.f.games.find(x => x.id === 'nxt');
    nxt.recording = { scheduleId: 4, status: 'scheduled' };
    h.p.act('record-options', { getAttribute: (k) => ({ 'data-id': 'nxt' })[k] ?? null });
    await h.settle();
    assert.doesNotMatch(h.body(), /class="rset"/, 'not the set-to-record window');
    h.press({ 'data-act': 'r-screen', 'data-to': 'channel' });
    assert.match(h.body(), /aria-checked="true" data-act="r-on" data-index="0"/, 'the best airing chosen, the others offered');
    h.press({ 'data-act': 'r-screen', 'data-to': 'main' });
    h.choose('sp-rec-post', '30');
    listed.push(row({ program_start: nxt.channels[0].start, program_end: nxt.channels[0].end, gameId: 'nxt' }));
    h.footer('r-save').click();
    await h.settle();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0, 'no second schedule');
    assert.deepEqual(plain(h.calls.find(c => c[0] === 'PUT')), ['PUT', '/recordings/scheduled/4', { postBufferMin: 30 }]);
});

test('Change recording while it records: Start early is locked, only Finish late changes; Stop recording; a gone schedule changes nothing', async () => {
    const h = await harness({ scheduled: [row({ status: 'recording' })] });
    h.f.games.find(x => x.id === 'ars').recording = { scheduleId: 4, status: 'recording' };
    h.p.openRecord('ars');
    await h.settle();
    assert.match(h.body(), /Recording now<\/p>/);
    h.press({ 'data-act': 'r-screen', 'data-to': 'extra' });
    assert.match(h.body(), /<div class="rstepper off"><span class="rrn">Start early<\/span><span class="rval pig-amount" id="sp-rec-pre" aria-live="polite">Started<\/span><\/div>/, 'Start early: Started, no − or +');
    assert.match(h.body(), /data-field="post" data-delta="-1"/, 'Finish late still changes');
    assert.doesNotMatch(h.body(), /data-field="pre"/);
    h.press({ 'data-act': 'r-screen', 'data-to': 'main' });
    assert.equal(h.footer('r-cancel').textContent, 'Stop recording');
    h.choose('sp-rec-post', '30');
    h.footer('r-save').click();
    await h.settle();
    assert.deepEqual(plain(h.calls.find(c => c[0] === 'PUT')), ['PUT', '/recordings/scheduled/4', { postBufferMin: 30 }]);

    const gone = await harness({ scheduled: [] });
    gone.f.games.find(x => x.id === 'nxt').recording = { scheduleId: 4, status: 'scheduled' };
    gone.p.openRecord('nxt');
    await gone.settle();
    assert.match(gone.body(), /<p class="rset off"><span class="rdot" aria-hidden="true"><\/span>Ended<\/p>/);
    assert.match(gone.body(), /This recording has finished or no longer exists, so it cannot be changed\./);
    assert.doesNotMatch(gone.body(), /data-to="extra"/, 'nothing to change');
    assert.equal(gone.footer('r-cancel').disabled, true);
    gone.footer('r-save').click();
    await gone.settle();
    assert.equal(gone.dialog(), null, 'Done only closes');
    assert.equal(gone.calls.filter(c => c[0] === 'PUT').length, 0);

});

test('Cancel recording closes the window and cancels with Undo', async () => {
    const h = await harness({ scheduled: [row()] });
    h.f.games.find(x => x.id === 'nxt').recording = { scheduleId: 4, status: 'scheduled' };
    let undoable = null;
    h.b.context.UI.undoable = (msg, o) => { undoable = [msg, o]; };
    h.p.openRecord('nxt');
    await h.settle();
    h.footer('r-cancel').click();
    assert.equal(h.dialog(), null);
    assert.equal(undoable[0], 'Recording of Newcastle v Tottenham cancelled.');
    await undoable[1].commit();
    assert.deepEqual(plain(h.calls.find(c => c[0] === 'DELETE')).slice(0, 2), ['DELETE', '/recordings/scheduled/4']);
});

test('HARD RULE: with scores hidden the record page holds no score, result or winner (markup, labels, buttons)', async () => {
    const h = await harness({ hide: true });
    assert.equal(h.p.hidden, true);
    for (const id of ['ars', 'pen', 'nfl', 'cri']) {
        for (const open of [(x) => h.p.openRecord(x)]) {
            open(id);
            await h.settle();
            const d = h.dialog();
            const text = [h.body(), d.querySelector('.ui-dialog-title').textContent, d.getAttribute('aria-label') || '',
                ...d.querySelectorAll('button').map(btn => `${btn.textContent} ${btn.getAttribute('aria-label') || ''}`)].join('\n');
            assertNoScores(text, `${id} window`);
            assert.doesNotMatch(text, /\bFinal\b|FINAL|won\b|winner/i, `${id}: no result`);
        }
    }
});

test('on a phone the windows are a sheet from the bottom with full-width buttons', () => {
    assert.match(rulesFor('.ui-dialog.sp-window', { media: 'max-width: 768px' }), /margin:\s*auto 0 0/);
    assert.match(rulesFor('.ui-dialog.sp-window', { media: 'max-width: 768px' }), /border-radius:\s*20px 20px 0 0/);
    assert.match(rulesFor('.ui-dialog.sp-window .ui-dialog-footer .btn', { media: 'max-width: 768px' }), /min-height:\s*44px/);
    assert.match(rulesFor('.sp-win .rchoice.on'), /background:\s*var\(--sel\)/);
});
