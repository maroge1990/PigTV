const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 0494 (Mark, 8 Nov: "we should always use segmented"): every recording is segmented. It resumes after a container stop
// (#246) or a failover, and can be watched from the start. Before 0494 it was a switch, off by default and on the web.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-segalways-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.cpSync(path.join(__dirname, '../package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
process.env.PIGTV_DB_BACKUPS = '0';

const db = require(path.join(sandbox, 'server', 'db'));
const sqlite = require(path.join(sandbox, 'server', 'db', 'sqlite'));

after(() => {
    try { sqlite.getDb().close(); } catch { /* closed */ }
    try { fs.rmdirSync(path.join(sandbox, 'node_modules')); } catch { /* gone */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
});

test('0494: a stored "off" is dropped once, and no later write or stored value turns segmenting off', async () => {
    const raw = sqlite.getDb();
    raw.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('segmentedRecordings', 'false')`).run();
    assert.equal((await db.settings.get()).segmentedRecordings, true, 'on, whatever an older build stored');
    assert.ok(raw.prepare(`SELECT value FROM meta WHERE key = 'segmented_always'`).get(), 'done once, remembered');
    // 0494 Codex round 1 (high): an old settings page, or a restored backup, sending "off" changes nothing.
    await db.settings.update({ segmentedRecordings: false, minFreeSpaceGB: 3 });
    assert.equal((await db.settings.get()).segmentedRecordings, true);
    assert.equal((await db.settings.get()).minFreeSpaceGB, 3, 'the rest of the change is saved');
    raw.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('segmentedRecordings', 'false')`).run();
    await db.settings.update({ minFreeSpaceGB: 4 }); // a write rebuilds what get() hands out
    assert.equal((await db.settings.get()).segmentedRecordings, true, 'a stored "off" never counts');
});

test('0494: the web no longer offers the switch', () => {
    const root = path.join(__dirname, '..', 'public');
    assert.ok(!fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('dvr-setting-segmented'));
    assert.ok(!fs.readFileSync(path.join(root, 'js', 'pages', 'Settings.js'), 'utf8').includes('segmentedRecordings'));
});
