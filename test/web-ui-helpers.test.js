const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const UI = require('../public/js/ui.js');

// #275: one HTML escape, one clock-time format, one trailing debounce, in public/js/ui.js (window.UI).

test('UI.escape: the five characters, quotes included; null and undefined are empty; 0 and false print', () => {
    const table = [
        ['a & b', 'a &amp; b'], ['<b>', '&lt;b&gt;'], ['say "hi"', 'say &quot;hi&quot;'], ["O'Brien", 'O&#39;Brien'],
        ['<img src="x" onerror=\'y()\'>&', '&lt;img src=&quot;x&quot; onerror=&#39;y()&#39;&gt;&amp;'],
        ['&amp;', '&amp;amp;'], ['', ''], [null, ''], [undefined, ''], [0, '0'], [false, 'false'], [12, '12'], ['plain', 'plain']
    ];
    for (const [input, expected] of table) assert.equal(UI.escape(input), expected, String(input));
});

test('UI.time: hours and minutes in the viewer\'s locale, from a Date, a number or a string', () => {
    const d = new Date(2026, 10, 10, 19, 5, 42);
    const expected = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    assert.equal(UI.time(d), expected);
    assert.equal(UI.time(d.getTime()), expected);
    assert.equal(UI.time(d.toISOString()), expected);
    assert.doesNotMatch(UI.time(d), /42/, 'no seconds');
});

test('UI.debounce: one trailing call with the last arguments, after the quiet period', async () => {
    const calls = [];
    const f = UI.debounce((...a) => calls.push(a), 1000);
    f(1); f(2); f(3);
    assert.deepEqual(calls, []);
    await new Promise((r) => setTimeout(r, 600));
    f(4);
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(calls, [], 'a call inside the window restarts it');
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(calls, [[4]]);
    f(5);
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(calls, [[4], [5]], 'it works again after firing');
});

test('ui.js is a plain global in a page context', () => {
    const ctx = vm.createContext({ window: {} });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/ui.js'), 'utf8'), ctx);
    assert.equal(ctx.window.UI.escape('<'), '&lt;');
    assert.match(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), /api\.js[^\n]*\n\s*<script src="\/js\/ui\.js"><\/script>/);
});

test('no file under public/js except ui.js defines its own HTML escape', () => {
    const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory()
        ? (d.name === 'vendor' ? [] : files(path.join(dir, d.name))) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);
    const root = path.join(__dirname, '../public/js');
    const own = files(root).filter((f) => path.basename(f) !== 'ui.js')
        .filter((f) => /\.replace\(\/&\/g|&amp;/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
    assert.deepEqual(own, []);
});
