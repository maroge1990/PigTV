/**
 * Settings Page Controller
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
     * #9 (0358): one setting at a time, and the result shown: "Saved" next to the page's status, or why not. The
     * volume slider saves when let go, not on every step.
     */
    async savePlayerSetting(key) {
        const result = await this.app.player.saveSettings([key]);
        const status = document.getElementById('playback-settings-status');
        if (status) {
            status.textContent = result.ok ? 'Saved' : `Not saved: ${result.error}`;
            status.classList.toggle('error', !result.ok);
        }
        return result;
    }

    initHwDecodeSettings() {
        const bind = (id, key) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', async () => {
                try {
                    await API.settings.update({ [key]: el.checked });
                } catch (err) {
                    console.error(`Failed to save ${key}:`, err);
                    el.checked = !el.checked;
                }
            });
        };
        bind('setting-vaapi-hw-decode', 'vaapiHwDecode');
        bind('setting-vaapi-cpu-scale', 'vaapiCpuScale');
        // R12: the standby only works while recovery is on, so its switch is greyed out otherwise.
        const relay = document.getElementById('setting-relay-enabled');
        const standby = document.getElementById('setting-standby-enabled');
        const renewal = document.getElementById('setting-ingest-renewal');
        const shared = document.getElementById('setting-shared-ingest');
        // #65 (0360): like the standby (0203), a renewal switch that cannot run is unticked and saved off, not left
        // ticked and greyed, which read as "still on".
        const syncRenewalAvailability = async () => {
            if (!renewal) return;
            renewal.disabled = !relay?.checked || !shared?.checked;
            if (renewal.disabled && renewal.checked) {
                renewal.checked = false;
                try { await API.settings.update({ ingestReconnectRenewal: false }); } catch (err) { console.error('Failed to save ingestReconnectRenewal:', err); }
            }
        };
        shared?.addEventListener('change', syncRenewalAvailability);
        bind('setting-relay-enabled', 'relayEnabled');
        bind('setting-ingest-renewal', 'ingestReconnectRenewal');
        bind('setting-standby-enabled', 'standbyEnabled');
        bind('setting-warm-next-channel', 'warmNextChannel'); // R11
        bind('setting-shared-ingest', 'sharedIngestEnabled'); // Wave 5
        // 0203: turning recovery off also turns the standby off (it cannot run without it), and
        // says so: a ticked-but-greyed switch read as "still on".
        relay?.addEventListener('change', async () => {
            syncRenewalAvailability();
            if (!standby) return;
            standby.disabled = !relay.checked;
            if (!relay.checked && standby.checked) {
                standby.checked = false;
                try { await API.settings.update({ standbyEnabled: false }); } catch (err) { console.error('Failed to save standbyEnabled:', err); }
            }
        });
    }

    /**
     * #276: the Playback → transcoding panel's values (encoder, decoding, recovery, upscaling, User-Agent), from one
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
    }

    applyHwDecodeSettings(s) {
        const hw = document.getElementById('setting-vaapi-hw-decode');
        if (hw) {
            hw.checked = s.vaapiHwDecode !== false;
            const cpu = document.getElementById('setting-vaapi-cpu-scale');
            if (cpu) cpu.checked = s.vaapiCpuScale !== false;
            const relay = document.getElementById('setting-relay-enabled');
            const standby = document.getElementById('setting-standby-enabled');
            if (relay) relay.checked = s.relayEnabled === true;
            const renewal = document.getElementById('setting-ingest-renewal');
            if (renewal) { renewal.checked = s.ingestReconnectRenewal === true; renewal.disabled = s.relayEnabled !== true || s.sharedIngestEnabled !== true; }
            if (standby) {
                // Never shown ticked while recovery is off: the server treats it as off then.
                standby.checked = s.standbyEnabled === true && s.relayEnabled === true;
                standby.disabled = s.relayEnabled !== true;
            }
            const warm = document.getElementById('setting-warm-next-channel');
            if (warm) warm.checked = s.warmNextChannel === true;
            const shared = document.getElementById('setting-shared-ingest');
            if (shared) shared.checked = s.sharedIngestEnabled === true;
        }
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

    // ---- Devices tab ---------------------------------------------------

    initDevices() {
        const btn = document.getElementById('pair-approve');
        if (!btn) return;
        btn.addEventListener('click', () => this.approveDevice());

        const input = document.getElementById('pair-code');
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.approveDevice();
        });
        // #19 (0365): once a whole code is typed, say which device is asking before it is approved.
        input?.addEventListener('input', () => this.lookUpPairing());
    }

    async lookUpPairing() {
        const input = document.getElementById('pair-code');
        const status = document.getElementById('pair-status');
        const code = (input?.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!status) return;
        if (code.length < 6) { status.textContent = ''; return; }
        try {
            const p = await API.request('GET', `/devices/pair/pending?code=${encodeURIComponent(code)}`);
            if (((input?.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')) !== code) return; // typed on since
            const mins = Math.max(0, Math.round((Date.now() - p.askedAt) / 60000));
            status.textContent = `Asking: ${p.name} · ${SettingsPage.deviceLine(p.app, p.platform)} · ${mins < 1 ? 'just now' : `${mins} min ago`}`;
        } catch (err) {
            status.textContent = err.message || 'That code was not found';
        }
    }

    async approveDevice() {
        const input = document.getElementById('pair-code');
        const status = document.getElementById('pair-status');
        const code = (input?.value || '').trim().toUpperCase();
        if (!code) return;

        try {
            const result = await API.request('POST', '/devices/pair/approve', { code });
            if (status) status.textContent = `Paired ${result.device.name}`;
            if (input) input.value = '';
            await this.loadDevices();
            setTimeout(() => { if (status) status.textContent = ''; }, 4000);
        } catch (err) {
            if (status) status.textContent = err.message || 'That code was not accepted';
        }
    }

    async loadDevices() {
        const list = document.getElementById('devices-list');
        if (!list) return;
        try {
            const devices = await API.request('GET', '/devices');
            const active = devices.filter(d => !d.revoked_at);
            if (active.length === 0) {
                UI.setState(list, 'empty', { title: 'No devices signed in yet', detail: 'Enter the code a TV app shows to pair it.' });
                return;
            }
            const e = (v) => UI.escape(v);
            list.innerHTML = active.map(d => {
                const seen = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never';
                return `
                <div class="setting-item">
                    <div class="setting-info">
                        <span class="setting-label">${e(d.name || 'Unnamed device')}</span>
                        <span class="setting-hint">${e(SettingsPage.deviceLine(d.app, d.platform))} · last seen ${e(seen)}</span>
                    </div>
                    <button class="btn btn-sm btn-danger" data-revoke="${e(d.id)}">Remove</button>
                </div>`;
            }).join('');

            list.querySelectorAll('[data-revoke]').forEach(b => {
                b.addEventListener('click', async () => {
                    if (!confirm('Sign this device out?')) return;
                    b.disabled = true;
                    try {
                        await API.request('DELETE', `/devices/${b.dataset.revoke}`);
                        await this.loadDevices();
                    } catch (err) {
                        b.disabled = false;
                    }
                });
            });
        } catch (err) {
            console.error('Devices failed to load:', err);
            UI.setState(list, 'error', 'The signed-in devices could not be loaded.', { run: () => this.loadDevices() });
        }
    }

    // ---- Recording tab -------------------------------------------------

    initRecordingSettings() {
        const saveBtn = document.getElementById('dvr-settings-save');
        if (saveBtn) saveBtn.addEventListener('click', () => this.saveRecordingSettings());
        document.getElementById('notify-save')?.addEventListener('click', () => this.saveNotifySettings());
        document.getElementById('notify-test')?.addEventListener('click', () => this.testNotify());
    }

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
            if (status) status.textContent = 'Failed: ' + err.message;
        }
    }

    async testNotify() {
        const status = document.getElementById('notify-status');
        if (status) status.textContent = 'Sending…';
        try {
            const r = await API.request('POST', '/settings/notify-test');
            const why = r.skipped === 'no webhook' ? 'save an address first'
                : r.status ? `the address answered HTTP ${r.status}` : r.error === 'timeout' ? 'no answer in 10 s' : 'could not reach the address';
            if (status) status.textContent = r.sent ? 'Sent' : `Not sent: ${why}`;
        } catch (err) {
            if (status) status.textContent = 'Failed: ' + err.message;
        }
    }

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
    }

    async saveRecordingSettings() {
        const status = document.getElementById('dvr-settings-status');
        try {
            await API.settings.update({
                recordingsPath: document.getElementById('dvr-setting-path').value.trim() || '/app/recordings',
                defaultPreBufferMin: parseInt(document.getElementById('dvr-setting-pre').value, 10) || 0,
                defaultPostBufferMin: parseInt(document.getElementById('dvr-setting-post').value, 10) || 0,
                maxConcurrentRecordings: parseInt(document.getElementById('dvr-setting-max').value, 10) || 1,
                recordingPromptTimeoutMin: Math.max(1, parseInt(document.getElementById('dvr-setting-prompt-timeout').value, 10) || 3),
                minFreeSpaceGB: Math.max(0, parseInt(document.getElementById('dvr-setting-minfree').value, 10) || 0),
                postRecordCodec: document.getElementById('dvr-setting-codec').value,
                postRecordBitrateKbps: Math.max(500, parseInt(document.getElementById('dvr-setting-bitrate').value, 10) || 3000),
                postRecordKeepOriginal: document.getElementById('dvr-setting-keep-original').checked,
                adDetectionEnabled: document.getElementById('dvr-setting-addetect').checked,
                adAutoSkip: document.getElementById('dvr-setting-adautoskip').checked
            });
            if (status) {
                status.textContent = 'Saved';
                setTimeout(() => { status.textContent = ''; }, 2500);
            }
        } catch (err) {
            if (status) status.textContent = 'Failed: ' + err.message;
        }
    }

    // ---- UI tab --------------------------------------------------------

    initUiSettings() {
        // Theme applies immediately and is stored per device rather than on the
        // server: which appearance suits a phone at night is not the same
        // answer as a desktop in daylight.
        const themeSelect = document.getElementById('setting-theme');
        if (themeSelect) {
            themeSelect.addEventListener('change', () => window.Theme?.set(themeSelect.value));
        }
    }

    loadUiSettings() {
        const themeSelect = document.getElementById('setting-theme');
        if (themeSelect && window.Theme) themeSelect.value = window.Theme.choice;
    }

    // ---- Channel numbers tab (0123) ------------------------------------
    //
    // GET /api/lineup lists every visible channel once, in number order; the admin
    // edits numbers inline and saves only what changed with PUT /api/lineup/numbers.
    // The server validates the whole request (whole numbers, no duplicates, no
    // number another visible channel holds) and writes nothing unless all of it is
    // good, so its error message is shown as it comes.

    initLineup() {
        this.lineup = [];
        this.lineupEdits = new Map(); // key -> the typed value, only where it differs
        // #128: leaving the page with typed but unsaved numbers asks first.
        window.addEventListener?.('beforeunload', (e) => {
            if (!this.lineupEdits.size) return;
            e.preventDefault();
            e.returnValue = '';
        });
        this.lineupQuery = '';
        this.lineupCategoryNames = new Map();

        const search = document.getElementById('lineup-search');
        search?.addEventListener('input', UI.debounce(() => {
            this.lineupQuery = search.value;
            this.renderLineup();
        }, 200));

        document.getElementById('lineup-save')?.addEventListener('click', () => this.saveLineup());

        document.getElementById('lineup-list')?.addEventListener('input', (e) => {
            const input = e.target;
            if (!input?.classList?.contains('lineup-number-input')) return;
            this.editLineupNumber(input.dataset.key, input.value);
            input.closest('tr')?.classList.toggle('changed', this.lineupEdits.has(input.dataset.key));
            this.updateLineupSaveState();
        });
    }

    lineupKey(row) {
        return `${row.sourceId}:${row.id}`;
    }

    setLineupStatus(text, isError = false) {
        const status = document.getElementById('lineup-status');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('error', isError);
    }

    async loadLineup() {
        const list = document.getElementById('lineup-list');
        try {
            const [lineup, categories] = await Promise.all([
                API.lineup.get(),
                API.library.categories().catch(() => [])
            ]);
            this.lineup = Array.isArray(lineup) ? lineup : [];
            this.lineupCategoryNames = new Map((categories || []).map(c => [`${c.sourceId}:${c.id}`, c.name]));
            this.lineupEdits.clear();
            this.renderLineup();
            this.updateLineupSaveState();
        } catch (err) {
            console.error('Channel numbers failed to load:', err);
            UI.setState(list, 'error', 'The channel numbers could not be loaded.', { run: () => this.loadLineup() }, { colspan: 3 });
        }
    }

    lineupCategory(row) {
        return this.lineupCategoryNames.get(`${row.sourceId}:${row.category}`) || row.category || '';
    }

    /** The rows matching the search: a number (exact or leading digits), a name or a category. */
    filteredLineup() {
        const q = String(this.lineupQuery || '').trim().toLowerCase();
        if (!q) return this.lineup;
        return this.lineup.filter(row =>
            (row.number !== null && row.number !== undefined && String(row.number).startsWith(q)) ||
            String(row.name || '').toLowerCase().includes(q) ||
            this.lineupCategory(row).toLowerCase().includes(q));
    }

    renderLineup() {
        const list = document.getElementById('lineup-list');
        if (!list) return;
        const rows = this.filteredLineup();
        if (rows.length === 0) {
            UI.setState(list, 'empty', this.lineup.length
                ? { title: 'No channels match', detail: 'Try a different number, name or category.' }
                : { title: 'No channels yet', detail: 'Channels get their numbers once a provider has synced (Settings → Providers).' }, null, { colspan: 3 });
            return;
        }
        list.innerHTML = rows.map(row => {
            const key = this.lineupKey(row);
            const edited = this.lineupEdits.has(key);
            const value = edited ? this.lineupEdits.get(key) : (row.number ?? '');
            return `
                <tr class="lineup-row${edited ? ' changed' : ''}">
                    <td><input type="text" inputmode="numeric" class="form-input lineup-number-input"
                               data-key="${UI.escape(key)}" value="${UI.escape(value)}"
                               aria-label="Number for ${UI.escape(row.name)}"></td>
                    <td>${UI.escape(row.name)}</td>
                    <td>${UI.escape(this.lineupCategory(row))}</td>
                </tr>`;
        }).join('');
    }

    editLineupNumber(key, value) {
        const row = this.lineup.find(r => this.lineupKey(r) === key);
        if (!row) return;
        const typed = String(value ?? '').trim();
        const original = row.number === null || row.number === undefined ? '' : String(row.number);
        if (typed === original) this.lineupEdits.delete(key);
        else this.lineupEdits.set(key, typed);
    }

    /** What Save sends: only the changed rows. Anything not a whole number goes as typed, for the server to refuse. */
    lineupChanges() {
        const numbers = [];
        for (const [key, typed] of this.lineupEdits) {
            const row = this.lineup.find(r => this.lineupKey(r) === key);
            if (!row) continue;
            numbers.push({ sourceId: row.sourceId, id: row.id, number: /^\d+$/.test(typed) ? parseInt(typed, 10) : typed });
        }
        return numbers;
    }

    updateLineupSaveState() {
        const save = document.getElementById('lineup-save');
        if (save) save.disabled = this.lineupEdits.size === 0;
    }

    async saveLineup() {
        const numbers = this.lineupChanges();
        if (numbers.length === 0) {
            this.setLineupStatus('No changes');
            return;
        }
        const save = document.getElementById('lineup-save');
        if (save) save.disabled = true;
        this.setLineupStatus('Saving...');
        try {
            await API.lineup.saveNumbers(numbers);
            await this.loadLineup();
            this.setLineupStatus(`Saved ${numbers.length} number${numbers.length === 1 ? '' : 's'}`);
            // The channel list and guide show numbers too
            window.app?.channelList?.loadChannels?.();
            if (window.app?.epgGuide?.loaded) window.app.epgGuide.loadEpg();
        } catch (err) {
            // The server's own words: "Duplicate number 5", "Channel numbers must be whole numbers from 1 to 999999", ...
            this.setLineupStatus(err.message || 'Could not save the numbers', true);
            this.updateLineupSaveState();
        }
    }

    // ---- EPG matching tab (0134) ----------------------------------------
    //
    // GET /api/epg/unmatched lists the visible channels with no programmes in the
    // next 24 hours, each with up to five EPG channels whose names match best. A
    // suggestion button maps the channel (PUT /api/epg/mapping); "Search..." opens
    // a search of the EPG's whole channel list for that channel. Mapped channels
    // are listed below with a button to remove the mapping.

    initEpgMatching() {
        this.epgUnmatched = [];
        this.epgMappings = [];
        this.epgFilter = '';
        this.epgSelected = null;  // the row "Search..." was pressed on
        this.epgSearchResults = [];

        const filter = document.getElementById('epg-match-filter');
        filter?.addEventListener('input', UI.debounce(() => { this.epgFilter = filter.value; this.renderEpgMatching(); }, 200));

        const search = document.getElementById('epg-match-search');
        search?.addEventListener('input', UI.debounce(() => this.searchEpgChannels(search.value), 300));

        document.getElementById('epg-automap-preview')?.addEventListener('click', () => this.previewAutoMap());
        document.getElementById('epg-automap-apply')?.addEventListener('click', () => this.applyAutoMap());
        document.getElementById('epg-automap-batches')?.addEventListener('click', (e) => {
            const button = e.target?.closest?.('button[data-batch]');
            if (button) this.undoAutoMap(button.dataset.batch);
        });

        document.getElementById('tab-epg')?.addEventListener('click', (e) => {
            const button = e.target?.closest?.('button[data-epg-action]');
            if (!button) return;
            const { epgAction, key, tvg } = button.dataset;
            if (epgAction === 'map') this.mapEpgChannel(key, tvg);
            else if (epgAction === 'search') this.selectEpgRow(key);
            else if (epgAction === 'unmap') this.mapEpgChannel(key, null);
        });
    }

    epgKey(row) {
        return `${row.sourceId}:${row.id}`;
    }

    setEpgStatus(text, isError = false) {
        const status = document.getElementById('epg-match-status');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('error', isError);
    }

    // ---- R10: auto-map --------------------------------------------------

    async previewAutoMap() {
        const panel = document.getElementById('epg-automap-panel');
        const list = document.getElementById('epg-automap-list');
        const apply = document.getElementById('epg-automap-apply');
        if (!panel || !list) return;
        panel.classList.remove('hidden');
        UI.setState(list, 'loading');
        try {
            const preview = await API.epg.autoMapPreview();
            const rows = preview.channels || [];
            list.innerHTML = rows.length
                ? `<p class="setting-hint">${rows.length} channel${rows.length === 1 ? '' : 's'} would be mapped:</p><ul>${rows.map(r =>
                    `<li>${UI.escape(r.name)} → ${UI.escape(r.epgName)} <span class="pig-amount">${Math.round(r.score * 100)}%</span></li>`).join('')}</ul>`
                : UI.stateBlock('empty', 'Nothing is a clear enough match to map automatically.');
            if (apply) apply.hidden = rows.length === 0;
            this.renderAutoMapBatches(preview.batches || []);
        } catch (err) {
            console.error('Auto-map preview failed:', err);
            UI.setState(list, 'error', 'The auto-map preview could not be loaded.', { run: () => this.previewAutoMap() });
        }
    }

    renderAutoMapBatches(batches) {
        const el = document.getElementById('epg-automap-batches');
        if (!el) return;
        el.innerHTML = batches.length ? `<h4>Automatic mappings in force</h4>${batches.map(b =>
            `<p>${new Date(b.at).toLocaleString()}: ${b.count} channel${b.count === 1 ? '' : 's'}
             <button type="button" class="btn btn-sm btn-secondary" data-batch="${UI.escape(b.batch)}">Undo</button></p>`).join('')}` : '';
    }

    async applyAutoMap() {
        try {
            const result = await API.epg.autoMapApply();
            this.setEpgStatus(`${result.mapped} channel${result.mapped === 1 ? '' : 's'} mapped automatically`);
            await this.loadEpgMatching();
            await this.previewAutoMap();
        } catch (err) {
            this.setEpgStatus('Auto-map failed: ' + err.message, true);
        }
    }

    async undoAutoMap(batch) {
        if (!confirm('Undo these automatic mappings? Any you have changed since are kept.')) return;
        try {
            const result = await API.epg.autoMapUndo(batch);
            this.setEpgStatus(`${result.removed} automatic mapping${result.removed === 1 ? '' : 's'} undone`);
            await this.loadEpgMatching();
            await this.previewAutoMap();
        } catch (err) {
            this.setEpgStatus('Undo failed: ' + err.message, true);
        }
    }

    async loadEpgMatching() {
        const list = document.getElementById('epg-match-list');
        try {
            const [unmatched, mappings] = await Promise.all([API.epg.unmatched(), API.epg.mappings()]);
            this.epgUnmatched = unmatched?.channels || [];
            this.epgMappings = Array.isArray(mappings) ? mappings : [];
            const total = unmatched?.total ?? this.epgUnmatched.length;
            this.setEpgStatus(`${total} channel${total === 1 ? '' : 's'} without programme information`);
            this.renderEpgMatching();
        } catch (err) {
            console.error('Guide matching failed to load:', err);
            UI.setState(list, 'error', 'The guide matching list could not be loaded.', { run: () => this.loadEpgMatching() }, { colspan: 3 });
        }
    }

    filteredEpgUnmatched() {
        const q = String(this.epgFilter || '').trim().toLowerCase();
        if (!q) return this.epgUnmatched;
        return this.epgUnmatched.filter(r => String(r.name || '').toLowerCase().includes(q));
    }

    epgCandidateButton(key, c) {
        const e = (v) => UI.escape(v);
        const score = typeof c.score === 'number' ? `<span class="epg-score">${Math.round(c.score * 100)}%</span>` : '';
        return `<button type="button" class="btn btn-secondary epg-candidate" data-epg-action="map" data-key="${e(key)}"
                    data-tvg="${e(c.tvgId)}" title="${e(c.tvgId)}">${e(c.name)}${score}</button>`;
    }

    renderEpgMatching() {
        const e = (v) => UI.escape(v);
        const list = document.getElementById('epg-match-list');
        if (list) {
            const rows = this.filteredEpgUnmatched();
            list.innerHTML = rows.length === 0
                ? `<tr class="state-row"><td colspan="3">${UI.stateBlock('empty', this.epgUnmatched.length
                    ? { title: 'No channels match', detail: 'Try a different filter.' } : 'Every channel has programme information')}</td></tr>`
                : rows.map(row => {
                    const key = this.epgKey(row);
                    const candidates = (row.candidates || []).map(c => this.epgCandidateButton(key, c)).join('');
                    return `
                <tr class="epg-match-row${this.epgSelected === key ? ' selected' : ''}">
                    <td>${e(row.name)}</td>
                    <td>${e(row.tvgId || '–')}${row.mapped ? ' <span class="setting-hint">(mapped)</span>' : ''}</td>
                    <td><div class="epg-candidates">${candidates}
                        <button type="button" class="btn btn-secondary epg-candidate" data-epg-action="search" data-key="${e(key)}">Search...</button>
                    </div></td>
                </tr>`;
                }).join('');
        }

        const mapped = document.getElementById('epg-mapping-list');
        if (mapped) {
            mapped.innerHTML = this.epgMappings.length === 0
                ? `<tr class="state-row"><td>${UI.stateBlock('empty', { title: 'No channels are mapped', detail: 'Pick a suggestion above to map one.' })}</td></tr>`
                : this.epgMappings.map(m => `
                <tr>
                    <td>${e(m.name || m.id || '–')}</td>
                    <td>${e(m.tvgId)}</td>
                    <td>${m.id ? `<button type="button" class="btn btn-secondary epg-candidate" data-epg-action="unmap" data-key="${e(`${m.sourceId}:${m.id}`)}">Remove</button>` : ''}</td>
                </tr>`).join('');
        }

        const panel = document.getElementById('epg-match-search-panel');
        const row = this.epgUnmatched.find(r => this.epgKey(r) === this.epgSelected);
        panel?.classList.toggle('hidden', !row);
        const label = document.getElementById('epg-match-search-for');
        if (label) label.textContent = row ? `Search the EPG for ${row.name}` : '';
        const results = document.getElementById('epg-match-search-results');
        if (results) {
            results.innerHTML = row
                ? (this.epgSearchResults.length
                    ? this.epgSearchResults.map(c => this.epgCandidateButton(this.epgSelected, c)).join('')
                    : '<span class="setting-hint">Type a name or EPG id</span>')
                : '';
        }
    }

    selectEpgRow(key) {
        this.epgSelected = this.epgSelected === key ? null : key;
        this.epgSearchResults = [];
        const search = document.getElementById('epg-match-search');
        const row = this.epgUnmatched.find(r => this.epgKey(r) === this.epgSelected);
        if (search) search.value = row ? row.name : '';
        this.renderEpgMatching();
        if (row) this.searchEpgChannels(row.name);
    }

    async searchEpgChannels(query) {
        if (!this.epgSelected) return;
        const q = String(query || '').trim();
        if (!q) { this.epgSearchResults = []; this.renderEpgMatching(); return; }
        try {
            this.epgSearchResults = await API.epg.searchChannels(q) || [];
        } catch (err) {
            this.epgSearchResults = [];
            this.setEpgStatus(err.message || 'Could not search the EPG', true);
        }
        this.renderEpgMatching();
    }

    /** Map the channel `key` (sourceId:id) to `tvgId`; null removes its mapping. */
    async mapEpgChannel(key, tvgId) {
        const [sourceText, ...rest] = String(key || '').split(':');
        const sourceId = parseInt(sourceText, 10);
        const channelId = rest.join(':');
        if (!Number.isFinite(sourceId) || !channelId) return;
        this.setEpgStatus('Saving...');
        try {
            await API.epg.setMapping(sourceId, channelId, tvgId);
            this.epgSelected = null;
            this.epgSearchResults = [];
            await this.loadEpgMatching();
            this.setEpgStatus(tvgId ? `Mapped to ${tvgId}` : 'Mapping removed');
            // The guide and channel list show the new programmes
            window.app?.channelList?.loadChannels?.();
            if (window.app?.epgGuide?.loaded) window.app.epgGuide.loadEpg();
        } catch (err) {
            this.setEpgStatus(err.message || 'Could not save the mapping', true);
        }
    }

    // ---- Sports tab (0149, contract C-I) --------------------------------
    //
    // The leagues that count as sport (GET /api/sports/follow: since D-42 the leagues any account follows, read-only; the
    // admin keyword list is retired) and, below, the events the server recognises in the next 72 hours (GET
    // /api/sports/preview) with the rule that matched and the channels (expandable). 0151: the preview is grouped by kind
    // (0150): Events, then Replays, then Shows and Placeholders collapsed (a click on the heading opens one); each row
    // says why it is that kind and lists the guide titles merged into it.

    initSports() {
        this.sportsKeywords = [];
        this.sportsEvents = [];
        this.sportsOpenKinds = new Set(['event', 'replay']);
        document.getElementById('sports-preview-list')?.addEventListener('click', (e) => {
            const button = e.target?.closest?.('button[data-sports-kind]');
            if (button) this.toggleSportsKind(button.dataset.sportsKind);
        });
    }

    toggleSportsKind(kind) {
        if (this.sportsOpenKinds.has(kind)) this.sportsOpenKinds.delete(kind);
        else this.sportsOpenKinds.add(kind);
        this.renderSportsPreview();
    }

    setSportsStatus(text, isError = false) {
        const status = document.getElementById('sports-status');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('error', isError);
    }

    async loadSports() {
        try {
            const follow = await API.sports.follow();
            this.sportsKeywords = [...(follow?.keywords || [])];
            this.renderSportsFollow();
        } catch (err) {
            console.error('Followed leagues failed to load:', err);
            UI.setState(document.getElementById('sports-follow-chips'), 'error', 'The followed leagues could not be loaded.', { run: () => this.loadSports() });
        }
        await this.loadSportsPreview();
    }

    async loadSportsPreview() {
        const list = document.getElementById('sports-preview-list');
        try {
            const preview = await API.sports.preview();
            this.sportsEvents = preview?.events || [];
            this.renderSportsPreview();
        } catch (err) {
            console.error('Sport preview failed to load:', err);
            UI.setState(list, 'error', 'The sport preview could not be loaded.', { run: () => this.loadSportsPreview() }, { colspan: 5 });
        }
    }

    renderSportsFollow() {
        const e = (v) => UI.escape(v);
        const chips = document.getElementById('sports-follow-chips');
        if (chips) {
            chips.innerHTML = this.sportsKeywords.length
                ? this.sportsKeywords.map(k => `<span class="btn btn-secondary epg-candidate sports-chip">${e(k)}</span>`).join('')
                : UI.stateBlock('empty', { title: 'No account follows a league yet', detail: 'Each account chooses its own under Your sport, above.' });
        }
    }

    sportsTime(ev) {
        const t = (ms) => UI.time(ms);
        const day = new Date(ev.start).toDateString() === new Date().toDateString()
            ? '' : `${new Date(ev.start).toLocaleDateString([], { weekday: 'short' })} `;
        return `${day}${t(ev.start)} – ${t(ev.end)}`;
    }

    renderSportsPreview() {
        const e = (v) => UI.escape(v);
        const list = document.getElementById('sports-preview-list');
        if (!list) return;
        if (this.sportsEvents.length === 0) {
            UI.setState(list, 'empty', 'No sport recognised in the next 72 hours', null, { colspan: 5 });
            return;
        }
        const rules = { keyword: 'Keyword', category: 'EPG category', sportChannel: 'Sport category, live title' };
        const groups = [['event', 'Events'], ['replay', 'Replays'], ['show', 'Shows'], ['placeholder', 'Placeholders']];
        const row = (ev) => {
            const n = (ev.channels || []).length;
            const names = (ev.channels || []).map(c => `<li>${c.number ? `${e(c.number)} ` : ''}${e(c.name)}${c.quality ? ` <span class="setting-hint">${e(c.quality)}</span>` : ''}</li>`).join('');
            const aliases = (ev.aliases || []).filter(a => a !== ev.title);
            const titles = aliases.length
                ? `<details class="sports-aliases"><summary>${aliases.length} guide title${aliases.length === 1 ? '' : 's'}</summary><ul class="sports-channel-list">${aliases.map(a => `<li>${e(a)}</li>`).join('')}</ul></details>`
                : '';
            return `
                <tr class="sports-event-row">
                    <td>${e(this.sportsTime(ev))}${ev.live ? ' <span class="status-event status-failure">LIVE</span>' : ''}</td>
                    <td>${e(ev.title)}${titles}</td>
                    <td>${e(ev.league)}</td>
                    <td>${e(rules[ev.rule] || ev.rule || '–')}${ev.match ? `<div class="setting-hint">${e(ev.match)}</div>` : ''}${ev.kindRule ? `<div class="setting-hint">${e(ev.kindRule)}</div>` : ''}</td>
                    <td><details><summary>${n} channel${n === 1 ? '' : 's'}</summary><ul class="sports-channel-list">${names}</ul></details></td>
                </tr>`;
        };
        list.innerHTML = groups.map(([kind, label]) => {
            const items = this.sportsEvents.filter(ev => (ev.kind || 'event') === kind);
            if (!items.length) return '';
            const open = this.sportsOpenKinds.has(kind);
            return `
                <tr class="sports-kind-row"><th colspan="5">
                    <button type="button" class="sports-kind-toggle" data-sports-kind="${kind}" aria-expanded="${open}">${open ? '▾' : '▸'} ${label} (${items.length})</button>
                </th></tr>${open ? items.map(row).join('') : ''}`;
        }).join('');
    }

    initPlayerSettings() {
        const arrowKeysToggle = document.getElementById('setting-arrow-keys');
        const overlayDurationInput = document.getElementById('setting-overlay-duration');
        const defaultVolumeSlider = document.getElementById('setting-default-volume');
        const volumeValueDisplay = document.getElementById('volume-value');
        const rememberVolumeToggle = document.getElementById('setting-remember-volume');

        // Load current settings
        if (this.app.player?.settings) {
            arrowKeysToggle.checked = this.app.player.settings.arrowKeysChangeChannel;
            overlayDurationInput.value = this.app.player.settings.overlayDuration;
            defaultVolumeSlider.value = this.app.player.settings.defaultVolume;
            volumeValueDisplay.textContent = this.app.player.settings.defaultVolume + '%';
            rememberVolumeToggle.checked = this.app.player.settings.rememberVolume;
        }

        // Arrow keys toggle
        arrowKeysToggle.addEventListener('change', () => {
            this.app.player.settings.arrowKeysChangeChannel = arrowKeysToggle.checked;
            this.savePlayerSetting('arrowKeysChangeChannel');
        });

        // Overlay duration
        overlayDurationInput.addEventListener('change', () => {
            this.app.player.settings.overlayDuration = parseInt(overlayDurationInput.value) || 5;
            this.savePlayerSetting('overlayDuration');
        });

        // Default volume slider
        defaultVolumeSlider.addEventListener('input', () => {
            volumeValueDisplay.textContent = defaultVolumeSlider.value + '%';
        });
        defaultVolumeSlider.addEventListener('change', () => {
            this.app.player.settings.defaultVolume = parseInt(defaultVolumeSlider.value);
            this.savePlayerSetting('defaultVolume');
        });

        // Remember volume toggle
        rememberVolumeToggle.addEventListener('change', () => {
            this.app.player.settings.rememberVolume = rememberVolumeToggle.checked;
            this.savePlayerSetting('rememberVolume');
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
    }

    /** The transcoding panel's change handlers; its values come from loadTranscodeSettings when it is shown. */
    initTranscodingSettings() {
        // Encoder settings
        const hwEncoderSelect = document.getElementById('setting-hw-encoder');
        const maxResolutionSelect = document.getElementById('setting-max-resolution');
        const qualitySelect = document.getElementById('setting-quality');

        // User-Agent (Transcoding tab versions)
        const userAgentSelect = document.getElementById('setting-user-agent-tc');
        const userAgentCustomInput = document.getElementById('setting-user-agent-custom-tc');
        const customUaContainer = document.getElementById('custom-user-agent-container-tc');

        // Event listeners for encoder settings
        hwEncoderSelect?.addEventListener('change', () => {
            this.app.player.settings.hwEncoder = hwEncoderSelect.value;
            this.savePlayerSetting('hwEncoder');
        });

        maxResolutionSelect?.addEventListener('change', () => {
            this.app.player.settings.maxResolution = maxResolutionSelect.value;
            this.savePlayerSetting('maxResolution');
        });

        qualitySelect?.addEventListener('change', () => {
            this.app.player.settings.quality = qualitySelect.value;
            this.savePlayerSetting('quality');
        });

        // Audio Mix Preset
        const audioMixSelect = document.getElementById('setting-audio-mix');
        if (audioMixSelect) {
            audioMixSelect.addEventListener('change', () => {
                this.app.player.settings.audioMixPreset = audioMixSelect.value;
                this.savePlayerSetting('audioMixPreset');
            });
        }

        // Upscaling Settings
        const upscaleEnabledToggle = document.getElementById('setting-upscale-enabled');
        const upscaleMethodSelect = document.getElementById('setting-upscale-method');
        const upscaleTargetSelect = document.getElementById('setting-upscale-target');
        const upscaleMethodContainer = document.getElementById('upscale-method-container');
        const upscaleTargetContainer = document.getElementById('upscale-target-container');

        // Helper to toggle upscale options visibility
        const toggleUpscaleOptions = (enabled) => {
            if (upscaleMethodContainer) upscaleMethodContainer.style.display = enabled ? 'flex' : 'none';
            if (upscaleTargetContainer) upscaleTargetContainer.style.display = enabled ? 'flex' : 'none';
        };

        // Upscaling event handlers
        upscaleEnabledToggle?.addEventListener('change', () => {
            this.app.player.settings.upscaleEnabled = upscaleEnabledToggle.checked;
            this.savePlayerSetting('upscaleEnabled');
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        });

        upscaleMethodSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleMethod = upscaleMethodSelect.value;
            this.savePlayerSetting('upscaleMethod');
        });

        upscaleTargetSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleTarget = upscaleTargetSelect.value;
            this.savePlayerSetting('upscaleTarget');
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
    }

    /** The transcoding panel's values from GET /api/settings (#276: was fetched at start, with defaults on failure). */
    applyTranscodeSettings(s) {
        const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
        set('setting-hw-encoder', s.hwEncoder || 'auto');
        set('setting-max-resolution', s.maxResolution || '1080p');
        set('setting-quality', s.quality || 'medium');
        set('setting-user-agent-tc', s.userAgentPreset || 'chrome');
        set('setting-user-agent-custom-tc', s.userAgentCustom || '');
        set('setting-audio-mix', s.audioMixPreset || 'auto');
        set('setting-upscale-method', s.upscaleMethod || 'hardware');
        set('setting-upscale-target', s.upscaleTarget || '1080p');
        const customUa = document.getElementById('custom-user-agent-container-tc');
        if (customUa) customUa.style.display = (s.userAgentPreset || 'chrome') === 'custom' ? 'flex' : 'none';
        const upscale = document.getElementById('setting-upscale-enabled');
        if (upscale) upscale.checked = !!s.upscaleEnabled;
        for (const id of ['upscale-method-container', 'upscale-target-container']) {
            const el = document.getElementById(id);
            if (el) el.style.display = s.upscaleEnabled ? 'flex' : 'none';
        }
    }

    /**
     * Load and display hardware info in Transcoding tab
     */
    async loadHardwareInfo({ redetect = false } = {}) {
        const container = document.getElementById('hw-info-container');
        if (!container) return;

        try {
            // #61 (0367): "Re-detect GPU" probes again (a device passed through after the container started).
            const hwInfo = await API.request(redetect ? 'POST' : 'GET', redetect ? '/settings/hw-info/refresh' : '/settings/hw-info');
            const e = (v) => UI.escape(v);

            const detected = [];

            // Only show detected hardware
            if (hwInfo.nvidia?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ NVIDIA</span>
                    <span class="hw-name">${e(hwInfo.nvidia.name)}</span>
                </div>`);
            }

            if (hwInfo.amf?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ AMD</span>
                    <span class="hw-name">${e(hwInfo.amf.name || 'Available')}</span>
                </div>`);
            }

            if (hwInfo.qsv?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ Intel QSV</span>
                    <span class="hw-name">Available</span>
                </div>`);
            }

            if (hwInfo.vaapi?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ VAAPI</span>
                    <span class="hw-name">${e(hwInfo.vaapi.device || 'Available')}</span>
                </div>`);
            }

            let html;
            if (detected.length > 0) {
                html = `<div class="hw-info-grid">${detected.join('')}</div>`;
                html += `<p class="hint" style="margin-top: var(--space-sm);">Recommended encoder: <strong>${e(hwInfo.recommended)}</strong></p>`;
            } else {
                html = `<p class="hint">No GPU acceleration detected. Using software encoding.</p>`;
            }

            html += `<p style="margin-top: var(--space-sm);"><button type="button" class="btn btn-sm btn-secondary" data-hw-redetect>Re-detect GPU</button>`
                + `${redetect ? ' <span class="setting-hint">Detected again just now.</span>' : ''}</p>`;
            container.innerHTML = html;
            this.wireHwRedetect(container);
        } catch (err) {
            console.error('Error loading hardware info:', err);
            UI.setState(container, 'error', 'The hardware information could not be loaded.', { run: () => this.loadHardwareInfo({ redetect }) });
        }
    }

    wireHwRedetect(container) {
        const button = container.querySelector?.('[data-hw-redetect]');
        button?.addEventListener('click', () => {
            button.disabled = true;
            button.textContent = 'Detecting…';
            this.loadHardwareInfo({ redetect: true });
        });
    }

    initUserManagement() {
        // User tab visibility is handled in show() method
        // when currentUser is available

        // Handle add user form
        const addUserForm = document.getElementById('add-user-form');
        if (addUserForm) {
            addUserForm.addEventListener('submit', async (e) => {
                e.preventDefault();

                const username = document.getElementById('new-username').value;
                const password = document.getElementById('new-password').value;
                const role = document.getElementById('new-role').value;

                try {
                    await API.users.create({ username, password, role });
                    UI.toast('User created.');
                    addUserForm.reset();
                    this.loadUsers();
                } catch (err) {
                    UI.toast('Could not create the user: ' + err.message, { kind: 'error' });
                }
            });
        }
    }

    async loadUsers() {
        const userList = document.getElementById('user-list');
        if (!userList) return;

        try {
            const users = await API.users.getAll();
            // Store users in memory for easy access during edit
            this.users = users;

            if (users.length === 0) {
                UI.setState(userList, 'empty', { title: 'No users yet', detail: 'Add one below.' }, null, { colspan: 4 });
                return;
            }

            const e = (v) => UI.escape(v);
            userList.innerHTML = users.map(user => {
                const typeBadge = '<span class="user-badge user-badge-local">Local</span>';

                const roleBadge = user.role === 'admin'
                    ? '<span class="user-badge user-badge-admin">Admin</span>'
                    : '<span class="user-badge user-badge-viewer">Viewer</span>';

                return `
                <tr>
                    <td>
                        <div style="display:flex;align-items:center;gap:var(--space-sm);">
                            <strong>${e(user.username)}</strong>
                            ${typeBadge}
                        </div>
                    </td>
                    <td>${roleBadge}</td>
                    <td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}</td>
                    <td>
                        <button type="button" class="btn btn-sm btn-secondary" data-user-action="edit" data-user-id="${e(user.id)}">Edit</button>
                        <button type="button" class="btn btn-sm btn-error" data-user-action="delete" data-user-id="${e(user.id)}">Delete</button>
                    </td>
                </tr>
            `}).join('');

            // The buttons find their user by id in this.users, so no name is put into script.
            userList.querySelectorAll('[data-user-action]').forEach(button => {
                button.addEventListener('click', () => {
                    const user = this.users.find(u => String(u.id) === button.dataset.userId);
                    if (!user) return;
                    if (button.dataset.userAction === 'edit') this.openEditUserModal(user.id);
                    else this.deleteUser(user.id, user.username);
                });
            });
        } catch (err) {
            console.error('Error loading users:', err);
            UI.setState(userList, 'error', 'The users could not be loaded.', { run: () => this.loadUsers() }, { colspan: 4 });
        }
    }

    openEditUserModal(userId) {
        console.log('openEditUserModal called with ID:', userId, 'Type:', typeof userId);
        console.log('Current users list:', this.users);

        const user = this.users.find(u => u.id === userId);
        if (!user) {
            console.error('User not found in this.users cache!');
            console.log('Available IDs:', this.users.map(u => u.id));
            return;
        }
        console.log('User found:', user);

        const modal = document.getElementById('edit-user-modal');
        if (!modal) {
            console.error('CRITICAL: Modal element #edit-user-modal not found in DOM!');
            UI.toast('The edit window is missing. Refresh the page and try again.', { kind: 'error' });
            return;
        }

        // Populate form with null checks
        try {
            const editId = document.getElementById('edit-user-id');
            const editUsername = document.getElementById('edit-username');
            const editRole = document.getElementById('edit-role');
            const editPassword = document.getElementById('edit-password');

            console.log('Form elements found:', { editId, editUsername, editRole, editPassword });

            if (editId) editId.value = user.id;
            if (editUsername) editUsername.value = user.username;
            if (editRole) editRole.value = user.role;
            if (editPassword) editPassword.value = '';

            // A previous edit may have left the password field in another state; reset it.
            const passwordHint = document.getElementById('edit-password-hint');
            if (editPassword) {
                editPassword.disabled = false;
                editPassword.placeholder = "Leave blank to keep current";
            }
            if (passwordHint) passwordHint.textContent = "Optional. Leave blank to keep unchanged.";

            // Show it: Escape, the backdrop, the close button and Cancel close it; focus returns to the Edit button.
            this.setupModalHandlers(modal).open();
        } catch (err) {
            console.error('Error populating modal:', err);
            UI.toast('Could not open the edit window: ' + err.message, { kind: 'error' });
        }
    }

    setupModalHandlers(modal) {
        const dialog = UI.dialog.attach(modal);
        if (this.modalHandlersSetup) return dialog;

        const saveBtn = document.getElementById('edit-user-save');
        const closeModal = () => dialog.close();

        // Save Handler
        saveBtn.onclick = async () => {
            const userId = document.getElementById('edit-user-id').value;
            const updates = {
                username: document.getElementById('edit-username').value,
                role: document.getElementById('edit-role').value
            };

            const newPassword = document.getElementById('edit-password').value;
            if (newPassword && !document.getElementById('edit-password').disabled) {
                updates.password = newPassword;
            }

            try {
                await API.users.update(userId, updates);
                closeModal();
                this.loadUsers();
            } catch (err) {
                UI.toast('Could not update the user: ' + err.message, { kind: 'error' });
            }
        };

        this.modalHandlersSetup = true;
        return dialog;
    }


    async deleteUser(userId, username) {
        if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
            return;
        }

        try {
            await API.users.delete(userId);
            this.loadUsers();
        } catch (err) {
            UI.toast('Could not delete the user: ' + err.message, { kind: 'error' });
        }
    }

    /**
     * 0182: six tabs over the same panels. `name` is a tab or one of its panels:
     *   channels  one panel at a time, picked on the strip under the tabs
     *   playback, system  their panels one under the other
     *   backuplinks  belongs to Providers (opened from a backup's card)
     */
    switchTab(name) {
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
        this.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        this.tabContents.forEach(c => c.classList.toggle('active', panels.some(p => c.id === `tab-${p}`)));
        document.getElementById('subtabs-channels')?.classList.toggle('hidden', tab !== 'channels');
        document.querySelectorAll('.subtabs .subtab').forEach(sub => sub.classList.toggle('active', panels.includes(sub.dataset.subtab)));
    }

    isAdmin() {
        return this.app.currentUser?.role === 'admin';
    }

    /** R8 (pilot): the provider picker and its groups, with what each holds or skipped. */
    async loadImportExclusions() {
        const select = document.getElementById('import-exclusions-provider');
        if (!select) return;
        if (!this._importExclusionsWired) {
            this._importExclusionsWired = true;
            select.addEventListener('change', () => this.renderImportExclusions(select.value));
            document.getElementById('import-exclusions-save')?.addEventListener('click', () => this.saveImportExclusions());
        }
        try {
            const providers = await API.sources.providers();
            const current = select.value;
            select.innerHTML = providers.map(p => `<option value="${p.id}">${UI.escape(p.name)}</option>`).join('');
            if (current && providers.some(p => String(p.id) === current)) select.value = current;
            if (select.value) await this.renderImportExclusions(select.value);
        } catch (err) {
            console.error('Failed to load import exclusions:', err);
            UI.setState(document.getElementById('import-exclusions-list'), 'error', 'The providers could not be loaded.', { run: () => this.loadImportExclusions() });
        }
    }

    async renderImportExclusions(sourceId) {
        const list = document.getElementById('import-exclusions-list');
        if (!list || !sourceId) return;
        UI.setState(list, 'loading');
        try {
            const { groups } = await API.sources.importExclusions(sourceId);
            if (!groups.length) { UI.setState(list, 'empty', { title: 'No live groups yet', detail: 'Sync this provider first (its card, above).' }); return; }
            list.innerHTML = groups.map(g => {
                const size = g.excluded
                    ? (g.skippedAtLastSync == null ? 'excluded from the next sync' : `${g.skippedAtLastSync} skipped at the last sync`)
                    : `${g.imported} channels`;
                return `<label class="setting-item import-exclusion">
                    <input type="checkbox" value="${UI.escape(g.id)}" ${g.excluded ? 'checked' : ''}>
                    <span>${UI.escape(g.name)}</span> <span class="hint">${UI.escape(size)}</span>
                </label>`;
            }).join('');
        } catch (err) {
            console.error('Import exclusion groups failed to load:', err);
            UI.setState(list, 'error', 'The groups could not be loaded.', { run: () => this.renderImportExclusions(sourceId) });
        }
    }

    async saveImportExclusions() {
        const select = document.getElementById('import-exclusions-provider');
        const status = document.getElementById('import-exclusions-status');
        const ids = [...document.querySelectorAll('#import-exclusions-list input[type="checkbox"]:checked')].map(i => i.value);
        try {
            await API.sources.setImportExclusions(select.value, ids);
            if (status) status.textContent = 'Saved. It applies at the next sync.';
        } catch (err) {
            if (status) status.textContent = err.message;
        }
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

    async show() {
        // 0182: an admin lands on Providers the first time, a viewer on Playback; after that,
        // on the tab they left.
        if (this.isAdmin()) {
            document.querySelectorAll('.tabs .admin-tab').forEach(t => { t.style.display = ''; });
            if (!this.openedOnce) this.switchTab('providers');
            else if (document.getElementById('tab-providers')?.classList.contains('active')) this.providers.load();
        } else if (!this.openedOnce) {
            this.switchTab('playback');
        }
        this.openedOnce = true;

        // Refresh ALL player settings from server
        if (this.app.player?.settings) {
            const s = this.app.player.settings;

            // Player settings
            const arrowKeysToggle = document.getElementById('setting-arrow-keys');
            const overlayDurationInput = document.getElementById('setting-overlay-duration');
            const defaultVolumeSlider = document.getElementById('setting-default-volume');
            const volumeValueDisplay = document.getElementById('volume-value');
            const rememberVolumeToggle = document.getElementById('setting-remember-volume');
            const epgRefreshSelect = document.getElementById('epg-refresh-interval');

            if (arrowKeysToggle) arrowKeysToggle.checked = s.arrowKeysChangeChannel;
            if (overlayDurationInput) overlayDurationInput.value = s.overlayDuration;
            if (defaultVolumeSlider) defaultVolumeSlider.value = s.defaultVolume;
            if (volumeValueDisplay) volumeValueDisplay.textContent = s.defaultVolume + '%';
            if (rememberVolumeToggle) rememberVolumeToggle.checked = s.rememberVolume;
            if (epgRefreshSelect) epgRefreshSelect.value = s.epgRefreshInterval || '24';
        }

        // Update EPG last refreshed display
        this.updateEpgLastRefreshed();
    }

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
            return hours < 24 ? `${hours} hour${hours === 1 ? '' : 's'} ago` : new Date(ms).toLocaleString();
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
                display.title = data.sources.flatMap(src => (src.feeds || []).map(f => `${src.name} ${label[f.type] || f.type}: ${f.status}, ${new Date(f.at).toLocaleString()}`)).join('\n');
            } else if (data.lastSyncTime) {
                const at = new Date(data.lastSyncTime).getTime();
                display.textContent = ago(at);
                display.title = new Date(at).toLocaleString();
            } else {
                display.textContent = 'Never';
                display.title = 'Sync has not run yet since server started';
            }
        } catch (err) {
            console.error('Error fetching sync status:', err);
            display.title = '';
            UI.setState(display, 'error', 'The last sync time could not be loaded.', { run: () => this.updateEpgLastRefreshed() });
        }
    }

    hide() {
        // Page is hidden
    }
}

/**
 * #19 (0363): what a device is and runs, from the app's own X-PigTV-Client (GET /api/devices `app`):
 * "Apple TV · tvOS 26.1 · PigTV 84", or the platform alone before the app has said.
 */
SettingsPage.deviceLine = (app, platform) => {
    if (!app) return `${platform || 'unknown'} · app version not reported yet`;
    if (!app.build) return app.text;
    return [app.kind || app.model, app.os, `PigTV ${app.build}`].filter(Boolean).join(' · ');
};

SettingsPage.GROUPS = { channels: ['content', 'lineup', 'epg'], playback: ['player', 'transcode'], system: ['ui', 'devices', 'users'] };

window.SettingsPage = SettingsPage;
