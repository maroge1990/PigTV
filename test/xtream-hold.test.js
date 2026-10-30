const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

// #168, #170 (0354, 0355): an Xtream provider. A held (much smaller) channel list still lets the guide refresh, and
// "Accept the smaller list" reaches the guide too. The real sync in a sandbox against a local Xtream look-alike. On
// 0353 the held list stopped the guide sync, and acceptSmaller never reached the guide.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-xtream-hold-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.PIGTV_DB_BACKUPS = '0';
const db = load('db');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

const fmt = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const guide = (per, title) => {
    const start = Date.now() - 3600e3, out = ['<tv>'];
    for (let c = 0; c < 40; c++) out.push(`<channel id="ch${c}"><display-name>C${c}</display-name></channel>`);
    for (let c = 0; c < 40; c++) for (let i = 0; i < per; i++) {
        out.push(`<programme start="${fmt(start + i * 1800e3)}" stop="${fmt(start + (i + 1) * 1800e3)}" channel="ch${c}"><title>${title}</title></programme>`);
    }
    return out.concat('</tv>').join('\n');
};
const state = { channels: 100, xml: guide(100, 'First guide') };
const provider = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/xmltv.php') { res.setHeader('content-type', 'application/xml'); return res.end(state.xml); }
    const action = u.searchParams.get('action');
    if (!action) return res.end(JSON.stringify({ user_info: { auth: 1, status: 'Active' }, server_info: {} }));
    if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'Sport' }]));
    if (action === 'get_live_streams') {
        return res.end(JSON.stringify(Array.from({ length: state.channels }, (_, i) => ({
            stream_id: 1000 + i, name: `Channel ${i}`, category_id: '1', epg_channel_id: `ch${i % 40}` }))));
    }
    return res.end('[]'); // films and series: none
});
let source;
const realLog = console.log, realWarn = console.warn;
before(async () => {
    console.log = () => {}; console.warn = () => {};
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    source = await db.sources.create({ type: 'xtream', name: 'Xtreamy', url: `http://127.0.0.1:${provider.address().port}`, username: 'u', password: 'p' });
});
after(async () => {
    console.log = realLog; console.warn = realWarn;
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
    try { sqlite.getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});
const d = () => sqlite.getDb();
const channels = () => d().prepare(`SELECT COUNT(*) AS n FROM playlist_items WHERE source_id = ? AND type = 'live'`).get(source.id).n;
const titles = () => d().prepare(`SELECT DISTINCT p.title FROM epg_programs p JOIN epg_state s ON s.source_id = p.source_id
    AND s.active_gen = p.gen WHERE p.source_id = ?`).all(source.id).map(r => r.title);
const status = (type) => d().prepare('SELECT status FROM sync_status WHERE source_id = ? AND type = ?').get(source.id, type)?.status;

test('#168: a held Xtream list keeps its 100 channels and still refreshes the guide', async () => {
    await sync.syncSource(source.id);
    assert.equal(channels(), 100);
    assert.deepEqual(titles(), ['First guide']);
    state.channels = 10;
    state.xml = guide(100, 'Second guide');
    await sync.syncSource(source.id);
    assert.equal(channels(), 100, 'the lineup is held');
    assert.equal(status('all'), 'held');
    assert.deepEqual(titles(), ['Second guide'], 'the guide moved on');
    assert.equal(status('epg'), 'success');
});

test('#170: accepting the smaller list accepts the smaller guide too', async () => {
    state.xml = guide(20, 'Short guide');
    await sync.syncSource(source.id);
    assert.equal(status('epg'), 'held');
    await sync.syncSource(source.id, { acceptSmaller: true });
    assert.equal(channels(), 10);
    assert.deepEqual(titles(), ['Short guide']);
    assert.equal(status('all'), 'success');
    assert.equal(status('epg'), 'success');
});
