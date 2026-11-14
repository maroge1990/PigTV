const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #199 (D-41, C-U): Settings › Sports › "Your sport", a panel of its own (public/js/pages/SportSettings.js). The model
// is pure; the panel is driven here through a fake root and a fake API. The old web has no such panel.
const source = fs.readFileSync(path.join(__dirname, '../public/js/pages/SportSettings.js'), 'utf8');
const { loadUi, globalUi } = require('./helpers/webUi');
globalUi();
const { SportFollowModel: M } = require('../public/js/pages/SportSettings.js');
const catalog = [
    { sport: 'Football', leagues: [{ league: 'EPL', label: 'EPL', heading: 'Domestic leagues' }, { league: 'FA Cup', label: 'FA Cup', heading: 'Domestic cups' },
        { league: 'Champions League', label: 'Champions League', heading: 'European club competitions' }] },
    { sport: 'Tennis', leagues: [{ league: 'Grand Slams', label: 'Grand Slams', heading: null }, { league: 'ATP Tour', label: 'ATP Tour', heading: null }] },
    { sport: 'American football', leagues: [{ league: 'NFL', label: 'NFL', heading: null }] }];

test('#199: the model: a sport starts with its first league, keeps at least one, names once, order by moves', () => {
    let s = { spoilerFree: false, sports: [] };
    s = M.addSport(s, 'Football', catalog);
    assert.deepEqual(s.sports, [{ sport: 'Football', leagues: ['EPL'], teams: [] }]);
    assert.equal(M.addSport(s, 'Football', catalog), s, 'once');
    s = M.addLeague(M.addLeague(s, 'Football', 'Champions League'), 'Football', 'FA Cup');
    assert.deepEqual(s.sports[0].leagues, ['EPL', 'Champions League', 'FA Cup']);
    assert.deepEqual(M.move(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
    assert.deepEqual(M.move(['a', 'b'], 0, -1), ['a', 'b']);
    let r = M.addName(s, 'Football', '  Arsenal ');
    assert.deepEqual(r.state.sports[0].teams, ['Arsenal']);
    assert.match(M.addName(r.state, 'Football', 'arsenal').error, /followed already/);
    s = M.addName(r.state, 'Football', 'Celtic').state;
    // removing a league: a team only it lists goes with it (after a warning); unknown lists never count against a team
    const names = { EPL: ['Arsenal', 'Chelsea'], 'Champions League': ['Arsenal', 'Celtic'], 'FA Cup': null };
    const namesOf = (l) => names[l] ?? null;
    r = M.removeLeague(s, 'Football', 'Champions League', namesOf);
    assert.deepEqual(r.orphans, [], 'the FA Cup\'s list is not known yet: Celtic may play there');
    names['FA Cup'] = ['Arsenal'];
    r = M.removeLeague(s, 'Football', 'Champions League', namesOf);
    assert.deepEqual([r.state.sports[0].leagues, r.orphans], [['EPL', 'FA Cup'], ['Celtic']]);
    const one = { spoilerFree: false, sports: [{ sport: 'American football', leagues: ['NFL'], teams: [] }] };
    assert.match(M.removeLeague(one, 'American football', 'NFL').error, /at least one league/);
    assert.deepEqual(M.offered(s.sports[0], namesOf), ['Arsenal', 'Celtic', 'Chelsea']);
    assert.equal(M.ruleFor([{ id: 3, kind: 'team', sport: 'Football', match: 'ARSENAL' }], 'Football', 'Arsenal').id, 3);
    assert.equal(M.ruleFor([{ id: 3, kind: 'sport', match: 'Arsenal' }], 'Football', 'Arsenal'), null);
});

function panel(responses, { answer = true } = {}) {
    const calls = [], asked = [];
    const root = { innerHTML: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, querySelector: () => null };
    const ctx = vm.createContext({ confirm: (q) => { asked.push(q); return answer; }, CSS: { escape: (v) => v }, console,
        API: { request: async (method, url, body, opts) => {
            calls.push([method, url, body, opts]);
            const key = `${method} ${url.split('?')[0]}`;
            const r = await (typeof responses[key] === 'function' ? responses[key](body, url) : responses[key]);
            if (r instanceof Error) throw r;
            return JSON.parse(JSON.stringify(r ?? {}));
        } } });
    loadUi(ctx);
    vm.runInContext(`${source}\nthis.SportFollowSettings = SportFollowSettings;`, ctx);
    const settings = new ctx.SportFollowSettings(root, { currentUser: () => ({ username: 'mark' }) });
    return { settings, root, calls, asked, ctx };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

test('#199: the panel shows the account\'s sports, leagues under headings, names, suggestions and Record every game', async () => {
    const follows = { spoilerFree: true, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal', '<b>x</b>'] },
        { sport: 'Tennis', leagues: ['ATP Tour'], teams: ['Jannik Sinner'] }] };
    const { settings, root } = panel({
        'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': follows,
        'GET /recordings/rules': [{ id: 9, kind: 'team', sport: 'Football', match: 'Arsenal', enabled: true, createdByName: 'sam' }],
        'GET /sports/suggestions': { suggestions: [{ sport: 'Football', team: 'Arsenal', league: 'Champions League', label: 'Champions League', start: Date.parse('2026-11-04T20:00Z') }] },
        'GET /sports/names': (b, url) => ({ names: url.includes('EPL') ? ['Arsenal', 'Chelsea'] : ['Jannik Sinner'] }) });
    await settings.load();
    const html = root.innerHTML;
    assert.match(html, /id="sport-follow-spoilers" checked/);
    assert.match(html, /<optgroup label="Domestic cups"><option value="FA Cup">/, 'unchosen leagues under their headings');
    assert.match(html, /Champions League has <b>Arsenal<\/b> games too/);
    assert.match(html, /data-record-every="Arsenal" data-sport="Football" checked> Record every game \(set by sam\)/);
    assert.ok(!/data-record-every="Jannik Sinner"/.test(html), 'people are followed, not recorded by "every game"');
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/, 'names are escaped');
    assert.ok(!html.includes('<b>x</b>'));
    assert.match(html, /<option value="American football">/, 'a sport not followed can be added');
    assert.match(html, /<option value="Chelsea">/, 'the leagues\' names to search');
});

test('#199 / #276: changes save the whole list; unfollowing a team is at once, its "Record every game" stops when the notice ends, Undo keeps both', async () => {
    const plain = (v) => JSON.parse(JSON.stringify(v));
    for (const undo of [false, true]) {
        let stored = { spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL', 'Champions League'], teams: ['Arsenal'] }] };
        const { settings, root, calls, asked, ctx } = panel({
            'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': () => stored, 'PUT /sports/follows': (body) => (stored = plain(body)),
            'GET /recordings/rules': [{ id: 9, kind: 'team', sport: 'Football', match: 'Arsenal', enabled: true }], 'DELETE /recordings/rules/9': { success: true },
            'GET /sports/suggestions': { suggestions: [] }, 'GET /sports/names': { names: ['Arsenal'] } });
        await settings.load();
        const click = (data) => root.listeners.click({ target: { closest: () => ({ dataset: data }) } });
        await click({ act: 'league-up', sport: 'Football', league: 'Champions League' });
        assert.deepEqual(stored.sports[0].leagues, ['Champions League', 'EPL'], 'the whole list, in the new order');
        await click({ act: 'name-remove', sport: 'Football', name: 'Arsenal' });
        assert.deepEqual(stored.sports[0].teams, [], 'unfollowed at once');
        assert.deepEqual(asked, [], 'no question');
        const [message, options] = ctx.toasts.at(-1);
        assert.equal(message, 'Unfollowed Arsenal. Recording every Arsenal game stops too.');
        assert.equal(options.action.label, 'Undo');
        assert.equal(calls.some(c => c[0] === 'DELETE'), false, 'the rule is untouched while Undo is open');
        if (undo) {
            await options.action.run(); options.onEnd('action'); await settle();
            assert.deepEqual(stored.sports[0].teams, ['Arsenal'], 'Undo saves the old list again');
            assert.equal(calls.some(c => c[0] === 'DELETE'), false, 'and the rule was never deleted');
        } else {
            options.onEnd('timeout'); await settle();
            assert.equal(calls.some(c => c[0] === 'DELETE' && c[1] === '/recordings/rules/9'), true, 'the rule stops when the notice ends');
        }
    }
});

test('#276 (C12): stopping a sport and removing a league are at once with Undo, not a question; Undo puts the list back', async () => {
    const plain = (v) => JSON.parse(JSON.stringify(v));
    let stored = { spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL', 'Champions League'], teams: ['Celtic'] }, { sport: 'Tennis', leagues: ['ATP Tour'], teams: [] }] };
    const { settings, root, asked, ctx } = panel({
        'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': () => stored, 'PUT /sports/follows': (body) => (stored = plain(body)),
        'GET /recordings/rules': [], 'GET /sports/suggestions': { suggestions: [] },
        'GET /sports/names': (b, url) => ({ names: url.includes('Champions') ? ['Celtic'] : ['Arsenal'] }) });
    await settings.load();
    const click = (data) => root.listeners.click({ target: { closest: () => ({ dataset: data }) } });
    await click({ act: 'league-remove', sport: 'Football', league: 'Champions League' });
    assert.deepEqual(stored.sports[0].leagues, ['EPL']);
    assert.deepEqual(stored.sports[0].teams, [], 'the team only that league lists goes with it');
    assert.match(ctx.toasts.at(-1)[0], /^Removed Champions League\. Celtic plays in no other league you follow in Football, so it is unfollowed too\.$/);
    await ctx.toasts.at(-1)[1].action.run(); await settle();
    assert.deepEqual(stored.sports[0].leagues, ['EPL', 'Champions League']);
    assert.deepEqual(stored.sports[0].teams, ['Celtic'], 'Undo puts the league and the team back');
    await click({ act: 'sport-remove', sport: 'Tennis' });
    assert.deepEqual(stored.sports.map(x => x.sport), ['Football']);
    assert.equal(ctx.toasts.at(-1)[0], 'Stopped following Tennis.');
    await ctx.toasts.at(-1)[1].action.run(); await settle();
    assert.deepEqual(stored.sports.map(x => x.sport), ['Football', 'Tennis']);
    assert.deepEqual(asked, [], 'no confirm for any of them');
    assert.match(root.innerHTML, />Stop following</, 'the button says what it does');
});

test('#276 (C12): switching "Record every game" off is at once on the page; the rule is deleted when the notice ends, Undo keeps it', async () => {
    const rules = [{ id: 9, kind: 'team', sport: 'Football', match: 'Arsenal', enabled: true }];
    const stored = { spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] };
    const { settings, root, calls, asked, ctx } = panel({
        'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': stored, 'GET /recordings/rules': rules, 'DELETE /recordings/rules/9': { success: true },
        'GET /sports/suggestions': { suggestions: [] }, 'GET /sports/names': { names: ['Arsenal'] } });
    await settings.load();
    const off = () => settings.onChange({ target: { dataset: { recordEvery: 'Arsenal', sport: 'Football' }, checked: false } });
    await off();
    assert.deepEqual(asked, []);
    assert.doesNotMatch(root.innerHTML, /data-record-every="Arsenal" data-sport="Football" checked/, 'shown off at once');
    assert.equal(calls.some(c => c[0] === 'DELETE'), false);
    const [message, options] = ctx.toasts.at(-1);
    assert.equal(message, 'Stopped recording every Arsenal game. Recordings already made stay.');
    options.action.run(); options.onEnd('action');
    assert.match(root.innerHTML, /data-record-every="Arsenal" data-sport="Football" checked/, 'Undo: on again, nothing was deleted');
    assert.equal(calls.some(c => c[0] === 'DELETE'), false);
    await off();
    ctx.toasts.at(-1)[1].onEnd('timeout'); await settle();
    assert.equal(calls.some(c => c[0] === 'DELETE' && c[1] === '/recordings/rules/9'), true);
});

// 0420 (0419 Codex round 1): two high, two medium.
test('0420: two quick changes both land: each save is built from what the one before left (high)', async () => {
    let stored = { spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: [] }] };
    const pending = [];
    const { settings, root } = panel({
        'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': () => stored,
        'PUT /sports/follows': (body) => new Promise(resolve => pending.push(() => resolve((stored = JSON.parse(JSON.stringify(body)))))),
        'GET /recordings/rules': [], 'GET /sports/suggestions': { suggestions: [] }, 'GET /sports/names': { names: [] } });
    await settings.load();
    const change = (league) => root.listeners.change({ target: { dataset: { addLeague: 'Football' }, value: league } });
    const a = change('FA Cup'), b = change('Champions League');
    while (pending.length < 1) await new Promise(r => setImmediate(r));
    pending.shift()();
    while (pending.length < 1) await new Promise(r => setImmediate(r));
    pending.shift()();
    await Promise.all([a, b]);
    assert.deepEqual(stored.sports[0].leagues, ['EPL', 'FA Cup', 'Champions League']);
});

