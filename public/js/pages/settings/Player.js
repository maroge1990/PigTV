/**
 * Settings › Playback › Player: the keyboard switch and the guide refresh (Providers), saved through the player, and when each provider last synced.
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
    /**
     * #9 (0358): one setting at a time, and the result shown: "Saved" next to the page's status, or why not. The
     * volume slider saves when let go, not on every step.
     */
    async savePlayerSetting(key) {
        const result = await this.app.player.saveSettings([key]);
        const status = document.getElementById('playback-settings-status');
        if (status) {
            status.textContent = result.ok ? 'Saved' : 'That setting was not saved. Try again.';
            status.classList.toggle('error', !result.ok);
        }
        return result;
    },

    initPlayerSettings() {
        const arrowKeysToggle = document.getElementById('setting-arrow-keys');

        // Load current settings
        if (this.app.player?.settings) {
            arrowKeysToggle.checked = this.app.player.settings.arrowKeysChangeChannel;
        }

        // Arrow keys toggle
        arrowKeysToggle.addEventListener('change', () => {
            this.app.player.settings.arrowKeysChangeChannel = arrowKeysToggle.checked;
            this.savePlayerSetting('arrowKeysChangeChannel');
        });

        // EPG refresh interval
        const epgRefreshSelect = document.getElementById('epg-refresh-interval');
        if (epgRefreshSelect && this.app.player?.settings) {
            // Load saved value from player settings
            epgRefreshSelect.value = this.app.player.settings.epgRefreshInterval || '24';

            // Save on change - server will restart its sync timer via PUT /api/settings
            epgRefreshSelect.addEventListener('change', () => {
                this.app.player.settings.epgRefreshInterval = epgRefreshSelect.value;
                this.savePlayerSetting('epgRefreshInterval');
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
