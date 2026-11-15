/**
 * Settings › Playback › Transcoding: the panel's values from one GET, the encoder and the User-Agent.
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
    /**
     * #276: the Playback → transcoding panel's values (encoder, decoding, recovery, User-Agent), from one
     * GET. Its controls stay disabled until they arrive, and after a failed load, which says so with Try again.
     */
    async loadTranscodeSettings() {
        const panel = document.getElementById('tab-transcode');
        const state = document.getElementById('tab-transcode-state');
        if (!panel) return;
        SettingsPage.lockPanel(panel, 'loading');
        UI.setState(state, 'loading', 'Loading the playback settings…');
        let s;
        try {
            s = await API.settings.get();
        } catch (err) {
            console.error('Failed to load the transcoding settings:', err);
            SettingsPage.lockPanel(panel, 'failed');
            UI.setState(state, 'error', 'The playback settings could not be loaded.', { run: () => this.loadTranscodeSettings() });
            return;
        }
        SettingsPage.lockPanel(panel, 'ready');
        if (state) state.innerHTML = '';
        this.applyTranscodeSettings(s);
        this.applyHwDecodeSettings(s);
    },

    /** The transcoding panel's change handlers; its values come from loadTranscodeSettings when it is shown. */
    initTranscodingSettings() {
        // Encoder settings
        const hwEncoderSelect = document.getElementById('setting-hw-encoder');

        // User-Agent (Transcoding tab versions)
        const userAgentSelect = document.getElementById('setting-user-agent-tc');
        const userAgentCustomInput = document.getElementById('setting-user-agent-custom-tc');
        const customUaContainer = document.getElementById('custom-user-agent-container-tc');

        // Event listeners for encoder settings
        hwEncoderSelect?.addEventListener('change', () => {
            this.app.player.settings.hwEncoder = hwEncoderSelect.value;
            this.savePlayerSetting('hwEncoder');
        });

        // User-Agent handlers
        const toggleCustomInput = () => {
            if (customUaContainer) {
                customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
            }
        };

        userAgentSelect?.addEventListener('change', () => {
            this.app.player.settings.userAgentPreset = userAgentSelect.value;
            this.savePlayerSetting('userAgentPreset');
            toggleCustomInput();
        });

        userAgentCustomInput?.addEventListener('change', () => {
            this.app.player.settings.userAgentCustom = userAgentCustomInput.value;
            this.savePlayerSetting('userAgentCustom');
        });
    },

    /** The transcoding panel's values from GET /api/settings (#276: was fetched at start, with defaults on failure). */
    applyTranscodeSettings(s) {
        const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
        set('setting-hw-encoder', s.hwEncoder || 'auto');
        set('setting-user-agent-tc', s.userAgentPreset || 'chrome');
        set('setting-user-agent-custom-tc', s.userAgentCustom || '');
        const customUa = document.getElementById('custom-user-agent-container-tc');
        if (customUa) customUa.style.display = (s.userAgentPreset || 'chrome') === 'custom' ? 'flex' : 'none';
    },
});
