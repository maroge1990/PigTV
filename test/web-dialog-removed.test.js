const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { createDocument } = require('./helpers/fakeDom');

// #292 (4): a dialog taken out of the page without close() must not leave the page unscrollable or hide later notices.
test('a dialog removed from the page without close() releases the scroll lock and later notices show on the page', () => {
    const document = createDocument();
    const context = vm.createContext({
        console: { ...console, log() {}, warn() {}, error() {} },
        document, setTimeout, clearTimeout, setInterval: () => 7, clearInterval() {},
        localStorage: { getItem: () => 'tok' }, CSS: { escape: (s) => s }
    });
    context.window = context;
    loadUi(context, { realToast: true });
    const UI = vm.runInContext('UI', context);
    const d = UI.dialog.create({ title: 'Gone' });
    d.open();
    const el = document.body.querySelectorAll('dialog')[0];
    assert.ok(document.body.classList.contains('ui-dialog-open'));
    el.remove(); // no close(): no close event
    UI.toast('After');
    const host = document.body.querySelector('.ui-toast-host');
    assert.equal(host.parentNode, document.body, 'the notices are back on the page, not inside the removed dialog');
    assert.ok(!document.body.classList.contains('ui-dialog-open'), 'the page scrolls again');
});
