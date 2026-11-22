const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// #45 (0898): the last lines the server logged, for an admin to read in the web app instead of `docker logs`. Each line
// is redacted before it is kept, so the ring never holds a login. On 0897 there is no logRing module.
const MODULE = path.join(__dirname, '../server/services/logRing.js');
const SECRET = 'hunter2secret';
const LEAKY = `resolve failed: http://viewer:${SECRET}@provider.invalid/live/viewer/${SECRET}/441360.ts?token=${SECRET}&x=1`;

test('a logged credential never enters the ring: user:pass, path logins and a token query are redacted first', () => {
    const ring = require(MODULE).createRing();
    ring.push('error', [LEAKY]);
    ring.push('log', ['[Sync] %s failed after %d ms', `http://provider.invalid/get.php?username=viewer&password=${SECRET}`, 42]);
    const lines = ring.since(0);
    assert.equal(lines.length, 2);
    assert.match(lines[0].text, /^resolve failed: /);
    assert.equal(lines[0].level, 'error');
    assert.match(lines[1].text, /^\[Sync\] .* failed after 42 ms$/, 'formatted as console formats it');
    for (const l of lines) {
        assert.ok(!l.text.includes(SECRET), l.text);
        assert.ok(!l.text.includes('provider.invalid'), l.text);
    }
});

test('the ring keeps the newest N lines, caps each line, and `since` returns only newer ones, newest last', () => {
    const { createRing, CAP, MAX_LINE } = require(MODULE);
    assert.equal(CAP, 2000);
    assert.ok(MAX_LINE >= 200 && MAX_LINE <= 2000);
    const ring = createRing({ cap: 5, maxLine: 20 });
    for (let i = 1; i <= 8; i++) ring.push('log', [`line ${i}`]);
    assert.deepEqual(ring.since(0).map(l => l.text), ['line 4', 'line 5', 'line 6', 'line 7', 'line 8']);
    const cursor = ring.since(0)[2].seq;
    assert.deepEqual(ring.since(cursor).map(l => l.text), ['line 7', 'line 8']);
    assert.deepEqual(ring.since(ring.since(0).at(-1).seq), []);
    ring.push('log', ['x'.repeat(500)]);
    assert.ok(ring.since(0).at(-1).text.length <= 21, 'one long line is cut');
    // A long line is redacted before it is cut, so a cut can never leave half a login behind.
    const r2 = createRing({ cap: 5, maxLine: 60 });
    r2.push('log', [LEAKY]);
    assert.ok(!r2.since(0)[0].text.includes(SECRET));
    assert.ok(!r2.since(0)[0].text.includes('hunter2'));
});

test('installing the ring leaves what goes to stdout and stderr exactly as before', () => {
    const code = `
        const before = ${JSON.stringify(['plain line', 'warned line'])};
        const ring = require(${JSON.stringify(MODULE)}).install();
        console.log(before[0], 42);
        console.warn(before[1]);
        console.error(${JSON.stringify(LEAKY)});
        process.stdout.write(JSON.stringify(ring.since(0).map(l => l.text)) + '\\n');
    `;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.split('\n');
    assert.equal(out[0], 'plain line 42');
    assert.equal(r.stderr, `warned line\n${LEAKY}\n`, 'stderr unchanged (the source of a line redacts it, not the ring)');
    const kept = JSON.parse(out[1]);
    assert.deepEqual(kept.slice(0, 2), ['plain line 42', 'warned line']);
    assert.ok(!kept[2].includes(SECRET));
});

test('review of 0898: a Bearer header, an object with a password and an Error with request extras never enter the ring', () => {
    const ring = require(MODULE).createRing();
    ring.push('log', [`request headers: Authorization: Bearer eyJ${SECRET}.abc`]);
    ring.push('log', ['headers', { authorization: `Bearer ${SECRET}`, cookie: `sid=${SECRET}` }]);
    ring.push('error', [{ username: 'owner', password: SECRET, nested: { access_token: SECRET, refresh_token: SECRET } }]);
    const err = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
        body: `{"username":"owner","password":"${SECRET}"`, type: 'entity.parse.failed',
        headers: { authorization: `Basic ${SECRET}` }, config: { auth: { password: SECRET } }, request: { secret: SECRET }
    });
    ring.push('error', ['Server error:', err]);
    ring.push('log', [`raw: {"user":"owner","passwd":"${SECRET}","api_key":"${SECRET}"} Cookie: a=${SECRET}; b=${SECRET}`]);
    const text = JSON.stringify(ring.since(0));
    assert.ok(!text.includes(SECRET), text);
    assert.match(ring.since(0)[3].text, /SyntaxError: Unexpected end of JSON input/, 'the error itself is still there');
    assert.ok(!ring.since(0)[3].text.includes('entity.parse.failed'), 'but none of its extras');
});
