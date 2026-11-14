const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #9 (0358): changing a web player preference no longer writes a page-load copy of every setting back. The real
// VideoPlayer script with the API stubbed. On 0357 saveSettings() PUT the whole object it loaded with the page, so a
// switch changed elsewhere since (in-stream recovery, segmented recordings, the webhook) was silently put back.
function harness(serverSettings, { refuse = null, fetch = null, setTimeout = null } = {}) {
    const puts = [];
    const store = new Map();
    const context = vm.createContext({
        window: {}, console: { ...console, log() {}, warn() {}, error() {} },
        document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
        fetch, setTimeout, clearTimeout() {},
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
    return { player, puts, store, serverSettings, context };
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
    player.settings.arrowKeysChangeChannel = false;
    await player.saveSettings(['arrowKeysChangeChannel']);
    assert.deepEqual(puts, [], 'nothing sent to the server');
    assert.deepEqual(JSON.parse(store.get('pigtv_player_prefs')), { arrowKeysChangeChannel: false });
    await player.loadSettingsFromServer();
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

// #322: web upscaling is removed. A stored `upscaleEnabled: true` made every web play ask the server for a re-encode
// (`upscale: true`); a play's request no longer carries it, whatever the server still holds.
test('a stored upscaling switch is not sent with a play', async () => {
    const sent = [];
    const fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { status: 499, ok: false, json: async () => ({}) }; };
    const { player } = harness({ upscaleEnabled: true }, { fetch });
    await player.loadSettingsFromServer();
    Object.assign(player, { _playGeneration: 1, video: { canPlayType: () => '' } });
    player.getCodecCapabilities = () => ({ h264: true, aac: true });
    player.needsAudioEncode = () => false;
    await player.resolvePlayback({ sourceId: 1, id: 'pos_1' }, 'http://provider.invalid/1.ts', { generation: 1 });
    assert.equal(sent.length, 1, 'one resolve request');
    assert.equal('upscale' in sent[0], false);
    assert.equal(sent[0].channelId, 'pos_1');
});

// #322: the now-playing overlay shows for 5 s and the last volume is always remembered in this browser
// (overlayDuration, defaultVolume and rememberVolume are retired, from the server and from browser storage alike).
test('a stored "do not remember the volume" and default volume no longer count: the last volume comes back', async () => {
    const { context, store } = harness({ rememberVolume: false, defaultVolume: 20 });
    store.set('pigtv_player_prefs', JSON.stringify({ rememberVolume: false, defaultVolume: 20 }));
    store.set('pigtv_last_volume', '55');
    const VideoPlayer = context.window.VideoPlayer;
    const realInit = VideoPlayer.prototype.init;
    let ready;
    const started = new Promise(r => { ready = r; });
    VideoPlayer.prototype.init = function () { ready(this); };
    const player = await (new VideoPlayer(), started);
    const listeners = {};
    player.video = { volume: 1, addEventListener: (type, fn) => { listeners[type] = fn; } };
    player.initCustomControls = () => {};
    realInit.call(player);
    assert.equal(player.video.volume, 0.55, 'the last volume, not the stored default');
    player.video.volume = 0.3;
    listeners.volumechange();
    assert.equal(store.get('pigtv_last_volume'), '30', 'and a change is remembered');
});

test('a stored overlay duration no longer counts: the now-playing overlay shows for 5 s', async () => {
    const delays = [];
    const { player, store } = harness({ overlayDuration: 30 }, { setTimeout: (fn, ms) => { delays.push(ms); return 1; } });
    store.set('pigtv_player_prefs', JSON.stringify({ overlayDuration: 30 }));
    await player.loadSettingsFromServer();
    Object.assign(player, { currentChannel: { name: 'One' }, overlayTimer: null, overlayDuration: 5000,
        nowPlaying: { classList: { add() {}, remove() {} } } });
    player.showNowPlayingOverlay();
    assert.deepEqual(delays, [5000]);
});