test('0420: a rule that could not be stopped is said, never "Unfollowed" alone (high); a rule switched off shows off and is switched back on (medium)', async () => {
    let stored = { spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal', 'Chelsea'] }] };
    const rules = [{ id: 9, kind: 'team', sport: 'Football', match: 'Arsenal', enabled: true }, { id: 10, kind: 'team', sport: 'Football', match: 'Chelsea', enabled: false }];
    const { settings, root, calls, ctx } = panel({
        'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': () => stored, 'PUT /sports/follows': (body) => (stored = JSON.parse(JSON.stringify(body))),
        'GET /recordings/rules': rules, 'DELETE /recordings/rules/9': new Error('Server unavailable'), 'PUT /recordings/rules/10': { id: 10, enabled: true },
        'PUT /recordings/rules/9': () => (refuseOff ? new Error('Server unavailable') : { id: 9, enabled: false }),
        'GET /sports/suggestions': { suggestions: [] }, 'GET /sports/names': { names: ['Arsenal', 'Chelsea'] } }, { answer: false });
    let refuseOff = true;
    await settings.load();
    assert.match(root.innerHTML, /data-record-every="Arsenal" data-sport="Football" checked>/);
    assert.match(root.innerHTML, /data-record-every="Chelsea" data-sport="Football" > Record every game/, 'switched off in Recordings: shown off');
    await root.listeners.change({ target: { dataset: { recordEvery: 'Chelsea', sport: 'Football' }, checked: true } });
    assert.ok(calls.some(c => c[0] === 'PUT' && c[1] === '/recordings/rules/10' && c[2].enabled === true), 'switched back on, not a second rule');
    assert.ok(!calls.some(c => c[0] === 'POST' && c[1] === '/recordings/rules'));
    // #276 review: the rule is switched off before anything is unfollowed; when that is refused, nothing is unfollowed.
    const toasts = ctx.toasts.length;
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    assert.deepEqual(stored.sports[0].teams, ['Arsenal', 'Chelsea'], 'not unfollowed: its rule would go on recording');
    assert.match(root.innerHTML, /Nothing was unfollowed: recording every Arsenal game could not be stopped\./);
    assert.equal(ctx.toasts.length, toasts, 'no Undo notice for a change not made');
    refuseOff = false;
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    assert.deepEqual(stored.sports[0].teams, ['Chelsea']);
    ctx.toasts.at(-1)[1].onEnd('timeout'); await settle(); // the notice ends: the rule (off) is deleted, and that fails
    assert.match(root.innerHTML, /Recording every Arsenal game is off, but the rule could not be deleted: delete it in Recordings › Recording rules\./);
});

// #276 review (Codex high, Opus M2/M4): what is waiting for its notice is never lost, and Undo puts back only what went.
function ruleServer(follows) {
    const server = { stored: JSON.parse(JSON.stringify(follows)), rules: [{ id: 9, kind: 'team', sport: 'Football', match: 'Arsenal', enabled: true }] };
    const rule = (url) => server.rules.find(r => `/recordings/rules/${r.id}` === url.split('?')[0]);
    const responses = {
        'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': () => server.stored,
        'PUT /sports/follows': (body) => (server.stored = JSON.parse(JSON.stringify(body))),
        'GET /recordings/rules': () => server.rules, 'GET /sports/suggestions': { suggestions: [] }, 'GET /sports/names': { names: ['Arsenal', 'Chelsea'] } };
    for (const id of [9]) {
        responses[`PUT /recordings/rules/${id}`] = (body, url) => { const r = rule(url); if (!r) return Object.assign(new Error('gone'), { status: 404 }); Object.assign(r, body); return r; };
        responses[`DELETE /recordings/rules/${id}`] = (body, url) => { server.rules = server.rules.filter(r => r !== rule(url)); return { success: true }; };
    }
    return { server, responses };
}

test('#276 review: unfollowing a team switches its "Record every game" off before the list is saved, so a page closed at any moment never leaves it recording', async () => {
    const { server, responses } = ruleServer({ spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal', 'Chelsea'] }] });
    const order = [];
    const put = responses['PUT /sports/follows'];
    responses['PUT /sports/follows'] = (body) => { order.push(['follows', server.rules[0]?.enabled]); return put(body); };
    const { settings, root, calls, ctx } = panel(responses);
    await settings.load();
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    assert.deepEqual(order, [['follows', false]], 'the rule was off when the list was saved');
    assert.deepEqual(server.stored.sports[0].teams, ['Chelsea']);
    assert.equal(server.rules[0].enabled, false, 'closed now, with nothing more sent: the rule records nothing');
    assert.equal(ctx.toasts.at(-1)[0], 'Unfollowed Arsenal. Recording every Arsenal game stops too.');
    // The page goes (pagehide, tab hidden, sign-out): the delete is sent at once, with keepalive, and once only.
    await vm.runInContext('UI.flushPending()', ctx);
    const deletes = calls.filter(c => c[0] === 'DELETE');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0][3]?.keepalive, true, 'sent so that it outlives the page');
    assert.deepEqual(server.rules, []);
    ctx.toasts.at(-1)[1].onEnd('closed'); await settle();
    assert.equal(calls.filter(c => c[0] === 'DELETE').length, 1, 'the notice ending later sends nothing again');
});

test('#276 review: Undo puts back only what was removed, onto the list as it is now, and switches the rule back on', async () => {
    const { server, responses } = ruleServer({ spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal', 'Chelsea'] }] });
    const { settings, root, calls, ctx } = panel(responses);
    await settings.load();
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    const [, notice] = ctx.toasts.at(-1);
    await root.listeners.change({ target: { id: 'sport-follow-spoilers', checked: true, dataset: {} } });
    await root.listeners.change({ target: { dataset: { addLeague: 'Football' }, value: 'FA Cup' } });
    assert.equal(server.stored.spoilerFree, true);
    notice.onEnd('action'); await notice.action.run(); await settle();
    assert.equal(server.stored.spoilerFree, true, 'Hide scores, turned on in the 10 s, stays on');
    assert.deepEqual(server.stored.sports[0].leagues, ['EPL', 'FA Cup'], 'the league added in the 10 s stays');
    assert.deepEqual(server.stored.sports[0].teams, ['Arsenal', 'Chelsea'], 'the team is back in its place');
    assert.equal(server.rules[0].enabled, true, 'and its rule records again');
    await vm.runInContext('UI.flushPending()', ctx);
    assert.equal(calls.filter(c => c[0] === 'DELETE').length, 0, 'nothing is sent after Undo');
});

test('#276 review: a team followed again inside the 10 s keeps its rule when the notice ends', async () => {
    const { server, responses } = ruleServer({ spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] });
    const { settings, root, calls, ctx } = panel(responses);
    root.querySelector = (sel) => (sel.startsWith('input[data-name-for') ? { value: 'Arsenal' } : null);
    await settings.load();
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    const [, notice] = ctx.toasts.at(-1);
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-add', sport: 'Football' } }) } });
    assert.deepEqual(server.stored.sports[0].teams, ['Arsenal']);
    notice.onEnd('timeout'); await settle();
    assert.equal(calls.filter(c => c[0] === 'DELETE').length, 0, 'the rule is not deleted');
    assert.equal(server.rules.length, 1, 'the rule survives');
    assert.equal(server.rules[0].enabled, true, 'and records again: re-following is Undo by another route');
});

test('#276 review: a team followed again whose rule cannot be switched back on stays followed, and a notice says so', async () => {
    const { server, responses } = ruleServer({ spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] });
    const { settings, root, ctx } = panel(responses);
    root.querySelector = (sel) => (sel.startsWith('input[data-name-for') ? { value: 'Arsenal' } : null);
    await settings.load();
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    const [, notice] = ctx.toasts.at(-1);
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-add', sport: 'Football' } }) } });
    const put = responses['PUT /recordings/rules/9'];
    responses['PUT /recordings/rules/9'] = (body, url) => (body.enabled ? new Error('Server unavailable') : put(body, url));
    notice.onEnd('timeout'); await settle();
    assert.deepEqual(server.stored.sports[0].teams, ['Arsenal'], 'the follow stands');
    assert.equal(server.rules[0].enabled, false);
    const [message, options] = ctx.toasts.at(-1);
    assert.equal(options.kind, 'error');
    assert.match(message, /^Following Arsenal again, but recording every Arsenal game could not be switched back on/);
});

test('#276 review: a list that fails to save switches the rule back on; nothing waits for Undo', async () => {
    const { server, responses } = ruleServer({ spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] });
    responses['PUT /sports/follows'] = () => new Error('Server unavailable');
    const { settings, root, ctx } = panel(responses);
    await settings.load();
    const toasts = ctx.toasts.length;
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    assert.deepEqual(server.stored.sports[0].teams, ['Arsenal']);
    assert.equal(server.rules[0].enabled, true, 'still followed, still recorded');
    assert.equal(ctx.toasts.length, toasts);
});

