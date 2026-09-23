const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 0123: Settings -> "Channel numbers". The real Settings.js and api.js against a
// recorded fetch: GET /api/lineup fills the list, a search narrows it, an edited
// number is saved with PUT /api/lineup/numbers (only the changed rows), and the
// server's own validation message is what the admin sees. The old code has no
// such panel (SettingsPage.prototype.loadLineup is undefined).

const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

const LINEUP = [
    { sourceId: 1, id: 'pos_1', stableId: 's1', name: 'BBC One', number: 1, category: 'UK' },
    { sourceId: 1, id: 'pos_2', stableId: 's2', name: 'Sky <News>', number: 2, category: 'UK' },
    { sourceId: 1, id: 'pos_9', stableId: 's9', name: 'Fox Sports 505', number: 505, category: 'SPORT' }
];

function page(putReplies) {
    const requests = [];
    const elements = {
        'lineup-list': { innerHTML: '' },
        'lineup-status': { textContent: '', classList: { toggle(c, on) { this.error = on; } } },
        'lineup-save': { disabled: true }
    };
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
        document: { getElementById: (id) => elements[id] || null, querySelectorAll: () => [] },
        fetch: async (url, opts = {}) => {
            const method = opts.method || 'GET';
            requests.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });
            let status = 200, body;
            if (url === '/api/lineup') body = LINEUP;
            else if (url === '/api/library/categories') body = [{ id: 'SPORT', sourceId: 1, name: 'Sport', channelCount: 1 }];
            else if (url === '/api/lineup/numbers' && method === 'PUT') ({ status, body } = putReplies.shift());
            else { status = 404; body = { error: 'No such API endpoint' }; }
            return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
        }
    });
    context.window = context;
    vm.runInContext(js('api.js'), context);
    vm.runInContext(js('pages/Settings.js'), context);
    const settings = Object.create(context.SettingsPage.prototype);
    Object.assign(settings, { lineup: [], lineupEdits: new Map(), lineupQuery: '', lineupCategoryNames: new Map() });
    return { settings, requests, elements };
}

test('the Channel numbers panel lists GET /api/lineup with numbers, names and category names', async () => {
    const { settings, requests, elements } = page([]);
    assert.equal(typeof settings.loadLineup, 'function', 'the panel exists');
    await settings.loadLineup();

    assert.deepEqual(plain(requests.map(r => `${r.method} ${r.url}`)), ['GET /api/lineup', 'GET /api/library/categories']);
    const html = elements['lineup-list'].innerHTML;
    assert.equal((html.match(/<tr class="lineup-row/g) || []).length, 3);
    assert.match(html, /data-key="1:pos_9" value="505"/);
    assert.ok(html.includes('Sky &lt;News&gt;'), 'names are escaped');
    assert.ok(html.includes('<td>Sport</td>'), 'the category name from /api/library/categories');
    assert.ok(html.includes('<td>UK</td>'), 'else the category id');
    assert.equal(elements['lineup-save'].disabled, true, 'nothing to save yet');
});

test('the search matches a number, a name or a category', async () => {
    const { settings } = page([]);
    await settings.loadLineup();
    const names = (q) => { settings.lineupQuery = q; return plain(settings.filteredLineup().map(r => r.id)); };
    assert.deepEqual(names('50'), ['pos_9'], 'leading digits of a number');
    assert.deepEqual(names('bbc'), ['pos_1']);
    assert.deepEqual(names('sport'), ['pos_9'], 'by category name');
    assert.deepEqual(names(''), ['pos_1', 'pos_2', 'pos_9']);
});

test('save sends only the edited rows, and shows the server\'s validation error as it comes', async () => {
    const { settings, requests, elements } = page([
        { status: 400, body: { error: 'Duplicate number 2' } },
        { status: 200, body: { success: true } }
    ]);
    await settings.loadLineup();

    settings.editLineupNumber('1:pos_9', ' 2 ');
    settings.editLineupNumber('1:pos_1', '1'); // unchanged: not sent
    settings.updateLineupSaveState();
    assert.equal(elements['lineup-save'].disabled, false);

    await settings.saveLineup();
    const put = requests.filter(r => r.method === 'PUT');
    assert.deepEqual(plain(put), [{ url: '/api/lineup/numbers', method: 'PUT', body: { numbers: [{ sourceId: 1, id: 'pos_9', number: 2 }] } }]);
    assert.equal(elements['lineup-status'].textContent, 'Duplicate number 2', "the server's words");
    assert.equal(elements['lineup-status'].classList.error, true);
    assert.equal(settings.lineupEdits.size, 1, 'the edit is kept so it can be corrected');

    settings.editLineupNumber('1:pos_9', '7');
    await settings.saveLineup();
    assert.deepEqual(plain(requests.filter(r => r.method === 'PUT')[1].body), { numbers: [{ sourceId: 1, id: 'pos_9', number: 7 }] });
    assert.equal(elements['lineup-status'].textContent, 'Saved 1 number');
    assert.equal(settings.lineupEdits.size, 0, 'the list is reloaded from the server');
});

test('something that is not a whole number goes to the server as typed, for it to refuse', async () => {
    const { settings, requests, elements } = page([{ status: 400, body: { error: 'Channel numbers must be whole numbers from 1 to 999999' } }]);
    await settings.loadLineup();
    settings.editLineupNumber('1:pos_2', '2.5');
    await settings.saveLineup();
    assert.deepEqual(plain(requests.filter(r => r.method === 'PUT')[0].body.numbers), [{ sourceId: 1, id: 'pos_2', number: '2.5' }]);
    assert.match(elements['lineup-status'].textContent, /whole numbers/);
});
