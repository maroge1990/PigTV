const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FakeEvent } = require('./helpers/fakeDom');
const { browser, answer, page } = require('./helpers/sportWeb');

// #323 review of step 1 (medium): the game's menu gives focus back to its card when it closes, also when a poll has
// redrawn the page meanwhile (the card is a new element: it is found again by its data-key), and when Tab closes it.
async function harness() {
    const front = answer();
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? front : url === '/sports/pages/preferences' ? { spoilerFree: false } : new Promise(() => {})) });
    const p = page(b, {});
    await p.show('');
    const card = () => { const el = b.document.createElement('button'); el.setAttribute('data-key', 'card:test'); p.root.appendChild(el); return el; };
    return { b, p, card, menu: () => b.document.body.querySelector('.sp-menu') };
}
const key = (el, k) => el.dispatchEvent(new FakeEvent('keydown', { key: k }));

for (const k of ['Escape', 'Tab']) {
    test(`${k} after a redraw: focus goes to the card as the page now draws it`, async () => {
        const h = await harness();
        const old = h.card();
        h.p.select('nxt', old);
        assert.ok(h.menu());
        old.remove();                // a poll redrew the page: the card is a new element with the same data-key
        const fresh = h.card();
        key(h.menu(), k);
        assert.equal(h.menu(), null, `${k} closes it`);
        assert.equal(h.b.document.activeElement, fresh, 'focus is on the redrawn card');
        assert.equal(fresh.getAttribute('aria-expanded'), 'false');
    });
}

test('Tab without a redraw also gives focus back to the card', async () => {
    const h = await harness();
    const el = h.card();
    h.p.select('nxt', el);
    key(h.menu(), 'Tab');
    assert.equal(h.b.document.activeElement, el);
});