test('#276 review: switching "Record every game" off and leaving the page sends the delete once, with keepalive', async () => {
    const { server, responses } = ruleServer({ spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] });
    const { settings, calls, ctx } = panel(responses);
    await settings.load();
    await settings.onChange({ target: { dataset: { recordEvery: 'Arsenal', sport: 'Football' }, checked: false } });
    await vm.runInContext('UI.flushPending()', ctx);
    assert.equal(calls.filter(c => c[0] === 'DELETE').length, 1);
    assert.equal(calls.find(c => c[0] === 'DELETE')[3]?.keepalive, true);
    assert.deepEqual(server.rules, []);
    ctx.toasts.at(-1)[1].onEnd('timeout'); await settle();
    assert.equal(calls.filter(c => c[0] === 'DELETE').length, 1, 'once');
});

// 0421 (0420 Codex round 2, high): rules that could not be read were taken as none, so unfollowing said nothing of them.
test('0421: when the recording rules cannot be read, unfollowing says any "Record every game" is still on', async () => {
    let stored = { spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] };
    const { settings, root, ctx } = panel({
        'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': () => stored, 'PUT /sports/follows': (body) => (stored = JSON.parse(JSON.stringify(body))),
        'GET /recordings/rules': new Error('Server unavailable'), 'GET /sports/suggestions': { suggestions: [] }, 'GET /sports/names': { names: ['Arsenal'] } });
    await settings.load();
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    assert.deepEqual(stored.sports[0].teams, []);
    assert.match(root.innerHTML, /The recording rules could not be read, so any &quot;Record every game&quot; on it is still on/);
    assert.equal(ctx.toasts.at(-1)[0], 'Unfollowed Arsenal.');
});

