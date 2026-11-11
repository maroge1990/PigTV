const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument, FakeEvent } = require('./helpers/fakeDom');

// #276: the "⋯" menu (UI.menu in ui.js) on the Recordings page's cards: a button that says it opens a menu, items in the
// menu role, opened by click (Enter and Space click a button) or the arrow keys, arrows move, Escape and a click outside
// close it and give focus back to the button. Where it sits on screen needs a browser (T3).

function browser() {
    const document = createDocument();
    const context = vm.createContext({ console, document, setTimeout, clearTimeout, localStorage: { getItem: () => null } });
    context.window = context;
    loadUi(context);
    const UI = vm.runInContext('UI', context);
    const button = document.createElement('button');
    document.body.appendChild(button);
    const ran = [];
    UI.menu.attach(button, () => [
        { label: 'Download', href: '/api/recordings/1/download', download: true },
        { label: 'Compress', run: () => ran.push('compress') },
        { label: 'Delete', run: () => ran.push('delete'), danger: true }
    ], { label: 'More for News' });
    const menu = () => document.body.querySelector('.ui-menu');
    const items = () => menu().querySelectorAll('[role=menuitem]');
    const key = (el, k) => el.dispatchEvent(new FakeEvent('keydown', { key: k }));
    return { UI, document, button, menu, items, key, ran };
}

test('the button says it opens a menu and whether it is open', () => {
    const { button, menu } = browser();
    assert.equal(button.getAttribute('aria-haspopup'), 'menu');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(menu(), null, 'nothing drawn until it opens');
    button.click();
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(menu().getAttribute('role'), 'menu');
    assert.equal(menu().getAttribute('aria-label'), 'More for News');
});

test('items are menuitems in order, Delete styled as the destructive one, Download a real link', () => {
    const { button, items, document } = browser();
    button.click();
    assert.deepEqual(items().map(i => i.textContent), ['Download', 'Compress', 'Delete']);
    assert.equal(items()[0].tagName, 'A');
    assert.equal(items()[0].href, '/api/recordings/1/download');
    assert.ok(items()[2].classList.contains('is-danger'));
    assert.ok(!items()[1].classList.contains('is-danger'));
    assert.equal(document.activeElement, items()[0], 'focus goes to the first item');
});

test('arrows move (and wrap), Home and End jump; Escape closes and focus returns to the button', () => {
    const { button, items, key, menu, document } = browser();
    button.click();
    key(document.activeElement, 'ArrowDown');
    assert.equal(document.activeElement, items()[1]);
    key(document.activeElement, 'ArrowDown');
    key(document.activeElement, 'ArrowDown');
    assert.equal(document.activeElement, items()[0], 'wraps');
    key(document.activeElement, 'ArrowUp');
    assert.equal(document.activeElement, items()[2]);
    key(document.activeElement, 'Home');
    assert.equal(document.activeElement, items()[0]);
    key(document.activeElement, 'End');
    assert.equal(document.activeElement, items()[2]);
    key(document.activeElement, 'Escape');
    assert.equal(menu(), null);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, button);
});

test('ArrowDown on the button opens it; choosing an item closes the menu first, then runs it', () => {
    const { button, items, key, menu, document, ran } = browser();
    key(button, 'ArrowDown');
    assert.ok(menu());
    assert.equal(document.activeElement, items()[0]);
    items()[2].click();
    assert.equal(menu(), null);
    assert.deepEqual(ran, ['delete']);
    assert.equal(document.activeElement, button);
});

test('a click outside closes it and gives focus back; a second click on the button closes it', () => {
    const { button, menu, document } = browser();
    button.click();
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    document.dispatchEvent(new FakeEvent('pointerdown', { target: elsewhere }));
    assert.equal(menu(), null);
    assert.equal(document.activeElement, button);
    button.click();
    assert.ok(menu());
    button.click();
    assert.equal(menu(), null);
});

test('only one menu is open at a time', () => {
    const { UI, button, document } = browser();
    const other = document.createElement('button');
    document.body.appendChild(other);
    UI.menu.attach(other, () => [{ label: 'Delete', run() {} }]);
    button.click();
    other.click();
    assert.equal(document.body.querySelectorAll('.ui-menu').length, 1);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(UI.menu.isOpen(), true);
    UI.menu.close();
    assert.equal(UI.menu.isOpen(), false);
});
