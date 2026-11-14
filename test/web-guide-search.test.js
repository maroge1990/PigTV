const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument, FakeEvent } = require('./helpers/fakeDom');

// #321 (5): the guide's search also finds programmes by title in the next 24 h, from the guide already loaded (no
// request), and a hit opens the programme menu. The channel filter stays instant; the programme scan waits for a pause.
const js = (f) => fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf8');
const HOUR = 3600000;

function browser() {
    const document = createDocument();
    document.body.innerHTML = '<div id="epg-grid"></div><span id="guide-date"></span><button id="guide-prev"></button>'
        + '<button id="guide-next"></button><select id="epg-group-select"></select><input id="epg-search">';
    const timers = [];
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        document, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
        setInterval: () => 7, clearInterval() {}, localStorage: { getItem: () => 'tok' }, CSS: { escape: (s) => s }
    });
    context.window = context;
    loadUi(context);
    vm.runInContext(js('components/EpgGuide.js'), context);
    const guide = new context.EpgGuide();
    return { context, document, guide, timers, fire: () => timers.splice(0).forEach((t) => t.fn && t.fn()) };
}
const prog = (title, startH, lenH = 1) => {
    const startMs = Date.now() + startH * HOUR;
    return { title, description: '', start: new Date(startMs).toISOString(), stop: new Date(startMs + lenH * HOUR).toISOString(), startMs, stopMs: startMs + lenH * HOUR };
};
const channel = (id, name, programmes) => ({ id, sourceId: 1, name, programmes });

test('findProgrammes: titles in the next 24 h, soonest first; a past, later or non-matching programme is left out', () => {
    const { guide } = browser();
    guide.rows = [
        channel('a', 'Alpha', [prog('Old Show Match', -3), prog('Match Day Live', 2), prog('News', 1)]),
        channel('b', 'Beta', [prog('The MATCH', -0.5), prog('Match tomorrow', 30)])
    ];
    const { list, total } = guide.findProgrammes('match');
    assert.deepEqual(Array.from(list, (h) => [h.programme.title, h.channel.name]), [['The MATCH', 'Beta'], ['Match Day Live', 'Alpha']]);
    assert.equal(total, 2);
    assert.equal(guide.findProgrammes('m').list.length, 0, 'one letter searches nothing');
});

test('a few thousand programmes are scanned once per pause, not once per keystroke', () => {
    const { guide, timers, fire } = browser();
    guide.rows = Array.from({ length: 300 }, (_, c) => channel(`c${c}`, `Chan ${c}`, Array.from({ length: 12 }, (_, i) => prog(i === 5 ? `Football ${c}` : `Show ${c}-${i}`, i * 2 - 1, 2))));
    let scans = 0; const find = guide.findProgrammes.bind(guide);
    guide.findProgrammes = (...a) => { scans++; return find(...a); };
    guide.render = () => {}; // the grid is not under test
    const input = guide.searchInput;
    for (const term of ['f', 'fo', 'foo', 'foot']) {
        input.value = term;
        input.dispatchEvent(new FakeEvent('input'));
    }
    assert.equal(scans, 0, 'no scan while typing');
    fire();
    assert.equal(scans, 1, 'one scan after the pause');
    assert.equal(guide._hits.total, 300);
    assert.equal(guide._hits.list.length, 30, 'the list is capped, the rest is counted');
    assert.match(guide.programmeHitsHtml(), /270 more/);
    const t0 = process.hrtime.bigint();
    guide.findProgrammes('football');
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 250, 'a scan of 3,600 programmes is quick');
    assert.ok(timers.length === 0);
});

test('a hit shows its channel and time, escaped, and opens the programme menu for that airing', () => {
    const { guide, document } = browser();
    guide.rows = [channel('a', 'Al<b>pha', [prog('<i>Derby</i>', 2)])];
    guide.render = () => {};
    guide.searchInput.value = 'derby';
    guide.searchProgrammes();
    const html = guide.programmeHitsHtml();
    assert.match(html, /&lt;i&gt;Derby&lt;\/i&gt;/);
    assert.match(html, /Al&lt;b&gt;pha/);
    assert.doesNotMatch(html, /<i>Derby/);
    const opened = [];
    guide.showProgramDetails = (data) => opened.push(data);
    const hit = document.createElement('button'); hit.setAttribute('data-hit', '0'); hit.dataset = { hit: '0' };
    guide.container.appendChild(hit);
    hit.click();
    assert.equal(opened.length, 1);
    assert.deepEqual({ title: opened[0].title, channelName: opened[0].channelName, channelId: opened[0].channelId, sourceId: opened[0].sourceId, recordable: opened[0].recordable },
        { title: '<i>Derby</i>', channelName: 'Al<b>pha', channelId: 'a', sourceId: '1', recordable: 'true' });
});

test('clearing the search removes the programme hits at once', () => {
    const { guide } = browser();
    guide.rows = [channel('a', 'Alpha', [prog('Derby', 2)])];
    guide.render = () => {};
    guide.searchInput.value = 'derby'; guide.searchProgrammes();
    assert.equal(guide._hits.list.length, 1);
    guide.searchInput.value = '';
    guide.searchInput.dispatchEvent(new FakeEvent('input'));
    assert.equal(guide._hits, null);
    assert.equal(guide.programmeHitsHtml(), '');
});
