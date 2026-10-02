const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 0149 (contract C-I): Settings -> Sports. The follow list as chips (add, remove, save with
// PUT /api/sports/follow) and a preview of the recognised events (GET /api/sports/preview) with
// the rule that matched and the channels, reloaded after a save. Also the Manage Content Sport
// toggle's tooltip now says it helps sport recognition. The old web app has no such tab.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function harness(replies) {
    const requests = [];
    const el = () => ({ innerHTML: '', textContent: '', value: '', disabled: false, classList: { toggle() {} }, addEventListener() {} });
    const elements = Object.fromEntries(['sports-follow-chips', 'sports-league-select', 'sports-team-league', 'sports-team-select', 'sports-follow-input', 'sports-follow-add', 'sports-follow-save',
        'sports-status', 'sports-preview-list'].map(id => [id, el()]));
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
        document: { getElementById: (id) => elements[id] || null, querySelectorAll: () => [] },
        setTimeout, clearTimeout,
        fetch: async (url, opts = {}) => {
            const key = `${opts.method || 'GET'} ${url}`;
            requests.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined });
            const reply = typeof replies[key] === 'function' ? replies[key]() : replies[key];
            const status = reply === undefined ? 404 : 200;
            return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => reply, text: async () => JSON.stringify(reply) };
        }
    });
    context.window = context;
    vm.runInContext(js('api.js'), context);
    vm.runInContext(js('pages/Settings.js'), context);
    const settings = Object.create(context.SettingsPage.prototype);
    return { settings, elements, requests };
}

const NOW = Date.now();
const event = (title, extra = {}) => ({
    id: 'abc', title, league: 'NFL', start: NOW - 60000, end: NOW + 3600000, live: true, rule: 'keyword', match: 'NFL',
    channels: [{ sourceId: 1, id: 'pos_1', name: 'Sky <Sports> UHD', number: 501, quality: 'UHD' }, { sourceId: 1, id: 'pos_2', name: 'ESPN', number: 502, quality: null }],
    ...extra
});

test('Settings has a Sports tab explaining what counts as sport', () => {
    assert.match(html, /<button class="tab" data-tab="sports">Sports<\/button>/);
    assert.match(html, /<div id="tab-sports" class="tab-content">[\s\S]*?counts as sport[\s\S]*?id="sports-preview-list"/);
});

test('the follow list shows as chips, is edited, saved with PUT /api/sports/follow, and the preview reloads', async () => {
    let previews = 0;
    const { settings, elements, requests } = harness({
        'GET /api/sports/follow': { keywords: ['NFL'], leagues: [{ name: 'EPL', fixtures: true }, { name: 'F1', fixtures: true }, { name: 'MotoGP', fixtures: false }, { name: 'NFL', fixtures: true }] },
        'PUT /api/sports/follow': { keywords: ['NFL', 'F1'] },
        'GET /api/sports/preview': () => { previews++; return { now: NOW, events: previews === 1 ? [event('NFL: Chiefs <v> Bills')] : [event('F1: Monaco', { league: 'F1', match: 'F1' })] }; }
    });
    settings.initSports();
    await settings.loadSports();
    assert.match(elements['sports-follow-chips'].innerHTML, /NFL[\s\S]*data-sports-remove="0"/);
    assert.equal(elements['sports-follow-save'].disabled, true, 'nothing to save');
    // 0185: leagues are picked from a list: the ones not followed yet, those with real fixture times first.
    const picker = () => elements['sports-league-select'].innerHTML;
    assert.match(picker(), /Add a league[\s\S]*With real fixture times[\s\S]*value="EPL"[\s\S]*value="F1"[\s\S]*From the guide only[\s\S]*value="MotoGP"/);
    assert.ok(!picker().includes('value="NFL"'), 'already followed');
    assert.match(html, /id="sports-league-select"/);

    // ...and teams: a league with a roster, then one of its teams.
    assert.match(html, /id="sports-team-league"[\s\S]*id="sports-team-select"/);
    assert.match(js('pages/Settings.js'), /addSportsKeyword\(`\$\{teamLeague\.value\}: \$\{teamSelect\.value\}`\)/);

    const rows = elements['sports-preview-list'].innerHTML;
    assert.ok(rows.includes('NFL: Chiefs &lt;v&gt; Bills'), 'escaped');
    assert.ok(rows.includes('LIVE'));
    assert.ok(rows.includes('Keyword'), 'the matched rule');
    assert.match(rows, /<summary>2 channels<\/summary>/);
    assert.ok(rows.includes('501 Sky &lt;Sports&gt; UHD'), 'the channel names, expandable');

    settings.addSportsKeyword('  F1 ');
    settings.addSportsKeyword('nfl');
    assert.deepEqual([...settings.sportsKeywords], ['NFL', 'F1'], 'trimmed; a duplicate is not added');
    assert.equal(elements['sports-follow-save'].disabled, false);
    assert.ok(!picker().includes('value="F1"') && picker().includes('value="EPL"'), 'a league just added leaves the list');
    settings.addSportsKeyword('Chiefs');
    settings.removeSportsKeyword(2);
    assert.deepEqual([...settings.sportsKeywords], ['NFL', 'F1']);

    await settings.saveSportsFollow();
    const put = requests.find(r => r.key === 'PUT /api/sports/follow');
    assert.deepEqual(JSON.parse(JSON.stringify(put.body)), { keywords: ['NFL', 'F1'] });
    assert.equal(elements['sports-status'].textContent, 'Saved');
    assert.equal(previews, 2, 'the preview reloads after a save');
    assert.ok(elements['sports-preview-list'].innerHTML.includes('F1: Monaco'));
    assert.equal(elements['sports-follow-save'].disabled, true);
});