// #208 (as Apple 93): a change the server kept whose answer was lost, with the re-read failing too, left the old list
// on show; the next queued change was built from it and its whole-list PUT undid the kept one. Now the panel goes
// read-only and drops queued changes until a load reads the server again.
test('#208: a lost answer that cannot be read again stops queued changes until the panel loads again', async () => {
    let stored = { spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: [] }] };
    let reads = 'ok', puts = 0, release;
    const { settings, root } = panel({
        'GET /sports/catalog': { sports: catalog },
        'GET /sports/follows': () => (reads === 'fail' ? new Error('offline') : stored),
        'PUT /sports/follows': (body) => {
            puts++;
            stored = JSON.parse(JSON.stringify(body)); // kept...
            if (puts === 1) return new Promise(r => { release = () => r(new Error('the answer was lost')); }); // ...answer lost
            return stored;
        },
        'GET /recordings/rules': [], 'GET /sports/suggestions': { suggestions: [] }, 'GET /sports/names': { names: [] } });
    await settings.load();
    const change = (league) => root.listeners.change({ target: { dataset: { addLeague: 'Football' }, value: league } });
    const a = change('FA Cup');
    while (!release) await new Promise(r => setImmediate(r));
    const b = change('Champions League'); // queued behind the first
    reads = 'fail';
    release();
    await Promise.all([a, b]);
    assert.deepEqual(stored.sports[0].leagues, ['EPL', 'FA Cup'], 'the kept change is never undone');
    assert.equal(puts, 1, 'the queued change was dropped');
    assert.match(root.innerHTML, /could not be read again/i);
    await change('Champions League');
    assert.equal(puts, 1, 'read-only until it loads again');
    reads = 'ok';
    await settings.load();
    await change('Champions League');
    assert.deepEqual(stored.sports[0].leagues, ['EPL', 'FA Cup', 'Champions League'], 'after a load, changes save again');
});

