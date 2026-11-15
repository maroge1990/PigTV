const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadUi } = require('./helpers/webUi');
const { settingsSource } = require('./helpers/settingsPage');

// #64: one save model in Settings. A single switch or list saves when changed; if the save fails, the control goes back
// to the value the server holds and a notice says why and that it is back. Before: a switch flipped back with a notice
// that gave no reason, and a list (encoder, User-Agent, guide refresh) kept the refused value with "Try again".

const refused = (message, status = 400) => Object.assign(new Error(message), { status });

function page({ update }) {
    const els = {};
    const el = (id) => (els[id] ||= {
        id, type: id.includes('encoder') || id.includes('agent') || id.includes('interval') ? 'select-one' : 'checkbox',
        value: '', checked: false, disabled: false, textContent: '', style: {}, listeners: {},
        classList: { toggle() {} },
        addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    });
    const fire = async (id) => {
        // As a browser does: every listener runs at once, and nothing waits for a save (a test's answer may be held).
        (el(id).listeners.change || []).forEach(fn => fn());
        await new Promise(resolve => setImmediate(resolve));
    };
    const sent = [];
    const context = vm.createContext({
        console: { ...console, error() {}, log() {} },
        document: { getElementById: el, querySelectorAll: () => [], addEventListener() {} },
        API: { settings: { update: async (body) => { sent.push(body); return update(body); } } }
    });
    context.window = context;
    loadUi(context);
    vm.runInContext(settingsSource(), context);
    const settings = Object.create(context.window.SettingsPage.prototype);
    class Player { static get LOCAL_KEYS() { return ['arrowKeysChangeChannel']; } async saveSettings() { return { ok: true }; } }
    settings.app = { player: Object.assign(new Player(), { settings: { hwEncoder: 'auto', userAgentPreset: 'chrome', epgRefreshInterval: '24' } }) };
    return { settings, el, fire, sent, toasts: context.toasts };
}

test('a switch whose save is refused goes back and the notice gives the server\'s reason', async () => {
    const { settings, el, fire, toasts } = page({ update: async () => { throw refused('Hardware decoding needs a VAAPI device'); } });
    settings.initHwDecodeSettings();
    el('setting-vaapi-hw-decode').checked = true;
    await fire('setting-vaapi-hw-decode');
    assert.equal(el('setting-vaapi-hw-decode').checked, false, 'back to the saved value');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][0], 'That setting was not saved. Hardware decoding needs a VAAPI device. It is back to how it was.');
    assert.equal(toasts[0][1].kind, 'error');
});

test('a save that never reached the server says so, and the switch is back', async () => {
    const { settings, el, fire, toasts } = page({ update: async () => { throw new TypeError('Failed to fetch'); } });
    settings.initHwDecodeSettings();
    el('setting-warm-next-channel').checked = true;
    await fire('setting-warm-next-channel');
    assert.equal(el('setting-warm-next-channel').checked, false);
    assert.equal(toasts[0][0], 'That setting was not saved: the server could not be reached. It is back to how it was.');
});

test('a list whose save is refused goes back, with the player\'s copy, and says why', async () => {
    const { settings, el, fire, toasts, sent } = page({ update: async () => { throw refused('That encoder is not available on this server'); } });
    settings.initTranscodingSettings();
    el('setting-hw-encoder').value = 'nvenc';
    await fire('setting-hw-encoder');
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ hwEncoder: 'nvenc' }], 'one key, as #9');
    assert.equal(el('setting-hw-encoder').value, 'auto', 'the list shows the saved encoder again');
    assert.equal(settings.app.player.settings.hwEncoder, 'auto', 'the player does not keep the refused one');
    assert.equal(toasts[0][0], 'That setting was not saved. That encoder is not available on this server. It is back to how it was.');
    assert.equal(el('playback-settings-status').textContent, '', 'no "Saved"');

    el('setting-user-agent-tc').value = 'custom';
    await fire('setting-user-agent-tc');
    assert.equal(el('setting-user-agent-tc').value, 'chrome');
    assert.equal(el('custom-user-agent-container-tc').style.display, 'none', 'the custom field it opened is closed again');
});

