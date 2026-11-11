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

// #276: one date format for the web app: weekday, day and month, the year only when it is not this year, no seconds,
// the en-dash for a range; 12- or 24-hour from the locale. Fixed locale, zone and "now" so no test depends on the machine.
const AU = { locale: 'en-AU', timeZone: 'Australia/Sydney', now: Date.UTC(2026, 10, 11, 1, 0) };
const plain = (s) => s.replace(/[\u00a0\u202f]/g, ' ');

test('UI.dateTime: "Sat 7 Nov, 3:50 am"; the year only when it is not this year; nothing for a bad date', () => {
    assert.equal(plain(UI.dateTime(Date.UTC(2026, 10, 6, 16, 50, 42), AU)), 'Sat 7 Nov, 3:50 am');
    assert.equal(plain(UI.dateTime(new Date(Date.UTC(2026, 10, 7, 12, 5)), AU)), 'Sat 7 Nov, 11:05 pm', 'a Date works too');
    assert.equal(plain(UI.dateTime(Date.UTC(2025, 0, 3, 0, 0), AU)), 'Fri 3 Jan 2025, 11:00 am');
    assert.equal(plain(UI.dateTime(Date.UTC(2026, 10, 6, 16, 50), { ...AU, locale: 'en-GB' })), 'Sat 7 Nov, 03:50', '24-hour locale');
    assert.equal(UI.dateTime(NaN, AU), '');
    assert.equal(UI.dateTime(undefined, AU), '');
});

test('UI.dateRange: one day once, a shared am/pm once, the en-dash; a range over midnight names both days', () => {
    const at = (d, h, m) => Date.UTC(2026, 10, d, h, m);   // UTC; Sydney is UTC+11 in November
    assert.equal(plain(UI.dateRange(at(6, 16, 50), at(6, 18, 30), AU)), 'Sat 7 Nov, 3:50 – 5:30 am');
    assert.equal(plain(UI.dateRange(at(7, 0, 30), at(7, 2, 0), AU)), 'Sat 7 Nov, 11:30 am – 1:00 pm');
    assert.equal(plain(UI.dateRange(at(7, 12, 30), at(7, 14, 0), AU)), 'Sat 7 Nov, 11:30 pm – Sun 8 Nov, 1:00 am');
    assert.equal(plain(UI.dateRange(at(6, 16, 50), at(6, 18, 30), { ...AU, locale: 'en-GB' })), 'Sat 7 Nov, 03:50 – 05:30');
    assert.equal(plain(UI.dateRange(at(6, 16, 50), undefined, AU)), 'Sat 7 Nov, 3:50 am', 'no end: the start alone');
    assert.match(UI.dateRange(at(6, 16, 50), at(6, 18, 30), AU), /\u2013/);
    assert.doesNotMatch(UI.dateRange(at(6, 16, 50), at(6, 18, 30), AU), /:\d\d:\d\d/, 'no seconds');
});

test('UI.clock: hours and minutes as dateTime writes them ("10:15 pm")', () => {
    assert.equal(plain(UI.clock(Date.UTC(2026, 10, 11, 11, 15), AU)), '10:15 pm');
});
