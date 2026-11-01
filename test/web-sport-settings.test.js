const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #199 (D-41, C-U): Settings › Sports › "Your sport", a panel of its own (public/js/pages/SportSettings.js). The model
// is pure; the panel is driven here through a fake root and a fake API. The old web has no such panel.
const source = fs.readFileSync(path.join(__dirname, '../public/js/pages/SportSettings.js'), 'utf8');
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
    const calls = [];
    const root = { innerHTML: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, querySelector: () => null };
    const ctx = vm.createContext({ confirm: () => answer, CSS: { escape: (v) => v }, console,
        API: { request: async (method, url, body) => {
            calls.push([method, url, body]);
            const key = `${method} ${url.split('?')[0]}`;
            const r = typeof responses[key] === 'function' ? responses[key](body, url) : responses[key];
            if (r instanceof Error) throw r;
            return JSON.parse(JSON.stringify(r ?? {}));
        } } });
    vm.runInContext(`${source}\nthis.SportFollowSettings = SportFollowSettings;`, ctx);
    const settings = new ctx.SportFollowSettings(root, { currentUser: () => ({ username: 'mark' }) });
    return { settings, root, calls };
}

test('#199: the panel shows the account\'s sports, leagues under headings, names, suggestions and Record every game', async () => {
    const follows = { spoilerFree: true, sports: [{ sport: 'Football', leagues: ['EPL'], teams: ['Arsenal', '<b>x</b>'] },
        { sport: 'Tennis', leagues: ['ATP Tour'], teams: ['Jannik Sinner'] }] };
    const { settings, root } = panel({
        'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': follows,
        'GET /recordings/rules': [{ id: 9, kind: 'team', sport: 'Football', match: 'Arsenal', createdByName: 'sam' }],
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

test('#199: changes save the whole list; unfollowing a team with "Record every game" asks, and Cancel stops the rule', async () => {
    const plain = (v) => JSON.parse(JSON.stringify(v));
    for (const answer of [true, false]) {
        let stored = { spoilerFree: false, sports: [{ sport: 'Football', leagues: ['EPL', 'Champions League'], teams: ['Arsenal'] }] };
        const { settings, root, calls } = panel({
            'GET /sports/catalog': { sports: catalog }, 'GET /sports/follows': () => stored, 'PUT /sports/follows': (body) => (stored = plain(body)),
            'GET /recordings/rules': [{ id: 9, kind: 'team', sport: 'Football', match: 'Arsenal' }], 'DELETE /recordings/rules/9': { success: true },
            'GET /sports/suggestions': { suggestions: [] }, 'GET /sports/names': { names: ['Arsenal'] } }, { answer });
        await settings.load();
        const click = (data) => root.listeners.click({ target: { closest: () => ({ dataset: data }) } });
        await click({ act: 'league-up', sport: 'Football', league: 'Champions League' });
        assert.deepEqual(stored.sports[0].leagues, ['Champions League', 'EPL'], 'the whole list, in the new order');
        await click({ act: 'name-remove', sport: 'Football', name: 'Arsenal' });
        assert.deepEqual(stored.sports[0].teams, []);
        assert.equal(calls.some(c => c[0] === 'DELETE' && c[1] === '/recordings/rules/9'), !answer, answer ? 'OK keeps the rule' : 'Cancel stops it');
    }
});
