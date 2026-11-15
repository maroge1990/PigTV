/**
 * Settings › Channels › Channel numbers (0123).
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
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

        // #276 (C2): the list is in memory, so it filters on every keystroke; nothing waits.
        const search = document.getElementById('lineup-search');
        search?.addEventListener('input', () => {
            this.lineupQuery = search.value;
            this.renderLineup();
        });

        document.getElementById('lineup-save')?.addEventListener('click', () => this.saveLineup());

        document.getElementById('lineup-list')?.addEventListener('input', (e) => {
            const input = e.target;
            if (!input?.classList?.contains('lineup-number-input')) return;
            this.editLineupNumber(input.dataset.key, input.value);
            input.closest('tr')?.classList.toggle('changed', this.lineupEdits.has(input.dataset.key));
            this.updateLineupSaveState();
            this.flagLineupDuplicates();
        });
    },

    lineupKey(row) {
        return `${row.sourceId}:${row.id}`;
    },

    setLineupStatus(text, isError = false) {
        const status = document.getElementById('lineup-status');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('error', isError);
    },

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
    },

    lineupCategory(row) {
        return this.lineupCategoryNames.get(`${row.sourceId}:${row.category}`) || row.category || '';
    },

    /** The rows matching the search: a number (exact or leading digits), a name or a category. */
    filteredLineup() {
        const q = String(this.lineupQuery || '').trim().toLowerCase();
        if (!q) return this.lineup;
        return this.lineup.filter(row =>
            (row.number !== null && row.number !== undefined && String(row.number).startsWith(q)) ||
            String(row.name || '').toLowerCase().includes(q) ||
            this.lineupCategory(row).toLowerCase().includes(q));
    },

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
        this.flagLineupDuplicates();
    },

    editLineupNumber(key, value) {
        const row = this.lineup.find(r => this.lineupKey(r) === key);
        if (!row) return;
        const typed = String(value ?? '').trim();
        const original = row.number === null || row.number === undefined ? '' : String(row.number);
        if (typed === original) this.lineupEdits.delete(key);
        else this.lineupEdits.set(key, typed);
    },

    /** What Save sends: only the changed rows. Anything not a whole number goes as typed, for the server to refuse. */
    lineupChanges() {
        const numbers = [];
        for (const [key, typed] of this.lineupEdits) {
            const row = this.lineup.find(r => this.lineupKey(r) === key);
            if (!row) continue;
            numbers.push({ sourceId: row.sourceId, id: row.id, number: /^\d+$/.test(typed) ? parseInt(typed, 10) : typed });
        }
        return numbers;
    },

    /**
     * #276 (C13): the numbers two channels would hold once the typed changes are saved: key -> the name of the other
     * channel. Only a clash with a typed change counts; the server still has the last word on the rest.
     */
    lineupDuplicates() {
        const holders = new Map(); // number -> the channels that would hold it
        for (const row of this.lineup) {
            const key = this.lineupKey(row);
            const typed = this.lineupEdits.has(key) ? this.lineupEdits.get(key) : (row.number === null || row.number === undefined ? '' : String(row.number));
            if (!/^\d+$/.test(typed)) continue;
            const number = String(parseInt(typed, 10));
            if (!holders.has(number)) holders.set(number, []);
            holders.get(number).push(row);
        }
        const clashes = new Map();
        for (const rows of holders.values()) {
            if (rows.length < 2 || !rows.some(r => this.lineupEdits.has(this.lineupKey(r)))) continue;
            for (const r of rows) clashes.set(this.lineupKey(r), rows.find(o => o !== r).name);
        }
        return clashes;
    },

    /** Write (or clear) the "already used" line under each visible number field. */
    flagLineupDuplicates() {
        const clashes = this.lineupDuplicates();
        document.querySelectorAll?.('#lineup-list .lineup-number-input')?.forEach(input => {
            UI.fieldError(input, clashes.has(input.dataset.key) ? `Also used by ${clashes.get(input.dataset.key)}.` : '', { alert: false });
        });
        this.setLineupStatus(clashes.size ? 'Two channels cannot have the same number.' : '', clashes.size > 0);
    },

    updateLineupSaveState() {
        const save = document.getElementById('lineup-save');
        if (save) save.disabled = this.lineupEdits.size === 0 || this.lineupDuplicates().size > 0;
    },

    async saveLineup() {
        const numbers = this.lineupChanges();
        if (numbers.length === 0) {
            this.setLineupStatus('No changes');
            return;
        }
        const save = document.getElementById('lineup-save');
        if (save) save.disabled = true;
        this.setLineupStatus('Saving…');
        try {
            await API.lineup.saveNumbers(numbers);
            await this.loadLineup();
            this.setLineupStatus(`Saved ${numbers.length} channel number${numbers.length === 1 ? '' : 's'}`);
            // The channel list and guide show numbers too
            window.app?.channelList?.loadChannels?.();
            if (window.app?.epgGuide?.loaded) window.app.epgGuide.loadEpg();
        } catch (err) {
            // The server words a refusal ("Duplicate number 5", "Channel numbers must be whole numbers ..."): UI.errorText adds it.
            this.setLineupStatus(UI.errorText(err, 'The channel numbers were not saved.'), true);
            this.updateLineupSaveState();
        }
    },
});