test('a saved list says Saved and the player keeps what the server saved', async () => {
    const { settings, el, fire, toasts } = page({ update: async (body) => ({ ...body }) });
    settings.updateEpgLastRefreshed = async () => {};
    settings.initPlayerSettings();
    el('epg-refresh-interval').value = '12';
    await fire('epg-refresh-interval');
    assert.equal(settings.app.player.settings.epgRefreshInterval, '12');
    assert.equal(el('playback-settings-status').textContent, 'Saved');
    assert.equal(toasts.length, 0);
});

test('recovery put back after a refused save frees the standby switch again', async () => {
    const { settings, el, fire, toasts } = page({ update: async (body) => { if ('relayEnabled' in body) throw refused('Recovery cannot be turned off while a recording uses it'); return body; } });
    settings.initHwDecodeSettings();
    Object.assign(el('setting-relay-enabled'), { checked: false });
    Object.assign(el('setting-standby-enabled'), { checked: true });
    await fire('setting-relay-enabled');
    assert.equal(el('setting-relay-enabled').checked, true, 'recovery is back on');
    assert.equal(el('setting-standby-enabled').disabled, false, 'so the standby is not greyed out');
    assert.equal(toasts.length, 1, 'one notice: the standby was saved off');
});

// Codex review (medium): each save captured the value before it, and saves of one setting overlapped. auto → nvenc →
// vaapi with vaapi saved and nvenc then refused put the list and the player back to auto while the server held vaapi.
// Now saves of a setting go one at a time, and a failure goes back to the last value the server confirmed.
function deferredUpdate() {
    const waiting = [];
    const update = (body) => new Promise((resolve, reject) => waiting.push({ body, ok: () => resolve({ ...body }), no: (m) => reject(refused(m)) }));
    return { update, waiting };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a later change waits for the earlier save; an earlier failure does not undo a later success', async () => {
    const d = deferredUpdate();
    const { settings, el, fire, toasts } = page({ update: d.update });
    settings.initTranscodingSettings();
    el('setting-hw-encoder').value = 'nvenc'; await fire('setting-hw-encoder');
    el('setting-hw-encoder').value = 'vaapi'; await fire('setting-hw-encoder');
    assert.equal(d.waiting.length, 1, 'the second save is not sent while the first is on its way');
    d.waiting[0].no('nvenc is not available'); await settle();
    assert.equal(el('setting-hw-encoder').value, 'vaapi', 'a newer change is waiting: the list is left alone');
    assert.match(toasts[0][0], /nvenc is not available\.$/, 'it says the earlier one failed, not that the list is back');
    assert.equal(d.waiting.length, 2);
    d.waiting[1].ok(); await settle();
    assert.equal(el('setting-hw-encoder').value, 'vaapi');
    assert.equal(settings.app.player.settings.hwEncoder, 'vaapi', 'the player keeps what the server holds');
    assert.equal(toasts.length, 1);
});

test('a later failure goes back to the last confirmed value, never to one from before a success', async () => {
    const d = deferredUpdate();
    const { settings, el, fire, toasts } = page({ update: d.update });
    settings.initTranscodingSettings();
    el('setting-hw-encoder').value = 'nvenc'; await fire('setting-hw-encoder');
    el('setting-hw-encoder').value = 'vaapi'; await fire('setting-hw-encoder');
    d.waiting[0].ok(); await settle();
    d.waiting[1].no('vaapi is not available'); await settle();
    assert.equal(el('setting-hw-encoder').value, 'nvenc', 'back to the saved nvenc, not to auto');
    assert.equal(settings.app.player.settings.hwEncoder, 'nvenc');
    assert.match(toasts[0][0], /It is back to how it was\.$/);
});

test('two failures in a row go back to the value the server held, not to the first refused one', async () => {
    const d = deferredUpdate();
    const { settings, el, fire, toasts } = page({ update: d.update });
    settings.initTranscodingSettings();
    el('setting-hw-encoder').value = 'nvenc'; await fire('setting-hw-encoder');
    el('setting-hw-encoder').value = 'vaapi'; await fire('setting-hw-encoder');
    d.waiting[0].no('no nvenc'); await settle();
    d.waiting[1].no('no vaapi'); await settle();
    assert.deepEqual(d.waiting.map(w => w.body.hwEncoder), ['nvenc', 'vaapi'], 'sent in the order made');
    assert.equal(el('setting-hw-encoder').value, 'auto', 'auto, as the server holds it, not the refused nvenc');
    assert.equal(settings.app.player.settings.hwEncoder, 'auto');
    assert.equal(toasts.length, 2);
});
