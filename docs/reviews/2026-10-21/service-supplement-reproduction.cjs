// Audit evidence: asserts faulty behavior at a104726; NOT a corrected regression test.
// Uses synthetic HTTP and an isolated SQLite copy. No network/provider/media process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-service-supplement-'));
const originalFetch = global.fetch;
let sqlite;
(async () => {
  fs.cpSync(path.join(root, 'server'), path.join(tmp, 'server'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(tmp, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'));
  sqlite = require(path.join(tmp, 'server/db/sqlite'));
  const fixtures = require(path.join(tmp, 'server/services/sportsFixtures'));
  const classify = require(path.join(tmp, 'server/services/sportsClassify'));
  const fx = name => JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/espn', name + '.json')));
  const now = Date.parse('2026-09-27T12:00Z');
  let partial = false;
  global.fetch = async url => {
    const teams = String(url).includes('/teams');
    if (partial && String(url).includes('dates=20260927')) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => teams ? fx('teams-nfl') : partial ? { events: [] } : fx('nfl-20260927') };
  };
  await fixtures.refreshLeague('NFL', { now });
  const airing = { league: 'NFL', start: Date.parse('2026-09-27T17:00Z'), end: Date.parse('2026-09-27T20:00Z'), parsed: classify.parseTitle('NFL: Chargers v Bills') };
  assert.equal(classify.fixtureVerdict(airing, fixtures.snapshot(new Set(['NFL'])).get('NFL'), now).live, true);
  partial = true;
  await fixtures.refreshLeague('NFL', { now: now + 1000 });
  const after = fixtures.snapshot(new Set(['NFL'])).get('NFL');
  assert.equal(after.fixtures.length, 0);
  const verdict = classify.fixtureVerdict(airing, after, now + 1000);
  assert.equal(verdict.live, false);
  assert.equal(verdict.why, 'ESPN has no such game at this time');
  console.log('REPRODUCED: one failed scoreboard day erases known fixture and classifies it as replay under full coverage.');

  const links = require(path.join(tmp, 'server/services/channelLinks'));
  const rev = require(path.join(tmp, 'server/services/libraryRev'));
  const { VISIBLE_SQL } = require(path.join(tmp, 'server/services/channelNumbers'));
  const db = sqlite.getDb();
  db.prepare("INSERT INTO playlist_items (id,source_id,item_id,type,name,stable_id) VALUES ('1:pos_2',1,'pos_2','live','Channel (Backup)','s2')").run();
  const link = db.prepare("INSERT INTO channel_links (primary_source_id,primary_key,backup_source_id,backup_stream_id,method,status,rank) VALUES (1,'s1',1,'s2','sibling','auto',1)").run().lastInsertRowid;
  const visible = () => db.prepare(`SELECT COUNT(*) AS n FROM playlist_items p WHERE ${VISIBLE_SQL}`).get().n;
  assert.equal(visible(), 0);
  const beforeRev = rev.currentGuideVersion();
  links.setStatus(link, 'rejected');
  assert.equal(visible(), 1);
  assert.equal(rev.currentGuideVersion(), beforeRev);
  console.log('REPRODUCED: rejecting sibling changes guide membership without changing guide version.');

  // Invoke the real fetchAndStore function with an open image body and inspect its timer owner.
  const timers = new Map();
  let timerId = 0, bodyEntered = false;
  const module = { exports: {} };
  const fakeFs = { existsSync: () => true };
  const context = {
    module, __dirname: path.join(root, 'server/routes'), Buffer, AbortController,
    console, setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async () => ({ ok: true, headers: { get: () => 'image/png' }, body: { async *[Symbol.asyncIterator]() { bodyEntered = true; await new Promise(() => {}); } } }),
    require: id => {
      if (id === 'express') return { Router: () => ({ get() {} }) };
      if (id === 'fs') return fakeFs;
      if (id === 'path') return path;
      if (id === 'child_process') return { spawn() { throw Error('unexpected media process'); } };
      if (id === '../db/sqlite') return { getDb() { throw Error('unexpected database access'); } };
      if (id === '../services/logoCache') return { LOGO_CACHE_VERSION: 2 };
      throw Error('Unexpected import ' + id);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server/routes/logo.js'), 'utf8') + '\nmodule.exports._fetchAndStore = fetchAndStore;', context);
  let settled = false;
  module.exports._fetchAndStore({ app: { locals: {} } }, { url: 'https://synthetic.invalid/logo', key: '0'.repeat(32) }).then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(bodyEntered, true);
  assert.equal(timers.size, 0);
  assert.equal(settled, false);
  console.log('REPRODUCED: image body pending after headers, fetch deadline already cleared.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.fetch = originalFetch;
  try { sqlite?.getDb().close(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});