// 0151: the preview is grouped by kind (0150): Events, Replays, then Shows and Placeholders collapsed until
// their heading is clicked; each row shows why it is that kind and the guide titles merged into it.
test('the preview groups by kind: events and replays open, shows and placeholders collapsed; aliases listed', async () => {
    const { settings, elements } = harness({
        'GET /api/sports/follow': { keywords: ['AFLW'] },
        'GET /api/sports/preview': { now: NOW, events: [
            event('NFL Blitz', { kind: 'show', kindRule: 'show: "blitz"', aliases: ['NFL Blitz'] }),
            event('Carlton Blues v Richmond Tigers', { kind: 'event', kindRule: 'event: a match-up', league: 'AFLW',
                aliases: ['Live AFLW: Carlton v Richmond', "Women's AFL - AFLW: Carlton v Richmond"] }),
            event('NBA 06', { kind: 'placeholder', kindRule: 'placeholder: ends in a bare ":"', aliases: ['NBA 06 :'] }),
            event('Packers v Jets', { kind: 'replay', kindRule: 'replay: a game with "re airs"', live: false,
                aliases: ['NFL Game Re-Airs - 2026: Packers vs. Jets - Week 2'] })
        ] }
    });
    settings.initSports();
    await settings.loadSports();
    const html = () => elements['sports-preview-list'].innerHTML;
    const order = ['Events (1)', 'Replays (1)', 'Shows (1)', 'Placeholders (1)'].map(h => html().indexOf(h));
    assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), 'Events, Replays, Shows, Placeholders in that order');
    assert.ok(html().includes('Carlton Blues v Richmond Tigers') && html().includes('Packers v Jets'), 'events and replays open');
    assert.ok(!html().includes('NFL Blitz') && !html().includes('>NBA 06<'), 'shows and placeholders collapsed');
    assert.match(html(), /<summary>2 guide titles<\/summary>[\s\S]*Live AFLW: Carlton v Richmond[\s\S]*Women&#39;s AFL - AFLW/);
    assert.ok(html().includes('event: a match-up'), 'why it is an event');

    settings.toggleSportsKind('show');
    assert.ok(html().includes('NFL Blitz') && html().includes('show: &quot;blitz&quot;'), 'a click opens the shows');
    assert.match(html(), /data-sports-kind="show" aria-expanded="true"/);
    settings.toggleSportsKind('event');
    assert.ok(!html().includes('Carlton Blues v Richmond Tigers'), 'events collapse too');
});

test('the Manage Content Sport toggle says it helps sport recognition', () => {
    const source = js('components/SourceManager.js');
    assert.doesNotMatch(source, /Sport on now row/);
    assert.match(source, /title="Sport category: [^"]*counts as sport[^"]*"/);
});
