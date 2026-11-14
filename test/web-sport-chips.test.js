'use strict';
// #326: a league page's round, standings-view and table-group chips are iOS's GuideFilterStyle: a raised capsule with
// no border; the selected one the accent tint (14 %, --sel) with accent text and a 26 x 3 accent bar at the bottom,
// not a solid pink fill with dark text. The phone's league chips already were.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rulesFor } = require('./helpers/sportCss');

test('a chip: raised, no border', () => {
    const r = rulesFor('.sp .fchip');
    assert.match(r, /background:\s*var\(--raised\)/);
    assert.match(r, /border:\s*0/);
});

test('the selected chip: the tint, accent text and the underline bar; never the solid accent fill', () => {
    const on = rulesFor('.sp .fchip.on');
    assert.match(on, /background:\s*var\(--sel\)/);
    assert.match(on, /color:\s*var\(--color-accent-text\)/);
    assert.doesNotMatch(on, /background:\s*var\(--color-accent\)|--color-on-accent/);
    const bar = rulesFor('.sp .fchip.on::after');
    assert.match(bar, /width:\s*26px/);
    assert.match(bar, /height:\s*3px/);
    assert.match(bar, /background:\s*var\(--color-accent\)/);
});
