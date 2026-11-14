'use strict';
// #327 (Mark, 15 Nov 2026): iOS's game details (SportEventDetails, `presenter.open(event, .details)`) and record page
// (RecordPage, behind "More options…") on the web, so a person can choose the channel to watch or record. Details: every
// channel airing the game, each with Watch (only while it airs, checked at the press) and Record on it. Record page: What
// (this game, every <team> game, every <league> game), When it stops, Start early / Finish late, Record on; a game already
// set to record is changed with PUT (0662), never scheduled twice. Hard rule: with scores hidden no score, result or winner
// in either window.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FakeEvent } = require('./helpers/fakeDom');
const { browser, answer, NOW, page, assertNoScores } = require('./helpers/sportWeb');
const { rulesFor } = require('./helpers/sportCss');

const H = 3600000;
function front() {
    const a = answer();
    const ars = a.games.find(g => g.id === 'ars');
    ars.channels.push({ sourceId: 1, stableId: 's9', id: '109', name: 'Stan Sport 1 HD', quality: 'HD', start: NOW - H, end: NOW + 2 * H });
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
    const choose = (id, value) => { const el = b.document.getElementById(id); el.value = value; el.dispatchEvent(new FakeEvent('change')); };
    const settle = () => new Promise(setImmediate);
    return { b, p, f, calls, played, dialog, body, press, footer, choose, settle };
}
const plain = (o) => JSON.parse(JSON.stringify(o));

test('pressing a game to come opens its details (iOS), not its menu; a game on now still plays', async () => {
    const h = await harness();
    const card = h.b.document.createElement('button'); h.p.root.appendChild(card);
    h.p.select('nxt', card);
    assert.equal(h.b.document.body.querySelector('.sp-menu'), null);
    assert.ok(h.dialog()?.open, 'a window');
    assert.match(h.dialog().className, /\bsp-window\b/);
    assert.equal(h.dialog().querySelector('.ui-dialog-title').textContent, 'Newcastle v Tottenham');
    assert.match(h.body(), /<div class="dk"><span>PREMIER LEAGUE · (TODAY|TOMORROW)<\/span><\/div><p class="dline pig-amount">[^<]+ – [^<]+ · starts in 2 h<\/p>/);
    assert.match(h.body(), /data-act="d-remind" data-key="d:watch">[\s\S]*?Watch Stan Sport 2 when it starts<\/button><button type="button" class="pill" data-act="d-record" data-key="d:record">[\s\S]*?Record<\/button>/);
    h.dialog().close();
    assert.equal(h.b.document.activeElement, card, 'focus goes back to the card');
    await h.p.select('ars', card);
    assert.deepEqual(h.played, ['p1']);
});

test('the details list every channel airing it, the first Recommended; Watch only on a channel that airs it now', async () => {
    const h = await harness();
    h.p.openDetails('nxt');
    const html = h.body();
    assert.match(html, /<h3 class="dsec">Channels<\/h3>/);
    assert.match(html, /<b>Stan Sport 2<\/b><span class="dsub">Recommended<\/span><\/span><span class="dca"><button type="button" class="pill" data-act="d-record-on" data-channel="1:s2" data-key="d:r:1:s2" aria-label="Record on Stan Sport 2">/);
    assert.match(html, /<b>Kayo 5<\/b><span class="dsub">(Today|Tomorrow) [^<]+<\/span>/, 'another channel on its own times');
    assert.doesNotMatch(html, /d-watch-on/, 'not on yet: no Watch on a channel');
    h.p.openDetails('ars');
    const live = h.body();
    assert.match(live, /<div class="dk live"><span class="dot" aria-hidden="true"><\/span><span>LIVE · PREMIER LEAGUE<\/span>/);
    assert.match(live, /data-act="d-watch" data-key="d:watch">[\s\S]*?Watch Stan Sport 1<\/button>/);
    assert.match(live, /data-act="d-watch-on" data-channel="1:s9" data-key="d:w:1:s9" aria-label="Watch on Stan Sport 1 HD">/);
    assert.match(live, /<b>Stan Sport 1 HD<\/b> <span class="qual">HD<\/span>/);
    h.press({ 'data-act': 'd-watch-on', 'data-channel': '1:s9' });
    await h.settle();
    assert.deepEqual(h.played, ['p9'], 'the chosen channel, found by its identity');
    assert.equal(h.dialog(), null, 'the window closes first');
});

test('Watch on a channel is decided again at the press, on that channel\'s own airing', async () => {
    const h = await harness();
    h.p.openDetails('ars');
    h.p.received = Date.now() - 1.5 * H; // the page was left open: Stan Sport 1's airing has ended, the HD one's has not
    h.press({ 'data-act': 'd-watch-on', 'data-channel': '1:s1' });
    await h.settle();
    assert.deepEqual(h.played, [], 'an airing that ended meanwhile plays nothing');
    assert.match(h.b.context.toasts.at(-1)[0], /That channel isn’t showing the game now/);
    h.p.openDetails('ars');
    assert.doesNotMatch(h.body(), /data-act="d-watch-on" data-channel="1:s1"/, 'redrawn: no Watch on it');
    assert.match(h.body(), /<b>Stan Sport 1<\/b><span class="dsub">Recommended · Not on now<\/span>/);
    h.press({ 'data-act': 'd-watch-on', 'data-channel': '1:s9' });
    await h.settle();
    assert.deepEqual(h.played, ['p9'], 'another channel still airing it plays');
});

