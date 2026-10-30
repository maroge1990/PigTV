const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

// #11 (0350): the scheduled sync runs at fixed local times, a failed feed is retried, a failed guide is not masked by
// the playlist's success at start-up, and a guide running out is raised. On 0349 the timer restarted with every
// redeploy, a failure waited a whole interval, the start-up check read MAX(last_sync) over both feeds (and a
// `source.syncInterval` nothing sets), and nothing warned about a short guide.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-sync-schedule-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
process.env.PIGTV_DB_BACKUPS = '0';
const db = load('db');
const sqlite = load('db/sqlite');
const sync = load('services/syncService');

const fmt = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const guide = (hoursAhead) => {
    const start = Date.now() - 3600e3, out = ['<tv><channel id="c"><display-name>C</display-name></channel>'];
    for (let t = start; t < Date.now() + hoursAhead * 3600e3; t += 3600e3) {
        out.push(`<programme start="${fmt(t)}" stop="${fmt(t + 3600e3)}" channel="c"><title>Show</title></programme>`);
    }
    return out.concat('</tv>').join('\n');
};
const state = { playlistFails: 0, guideFails: 0, guideHours: 96, requests: [], hooks: [] };
const provider = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    state.requests.push(url);
    if (url === '/hook') { let b = ''; req.on('data', c => b += c); req.on('end', () => { state.hooks.push(JSON.parse(b)); res.end('{}'); }); return; }
    if (url === '/xmltv.php') {
        if (state.guideFails > 0) { state.guideFails--; res.statusCode = 500; return res.end('busy'); }
        res.setHeader('content-type', 'application/xml'); return res.end(guide(state.guideHours));
    }
    if (url === '/get.php' && state.playlistFails > 0) { state.playlistFails--; res.statusCode = 503; return res.end('busy'); }
    res.setHeader('content-type', 'audio/x-mpegurl');
    res.end('#EXTM3U\n#EXTINF:-1 tvg-id="c" group-title="G",C\nhttp://p.invalid/live/u/p/1.ts\n');
});
let source, base;
const realLog = console.log, realWarn = console.warn, realError = console.error;
before(async () => {
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    base = `http://127.0.0.1:${provider.address().port}`;
    source = await db.sources.create({ type: 'm3u', name: 'Strong8K', url: `${base}/get.php?username=u&password=p`, epgUrl: `${base}/xmltv.php` });
});
after(async () => {
    console.log = realLog; console.warn = realWarn; console.error = realError;
    sync.stopSyncTimer();
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
    try { sqlite.getDb().close(); } catch { /* closed */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});
const feed = (type) => sqlite.getDb().prepare('SELECT status FROM sync_status WHERE source_id = ? AND type = ?').get(source.id, type)?.status;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('the scheduled sync runs at 04:30 local and every interval after it, whenever the server started', () => {
    assert.equal(typeof sync.nextRunAt, 'function', 'a fixed schedule exists');
    const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
    const show = (ms) => { const x = new Date(ms); return `${x.getDate()} ${x.getHours()}:${String(x.getMinutes()).padStart(2, '0')}`; };
    assert.equal(show(sync.nextRunAt(at(2026, 10, 30, 21, 16), 24)), '31 4:30');
    assert.equal(show(sync.nextRunAt(at(2026, 10, 30, 3, 0), 24)), '30 4:30');
    assert.equal(show(sync.nextRunAt(at(2026, 10, 30, 21, 16), 6)), '30 22:30');
    assert.equal(show(sync.nextRunAt(at(2026, 10, 30, 4, 30), 12)), '30 16:30', 'exactly on time: the next one');
});

test('at start-up a failed guide makes the source stale although its playlist synced moments ago', async () => {
    state.guideFails = 1;
    await sync.syncSource(source.id);
    assert.equal(feed('all'), 'success');
    assert.equal(feed('epg'), 'error');
    state.requests.length = 0;
    await sync.syncIfStale();
    assert.ok(state.requests.includes('/xmltv.php'), 'the guide is fetched again');
    assert.equal(feed('epg'), 'success');
});

test('a failed sync is retried after the first delay, and the series ends on success', async () => {
    sync.SCHEDULE.retriesMs = [80, 160, 240];
    state.playlistFails = 2;
    state.requests.length = 0;
    await sync.syncWithRetry(source.id);
    assert.equal(feed('all'), 'error');
    await wait(900);
    assert.equal(feed('all'), 'success', 'two retries later the provider answers');
    assert.equal(state.requests.filter(u => u === '/get.php').length, 3, JSON.stringify(state.requests));
});

test('a guide reaching less than 36 h ahead is raised once by webhook and shows on Status', async () => {
    await db.settings.update({ notifyWebhookUrl: `${base}/hook`, notifyWebhookFormat: 'json' });
    state.guideHours = 10;
    await sync.syncSource(source.id, { acceptSmaller: true });
    await sync.checkGuide();
    await sync.checkGuide();
    await wait(200);
    assert.equal(state.hooks.length, 1, 'once per episode');
    assert.equal(state.hooks[0].event, 'guide-stale');
    assert.match(state.hooks[0].message, /^Strong8K's guide covers only 1\d hours ahead/);
    const until = sync.guideAhead().get(source.id);
    assert.ok(until - Date.now() < 36 * 3600e3);
    // A full guide again ends the episode; the next shortage alerts again.
    state.guideHours = 96;
    await sync.syncSource(source.id, { acceptSmaller: true });
    await sync.checkGuide();
    state.guideHours = 10;
    await sync.syncSource(source.id, { acceptSmaller: true });
    await sync.checkGuide();
    await wait(200);
    assert.equal(state.hooks.length, 1, 'the webhook itself dedupes the same key for an hour');
});

// #61 (0368): Settings' "Last full sync" read "Just now" after every restart, because the start-up check set the time
// even when every source was fresh and nothing synced; and it never said which source. Now the time moves only when
// something synced, and lastSyncs() gives each source's feeds from sync_status (which a restart keeps).
test('#61: a start-up check that synced nothing leaves the last sync time alone; each source\'s feeds are listed', async () => {
    state.guideHours = 96;
    await sync.syncSource(source.id, { acceptSmaller: true });
    sync.lastSyncTime = null;
    await sync.syncIfStale();
    assert.equal(sync.getLastSyncTime(), null, 'every source fresh: nothing synced, so no "Just now"');

    const [one] = await sync.lastSyncs();
    assert.equal(one.name, 'Strong8K');
    assert.deepEqual(one.feeds.map(f => [f.type, f.status]).sort(), [['all', 'success'], ['epg', 'success']]);
    assert.ok(one.feeds.every(f => Date.now() - f.at < 60e3));

    state.guideFails = 1;
    sync.SCHEDULE.retriesMs = [];
    await sync.syncSource(source.id);
    await sync.syncIfStale();
    assert.ok(sync.getLastSyncTime(), 'a check that synced something sets it');
});
