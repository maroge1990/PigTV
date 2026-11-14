const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #322 (Mark, 14 Nov 2026): the hardware encoder, GPU decode, CPU scale and User-Agent controls are in one Advanced
// block under Settings → Playback, shown only to admins. They keep working; a viewer never sees them.
const read = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const CONTROLS = ['setting-hw-encoder', 'setting-vaapi-hw-decode', 'setting-vaapi-cpu-scale', 'setting-user-agent-tc',
    'setting-user-agent-custom-tc'];

test('the Advanced block holds the encoder, decoding, scaling and User-Agent controls, and starts hidden', () => {
    const html = read('index.html');
    const open = html.match(/<details [^>]*id="transcode-advanced"[^>]*>/);
    assert.ok(open, 'the block is there');
    assert.match(open[0], /\bhidden\b/, 'hidden until the page knows the user is an admin');
    const start = html.indexOf(open[0]);
    const block = html.slice(start, html.indexOf('</details>', start));
    for (const id of CONTROLS) {
        assert.match(block, new RegExp(`id="${id}"`), `${id} is in the block`);
        assert.equal(html.split(`id="${id}"`).length, 2, `${id} appears once`);
    }
});

function page(role) {
    const advanced = { hidden: true };
    const ctx = vm.createContext({ console, document: { getElementById: (id) => (id === 'transcode-advanced' ? advanced : null) } });
    ctx.window = ctx;
    require('./helpers/webUi').loadUi(ctx);
    vm.runInContext(read('js/pages/Settings.js'), ctx);
    const p = Object.create(ctx.SettingsPage.prototype);
    p.app = { currentUser: { role } };
    return { p, advanced };
}

test('only an admin is shown the Advanced block', () => {
    const viewer = page('viewer');
    viewer.p.showAdminOnly();
    assert.equal(viewer.advanced.hidden, true);
    const admin = page('admin');
    admin.p.showAdminOnly();
    assert.equal(admin.advanced.hidden, false);
    assert.match(read('js/pages/Settings.js'), /this\.showAdminOnly\(\);/, 'show() applies it');
});
