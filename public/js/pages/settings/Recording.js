/**
 * Settings › Recording: storage, scheduling, commercial breaks, compression and the notification webhook.
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
    // ---- Recording tab -------------------------------------------------

    initRecordingSettings() {
        const saveBtn = document.getElementById('dvr-settings-save');
        if (saveBtn) saveBtn.addEventListener('click', () => this.saveRecordingSettings());
        document.getElementById('notify-save')?.addEventListener('click', () => this.saveNotifySettings());
        document.getElementById('notify-test')?.addEventListener('click', () => this.testNotify());
    },

    /** R11: the notification webhook (admins only see and save it). */
    async saveNotifySettings() {
        const status = document.getElementById('notify-status');
        try {
            await API.settings.update({
                notifyWebhookUrl: document.getElementById('notify-url').value.trim(),
                notifyWebhookFormat: document.getElementById('notify-format').value
            });
            if (status) status.textContent = 'Saved';
        } catch (err) {
            if (status) status.textContent = UI.errorText(err, 'The notification settings were not saved.');
        }
    },

    async testNotify() {
        const status = document.getElementById('notify-status');
        if (status) status.textContent = 'Sending…';
        try {
            const r = await API.request('POST', '/settings/notify-test');
            const why = r.skipped === 'no webhook' ? 'save an address first'
                : r.status ? 'the address answered with an error' : r.error === 'timeout' ? 'no answer in 10 s' : 'could not reach the address';
            if (status) status.textContent = r.sent ? 'Sent' : `Not sent: ${why}`;
        } catch (err) {
            if (status) status.textContent = UI.errorText(err, 'The test could not be sent.');
        }
    },

    async loadRecordingSettings() {
        const path = document.getElementById('dvr-setting-path');
        if (!path) return;
        const panel = document.getElementById('tab-recording');
        const state = document.getElementById('tab-recording-state');
        SettingsPage.lockPanel(panel, 'loading');
        UI.setState(state, 'loading', 'Loading the recording settings…');
        try {
            const s = await API.settings.get();
            SettingsPage.lockPanel(panel, 'ready');
            if (state) state.innerHTML = '';
            path.value = s.recordingsPath || '/app/recordings';
            document.getElementById('dvr-setting-pre').value = s.defaultPreBufferMin ?? 1;
            document.getElementById('dvr-setting-post').value = s.defaultPostBufferMin ?? 5;
            document.getElementById('dvr-setting-max').value = s.maxConcurrentRecordings ?? 1;
            document.getElementById('dvr-setting-prompt-timeout').value = s.recordingPromptTimeoutMin ?? 3;
            document.getElementById('dvr-setting-minfree').value = s.minFreeSpaceGB ?? 10;
            document.getElementById('dvr-setting-codec').value = s.postRecordCodec || 'h264';
            document.getElementById('dvr-setting-bitrate').value = s.postRecordBitrateKbps ?? 3000;
            document.getElementById('dvr-setting-keep-original').checked = s.postRecordKeepOriginal === true;
            document.getElementById('dvr-setting-addetect').checked = s.adDetectionEnabled === true;
            document.getElementById('dvr-setting-adautoskip').checked = s.adAutoSkip === true;
            const notifyUrl = document.getElementById('notify-url');
            if (notifyUrl) notifyUrl.value = s.notifyWebhookUrl || '';
            const notifyFormat = document.getElementById('notify-format');
            if (notifyFormat) notifyFormat.value = s.notifyWebhookFormat === 'text' ? 'text' : 'json';
        } catch (err) {
            console.error('Failed to load recording settings:', err);
            SettingsPage.lockPanel(panel, 'failed');
            UI.setState(state, 'error', 'The recording settings could not be loaded.', { run: () => this.loadRecordingSettings() });
        }
    },

    async saveRecordingSettings() {
        const status = document.getElementById('dvr-settings-status');
        const numbers = {};
        for (const [key, id] of [['defaultPreBufferMin', 'dvr-setting-pre'], ['defaultPostBufferMin', 'dvr-setting-post'], ['maxConcurrentRecordings', 'dvr-setting-max'],
            ['recordingPromptTimeoutMin', 'dvr-setting-prompt-timeout'], ['minFreeSpaceGB', 'dvr-setting-minfree'], ['postRecordBitrateKbps', 'dvr-setting-bitrate']]) {
            numbers[key] = UI.readWholeNumber(document.getElementById(id));
        }
        if (Object.values(numbers).some(v => v === null)) {
            if (status) status.textContent = 'Some numbers need fixing. Nothing was saved.';
            document.querySelector('#tab-recording [aria-invalid]')?.focus();
            return;
        }
        try {
            await API.settings.update({
                recordingsPath: document.getElementById('dvr-setting-path').value.trim() || '/app/recordings',
                ...numbers,
                postRecordCodec: document.getElementById('dvr-setting-codec').value,
                postRecordKeepOriginal: document.getElementById('dvr-setting-keep-original').checked,
                adDetectionEnabled: document.getElementById('dvr-setting-addetect').checked,
                adAutoSkip: document.getElementById('dvr-setting-adautoskip').checked
            });
            if (status) {
                status.textContent = 'Saved';
                setTimeout(() => { status.textContent = ''; }, 2500);
            }
        } catch (err) {
            if (status) status.textContent = UI.errorText(err, 'The recording settings were not saved.');
        }
    },
});
