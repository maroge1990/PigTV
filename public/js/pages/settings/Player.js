/**
 * Settings › Playback › Player: the keyboard switch and the guide refresh (Providers), saved through the player, and when each provider last synced.
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
    /**
     * #9 (0358): one setting at a time, and the result shown: "Saved" next to the page's status. #64: saved like every
     * other single control (saveOnChange): if the server refuses it, the control and the player's copy go back to the
     * value it holds and a notice says why. `shown` turns a stored value into what the control shows; `after` runs once
     * it is back (a field that depends on it).
     */
    async savePlayerSetting(key, control, { shown = (v) => v ?? '', after = null } = {}) {
        const player = this.app.player;
        const settings = player.settings;
        const previous = settings[key];
        const value = control.type === 'checkbox' ? control.checked : control.value;
        settings[key] = value;
        return this.saveOnChange({
            status: document.getElementById('playback-settings-status'),
            save: async () => {
                // This browser's own preferences (the arrow keys) the player keeps itself; the rest go to the server
                // one key at a time, and what it saved is what the player keeps.
                if ((player.constructor?.LOCAL_KEYS || []).includes(key)) return player.saveSettings([key]);
                const saved = await API.settings.update({ [key]: value });
                if (saved && typeof saved === 'object' && key in saved) settings[key] = saved[key];
                return saved;
            },
            revert: () => {
                settings[key] = previous;
                if (control.type === 'checkbox') control.checked = previous === true;
                else control.value = shown(previous);
                if (after) after();
            }
        });
    },

    initPlayerSettings() {
        const arrowKeysToggle = document.getElementById('setting-arrow-keys');

        // Load current settings
        if (this.app.player?.settings) {
            arrowKeysToggle.checked = this.app.player.settings.arrowKeysChangeChannel;
        }

        // Arrow keys toggle
        arrowKeysToggle.addEventListener('change', () => {
            this.savePlayerSetting('arrowKeysChangeChannel', arrowKeysToggle);
        });

        // EPG refresh interval
        const epgRefreshSelect = document.getElementById('epg-refresh-interval');
        if (epgRefreshSelect && this.app.player?.settings) {
            // Load saved value from player settings
            epgRefreshSelect.value = this.app.player.settings.epgRefreshInterval || '24';

            // Save on change - server will restart its sync timer via PUT /api/settings
            epgRefreshSelect.addEventListener('change', () => {
                this.savePlayerSetting('epgRefreshInterval', epgRefreshSelect, { shown: (v) => v || '24' });
            });
        }

        // Update last refreshed display
        this.updateEpgLastRefreshed();
    },

    /**
     * Update the EPG last refreshed display
     */
    async updateEpgLastRefreshed() {
        const display = document.getElementById('epg-last-refreshed');
        if (!display) return;

        const ago = (ms) => {
            const mins = Math.floor((Date.now() - ms) / 60000);
            if (mins < 1) return 'just now';
            if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
            const hours = Math.floor(mins / 60);
            return hours < 24 ? `${hours} hour${hours === 1 ? '' : 's'} ago` : UI.dateTime(ms);
        };
        try {
            const data = await API.request('GET', '/settings/sync-status');
            // #61 (0368): per source, from what the server keeps (a restart no longer reads as "Just now"). A source
            // is as current as its oldest feed; a failed or held feed is named.
            if (Array.isArray(data.sources)) {
                const label = { epg: 'guide', all: 'channels', live: 'channels' };
                const lines = data.sources.map(src => {
                    const feeds = src.feeds || [];
                    if (!feeds.length) return `${src.name}: never`;
                    const bad = feeds.find(f => f.status !== 'success');
                    if (bad) return `${src.name}: ${label[bad.type] || bad.type} ${bad.status === 'held' ? 'held' : bad.status === 'syncing' ? 'syncing' : 'failed'} ${ago(bad.at)}`;
                    return `${src.name} ${ago(Math.min(...feeds.map(f => f.at)))}`;
                });
                display.textContent = lines.length ? lines.join(' · ') : 'No providers';
                display.title = data.sources.flatMap(src => (src.feeds || []).map(f => `${src.name} ${label[f.type] || f.type}: ${f.status}, ${UI.dateTime(f.at)}`)).join('\n');
            } else if (data.lastSyncTime) {
                const at = new Date(data.lastSyncTime).getTime();
                display.textContent = ago(at);
                display.title = UI.dateTime(at);
            } else {
                display.textContent = 'Never';
                display.title = 'Sync has not run yet since server started';
            }
        } catch (err) {
            console.error('Error fetching sync status:', err);
            display.title = '';
            UI.setState(display, 'error', 'The last sync time could not be loaded.', { run: () => this.updateEpgLastRefreshed() });
        }
    },
});
