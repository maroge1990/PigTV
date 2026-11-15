/**
 * Settings › Channels › EPG matching (0134) and auto-map (R10).
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
    // ---- EPG matching tab (0134) ----------------------------------------
    //
    // GET /api/epg/unmatched lists the visible channels with no programmes in the
    // next 24 hours, each with up to five EPG channels whose names match best. A
    // suggestion button maps the channel (PUT /api/epg/mapping); "Search…" opens
    // a search of the EPG's whole channel list for that channel. Mapped channels
    // are listed below with a button to remove the mapping.

    initEpgMatching() {
        this.epgUnmatched = [];
        this.epgMappings = [];
        this.epgFilter = '';
        this.epgSelected = null;  // the row "Search…" was pressed on
        this.epgSearchResults = [];

        const filter = document.getElementById('epg-match-filter');
        // #276 (C2): filtering the list in memory waits for nothing; the search below asks the server, so it keeps its pause.
        filter?.addEventListener('input', () => { this.epgFilter = filter.value; this.renderEpgMatching(); });

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
    },

    epgKey(row) {
        return `${row.sourceId}:${row.id}`;
    },

    setEpgStatus(text, isError = false) {
        const status = document.getElementById('epg-match-status');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('error', isError);
    },

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
    },

    renderAutoMapBatches(batches) {
        const el = document.getElementById('epg-automap-batches');
        if (!el) return;
        el.innerHTML = batches.length ? `<h4>Automatic mappings in force</h4>${batches.map(b =>
            `<p><span class="pig-amount">${UI.escape(UI.dateTime(b.at))}</span>: <span class="pig-amount">${b.count}</span> channel${b.count === 1 ? '' : 's'}
             <button type="button" class="btn btn-sm btn-secondary" data-batch="${UI.escape(b.batch)}">Undo</button></p>`).join('')}` : '';
    },

    async applyAutoMap() {
        try {
            const result = await API.epg.autoMapApply();
            this.setEpgStatus(`${result.mapped} channel${result.mapped === 1 ? '' : 's'} mapped automatically`);
            await this.loadEpgMatching();
            await this.previewAutoMap();
        } catch (err) {
            this.setEpgStatus(UI.errorText(err, 'The channels could not be mapped.'), true);
        }
    },

    async undoAutoMap(batch) {
        // #276 (C12): this is itself an undo, so it needs no question: it happens at once, and Auto-map ("Map these") puts
        // the same suggestions back. Mappings changed by hand since are kept.
        try {
            const result = await API.epg.autoMapUndo(batch);
            this.setEpgStatus(`${result.removed} automatic mapping${result.removed === 1 ? '' : 's'} undone. Mappings you changed since are kept.`);
            await this.loadEpgMatching();
            await this.previewAutoMap();
        } catch (err) {
            this.setEpgStatus(UI.errorText(err, 'The automatic mappings could not be undone.'), true);
        }
    },

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
    },

    filteredEpgUnmatched() {
        const q = String(this.epgFilter || '').trim().toLowerCase();
        if (!q) return this.epgUnmatched;
        return this.epgUnmatched.filter(r => String(r.name || '').toLowerCase().includes(q));
    },

    epgCandidateButton(key, c) {
        const e = (v) => UI.escape(v);
        const score = typeof c.score === 'number' ? `<span class="epg-score">${Math.round(c.score * 100)}%</span>` : '';
        return `<button type="button" class="btn btn-secondary epg-candidate" data-epg-action="map" data-key="${e(key)}"
                    data-tvg="${e(c.tvgId)}" title="${e(c.tvgId)}">${e(c.name)}${score}</button>`;
    },

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
                        <button type="button" class="btn btn-secondary epg-candidate" data-epg-action="search" data-key="${e(key)}">Search…</button>
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
    },

    selectEpgRow(key) {
        this.epgSelected = this.epgSelected === key ? null : key;
        this.epgSearchResults = [];
        const search = document.getElementById('epg-match-search');
        const row = this.epgUnmatched.find(r => this.epgKey(r) === this.epgSelected);
        if (search) search.value = row ? row.name : '';
        this.renderEpgMatching();
        if (row) this.searchEpgChannels(row.name);
    },

    async searchEpgChannels(query) {
        if (!this.epgSelected) return;
        const q = String(query || '').trim();
        if (!q) { this.epgSearchResults = []; this.renderEpgMatching(); return; }
        try {
            this.epgSearchResults = await API.epg.searchChannels(q) || [];
        } catch (err) {
            this.epgSearchResults = [];
            this.setEpgStatus(UI.errorText(err, 'The search could not be finished.'), true);
        }
        this.renderEpgMatching();
    },

    /** Map the channel `key` (sourceId:id) to `tvgId`; null removes its mapping. */
    async mapEpgChannel(key, tvgId) {
        const [sourceText, ...rest] = String(key || '').split(':');
        const sourceId = parseInt(sourceText, 10);
        const channelId = rest.join(':');
        if (!Number.isFinite(sourceId) || !channelId) return;
        this.setEpgStatus('Saving…');
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
            this.setEpgStatus(UI.errorText(err, 'The mapping was not saved.'), true);
        }
    },
});
