/**
 * Settings › Providers › Groups never imported (R8, pilot).
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
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
    },

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
    },

    async saveImportExclusions() {
        const select = document.getElementById('import-exclusions-provider');
        const status = document.getElementById('import-exclusions-status');
        const ids = [...document.querySelectorAll('#import-exclusions-list input[type="checkbox"]:checked')].map(i => i.value);
        try {
            await API.sources.setImportExclusions(select.value, ids);
            if (status) status.textContent = 'Saved. It applies at the next sync.';
        } catch (err) {
            if (status) status.textContent = UI.errorText(err, 'The excluded groups were not saved.');
        }
    },
});
