const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('installation signing key persists, is private and never silently rotates on corruption', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-key-'));
    const env = { ...process.env };
    delete env.JWT_SECRET;
    try {
        fs.mkdirSync(path.join(directory, 'server'));
        fs.copyFileSync(path.join(__dirname, '../server/authSecret.js'), path.join(directory, 'server/authSecret.js'));
        const read = overrides => execFileSync(process.execPath, ['-e', "process.stdout.write(require('./server/authSecret'))"],
            { cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const first = read();
        assert.match(first, /^[a-f0-9]{96}$/);
        assert.equal(read(), first);
        const filename = path.join(directory, 'data/auth-secret');
        if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
        assert.equal(read({ JWT_SECRET: 'explicit-private-key-for-test-only-12345' }), 'explicit-private-key-for-test-only-12345');
        assert.equal(read(), first, 'environment override must not overwrite persisted key');
        assert.throws(() => read({ JWT_SECRET: 'pigtv-secret-key-change-in-production' }));
        assert.throws(() => read({ JWT_SECRET: 'short' }));
        fs.writeFileSync(filename, 'corrupt');
        assert.throws(() => read());
        assert.equal(fs.readFileSync(filename, 'utf8'), 'corrupt');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
