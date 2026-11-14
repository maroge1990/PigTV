'use strict';
// #327 (Mark, 15 Nov 2026): a sport's card rail stays one row; on a wide window ‹ › buttons at its ends scroll it about a
// page of cards, shown only while the row runs on past that end, 44 px, keyboard reachable and labelled, on hover and focus
// with a mouse and always on a touch screen. A phone keeps its swipe rows, with no buttons.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browser, answer, ctx, page } = require('./helpers/sportWeb');
const { rulesFor } = require('./helpers/sportCss');

test('a wide front page draws ‹ › around each league rail, hidden until the page measures it; a phone draws none', () => {
    const { V } = browser();
    const html = V.front(ctx(V, answer()));
    assert.match(html, /<div class="rail-wrap"><button type="button" class="rail-arrow prev" data-act="rail-prev" data-key="rail-prev:EPL" aria-label="Earlier games, Premier League" hidden><svg[\s\S]*?<\/button><div class="rail" data-rail="EPL">/);
    assert.match(html, /<button type="button" class="rail-arrow next" data-act="rail-next" data-key="rail-next:EPL" aria-label="More games, Premier League" hidden>/);
    const phone = V.front(ctx(V, answer(), { phone: true }));
    assert.doesNotMatch(phone, /rail-arrow/);
});

test('the tennis page\'s rails have them too', () => {
    const { V } = browser();
    const evs = [{ id: 'ao', name: 'Australian Open', matches: [1, 2, 3].map(i => ({ id: `m${i}`, status: 'live', start: 0, players: [{ name: `A${i}` }, { name: `B${i}` }] })) }];
    const html = V.tennisHtml(evs, ctx(V, answer(), { now: 1000 }));
    assert.match(html, /aria-label="More games, Live now" hidden>/);
    assert.doesNotMatch(V.tennisHtml(evs, ctx(V, answer(), { now: 1000, phone: true })), /rail-arrow/);
});

function rig(b, { scrollWidth, clientWidth, scrollLeft = 0 }) {
    const d = b.document;
    const wrap = d.createElement('div'); wrap.className = 'rail-wrap';
    const prev = d.createElement('button'); prev.className = 'rail-arrow prev'; prev.hidden = true;
    const rail = d.createElement('div'); rail.className = 'rail';
    const next = d.createElement('button'); next.className = 'rail-arrow next'; next.hidden = true;
    for (let i = 0; i < 8; i++) { const c = d.createElement('div'); c.offsetWidth = 260; const card = d.createElement('button'); card.setAttribute('data-act', 'game'); c.appendChild(card); rail.appendChild(c); }
    rail.firstElementChild = rail.children[0];
    Object.assign(rail, { scrollWidth, clientWidth, scrollLeft });
    wrap.append(prev, rail, next);
    return { wrap, prev, rail, next };
}

test('each button shows only while the row runs on past its end', () => {
    const b = browser();
    const p = page(b);
    const r = rig(b, { scrollWidth: 2200, clientWidth: 1000 });
    p.root.appendChild(r.wrap);
    p.updateRails();
    assert.deepEqual([r.prev.hidden, r.next.hidden], [true, false], 'at the start: only ›');
    r.rail.scrollLeft = 600; p.updateRail(r.rail);
    assert.deepEqual([r.prev.hidden, r.next.hidden], [false, false], 'in the middle: both');
    r.rail.scrollLeft = 1200; p.updateRail(r.rail);
    assert.deepEqual([r.prev.hidden, r.next.hidden], [false, true], 'at the end: only ‹');
    r.rail.scrollWidth = 1000; r.rail.scrollLeft = 0; p.updateRail(r.rail);
    assert.deepEqual([r.prev.hidden, r.next.hidden], [true, true], 'a row that fits: none');
});

test('a scroll of the row moves its buttons (the page listens for it)', () => {
    const b = browser();
    const p = page(b);
    const r = rig(b, { scrollWidth: 2200, clientWidth: 1000 });
    p.root.appendChild(r.wrap);
    r.rail.scrollLeft = 1200;
    r.rail.dispatchEvent(new (require('./helpers/fakeDom').FakeEvent)('scroll'));
    assert.equal(r.next.hidden, true);
});

test('› scrolls about a page of whole cards, smoothly; with reduced motion at once', () => {
    for (const reduce of [false, true]) {
        const b = browser();
        b.context.matchMedia = (q) => ({ matches: reduce && /reduced-motion/.test(q), addEventListener() {} });
        b.context.window.matchMedia = b.context.matchMedia;
        const p = page(b);
        const r = rig(b, { scrollWidth: 2200, clientWidth: 1000 });
        p.root.appendChild(r.wrap);
        const asked = [];
        r.rail.scrollBy = (o) => asked.push(o);
        p.act('rail-next', r.next);
        p.act('rail-prev', r.prev);
        assert.deepEqual(JSON.parse(JSON.stringify(asked)), [{ left: 816, behavior: reduce ? 'auto' : 'smooth' }, { left: -816, behavior: reduce ? 'auto' : 'smooth' }],
            'three whole 260 px cards and their 12 px gaps');
    }
});

test('a focused button that reaches its end hands focus to the other one', () => {
    const b = browser();
    const p = page(b);
    const r = rig(b, { scrollWidth: 2200, clientWidth: 1000, scrollLeft: 600 });
    p.root.appendChild(r.wrap);
    p.updateRail(r.rail);
    r.next.focus();
    r.rail.scrollLeft = 1200; p.updateRail(r.rail);
    assert.equal(r.next.hidden, true);
    assert.equal(b.document.activeElement, r.prev);
});

test('on a phone the buttons never show', () => {
    const b = browser();
    b.context.matchMedia = () => ({ matches: true, addEventListener() {} });
    b.context.window.matchMedia = b.context.matchMedia;
    const p = page(b);
    const r = rig(b, { scrollWidth: 2200, clientWidth: 1000 });
    p.root.appendChild(r.wrap);
    p.updateRails();
    assert.deepEqual([r.prev.hidden, r.next.hidden], [true, true]);
});

test('44 px targets, shown on hover and focus, always on a touch screen, gone on a phone', () => {
    assert.match(rulesFor('.sp .rail-arrow'), /width:\s*44px/);
    assert.match(rulesFor('.sp .rail-arrow'), /height:\s*44px/);
    assert.match(rulesFor('.sp .rail-arrow'), /opacity:\s*0/);
    assert.match(rulesFor('.sp .rail-wrap:hover .rail-arrow'), /opacity:\s*1/);
    assert.match(rulesFor('.sp .rail-arrow:focus-visible'), /opacity:\s*1/);
    assert.match(rulesFor('.sp .rail-arrow', { media: 'any-pointer: coarse' }), /opacity:\s*1/);
    assert.match(rulesFor('.sp .rail-arrow[hidden]'), /display:\s*none/);
    assert.match(rulesFor('.sp.is-phone .rail-arrow'), /display:\s*none/);
});
