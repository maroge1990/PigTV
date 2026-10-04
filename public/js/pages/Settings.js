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
        this.initDevices();
        this.initRecordingSettings();
        this.initUiSettings();
        this.initLineup();
        this.initEpgMatching();
        this.initSports();
        this.providers = new ProvidersSettings();
        this.backupLinks = new BackupLinksSettings();
        document.getElementById('links-back')?.addEventListener('click', () => this.switchTab('providers'));
    }

    /** 0182: the backup links of one provider, opened from its card. */
    showBackupLinks(providerId) {
        if (providerId != null) this.backupLinks.filters.backupSourceId = String(providerId);
        this.switchTab('backuplinks');
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
        bind('setting-relay-enabled', 'relayEnabled');
        bind('setting-standby-enabled', 'standbyEnabled');
        bind('setting-warm-next-channel', 'warmNextChannel'); // R11
        // 0203: turning recovery off also turns the standby off (it cannot run without it), and
        // says so: a ticked-but-greyed switch read as "still on".
        relay?.addEventListener('change', async () => {
            if (!standby) return;
            standby.disabled = !relay.checked;
            if (!relay.checked && standby.checked) {
                standby.checked = false;
                try { await API.settings.update({ standbyEnabled: false }); } catch (err) { console.error('Failed to save standbyEnabled:', err); }
            }
        });
    }

    async loadHwDecodeSettings() {
        const hw = document.getElementById('setting-vaapi-hw-decode');
        if (!hw) return;
        try {
            const s = await API.settings.get();
            hw.checked = s.vaapiHwDecode !== false;
            const cpu = document.getElementById('setting-vaapi-cpu-scale');
            if (cpu) cpu.checked = s.vaapiCpuScale !== false;
            const relay = document.getElementById('setting-relay-enabled');
            const standby = document.getElementById('setting-standby-enabled');
            if (relay) relay.checked = s.relayEnabled === true;
            if (standby) {
                // Never shown ticked while recovery is off: the server treats it as off then.
                standby.checked = s.standbyEnabled === true && s.relayEnabled === true;
                standby.disabled = s.relayEnabled !== true;
            }
            const warm = document.getElementById('setting-warm-next-channel');
            if (warm) warm.checked = s.warmNextChannel === true;
        } catch (err) {
            console.error('Failed to load hardware decode settings:', err);
        }
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
                list.innerHTML = '<span class="setting-hint">No devices paired yet</span>';
                return;
            }
            list.innerHTML = active.map(d => {
                const seen = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never';
                return `
                <div class="setting-item">
                    <div class="setting-info">
                        <span class="setting-label">${d.name || 'Unnamed device'}</span>
                        <span class="setting-hint">${d.platform || 'unknown'} · last seen ${seen}</span>
                    </div>
                    <button class="btn btn-sm btn-danger" data-revoke="${d.id}">Remove</button>
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
            list.innerHTML = '<span class="setting-hint">Could not load devices</span>';
        }
    }

    // ---- Recording tab -------------------------------------------------

    initRecordingSettings() {
        const saveBtn = document.getElementById('dvr-settings-save');
        if (saveBtn) saveBtn.addEventListener('click', () => this.saveRecordingSettings());
    }

    async loadRecordingSettings() {
        const path = document.getElementById('dvr-setting-path');
        if (!path) return;
        try {
            const s = await API.settings.get();
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
        } catch (err) {
            console.error('Failed to load recording settings:', err);
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
        this.lineupQuery = '';
        this.lineupCategoryNames = new Map();

        const search = document.getElementById('lineup-search');
        let timer;
        search?.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                this.lineupQuery = search.value;
                this.renderLineup();
            }, 200);
        });

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

    escapeLineup(text) {
        return String(text ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
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
            if (list) list.innerHTML = `<tr><td colspan="3" class="hint">Could not load the channel numbers: ${this.escapeLineup(err.message)}</td></tr>`;
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
            list.innerHTML = `<tr><td colspan="3" class="hint">${this.lineup.length ? 'No channels match' : 'No channels yet'}</td></tr>`;
            return;
        }
        list.innerHTML = rows.map(row => {
            const key = this.lineupKey(row);
            const edited = this.lineupEdits.has(key);
            const value = edited ? this.lineupEdits.get(key) : (row.number ?? '');
            return `
                <tr class="lineup-row${edited ? ' changed' : ''}">
                    <td><input type="text" inputmode="numeric" class="form-input lineup-number-input"
                               data-key="${this.escapeLineup(key)}" value="${this.escapeLineup(value)}"
                               aria-label="Number for ${this.escapeLineup(row.name)}"></td>
                    <td>${this.escapeLineup(row.name)}</td>
                    <td>${this.escapeLineup(this.lineupCategory(row))}</td>
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
        let filterTimer;
        filter?.addEventListener('input', () => {
            clearTimeout(filterTimer);
            filterTimer = setTimeout(() => { this.epgFilter = filter.value; this.renderEpgMatching(); }, 200);
        });

        const search = document.getElementById('epg-match-search');
        let searchTimer;
        search?.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => this.searchEpgChannels(search.value), 300);
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
            if (list) list.innerHTML = `<tr><td colspan="3" class="hint">Could not load the EPG matching list: ${this.escapeLineup(err.message)}</td></tr>`;
        }
    }

    filteredEpgUnmatched() {
        const q = String(this.epgFilter || '').trim().toLowerCase();
        if (!q) return this.epgUnmatched;
        return this.epgUnmatched.filter(r => String(r.name || '').toLowerCase().includes(q));
    }

    epgCandidateButton(key, c) {
        const e = (v) => this.escapeLineup(v);
        const score = typeof c.score === 'number' ? `<span class="epg-score">${Math.round(c.score * 100)}%</span>` : '';
        return `<button type="button" class="btn btn-secondary epg-candidate" data-epg-action="map" data-key="${e(key)}"
                    data-tvg="${e(c.tvgId)}" title="${e(c.tvgId)}">${e(c.name)}${score}</button>`;
    }

    renderEpgMatching() {
        const e = (v) => this.escapeLineup(v);
        const list = document.getElementById('epg-match-list');
        if (list) {
            const rows = this.filteredEpgUnmatched();
            list.innerHTML = rows.length === 0
                ? `<tr><td colspan="3" class="hint">${this.epgUnmatched.length ? 'No channels match' : 'Every channel has programme information'}</td></tr>`
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
                ? '<tr><td class="hint">No channels are mapped</td></tr>'
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
    // The follow list (GET/PUT /api/sports/follow) as chips: Add puts one in,
    // x takes one out, Save sends the whole list. Below it, the events the
    // server recognises in the next 72 hours (GET /api/sports/preview; 24 before 0153), with the
    // rule that matched and the channels (expandable), reloaded after a save.
    // 0151: the preview is grouped by kind (0150): Events, then Replays, then
    // Shows and Placeholders collapsed (a click on the heading opens one); each
    // row says why it is that kind and lists the guide titles merged into it.

    initSports() {
        this.sportsKeywords = [];
        this.sportsSaved = [];
        this.sportsEvents = [];
        this.sportsOpenKinds = new Set(['event', 'replay']);
        const input = document.getElementById('sports-follow-input');
        document.getElementById('sports-follow-add')?.addEventListener('click', () => this.addSportsKeyword(input?.value));
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.addSportsKeyword(input.value); }
        });
        document.getElementById('sports-follow-save')?.addEventListener('click', () => this.saveSportsFollow());
        // 0185: leagues are picked from a list, so they are spelt the way the server knows them.
        const leagueSelect = document.getElementById('sports-league-select');
        leagueSelect?.addEventListener?.('change', () => {
            if (leagueSelect.value) this.addSportsKeyword(leagueSelect.value);
            leagueSelect.value = '';
        });
        // ...and so are teams: a league first, then one of its teams ("NFL: Arizona Cardinals").
        const teamLeague = document.getElementById('sports-team-league');
        const teamSelect = document.getElementById('sports-team-select');
        teamLeague?.addEventListener?.('change', () => this.loadSportsTeams(teamLeague.value));
        teamSelect?.addEventListener?.('change', () => {
            if (teamSelect.value && teamLeague.value) this.addSportsKeyword(`${teamLeague.value}: ${teamSelect.value}`);
            teamSelect.value = '';
        });
        document.getElementById('sports-follow-chips')?.addEventListener('click', (e) => {
            const button = e.target?.closest?.('button[data-sports-remove]');
            if (button) this.removeSportsKeyword(Number(button.dataset.sportsRemove));
        });
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
            this.sportsSaved = [...this.sportsKeywords];
            this.sportsLeagues = Array.isArray(follow?.leagues) ? follow.leagues : [];
            this.renderSportsFollow();
        } catch (err) {
            this.setSportsStatus(`Could not load the follow list: ${err.message}`, true);
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
            if (list) list.innerHTML = `<tr><td colspan="5" class="hint">Could not load the preview: ${this.escapeLineup(err.message)}</td></tr>`;
        }
    }

    /** Fill the team list for a league (GET /api/sports/teams); hidden until a league is chosen. */
    async loadSportsTeams(league) {
        const select = document.getElementById('sports-team-select');
        if (!select) return;
        select.classList.toggle('hidden', !league);
        if (!league) return;
        select.innerHTML = '<option value="">Loading...</option>';
        try {
            const reply = await API.sports.teams(league);
            const e = (v) => this.escapeLineup(v);
            const teams = reply?.teams || [];
            select.innerHTML = teams.length
                ? '<option value="">Choose a team...</option>' + teams.map(t => `<option value="${e(t)}">${e(t)}</option>`).join('')
                : '<option value="">No team list for this league</option>';
        } catch (err) {
            select.innerHTML = '<option value="">Could not load the teams</option>';
            this.setSportsStatus(err.message || 'Could not load the teams', true);
        }
    }

    sportsDirty() {
        return JSON.stringify(this.sportsKeywords) !== JSON.stringify(this.sportsSaved);
    }

    addSportsKeyword(value) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        const input = document.getElementById('sports-follow-input');
        if (input) input.value = '';
        if (!text) return;
        if (this.sportsKeywords.some(k => k.toLowerCase() === text.toLowerCase())) {
            this.setSportsStatus(`Already following ${text}`);
            return;
        }
        this.sportsKeywords.push(text.slice(0, 60));
        this.renderSportsFollow();
    }

    removeSportsKeyword(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.sportsKeywords.length) return;
        this.sportsKeywords.splice(index, 1);
        this.renderSportsFollow();
    }

    renderSportsFollow() {
        const e = (v) => this.escapeLineup(v);
        const chips = document.getElementById('sports-follow-chips');
        if (chips) {
            chips.innerHTML = this.sportsKeywords.length
                ? this.sportsKeywords.map((k, i) => `<span class="btn btn-secondary epg-candidate sports-chip">${e(k)}
                    <button type="button" class="sports-chip-remove" data-sports-remove="${i}" title="Stop following ${e(k)}" aria-label="Remove ${e(k)}">&times;</button></span>`).join('')
                : '<span class="setting-hint">No keywords yet</span>';
        }
        // The leagues not followed yet; those with real fixture times first.
        const select = document.getElementById('sports-league-select');
        if (select) {
            const followed = new Set(this.sportsKeywords.map(k => k.toLowerCase()));
            const left = (this.sportsLeagues || []).filter(l => !followed.has(l.name.toLowerCase()));
            const options = (list) => list.map(l => `<option value="${e(l.name)}">${e(l.name)}</option>`).join('');
            const withTimes = left.filter(l => l.fixtures);
            const without = left.filter(l => !l.fixtures);
            select.innerHTML = '<option value="">Add a league...</option>'
                + (withTimes.length ? `<optgroup label="With real fixture times">${options(withTimes)}</optgroup>` : '')
                + (without.length ? `<optgroup label="From the guide only">${options(without)}</optgroup>` : '');
        }
        // Teams come from the leagues with a roster (not the motor sports or cricket).
        const teamLeague = document.getElementById('sports-team-league');
        if (teamLeague && !teamLeague.value) {
            const withTeams = (this.sportsLeagues || []).filter(l => l.teams);
            teamLeague.innerHTML = '<option value="">Add a team from...</option>'
                + withTeams.map(l => `<option value="${e(l.name)}">${e(l.name)}</option>`).join('');
        }
        const save = document.getElementById('sports-follow-save');
        if (save) save.disabled = !this.sportsDirty();
        if (this.sportsDirty()) this.setSportsStatus('Not saved yet');
    }

    async saveSportsFollow() {
        const save = document.getElementById('sports-follow-save');
        if (save) save.disabled = true;
        this.setSportsStatus('Saving...');
        try {
            const res = await API.sports.setFollow(this.sportsKeywords);
            this.sportsKeywords = [...(res?.keywords || [])];
            this.sportsSaved = [...this.sportsKeywords];
            this.renderSportsFollow();
            this.setSportsStatus('Saved');
            await this.loadSportsPreview();
        } catch (err) {
            if (save) save.disabled = false;
            this.setSportsStatus(err.message || 'Could not save the follow list', true);
        }
    }

    sportsTime(ev) {
        const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const day = new Date(ev.start).toDateString() === new Date().toDateString()
            ? '' : `${new Date(ev.start).toLocaleDateString([], { weekday: 'short' })} `;
        return `${day}${t(ev.start)} – ${t(ev.end)}`;
    }

    renderSportsPreview() {
        const e = (v) => this.escapeLineup(v);
        const list = document.getElementById('sports-preview-list');
        if (!list) return;
        if (this.sportsEvents.length === 0) {
            list.innerHTML = '<tr><td colspan="5" class="hint">No sport recognised in the next 72 hours</td></tr>';
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
            this.app.player.saveSettings();
        });

        // Overlay duration
        overlayDurationInput.addEventListener('change', () => {
            this.app.player.settings.overlayDuration = parseInt(overlayDurationInput.value) || 5;
            this.app.player.saveSettings();
        });

        // Default volume slider
        defaultVolumeSlider.addEventListener('input', () => {
            const value = defaultVolumeSlider.value;
            volumeValueDisplay.textContent = value + '%';
            this.app.player.settings.defaultVolume = parseInt(value);
            this.app.player.saveSettings();
        });

        // Remember volume toggle
        rememberVolumeToggle.addEventListener('change', () => {
            this.app.player.settings.rememberVolume = rememberVolumeToggle.checked;
            this.app.player.saveSettings();
        });

        // EPG refresh interval
        const epgRefreshSelect = document.getElementById('epg-refresh-interval');
        if (epgRefreshSelect && this.app.player?.settings) {
            // Load saved value from player settings
            epgRefreshSelect.value = this.app.player.settings.epgRefreshInterval || '24';

            // Save on change - server will restart its sync timer via PUT /api/settings
            epgRefreshSelect.addEventListener('change', () => {
                this.app.player.settings.epgRefreshInterval = epgRefreshSelect.value;
                this.app.player.saveSettings();
            });
        }

        // Update last refreshed display
        this.updateEpgLastRefreshed();
    }

    async initTranscodingSettings() {
        // Encoder settings
        const hwEncoderSelect = document.getElementById('setting-hw-encoder');
        const maxResolutionSelect = document.getElementById('setting-max-resolution');
        const qualitySelect = document.getElementById('setting-quality');

        // User-Agent (Transcoding tab versions)
        const userAgentSelect = document.getElementById('setting-user-agent-tc');
        const userAgentCustomInput = document.getElementById('setting-user-agent-custom-tc');
        const customUaContainer = document.getElementById('custom-user-agent-container-tc');

        // Fetch settings directly from API to avoid race condition with VideoPlayer
        let s;
        try {
            s = await API.settings.get();
        } catch (err) {
            console.warn('[Settings] Failed to load settings from API, using player defaults:', err);
            s = this.app.player?.settings || {};
        }

        if (hwEncoderSelect) hwEncoderSelect.value = s.hwEncoder || 'auto';
        if (maxResolutionSelect) maxResolutionSelect.value = s.maxResolution || '1080p';
        if (qualitySelect) qualitySelect.value = s.quality || 'medium';
        if (userAgentSelect) userAgentSelect.value = s.userAgentPreset || 'chrome';
        if (userAgentCustomInput) userAgentCustomInput.value = s.userAgentCustom || '';
        if (customUaContainer) {
            customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
        }

        // Event listeners for encoder settings
        hwEncoderSelect?.addEventListener('change', () => {
            this.app.player.settings.hwEncoder = hwEncoderSelect.value;
            this.app.player.saveSettings();
        });

        maxResolutionSelect?.addEventListener('change', () => {
            this.app.player.settings.maxResolution = maxResolutionSelect.value;
            this.app.player.saveSettings();
        });

        qualitySelect?.addEventListener('change', () => {
            this.app.player.settings.quality = qualitySelect.value;
            this.app.player.saveSettings();
        });

        // Audio Mix Preset
        const audioMixSelect = document.getElementById('setting-audio-mix');
        if (audioMixSelect) {
            audioMixSelect.value = s.audioMixPreset || 'auto';
            audioMixSelect.addEventListener('change', () => {
                this.app.player.settings.audioMixPreset = audioMixSelect.value;
                this.app.player.saveSettings();
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

        // Load upscaling settings
        if (upscaleEnabledToggle) {
            upscaleEnabledToggle.checked = s.upscaleEnabled || false;
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        }
        if (upscaleMethodSelect) upscaleMethodSelect.value = s.upscaleMethod || 'hardware';
        if (upscaleTargetSelect) upscaleTargetSelect.value = s.upscaleTarget || '1080p';

        // Upscaling event handlers
        upscaleEnabledToggle?.addEventListener('change', () => {
            this.app.player.settings.upscaleEnabled = upscaleEnabledToggle.checked;
            this.app.player.saveSettings();
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        });

        upscaleMethodSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleMethod = upscaleMethodSelect.value;
            this.app.player.saveSettings();
        });

        upscaleTargetSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleTarget = upscaleTargetSelect.value;
            this.app.player.saveSettings();
        });

        // User-Agent handlers
        const toggleCustomInput = () => {
            if (customUaContainer) {
                customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
            }
        };

        userAgentSelect?.addEventListener('change', () => {
            this.app.player.settings.userAgentPreset = userAgentSelect.value;
            this.app.player.saveSettings();
            toggleCustomInput();
        });

        userAgentCustomInput?.addEventListener('change', () => {
            this.app.player.settings.userAgentCustom = userAgentCustomInput.value;
            this.app.player.saveSettings();
        });
    }

    /**
     * Load and display hardware info in Transcoding tab
     */
    async loadHardwareInfo() {
        const container = document.getElementById('hw-info-container');
        if (!container) return;

        try {
            const hwInfo = await API.request('GET', '/settings/hw-info');

            const detected = [];

            // Only show detected hardware
            if (hwInfo.nvidia?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ NVIDIA</span>
                    <span class="hw-name">${hwInfo.nvidia.name}</span>
                </div>`);
            }

            if (hwInfo.amf?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ AMD</span>
                    <span class="hw-name">${hwInfo.amf.name || 'Available'}</span>
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
                    <span class="hw-name">${hwInfo.vaapi.device || 'Available'}</span>
                </div>`);
            }

            let html;
            if (detected.length > 0) {
                html = `<div class="hw-info-grid">${detected.join('')}</div>`;
                html += `<p class="hint" style="margin-top: var(--space-sm);">Recommended encoder: <strong>${hwInfo.recommended}</strong></p>`;
            } else {
                html = `<p class="hint">No GPU acceleration detected. Using software encoding.</p>`;
            }

            container.innerHTML = html;
        } catch (err) {
            console.error('Error loading hardware info:', err);
            container.innerHTML = '<p class="hint error">Failed to load hardware info</p>';
        }
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
                    alert('User created successfully!');
                    addUserForm.reset();
                    this.loadUsers();
                } catch (err) {
                    alert('Error creating user: ' + err.message);
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
                userList.innerHTML = '<tr><td colspan="5" class="hint">No users found</td></tr>';
                return;
            }

            userList.innerHTML = users.map(user => {
                const typeBadge = '<span class="user-badge user-badge-local">Local</span>';

                const roleBadge = user.role === 'admin'
                    ? '<span class="user-badge user-badge-admin">Admin</span>'
                    : '<span class="user-badge user-badge-viewer">Viewer</span>';

                return `
                <tr>
                    <td>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <strong>${user.username}</strong>
                            ${typeBadge}
                        </div>
                    </td>
                    <td>${user.email || '<span class="hint">-</span>'}</td>
                    <td>${roleBadge}</td>
                    <td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary" onclick="window.app.pages.settings.openEditUserModal(${user.id})">Edit</button>
                        <button class="btn btn-sm btn-error" onclick="window.app.pages.settings.deleteUser(${user.id}, '${user.username}')">Delete</button>
                    </td>
                </tr>
            `}).join('');
        } catch (err) {
            console.error('Error loading users:', err);
            userList.innerHTML = '<tr><td colspan="5" class="hint">Error loading users</td></tr>';
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
        console.log('Modal element:', modal);
        if (!modal) {
            console.error('CRITICAL: Modal element #edit-user-modal not found in DOM!');
            alert('Error: Modal not found. Please refresh the page.');
            return;
        }

        // Populate form with null checks
        try {
            const editId = document.getElementById('edit-user-id');
            const editUsername = document.getElementById('edit-username');
            const editEmail = document.getElementById('edit-email');
            const editRole = document.getElementById('edit-role');
            const editPassword = document.getElementById('edit-password');

            console.log('Form elements found:', { editId, editUsername, editEmail, editRole, editPassword });

            if (editId) editId.value = user.id;
            if (editUsername) editUsername.value = user.username;
            if (editEmail) editEmail.value = user.email || '';
            if (editRole) editRole.value = user.role;
            if (editPassword) editPassword.value = '';

            // A previous edit may have left the password field in another state; reset it.
            const passwordHint = document.getElementById('edit-password-hint');
            if (editPassword) {
                editPassword.disabled = false;
                editPassword.placeholder = "Leave blank to keep current";
            }
            if (passwordHint) passwordHint.textContent = "Optional. Leave blank to keep unchanged.";

            // Show modal
            console.log('Adding active class to modal...');
            modal.classList.add('active');
            console.log('Modal classes after add:', modal.classList.toString());

            // Setup Close/Cancel handlers (once)
            this.setupModalHandlers(modal);
            console.log('Modal should now be visible!');
        } catch (err) {
            console.error('Error populating modal:', err);
            alert('Error opening edit modal: ' + err.message);
        }
    }

    setupModalHandlers(modal) {
        if (this.modalHandlersSetup) return;

        const closeBtn = document.getElementById('edit-user-close');
        const cancelBtn = document.getElementById('edit-user-cancel');
        const saveBtn = document.getElementById('edit-user-save');

        const closeModal = () => modal.classList.remove('active');

        closeBtn.onclick = closeModal;
        cancelBtn.onclick = closeModal;

        // Click outside to close
        modal.onclick = (e) => {
            if (e.target === modal) closeModal();
        };

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
                // alert('User updated successfully!'); // Optional: Replace with toast?
                closeModal();
                this.loadUsers();
            } catch (err) {
                alert('Error updating user: ' + err.message);
            }
        };

        this.modalHandlersSetup = true;
    }


    async deleteUser(userId, username) {
        if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
            return;
        }

        try {
            await API.users.delete(userId);
            this.loadUsers();
        } catch (err) {
            alert('Error deleting user: ' + err.message);
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

    /** What a panel needs fetched when it comes into view. */
    loadPanel(panel) {
        if (panel === 'transcode') { this.loadHwDecodeSettings(); this.loadHardwareInfo(); }
        if (panel === 'devices') this.loadDevices();
        if (panel === 'recording') this.loadRecordingSettings();
        if (panel === 'ui') this.loadUiSettings();
        if (panel === 'lineup') this.loadLineup();
        if (panel === 'epg') this.loadEpgMatching();
        if (panel === 'sports') this.loadSports();
        if (panel === 'providers') this.providers.load();
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

        try {
            // Fetch last sync time from server
            const data = await API.request('GET', '/settings/sync-status');

            if (data.lastSyncTime) {
                const lastRefreshTime = new Date(data.lastSyncTime);

                // Format as relative time or absolute
                const now = new Date();
                const diffMs = now - lastRefreshTime;
                const diffMins = Math.floor(diffMs / 60000);
                const diffHours = Math.floor(diffMins / 60);

                let text;
                if (diffMins < 1) {
                    text = 'Just now';
                } else if (diffMins < 60) {
                    text = `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
                } else if (diffHours < 24) {
                    text = `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
                } else {
                    // Use absolute time for older refreshes
                    text = lastRefreshTime.toLocaleString();
                }

                display.textContent = text;
                display.title = lastRefreshTime.toLocaleString(); // Full timestamp on hover
            } else {
                display.textContent = 'Never';
                display.title = 'Sync has not run yet since server started';
            }
        } catch (err) {
            console.error('Error fetching sync status:', err);
            display.textContent = 'Unknown';
            display.title = 'Could not fetch sync status';
        }
    }

    hide() {
        // Page is hidden
    }
}

SettingsPage.GROUPS = { channels: ['content', 'lineup', 'epg'], playback: ['player', 'transcode'], system: ['ui', 'devices', 'users'] };

window.SettingsPage = SettingsPage;