// Codex sign-off (high): a save kept by the server whose answer was lost was taken as failed, and the rule switched
// back on for a team no longer followed. A rule goes back on only for a team the server confirms is still followed.
test('sign-off: the list saved but its answer lost, read back unfollowed: the unfollow stands, rule off, its deletion waits for the notice', async () => {
    const { server, responses } = ruleServer({ spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] });
    const put = responses['PUT /sports/follows'];
    responses['PUT /sports/follows'] = (body) => { put(body); return new Error('the answer was lost'); };
    const { settings, root, calls, ctx } = panel(responses);
    await settings.load();
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    assert.deepEqual(server.stored.sports[0].teams, []);
    assert.equal(server.rules[0].enabled, false, 'not switched back on');
    assert.equal(ctx.toasts.at(-1)[0], 'Unfollowed Arsenal. Recording every Arsenal game stops too.');
    assert.doesNotMatch(root.innerHTML, /Not saved/);
    ctx.toasts.at(-1)[1].onEnd('timeout'); await settle();
    assert.equal(calls.filter(c => c[0] === 'DELETE' && c[1] === '/recordings/rules/9').length, 1, 'its deletion was registered');
});

test('sign-off: the answer lost and the list cannot be read again: the rule stays off, the page says so, nothing more', async () => {
    const { server, responses } = ruleServer({ spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] });
    const put = responses['PUT /sports/follows'];
    let readable = true;
    const get = responses['GET /sports/follows'];
    responses['GET /sports/follows'] = () => (readable ? get() : new Error('offline'));
    responses['PUT /sports/follows'] = (body) => { put(body); readable = false; return new Error('the answer was lost'); };
    const { settings, root, calls, ctx } = panel(responses);
    await settings.load();
    const toasts = ctx.toasts.length;
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    assert.equal(server.rules[0].enabled, false, 'off');
    assert.ok(!calls.some(c => c[0] === 'PUT' && c[1] === '/recordings/rules/9' && c[2].enabled === true), 'never switched back on');
    assert.ok(!calls.some(c => c[0] === 'DELETE'));
    assert.equal(ctx.toasts.length, toasts, 'no Undo notice');
    assert.match(root.innerHTML, /Could not confirm whether Arsenal is still followed, so recording every Arsenal game is off for now\. Reload this page\./);
});

