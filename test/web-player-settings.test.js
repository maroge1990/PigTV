const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #9 (0358): changing a web player preference no longer writes a page-load copy of every setting back. The real
// VideoPlayer script with the API stubbed. On 0357 saveSettings() PUT the whole object it loaded with the page, so a
// switch changed elsewhere since (in-stream recovery, segmented recordings, the webhook) was silently put back.
function harness(serverSettings, { refuse = null } = {}) {
    const puts = [];
    const store = new Map();
    const context = vm.createContext({
        window: {}, console: { ...console, log() {}, warn() {}, error() {} },
        document: { getElementById: () => null, addEventListener() {} },
        localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
        API: { settings: {
            get: async () => ({ ...serverSettings }),
            update: async (data) => {
                puts.push(data);
                if (refuse) throw new Error(refuse);
                Object.assign(serverSettings, data);
                return { ...serverSettings };
            }
        } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/VideoPlayer.js'), 'utf8'), context);
    const player = Object.create(context.window.VideoPlayer.prototype);
    player.getDefaultSettings = context.window.VideoPlayer.prototype.getDefaultSettings;
    return { player, puts, store, serverSettings };
}

test('a preference saves only its own key, so a switch changed since the page loaded is not put back', async () => {
    const { player, puts, serverSettings } = harness({ relayEnabled: false, epgRefreshInterval: '24', quality: 'high' });
    await player.loadSettingsFromServer();
    serverSettings.relayEnabled = true; // turned on in another tab
    player.settings.epgRefreshInterval = '12';
    const result = await player.saveSettings(['epgRefreshInterval']);
    assert.deepEqual(JSON.parse(JSON.stringify(puts)), [{ epgRefreshInterval: '12' }]);
    assert.equal(serverSettings.relayEnabled, true, 'untouched');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true });
});

test("this browser's own preferences stay in this browser and come back on the next load", async () => {
    const { player, puts, store } = harness({ quality: 'high' });
    await player.loadSettingsFromServer();
    player.settings.defaultVolume = 35;
    player.settings.arrowKeysChangeChannel = false;
    await player.saveSettings(['defaultVolume', 'arrowKeysChangeChannel']);
    assert.deepEqual(puts, [], 'nothing sent to the server');
    assert.deepEqual(JSON.parse(store.get('pigtv_player_prefs')), { defaultVolume: 35, arrowKeysChangeChannel: false });
    await player.loadSettingsFromServer();
    assert.equal(player.settings.defaultVolume, 35);
    assert.equal(player.settings.arrowKeysChangeChannel, false);
});

test('a refused save is reported, not hidden in browser storage', async () => {
    const { player, store } = harness({ quality: 'high' }, { refuse: 'The recordings folder is not mounted' });
    await player.loadSettingsFromServer();
    player.settings.userAgentPreset = 'vlc';
    const result = await player.saveSettings(['userAgentPreset']);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, error: 'The recordings folder is not mounted' });
    assert.equal(store.has('pigtv_player_settings'), false, 'no silent copy that is never read back');
});
