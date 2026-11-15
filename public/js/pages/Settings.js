/**
 * Settings Page Controller: the tabs, the address and which panel loads what. Each section's methods are in
 * pages/settings/ (one file per section, added to SettingsPage.prototype), loaded after this file by index.html (#64).
 */

class SettingsPage {
    constructor(app) {
        this.app = app;
        this.tabs = document.querySelectorAll('.tabs .tab');
        this.tabContents = document.querySelectorAll('.tab-content');

        this.init();
    }

    init() {
        // Tab switching
        this.tabs.forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });
        document.querySelectorAll('.subtabs .subtab').forEach(sub => {
            sub.addEventListener('click', () => this.switchTab(sub.dataset.subtab));
        });
        // #276 (B7): the tab strips are ARIA tablists (role in index.html; each tab's role and state here, since other tests
        // pin the buttons' markup): one Tab stop each, arrow keys (and Home/End) move and select.
        document.querySelectorAll('#page-settings [role="tablist"]').forEach(list => {
            list.querySelectorAll('.tab, .subtab').forEach(t => {
                t.setAttribute('role', 'tab');
                t.setAttribute('aria-selected', String(t.classList.contains('active')));
                t.tabIndex = t.classList.contains('active') ? 0 : -1;
            });
            list.addEventListener('keydown', (e) => {
                const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last' };
                if (!(e.key in keys)) return;
                const tabs = [...list.querySelectorAll('[role="tab"]')].filter(t => t.offsetParent !== null);
                const i = tabs.indexOf(document.activeElement);
                if (i < 0) return;
                e.preventDefault();
                const k = keys[e.key];
                const next = k === 'first' ? tabs[0] : k === 'last' ? tabs[tabs.length - 1] : tabs[(i + k + tabs.length) % tabs.length];
                next.click();
                next.focus();
            });
        });

        // Player settings
        this.initPlayerSettings();

        // Transcoding settings
        this.initTranscodingSettings();

        // User management (admin only)
        this.initUserManagement();

        // Recording / UI tabs
        this.initHwDecodeSettings();
        // #276: these panels show their controls only once the server's values are in them.
        SettingsPage.lockPanel(document.getElementById('tab-transcode'), 'loading');
        SettingsPage.lockPanel(document.getElementById('tab-recording'), 'loading');
        this.initDevices();
        this.initRecordingSettings();
        this.initUiSettings();
        this.initLineup();
        this.initEpgMatching();
        this.initSports();
        this.providers = new ProvidersSettings();
        this.backupLinks = new BackupLinksSettings();
        // #199 (D-41): what this account follows, a panel of its own (#64)
        this.sportFollow = new SportFollowSettings(document.getElementById('sport-follow-settings'), { currentUser: () => this.app.currentUser });
        document.getElementById('links-back')?.addEventListener('click', () => this.switchTab('providers'));
    }

    /** 0182: the backup links of one provider, opened from its card. */
    showBackupLinks(providerId) {
        if (providerId != null) this.backupLinks.filters.backupSourceId = String(providerId);
        this.switchTab('backuplinks');
    }

    /**
     * #276: a panel whose controls a GET fills. 'loading': disabled and aria-busy; 'failed': still disabled (what they
     * show is not what the server holds); 'ready': each control back to the state it had before.
     */
    static lockPanel(panel, phase) {
        if (!panel) return;
        panel.setAttribute?.('aria-busy', phase === 'loading' ? 'true' : 'false');
        const controls = panel.querySelectorAll?.('[data-settings-values] input, [data-settings-values] select, '
            + '[data-settings-values] textarea, [data-settings-values] button') || [];
        controls.forEach(el => {
            if (phase !== 'ready') {
                if (el.dataset.lockedWas === undefined) el.dataset.lockedWas = el.disabled ? '1' : '0';
                el.disabled = true;
            } else if (el.dataset.lockedWas !== undefined) {
                el.disabled = el.dataset.lockedWas === '1';
                delete el.dataset.lockedWas;
            }
        });
    }

    /**
     * 0182: six tabs over the same panels. `name` is a tab or one of its panels:
     *   channels  one panel at a time, picked on the strip under the tabs
     *   playback, system  their panels one under the other
     *   backuplinks  belongs to Providers (opened from a backup's card)
     */
    switchTab(name, { history = 'push' } = {}) {
        const groups = SettingsPage.GROUPS;
        const tab = groups[name] ? name
            : (Object.keys(groups).find(g => groups[g].includes(name)) || (name === 'backuplinks' ? 'providers' : name));
        let panels = [name];
        if (tab === 'channels') {
            this.channelsPanel = groups.channels.includes(name) ? name : (this.channelsPanel || groups.channels[0]);
            panels = [this.channelsPanel];
        } else if (groups[tab]) {
            panels = groups[tab].filter(p => p !== 'users' || this.isAdmin());
        }
        panels.forEach(panel => this.loadPanel(panel));
        const select = (el, on) => {
            el.classList.toggle('active', on);
            el.setAttribute('aria-selected', String(on));
            el.tabIndex = on ? 0 : -1;
        };
        this.tabs.forEach(t => select(t, t.dataset.tab === tab));
        this.tabContents.forEach(c => c.classList.toggle('active', panels.some(p => c.id === `tab-${p}`)));
        document.getElementById('subtabs-channels')?.classList.toggle('hidden', tab !== 'channels');
        document.querySelectorAll('.subtabs .subtab').forEach(sub => select(sub, panels.includes(sub.dataset.subtab)));
        // #276 (C14): the tab is in the address (#settings/recording), so a reload and Back return to it.
        this.path = SettingsPage.pathFor(tab, tab === 'channels' ? this.channelsPanel : name);
        if (history !== 'none') this.app?.setLocation?.('settings', this.path, history);
        else if (this.app?.setLocation && typeof document !== 'undefined') document.title = this.app.titleFor('settings', this.path);
    }

    /** The tab open now as it reads in the address: "recording", "channels/lineup", "providers/backup-links". */
    currentPath() { return this.path || (this.isAdmin() ? 'providers' : 'playback'); }

    /** Open the tab an address names (Back, Forward, a link); an unknown one opens the default. */
    openPath(path) {
        const name = SettingsPage.PATHS[path] || SettingsPage.PATHS[this.currentPath()];
        this.switchTab(name, { history: 'none' });
    }

    /** What the title adds after "Settings": "Channels", "Channel numbers". */
    titleParts(path) {
        const [tab, sub] = String(path || this.currentPath()).split('/');
        const labels = SettingsPage.LABELS;
        return [labels[tab], sub && labels[`${tab}/${sub}`]].filter(Boolean);
    }

    isAdmin() {
        return this.app.currentUser?.role === 'admin';
    }

    /** #322: the Advanced block (encoder, GPU decode, CPU scale, User-Agent) is for admins only. */
    showAdminOnly() {
        const advanced = document.getElementById('transcode-advanced');
        if (advanced) advanced.hidden = !this.isAdmin();
    }

    /** What a panel needs fetched when it comes into view. */
    loadPanel(panel) {
        if (panel === 'transcode') { this.loadTranscodeSettings(); this.loadHardwareInfo(); }
        if (panel === 'devices') this.loadDevices();
        if (panel === 'recording') this.loadRecordingSettings();
        if (panel === 'ui') this.loadUiSettings();
        if (panel === 'lineup' && !this.lineupEdits?.size) this.loadLineup(); // #128: typed numbers survive a tab switch
        if (panel === 'epg') this.loadEpgMatching();
        if (panel === 'sports') { this.sportFollow.load(); if (this.isAdmin()) this.loadSports(); }
        if (panel === 'providers') { this.providers.load(); if (this.isAdmin()) this.loadImportExclusions(); }
        if (panel === 'backuplinks') { if (this.backupLinks.stale) this.backupLinks.load(); else this.backupLinks.reload(); }
        if (panel === 'content') this.app.sourceManager.loadContentSources();
        if (panel === 'users') this.loadUsers();
    }

    async show(path) {
        // 0182: an admin lands on Providers the first time, a viewer on Playback; after that, on the tab they left.
        // #276: or on the tab the address names (a reload, a link, Back).
        const wanted = SettingsPage.PATHS[path] ? path : null;
        if (this.isAdmin()) {
            document.querySelectorAll('.tabs .admin-tab').forEach(t => { t.style.display = ''; });
            if (wanted && (wanted !== this.path || !this.openedOnce)) this.openPath(wanted);
            else if (!this.openedOnce) this.switchTab('providers', { history: 'none' });
            else if (document.getElementById('tab-providers')?.classList.contains('active')) this.providers.load();
        } else if (!this.openedOnce) {
            this.switchTab('playback', { history: 'none' });
        }
        this.openedOnce = true;
        this.showAdminOnly();

        // Refresh ALL player settings from server
        if (this.app.player?.settings) {
            const s = this.app.player.settings;

            // Player settings
            const arrowKeysToggle = document.getElementById('setting-arrow-keys');
            const epgRefreshSelect = document.getElementById('epg-refresh-interval');

            if (arrowKeysToggle) arrowKeysToggle.checked = s.arrowKeysChangeChannel;
            if (epgRefreshSelect) epgRefreshSelect.value = s.epgRefreshInterval || '24';
        }

        // Update EPG last refreshed display
        this.updateEpgLastRefreshed();
    }

    hide() {
        // Page is hidden
    }
}