test('sign-off: Undo whose save was kept but whose answer was lost switches the rule on (read back as followed); unknown keeps it off', async () => {
    for (const readable of [true, false]) {
        const { server, responses } = ruleServer({ spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal'] }] });
        const put = responses['PUT /sports/follows'];
        const get = responses['GET /sports/follows'];
        let lose = false, canRead = true;
        responses['PUT /sports/follows'] = (body) => { const r = put(body); if (!lose) return r; canRead = readable; return new Error('the answer was lost'); };
        responses['GET /sports/follows'] = () => (canRead ? get() : new Error('offline'));
        const { settings, root, calls, ctx } = panel(responses);
        await settings.load();
        await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
        const [, notice] = ctx.toasts.at(-1);
        lose = true;
        notice.onEnd('action'); await notice.action.run(); await settle();
        assert.deepEqual(server.stored.sports[0].teams, ['Arsenal']);
        assert.equal(server.rules[0].enabled, readable, `readable=${readable}`);
        if (!readable) assert.match(root.innerHTML, /Could not confirm whether Arsenal is followed again/);
        assert.ok(!calls.some(c => c[0] === 'DELETE'));
    }
});

test('sign-off: when the notice ends with the list unknown, the rule is neither deleted nor switched on', async () => {
    const { server, responses } = ruleServer({ spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL', 'FA Cup'], teams: ['Arsenal'] }] });
    const { settings, root, calls, ctx } = panel(responses);
    await settings.load();
    await root.listeners.click({ target: { closest: () => ({ dataset: { act: 'name-remove', sport: 'Football', name: 'Arsenal' } }) } });
    const [, notice] = ctx.toasts.at(-1);
    settings.unknown = true; // a later change's answer was lost and could not be read again (#208)
    notice.onEnd('timeout'); await settle();
    assert.ok(!calls.some(c => c[0] === 'DELETE'));
    assert.equal(server.rules[0].enabled, false);
    assert.match(root.innerHTML, /Could not confirm whether Arsenal is still followed/);
});

test('#323: Score delay sits under Hide scores; a bad number is said beside the field, never dropped; it saves with its revision', async () => {
    // Moved here from the retired C-O Sport page's "Scores & delay" dialog (Apple: Settings › Sport › Score delay).
    const sent = [];
    let conflict = false;
    const { settings, root, ctx } = panel({
        'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': { spoilerFree: false, sports: [] },
        'GET /recordings/rules': [], 'GET /sports/suggestions': { suggestions: [] },
        'GET /sports/preferences': () => ({ avoidSpoilers: false, scoreDelaySeconds: conflict ? 30 : 90, revision: conflict ? 4 : 3 }),
        'PUT /sports/preferences': (body) => { sent.push(body); if (conflict) return Object.assign(new Error('Conflict'), { status: 409 }); return { avoidSpoilers: false, scoreDelaySeconds: body.scoreDelaySeconds, revision: 4 }; } });
    await settings.load();
    const html = root.innerHTML;
    assert.ok(html.indexOf('Hide scores') < html.indexOf('Score delay'), 'under Hide scores');
    assert.match(html, /<label class="setting-label" for="sport-delay">Score delay<\/label>/);
    assert.match(html, /<input type="number" id="sport-delay" min="0" max="300" step="1" inputmode="numeric" value="90"/);
    assert.match(html, /<button class="btn btn-sm btn-secondary" data-act="delay-save">Save score delay<\/button>/);
    const errors = [];
    ctx.errors = errors;
    vm.runInContext('UI.fieldError = (input, text) => { errors.push(text); };', ctx);
    const input = { min: '0', max: '300', value: '', focus() { this.focused = true; } };
    root.querySelector = (sel) => (sel === '#sport-delay' ? input : null);
    const click = () => root.listeners.click({ target: { closest: () => ({ dataset: { act: 'delay-save' } }) } });
    for (const bad of ['', '1.5', '-1', '301', 'abc']) {
        input.value = bad; errors.length = 0; input.focused = false;
        await click();
        assert.match(errors[0] || '', /Enter a whole number from 0 to 300\./, `"${bad}" is said`);
        assert.equal(input.focused, true);
    }
    assert.equal(sent.length, 0, 'nothing bad is sent');
    input.value = '0';
    await click(); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ scoreDelaySeconds: 0, revision: 3 }], '0 is a delay, sent with the revision it was read at');
    assert.match(root.innerHTML, /Score delay saved: 0 seconds\./);
    conflict = true; input.value = '45';
    await click(); await settle();
    assert.match(root.innerHTML, /changed on another device/);
    assert.match(root.innerHTML, /value="30"/, 'the newer value is shown');
});

test('#323: a server without the score delay shows no row', async () => {
    const { settings, root } = panel({ 'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': { spoilerFree: false, sports: [] },
        'GET /recordings/rules': [], 'GET /sports/suggestions': { suggestions: [] }, 'GET /sports/preferences': Object.assign(new Error('Not found'), { status: 404 }) });
    await settings.load();
    assert.doesNotMatch(root.innerHTML, /Score delay/);
});
