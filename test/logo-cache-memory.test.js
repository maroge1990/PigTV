const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sqlCount } = require('./helpers/sqlCount');

// #273 I-2: a library/guide read must not re-register logos it already knows:
// a known URL costs a Map lookup, not a hash, an INSERT or a write transaction.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-logo-mem-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'), 'junction');
process.chdir(sandbox);

const load = p => require(path.join(sandbox, 'server', p));
const sqlite = load('db/sqlite');
const logo = load('services/logoCache');

let c;
before(() => {
    // Installed before the first registerLogo, so its INSERT statement is counted.
    c = sqlCount(sqlite.getDb());
});
after(() => {
    c.restore();
    try { sqlite.getDb().close(); } catch {}
    fs.rmSync(sandbox, { recursive: true, force: true });
});

const items = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: i, logo: `https://logos.example/${tag}/${i}.png` }));
const rows = () => new Set(sqlite.getDb().prepare('SELECT key FROM logo_cache').all().map(r => r.key));

test('applyLogoCache on a page it has seen runs no statement and opens no transaction', () => {
    logo._resetMemory?.();
    const first = items(500, 'a');
    logo.applyLogoCache(first);
    assert.equal(c.runs(/INSERT/), 500);
    c.reset();
    const second = items(500, 'a');
    logo.applyLogoCache(second);
    assert.equal(c.executions(), 0, 'no statement');
    assert.equal(c.prepares(), 0);
    assert.equal(c.transactions(), 0, 'no transaction');
    assert.deepEqual(second, first);
});

test('registerLogo for a known URL runs no statement the second time', () => {
    const url = 'https://logos.example/single.png';
    const a = logo.registerLogo(url);
    c.reset();
    const b = logo.registerLogo(url);
    assert.equal(b, a);
    assert.equal(c.executions(), 0);
    assert.equal(c.transactions(), 0);
});

test('one new URL among 499 known ones: one insert, one transaction', () => {
    logo._resetMemory?.();
    logo.applyLogoCache(items(499, 'b'));
    c.reset();
    const page = [...items(499, 'b'), { id: 'new', logo: 'https://logos.example/b/new.png' }];
    logo.applyLogoCache(page);
    assert.equal(c.runs(/INSERT/), 1);
    assert.equal(c.transactions(), 1);
    assert.equal(page[499].logo, `/api/logo/${logo.keyForUrl('https://logos.example/b/new.png')}`);
});

test('non-http logos and empty logos pass through unchanged', () => {
    const page = [{ logo: '/already/relative.png' }, { logo: null }, { logo: '' }, { logo: 'https://logos.example/mix.png' }];
    logo.applyLogoCache(page);
    assert.equal(page[0].logo, '/already/relative.png');
    assert.equal(page[1].logo, null);
    assert.equal(page[2].logo, '');
    assert.match(page[3].logo, /^\/api\/logo\/[0-9a-f]{32}$/);
});

test('the memory never runs ahead of the table, including after a failed transaction', () => {
    logo._resetMemory?.();
    const db = sqlite.getDb();
    // Fail the page's transaction partway: a trigger rejects the 3rd URL, so
    // the first two inserts roll back with it.
    const page = items(5, 'fail');
    db.exec(`CREATE TRIGGER fail_probe BEFORE INSERT ON logo_cache WHEN NEW.url LIKE '%/fail/2.png'
             BEGIN SELECT RAISE(ABORT, 'disk I/O error (test)'); END`);
    try {
        assert.throws(() => logo.applyLogoCache(page), /disk I\/O/);
    } finally { db.exec('DROP TRIGGER fail_probe'); }
    assert.equal(rows().size, 1002, 'the failed page left no rows behind');
    // Nothing from the rolled-back page may be remembered: a retry must insert all five.
    const retry = items(5, 'fail');
    c.reset();
    logo.applyLogoCache(retry);
    assert.equal(c.runs(/INSERT/), 5);
    // And every remembered URL has its row.
    const have = rows();
    for (const it of items(5, 'fail')) assert.ok(have.has(logo.keyForUrl(it.logo)));
    for (const it of [...items(500, 'a'), ...items(499, 'b')]) assert.ok(have.has(logo.keyForUrl(it.logo)));
});
