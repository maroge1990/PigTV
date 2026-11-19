'use strict';
// #347 (Codex, Apple batch sign-off): POST /recordings/schedule refuses, 409 `cancelling` (C-M), an airing whose
// recording is still being cancelled (begun after the page's own check at the press): "Cancelling…" on that airing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { browser, answer, page } = require('./helpers/sportWeb');


const refusal = (code, error) => Object.assign(new Error(error), { status: 409, code, scheduleId: 9 });
const CANCELLING = refusal('cancelling', 'That recording is still being cancelled. Try again in a moment.');

async function harness(fail) {
    const calls = [];
    const f = answer();
    const nxt = f.games.find(g => g.id === 'nxt');
    delete nxt.recording;
    const b = browser({ request: async (m, url, body) => {
        calls.push([m, url, body]);
        if (url === '/recordings/scheduled') return []; // nothing being cancelled when the page checks
        return url === '/sports/front' ? f : url === '/sports/pages/preferences' ? { spoilerFree: false } : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d]); throw fail; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
    const save = () => b.document.body.querySelector('dialog [data-act="r-save"]');
    const body = () => b.document.body.querySelector('dialog .ui-dialog-body')?.innerHTML || '';
    return { b, p, f, calls, settle, save, body };
}

test('#347: the cancel begins between the page\'s check and the POST: More options shows Cancelling… and why; a new answer clears it', async () => {
    const h = await harness(CANCELLING);
    h.p.act('record-options', { getAttribute: (k) => ({ 'data-id': 'nxt' })[k] ?? null });
    h.save().click();
    await h.settle();
    assert.equal(h.calls.filter(c => c[0] === 'schedule').length, 1, 'the POST was sent and refused');
    assert.deepEqual([h.save().textContent, !!h.save().disabled], ['Cancelling…', true]);
    assert.match(h.body(), /class="rerr" role="alert">A recording of this is being cancelled\./);
    await h.p.refresh(); await h.settle(); // the next answer: no cancel any more
    assert.deepEqual([h.save().textContent, !!h.save().disabled], ['Record game', false]);
});

test('#347: Record this game refused as cancelling says so (not a failure) and refreshes', async () => {
    const h = await harness(CANCELLING);
    const fronts = () => h.calls.filter(c => c[1] === '/sports/front').length, before = fronts();
    await h.p.record('nxt');
    await h.settle();
    assert.equal(h.b.context.toasts.at(-1)[0], 'A recording of this is being cancelled. You can record it again once that has finished.');
    assert.ok(fronts() > before, 'refreshed');
});

test('#347: API.request carries a refusal\'s code and schedule id', async () => {
    const ctx = vm.createContext({ console: { ...console, log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => 'tok', removeItem() {}, setItem() {} },
        fetch: async () => ({ ok: false, status: 409, headers: { get: () => 'application/json' },
            json: async () => ({ error: 'That recording is still being cancelled. Try again in a moment.', code: 'cancelling', scheduleId: 9 }) }) });
    ctx.window = ctx;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8'), ctx);
    const err = await ctx.API.request('POST', '/recordings/schedule', {}).then(() => null, (e) => e);
    assert.deepEqual([err.status, err.code, err.scheduleId, err.message], [409, 'cancelling', 9, 'That recording is still being cancelled. Try again in a moment.']);
});