test('Details is in the game\'s menu and opens the window; Record on the second channel opens the record page on it and records it there, with the game\'s id', async () => {
    const h = await harness();
    const card = h.b.document.createElement('button'); h.p.root.appendChild(card);
    h.p.openMenu(h.p.game('nxt'), card);
    assert.match(h.b.document.body.querySelector('.sp-menu').innerHTML, /data-act="details" data-id="nxt"><svg[\s\S]*?<\/svg><span><b>Details<\/b><span>Every channel showing it, to watch or record<\/span>/);
    h.p.act('details', Object.assign(h.b.document.createElement('button'), { getAttribute: (k) => ({ 'data-id': 'nxt' })[k] ?? null }));
    assert.equal(h.b.document.body.querySelector('.sp-menu'), null);
    assert.ok(h.dialog());
    h.press({ 'data-act': 'd-record-on', 'data-channel': '2:k5' });
    const rec = h.body();
    assert.equal(h.b.document.body.querySelectorAll('dialog').length, 1, 'one window at a time');
    assert.match(rec, /<span class="rk">RECORD · PREMIER LEAGUE<\/span><span class="rmeta pig-amount">[^<]+ · [^<]+ · Kayo 5<\/span>/);
    assert.match(rec, /<h3 class="rsec" id="sp-rec-on">Record on<\/h3><span>2 channels in your guide carry it<\/span>/);
    assert.match(rec, /role="radio" aria-checked="true" data-act="r-on" data-index="1"[\s\S]*?<b>Kayo 5<\/b>/);
    assert.match(rec, /data-index="0"[^>]*>[\s\S]*?<b>Stan Sport 2<\/b><span class="pig-amount">Best channel · /);
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
    const whats = [...html.matchAll(/data-act="r-what" data-index="\d" data-key="[^"]+"><b>([^<]+)<\/b><span class="pig-amount">([^<]*)<\/span>/g)].map(m => [m[1], m[2].replace(/^(Today|Tomorrow) .*/, 'when')]);
    assert.deepEqual(whats, [['This game', 'when'], ['Every Tottenham game', 'Never replays'], ['Every Premier League game', 'On your channels, never replays']]);
    assert.match(html, /<h3 class="rsec">When it stops<\/h3><div class="rstop">[\s\S]*?<b>When the game ends \(ESPN\)<\/b><span class="pig-amount">Else the guide end, [^<]+, \+ Finish late<\/span>/);
    assert.match(html, /<select id="sp-rec-pre" data-key="r:sp-rec-pre"><option value="" selected>Usual<\/option><option value="0">On time<\/option><option value="1">1 min<\/option><option value="2">2 min<\/option><option value="5">5 min<\/option><option value="10">10 min<\/option><\/select>/);
    assert.match(html, /<select id="sp-rec-post"[^>]*><option value="" selected>Usual<\/option><option value="0">On time<\/option>(<option value="\d+">\d+ min<\/option>){5}<\/select>/);
    assert.match(html, /If every provider connection is in use when it starts, the recording waits for one to free up\./);
    h.press({ 'data-act': 'r-what', 'data-index': '1' });
    assert.equal(h.footer('r-save').textContent, 'Record every game');
    h.choose('sp-rec-pre', '5');
    assert.match(h.body(), /in use at [^,]+, the recording waits/, 'the note follows Start early');
    h.choose('sp-rec-post', '30');
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

test('a page game without a card (no game id): the guide\'s end, and no game id sent', async () => {
    const h = await harness();
    const g = { ...h.f.games.find(x => x.id === 'nxt'), id: 'fx:EPL:9', synthetic: true, followed: false };
    h.p.game = (id) => (id === g.id ? g : null);
    h.p.openRecord(g.id);
    assert.match(h.body(), /<b>When the guide says it ends<\/b><span class="pig-amount">[^<]+ \+ Finish late<\/span>/);
    h.footer('r-save').click();
    await h.settle();
    assert.equal(h.calls.find(c => c[0] === 'schedule')[1].gameId, undefined);
});

// 0662 (#323 Codex review of step 5): a game already set to record is changed, never scheduled a second time.
const row = (o) => ({ id: 4, status: 'scheduled', pre_buffer_min: 2, post_buffer_min: 15, endsWith: 'event', source_id: 1, channel_item_id: '102', channel_stable_id: 's2', channel_name: 'Stan Sport 2', ...o });
for (const [entry, how] of [['More options…', (h) => h.p.act('record-options', { getAttribute: (k) => ({ 'data-id': 'nxt' })[k] ?? null })],
    ['the details\' Record on another channel', (h) => { h.p.openDetails('nxt'); h.press({ 'data-act': 'd-record-on', 'data-channel': '2:k5' }); }]]) {
    test(`Change recording from ${entry}: its own padding, Save changes sends only what changed with PUT`, async () => {
        const h = await harness({ scheduled: [row()] });
        h.f.games.find(x => x.id === 'nxt').recording = { scheduleId: 4, status: 'scheduled' };
        how(h);
        await h.settle();
        const html = h.body();
        assert.match(html, /<span class="rk">CHANGE RECORDING · RECORDING SCHEDULED · PREMIER LEAGUE<\/span><span class="rmeta pig-amount">[^<]+ · Stan Sport 2<\/span>/, 'the channel it records on');
        assert.doesNotMatch(html, /r-what|Record on</, 'one schedule: no What, no Record on');
        assert.match(html, /<b>When the game ends \(ESPN\)<\/b>/, 'the schedule follows the game');
        assert.match(html, /<select id="sp-rec-pre" data-key="r:sp-rec-pre"><option value="0">On time<\/option><option value="1">1 min<\/option><option value="2" selected>2 min<\/option>/);
        assert.match(html, /<select id="sp-rec-post"[^>]*><option value="0">On time<\/option>[\s\S]*<option value="15" selected>15 min<\/option>/);
        assert.doesNotMatch(html, /Usual/);
        assert.match(html, /Changes apply to this recording only\./);
        assert.equal(h.footer('r-save').textContent, 'Save changes');
        assert.equal(h.footer('r-save').disabled, true, 'nothing changed yet');
        assert.equal(h.footer('r-cancel').textContent, 'Cancel recording');
        assert.equal(h.footer('r-close').textContent, 'Close');
        h.choose('sp-rec-post', '30');
        assert.ok(!h.footer('r-save').disabled, 'a change: Save changes is on');
        h.footer('r-save').click();
        await h.settle();
        assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 0, 'no second schedule');
        assert.deepEqual(plain(h.calls.find(c => c[0] === 'PUT')), ['PUT', '/recordings/scheduled/4', { postBufferMin: 30 }]);
    });
}

test('Change recording while it records: Start early is locked, only Finish late changes; Stop recording; a gone schedule changes nothing', async () => {
    const h = await harness({ scheduled: [row({ status: 'recording' })] });
    h.f.games.find(x => x.id === 'ars').recording = { scheduleId: 4, status: 'recording' };
    h.p.openRecord('ars');
    await h.settle();
    assert.match(h.body(), /<select id="sp-rec-pre" data-key="r:sp-rec-pre" disabled>/);
    assert.match(h.body(), /It is recording: only Finish late can change\./);
    assert.equal(h.footer('r-cancel').textContent, 'Stop recording');
    h.choose('sp-rec-post', '30');
    h.footer('r-save').click();
    await h.settle();
    assert.deepEqual(plain(h.calls.find(c => c[0] === 'PUT')), ['PUT', '/recordings/scheduled/4', { postBufferMin: 30 }]);

    const gone = await harness({ scheduled: [] });
    gone.f.games.find(x => x.id === 'nxt').recording = { scheduleId: 4, status: 'scheduled' };
    gone.p.openRecord('nxt');
    await gone.settle();
    assert.match(gone.body(), /CHANGE RECORDING · ENDED/);
    assert.match(gone.body(), /This recording has finished or no longer exists, so it cannot be changed\./);
    assert.equal(gone.footer('r-save').disabled, true);
    assert.equal(gone.footer('r-cancel').disabled, true);
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

test('HARD RULE: with scores hidden neither window holds a score, a result or a winner (markup, labels, buttons)', async () => {
    const h = await harness({ hide: true });
    assert.equal(h.p.hidden, true);
    for (const id of ['ars', 'pen', 'nfl', 'cri']) {
        for (const open of [(x) => h.p.openDetails(x), (x) => h.p.openRecord(x)]) {
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

test('a window\'s details redraw with a new answer and keep the focused control', async () => {
    const h = await harness();
    h.p.openDetails('nxt');
    h.f.games.find(x => x.id === 'nxt').recording = { scheduleId: 9, status: 'scheduled' };
    h.p.render();
    assert.match(h.body(), / · Recording scheduled<\/p>/);
    assert.match(h.body(), /Change recording<\/button>/);
});

test('on a phone the windows are a sheet from the bottom with full-width buttons', () => {
    assert.match(rulesFor('.ui-dialog.sp-window', { media: 'max-width: 768px' }), /margin:\s*auto 0 0/);
    assert.match(rulesFor('.ui-dialog.sp-window', { media: 'max-width: 768px' }), /border-radius:\s*20px 20px 0 0/);
    assert.match(rulesFor('.ui-dialog.sp-window .ui-dialog-footer .btn', { media: 'max-width: 768px' }), /min-height:\s*44px/);
    assert.match(rulesFor('.sp-win .rchoice.on'), /background:\s*var\(--sel\)/);
});