/** #276 (C14): Settings places as they read in the address, and the tab or panel each one opens. */
SettingsPage.PATHS = {
    providers: 'providers', 'providers/backup-links': 'backuplinks',
    channels: 'channels', 'channels/content': 'content', 'channels/lineup': 'lineup', 'channels/epg': 'epg',
    playback: 'playback', recording: 'recording', sport: 'sports', system: 'system'
};
SettingsPage.LABELS = {
    providers: 'Providers', 'providers/backup-links': 'Backup links', channels: 'Channels',
    'channels/content': 'Manage content', 'channels/lineup': 'Channel numbers', 'channels/epg': 'EPG matching',
    playback: 'Playback', recording: 'Recording', sport: 'Sport', system: 'System'
};
/** The address part for a tab (and, in Channels, its panel). */
SettingsPage.pathFor = (tab, panel) => {
    if (tab === 'channels') return `channels/${['content', 'lineup', 'epg'].includes(panel) ? panel : 'content'}`;
    if (panel === 'backuplinks') return 'providers/backup-links';
    return tab === 'sports' ? 'sport' : tab;
};

SettingsPage.GROUPS = { channels: ['content', 'lineup', 'epg'], playback: ['player', 'transcode'], system: ['ui', 'devices', 'users'] };

window.SettingsPage = SettingsPage;
