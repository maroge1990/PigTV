/**
 * Source Manager Component
 * The Manage Content browser: which categories and channels of a provider are shown.
 * (Adding and editing providers moved to Settings -> Providers in 0182.)
 */

class SourceManager {
    constructor() {
        // Content browser state (live channels only since 0121: movies and series are gone)
        this.treeData = null; // { type: 'channels', sourceId, groups: [{ id, name, categoryId, items: [] }] }
        this.hiddenSet = new Set(); // Set of hidden item keys (current state)
        this.originalHiddenSet = new Set(); // Set of hidden item keys (state when loaded)
        this.expandedGroups = new Set(); // Set of expanded group IDs
        this.searchQuery = ''; // Search filter for content browser
        this.undoSnapshot = null; // #16: { sourceId, hidden } before the last save, for one-step Undo (#174: per provider)
        this.saving = false; // #175: one save at a time

        this.init();
    }

    /** #128: unsaved ticks that a reload, another source or leaving the page would lose. */
    isDirty() {
        if (!this.treeData) return false;
        if (this.hiddenSet.size !== this.originalHiddenSet.size) return true;
        for (const key of this.hiddenSet) if (!this.originalHiddenSet.has(key)) return true;
        return false;
    }

    /** #16: the counts a save would apply: channels newly shown and newly hidden, and the total shown after. */
    pendingCounts() {
        const visible = (set, group, item) => !set.has(`${item.type}:${item.id}`)
            && (!group.categoryId || !set.has(`${this.groupItemType()}:${group.categoryId}`));
        let show = 0, hide = 0, before = 0, after = 0;
        for (const group of this.treeData?.groups || []) {
            for (const item of group.items) {
                const was = visible(this.originalHiddenSet, group, item), now = visible(this.hiddenSet, group, item);
                if (was) before++;
                if (now) after++;
                if (!was && now) show++;
                if (was && !now) hide++;
            }
        }
        return { show, hide, before, after };
    }

    init() {
        this.initContentBrowser();
    }

    /**
     * Initialize content browser
     */
    initContentBrowser() {
        this.contentSourceSelect = document.getElementById('content-source-select');
        this.contentTree = document.getElementById('content-tree');

        // Source selection
        this.contentSourceSelect?.addEventListener('change', () => this.reloadContentTree());

        // Show All / Hide All buttons
        document.getElementById('content-show-all')?.addEventListener('click', () => this.setAllVisibility(true));
        document.getElementById('content-hide-all')?.addEventListener('click', () => this.setAllVisibility(false));

        // Save Changes button
        document.getElementById('content-save')?.addEventListener('click', () => this.saveContentChanges());
        document.getElementById('content-undo')?.addEventListener('click', () => this.undoLastSave());

        // #128: leaving the page with unsaved ticks asks first.
        window.addEventListener?.('beforeunload', (e) => {
            if (!this.isDirty()) return;
            e.preventDefault();
            e.returnValue = '';
        });

        // Search input
        const searchInput = document.getElementById('content-search');
        const searchClear = searchInput?.parentElement?.querySelector('.search-clear');

        searchInput?.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.toLowerCase().trim();
            this.renderTree();
        });

        searchClear?.addEventListener('click', () => {
            if (searchInput) {
                searchInput.value = '';
                this.searchQuery = '';
                this.renderTree();
            }
        });
    }

    /**
     * Reload content tree based on current type and source
     */
    reloadContentTree() {
        const sourceId = this.contentSourceSelect?.value;
        // #175: not while a save is running: it finishes on the provider it started on.
        if (this.saving) {
            if (this.contentSourceSelect && this.treeData) this.contentSourceSelect.value = String(this.treeData.sourceId);
            return;
        }
        // #128: another provider throws the unsaved ticks away: ask first.
        if (this.isDirty() && String(sourceId) !== String(this.treeData.sourceId)
            && !window.confirm('Discard the changes you have not saved?')) {
            if (this.contentSourceSelect) this.contentSourceSelect.value = String(this.treeData.sourceId);
            return;
        }
        if (!sourceId) {
            this.contentTree.innerHTML = '<p class="hint">Select a source to view groups and channels</p>';
            return;
        }
        this.loadContentTree(parseInt(sourceId));
    }

    /**
     * #10 (0359): "New on the provider": groups the provider added since the last sync. They arrive hidden, so the guide
     * and the TV do not fill up with thousands of channels; each can be shown here (at once), or the list cleared.
     */
    async loadNewGroups(sourceId) {
        const box = document.getElementById('content-new-groups');
        if (!box) return;
        let groups = [];
        try { groups = await API.channels.newGroups(sourceId); } catch { groups = []; }
        this.newGroups = Array.isArray(groups) ? groups : [];
        box.hidden = this.newGroups.length === 0;
        if (box.hidden) { box.innerHTML = ''; return; }
        const e = (v) => this.escapeHtml(String(v ?? ''));
        box.innerHTML = `<h3>New on the provider</h3>
            <p class="setting-hint">New groups arrive hidden, so the guide and the Apple TV do not fill up with thousands of channels. Show the ones you want.</p>
            ${this.newGroups.map(g => `<div class="setting-item new-group">
                <div class="setting-info"><span class="setting-label">${e(g.name)}</span>
                    <span class="setting-hint">${e(Number(g.channels || 0).toLocaleString())} channel${g.channels === 1 ? '' : 's'} · found ${e(new Date(g.foundAt).toLocaleDateString())}</span></div>
                <button type="button" class="btn btn-sm btn-secondary" data-new-group-look="${e(g.categoryId)}">Look inside</button>
                <button type="button" class="btn btn-sm btn-primary" data-new-group-show="${e(g.categoryId)}">Show</button>
            </div>`).join('')}
            <p><button type="button" class="btn btn-sm btn-ghost" data-new-groups-dismiss>Keep all hidden and clear this list</button></p>`;
        box.querySelectorAll('[data-new-group-show]').forEach(b => b.addEventListener('click', () => this.showNewGroup(b.dataset.newGroupShow, b)));
        box.querySelectorAll('[data-new-group-look]').forEach(b => b.addEventListener('click', () => this.lookInside(b.dataset.newGroupLook)));
        box.querySelector('[data-new-groups-dismiss]')?.addEventListener('click', () => this.dismissNewGroups());
    }

    /** Show a new group now (the server also takes it off the list), then redraw. */
    async showNewGroup(categoryId, button) {
        if (button) button.disabled = true;
        try {
            await API.channels.show(this.treeData.sourceId, this.groupItemType(), categoryId);
            const group = this.treeData.groups.find(g => String(g.categoryId) === String(categoryId));
            for (const set of [this.hiddenSet, this.originalHiddenSet]) {
                set.delete(`${this.groupItemType()}:${categoryId}`);
                group?.items.forEach(i => set.delete(`${i.type}:${i.id}`));
            }
            this.renderTree();
            await this.loadNewGroups(this.treeData.sourceId);
            try { await window.app?.channelList?.loadChannels?.(); } catch { /* the list reloads on its own */ }
        } catch (err) {
            alert(`Could not show the group: ${err.message || err}`);
            if (button) button.disabled = false;
        }
    }

    /** Open the group in the tree below (its channels can then be ticked one by one). */
    lookInside(categoryId) {
        const group = this.treeData?.groups.find(g => String(g.categoryId) === String(categoryId));
        if (!group) return;
        this.searchQuery = '';
        const search = document.getElementById('content-search');
        if (search) search.value = '';
        this.expandedGroups.add(group.id);
        this.renderTree();
        this.contentTree?.querySelector?.(`.content-group[data-group-id="${CSS.escape(group.id)}"]`)?.scrollIntoView?.({ block: 'start' });
    }

    async dismissNewGroups() {
        try {
            await API.channels.dismissNewGroups(this.treeData.sourceId);
            await this.loadNewGroups(this.treeData.sourceId);
        } catch (err) {
            alert(`Could not clear the list: ${err.message || err}`);
        }
    }

    /**
     * Load sources into content browser dropdown
     */
    async loadContentSources() {
        try {
            const sources = await API.sources.getAll();
            const select = document.getElementById('content-source-select');
            if (!select) return;

            // Keep the placeholder option
            select.innerHTML = '<option value="">Select a source...</option>';

            sources.filter(s => s.type === 'xtream' || s.type === 'm3u').forEach(source => {
                select.innerHTML += `<option value="${this.escapeHtml(source.id)}">${this.escapeHtml(source.name)} (${this.escapeHtml(source.type)})</option>`;
            });
            // #128: coming back to this tab keeps the provider (and any unsaved ticks) on screen.
            if (this.treeData?.sourceId) select.value = String(this.treeData.sourceId);
        } catch (err) {
            console.error('Error loading content sources:', err);
        }
    }

    /**
     * Load content tree for a source
     * Checked = Visible, Unchecked = Hidden
     *
     * 0121 (W2.1): one request, GET /api/sources/:id/catalogue?type=live (0120) -
     * every category and channel of the source, hidden ones included, with their
     * hidden flags - instead of the Xtream-emulation routes plus /channels/hidden.
     */
    async loadContentTree(sourceId) {
        // #174: an Undo belongs to the provider it was saved on.
        if (this.undoSnapshot && String(this.undoSnapshot.sourceId) !== String(sourceId)) {
            this.undoSnapshot = null;
            this.showUndo(false);
        }
        this.contentTree.innerHTML = '<p class="hint">Loading...</p>';
        this.treeData = { type: 'channels', sourceId, groups: [] };
        this.expandedGroups.clear();

        try {
            const { categories = [], channels = [] } = await API.sources.catalogue(sourceId);

            // The saved state, keyed as the save and bulk routes expect it
            this.hiddenSet = new Set([
                ...categories.filter(c => c.hidden).map(c => `group:${c.id}`),
                ...channels.filter(ch => ch.hidden).map(ch => `channel:${ch.id}`)
            ]);
            this.originalHiddenSet = new Set(this.hiddenSet); // Track original state for diffing

            // Groups in the provider's category order; a channel whose category is
            // not listed gets a group of its own, after them. Empty categories are
            // left out, as before.
            const groupMap = new Map();
            for (const cat of categories) {
                groupMap.set(String(cat.id), { id: String(cat.id), name: cat.name || String(cat.id), categoryId: cat.id, sport: cat.sport === true, type: 'group', items: [] });
            }
            for (const ch of channels) {
                const key = ch.categoryId !== null && ch.categoryId !== undefined ? String(ch.categoryId) : 'Uncategorized';
                if (!groupMap.has(key)) {
                    groupMap.set(key, { id: key, name: key, categoryId: ch.categoryId ?? null, type: 'group', items: [] });
                }
                groupMap.get(key).items.push({ id: String(ch.id), name: ch.name || 'Unknown', number: ch.number ?? null, type: 'channel' });
            }
            this.treeData.groups = [...groupMap.values()].filter(g => g.items.length > 0);

            this.renderTree();
            this.loadNewGroups(sourceId);

        } catch (err) {
            console.error('Error loading content tree:', err);
            this.contentTree.innerHTML = '<p class="hint" style="color: var(--color-error);">Error loading content</p>';
        }
    }

    /**
     * Get groups filtered by search query
     */
    getFilteredGroups() {
        if (!this.treeData?.groups) return [];
        if (!this.searchQuery) return this.treeData.groups;

        return this.treeData.groups
            .map(group => {
                // Check if group name matches
                const groupMatches = group.name.toLowerCase().includes(this.searchQuery);

                // Filter items that match
                const matchingItems = group.items.filter(item =>
                    item.name.toLowerCase().includes(this.searchQuery)
                );

                // Include group if name matches OR has matching items
                if (groupMatches || matchingItems.length > 0) {
                    return { ...group, items: groupMatches ? group.items : matchingItems };
                }
                return null;
            })
            .filter(Boolean);
    }

    /**
     * Render the full tree based on current state
     */
    renderTree() {
        const groups = this.getFilteredGroups();

        if (!groups.length) {
            const msg = this.searchQuery ? 'No matches found' : 'No content found';
            this.contentTree.innerHTML = `<p class="hint">${msg}</p>`;
            return;
        }

        const html = groups.map(group => this.getGroupHtml(group)).join('');
        this.contentTree.innerHTML = html;

        // Attach event listeners
        this.attachTreeListeners(this.contentTree);
    }

    /**
     * Get HTML for a group (and its items if expanded)
     */
    groupItemType() {
        return 'group';
    }

    getGroupHtml(group) {
        const isExpanded = this.expandedGroups.has(group.id);

        // The category's own record is authoritative. Deriving this from the
        // children instead let the two drift apart: a category could be hidden
        // in the database while its checkbox showed ticked because some
        // channels beneath it were visible, and because the displayed state
        // already matched what the user wanted, no change was ever saved. The
        // server filters on the category record, so those channels vanished
        // from Live TV with nothing in the UI to explain it.
        const groupKey = `${this.groupItemType()}:${group.categoryId}`;
        const checked = group.categoryId
            ? !this.hiddenSet.has(groupKey)
            : group.items.some(item => !this.hiddenSet.has(`${item.type}:${item.id}`));

        let itemsHtml = '';
        if (isExpanded) {
            itemsHtml = `<div class="content-channels">
                ${group.items.map(item => {
                const itemHidden = this.hiddenSet.has(`${item.type}:${item.id}`);
                return `
                    <label class="checkbox-label channel-item" title="${this.escapeHtml(item.name)}">
                        <input type="checkbox" class="channel-checkbox" 
                               data-type="${this.escapeHtml(String(item.type))}" 
                               data-id="${this.escapeHtml(String(item.id))}" 
                               data-source-id="${this.treeData.sourceId}" 
                               ${!itemHidden ? 'checked' : ''}>
                        <span class="channel-name">${item.number !== null && item.number !== undefined ? `<span class="channel-number pig-amount">${this.escapeHtml(item.number)}</span> ` : ''}${this.escapeHtml(item.name)}</span>
                    </label>`;
            }).join('')}
            </div>`;
        }

        return `
            <div class="content-group ${isExpanded ? '' : 'collapsed'}" data-group-id="${this.escapeHtml(group.id)}">
                <div class="content-group-header">
                    <span class="group-expander">${Icons.chevronDown}</span>
                    <label class="checkbox-label" onclick="event.stopPropagation()">
                        <input type="checkbox" class="group-checkbox" 
                               data-type="group" 
                               data-id="${this.escapeHtml(group.id)}" 
                               data-source-id="${this.treeData.sourceId}" 
                               ${checked ? 'checked' : ''}>
                        <span class="group-name">${this.escapeHtml(group.name)} (${group.items.length})</span>
                    </label>
                    ${group.categoryId !== null && group.categoryId !== undefined ? this.sportToggleHtml(group) : ''}
                </div>
                ${itemsHtml}
            </div>
        `;
    }

    /**
     * 0146 (C-H): the category's Sport toggle. Unlike visibility it saves at
     * once (PUT /api/library/categories/sport): it is one flag, not part of
     * the Save diff. Since 0148 (C-I) a sport category is one signal for sport
     * recognition: its channels' live-looking programmes count as sport.
     */
    sportToggleHtml(group) {
        return `<button type="button" class="btn btn-sm btn-ghost sport-toggle${group.sport ? ' active' : ''}"
                        data-category-id="${this.escapeHtml(group.categoryId)}"
                        aria-pressed="${group.sport ? 'true' : 'false'}"
                        title="Sport category: a live-looking programme on its channels (Live, vs, v) counts as sport (Settings → Sports)">Sport</button>`;
    }

    async toggleSport(button) {
        const group = (this.treeData?.groups || []).find(g => String(g.categoryId) === button.dataset.categoryId);
        if (!group) return;
        const want = !group.sport;
        button.disabled = true;
        try {
            const res = await API.library.setCategorySport(this.treeData.sourceId, group.categoryId, want);
            group.sport = res && res.sport === true;
        } catch (err) {
            console.error('Error saving sport category:', err);
            alert(`Could not save: ${err.message || err}`);
        }
        button.disabled = false;
        button.classList.toggle('active', group.sport);
        button.setAttribute('aria-pressed', group.sport ? 'true' : 'false');
        button.textContent = 'Sport';
    }

    escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    attachTreeListeners(container) {
        // Toggle group collapse
        container.querySelectorAll('.content-group-header').forEach(header => {
            header.addEventListener('click', (e) => {
                // Prevent triggering if clicking the checkbox/label directly (handled by its own listener/bubbling)
                if (e.target.closest('input') || e.target.closest('label')) return;

                const groupEl = header.closest('.content-group');
                const groupId = groupEl.dataset.groupId;
                this.toggleGroupExpand(groupId);
            });
        });

        // 0146: Sport toggle (saved at once; never expands the group)
        container.querySelectorAll('.sport-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleSport(btn);
            });
        });

        // Toggle visibility
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                if (cb.classList.contains('group-checkbox')) {
                    this.toggleGroupChildren(cb);
                } else {
                    this.toggleVisibility(cb);
                }
            });
        });
    }

    toggleGroupExpand(groupId) {
        if (this.expandedGroups.has(groupId)) {
            this.expandedGroups.delete(groupId);
        } else {
            this.expandedGroups.add(groupId);
        }

        // Re-render only this group - use filtered groups to respect search
        const groupEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(groupId)}"]`);
        if (groupEl) {
            const filteredGroups = this.getFilteredGroups();
            const group = filteredGroups.find(g => g.id === groupId);
            if (group) {
                const newHtml = this.getGroupHtml(group);
                groupEl.outerHTML = newHtml;

                // Re-attach listeners to the new element
                const newEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(groupId)}"]`);
                if (newEl) this.attachTreeListeners(newEl);
            }
        }
    }

    /**
     * Toggle visibility of a single item (LOCAL STATE ONLY - use Save to persist)
     * Checked = show (remove from hidden), Unchecked = hide (add to hidden)
     */
    toggleVisibility(checkbox) {
        const itemType = checkbox.dataset.type;
        const itemId = checkbox.dataset.id;
        const isVisible = checkbox.checked;

        // Update local state only (will be persisted when Save is clicked)
        const key = `${itemType}:${itemId}`;
        if (isVisible) {
            this.hiddenSet.delete(key);
        } else {
            this.hiddenSet.add(key);
        }
        // #59: a channel can only be seen when its group is shown too, so showing one channel of a hidden group shows
        // the group, and Save keeps its other channels hidden one by one.
        const owner = this.treeData.groups.find(g => g.items.some(i => `${i.type}:${i.id}` === key));
        if (isVisible && owner?.categoryId) this.hiddenSet.delete(`${this.groupItemType()}:${owner.categoryId}`);
        this.updateSaveLabel();

        // Update parent group checkbox to reflect derived state
        const groupEl = checkbox.closest('.content-group');
        if (groupEl) {
            const groupCheckbox = groupEl.querySelector('.group-checkbox');
            if (groupCheckbox) {
                const groupId = groupEl.dataset.groupId;
                const group = this.treeData.groups.find(g => g.id === groupId);
                if (group) {
                    const hasVisibleChild = group.items.some(item => !this.hiddenSet.has(`${item.type}:${item.id}`));
                    groupCheckbox.checked = hasVisibleChild;
                }
            }
        }
    }

    /**
     * Toggle all children of a group (LOCAL STATE ONLY - use Save to persist)
     */
    toggleGroupChildren(groupCb) {
        // #59: keyed by the group's id; two groups with the same name are two groups.
        const group = this.treeData.groups.find(g => g.id === groupCb.dataset.id);
        if (!group) return;

        const isChecked = groupCb.checked;

        const groupItemType = this.groupItemType();

        // Update state for the GROUP itself (if it has a categoryId)
        if (group.categoryId) {
            const groupKey = `${groupItemType}:${group.categoryId}`;
            if (isChecked) {
                this.hiddenSet.delete(groupKey);
            } else {
                this.hiddenSet.add(groupKey);
            }
        }

        // Update state for all children
        group.items.forEach(item => {
            const key = `${item.type}:${item.id}`;
            if (isChecked) {
                this.hiddenSet.delete(key);
            } else {
                this.hiddenSet.add(key);
            }
        });

        // Re-render group to update all checkboxes
        const groupEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(group.id)}"]`);
        if (groupEl) {
            groupEl.outerHTML = this.getGroupHtml(group);
            const newEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(group.id)}"]`);
            if (newEl) this.attachTreeListeners(newEl);
        }
    }

    /**
     * #16: Show all / Hide all act on what the filter shows, as pending edits like every other tick; Save applies them
     * (asking first when it is many). Before 0357 they saved at once, ignored the filter and could not be undone.
     */
    setAllVisibility(visible) {
        if (!this.treeData || !this.treeData.groups) return;
        const groupItemType = this.groupItemType();
        for (const shown of this.getFilteredGroups()) {
            const group = this.treeData.groups.find(g => g.id === shown.id) || shown;
            const whole = shown.items.length === group.items.length;
            for (const item of shown.items) {
                const key = `${item.type}:${item.id}`;
                if (visible) this.hiddenSet.delete(key); else this.hiddenSet.add(key);
            }
            if (!group.categoryId) continue;
            const groupKey = `${groupItemType}:${group.categoryId}`;
            if (visible) this.hiddenSet.delete(groupKey); // its other channels stay hidden one by one (#59)
            else if (whole || group.items.every(i => this.hiddenSet.has(`${i.type}:${i.id}`))) this.hiddenSet.add(groupKey);
        }
        this.renderTree();
        this.updateSaveLabel();
    }

    /** The Save button says how many changes are waiting. */
    updateSaveLabel() {
        const saveBtn = document.getElementById('content-save');
        if (!saveBtn || saveBtn.disabled) return;
        const { show, hide } = this.pendingCounts();
        const n = show + hide;
        saveBtn.textContent = n ? `💾 Save ${n.toLocaleString()} change${n === 1 ? '' : 's'}` : '💾 Save Changes';
    }

    /** #16: put back exactly what was hidden before the last save. */
    async undoLastSave() {
        if (!this.undoSnapshot || !this.treeData || this.saving) return;
        if (String(this.undoSnapshot.sourceId) !== String(this.treeData.sourceId)) { // #174
            this.undoSnapshot = null;
            this.showUndo(false);
            return;
        }
        this.hiddenSet = new Set(this.undoSnapshot.hidden);
        this.undoSnapshot = null;
        await this.saveContentChanges({ confirmed: true, undo: true });
    }

    showUndo(visible) {
        const undo = document.getElementById('content-undo');
        if (undo) undo.hidden = !visible;
    }

    /**
     * Save all content visibility changes to the server
     */
    async saveContentChanges({ confirmed = false, undo = false } = {}) {
        if (!this.treeData) {
            alert('No content loaded to save');
            return;
        }
        if (this.saving) return; // #175: one save at a time
        // #16: a large change says what it will do before it does it.
        const counts = this.pendingCounts();
        if (!confirmed && counts.show + counts.hide > 50) {
            const parts = [];
            if (counts.show) parts.push(`show ${counts.show.toLocaleString()} hidden channel${counts.show === 1 ? '' : 's'}`);
            if (counts.hide) parts.push(`hide ${counts.hide.toLocaleString()} shown channel${counts.hide === 1 ? '' : 's'}`);
            const sentence = parts.join(' and ');
            const ok = window.confirm(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}? Each shown channel gets a number and appears in the guide on every device. You now show ${counts.before.toLocaleString()} channels; this makes ${counts.after.toLocaleString()}.`);
            if (!ok) return;
        }
        const before = new Set(this.originalHiddenSet);
        // #175: the save sends, and afterwards records as saved, exactly the selection it started with; ticks made
        // while it runs stay unsaved for the next Save.
        const target = new Set(this.hiddenSet);
        const savedSource = this.treeData.sourceId;
        this.saving = true;

        const saveBtn = document.getElementById('content-save');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Saving...';
        }

        try {
            const sourceId = this.treeData.sourceId;
            const itemsToShow = [];
            const itemsToHide = [];
            const hideKeys = new Set();

            // Only collect items that have CHANGED from their original state
            // Track group changes for redundancy check
            const changedGroups = new Map(); // categoryId -> isHidden

            // First pass: Identify all changed groups
            this.treeData.groups.forEach(group => {
                const groupItemType = this.groupItemType();

                if (group.categoryId) {
                    const groupKey = `${groupItemType}:${group.categoryId}`;
                    const isGroupNowHidden = target.has(groupKey);
                    const wasGroupHidden = this.originalHiddenSet.has(groupKey);

                    if (isGroupNowHidden !== wasGroupHidden) {
                        changedGroups.set(group.categoryId, isGroupNowHidden);
                        if (isGroupNowHidden) {
                            itemsToHide.push({ sourceId, itemType: groupItemType, itemId: String(group.categoryId) });
                        } else {
                            itemsToShow.push({ sourceId, itemType: groupItemType, itemId: String(group.categoryId) });
                        }
                    }
                }
            });

            // Second pass: Process items, skipping if redundant with group change
            this.treeData.groups.forEach(group => {
                const groupIsChanging = changedGroups.has(group.categoryId);
                const groupNewState = changedGroups.get(group.categoryId); // true = hiding, false = showing

                group.items.forEach(item => {
                    const key = `${item.type}:${item.id}`;
                    const isNowHidden = target.has(key);
                    const wasHidden = this.originalHiddenSet.has(key);

                    // Only send if state changed
                    if (isNowHidden !== wasHidden) {
                        // Check for redundancy:
                        // If group is changing to the SAME state as the item, skip the item
                        // The backend cascade will handle it.
                        if (groupIsChanging && groupNewState === isNowHidden) {
                            return;
                        }

                        if (isNowHidden) {
                            itemsToHide.push({ sourceId, itemType: item.type, itemId: String(item.id) });
                            hideKeys.add(key);
                        } else {
                            itemsToShow.push({ sourceId, itemType: item.type, itemId: String(item.id) });
                        }
                    }
                });
            });

            // #59: showing a group shows every channel in it on the server (it cascades), so the ones still unticked
            // are hidden again one by one, after the shows.
            this.treeData.groups.forEach(group => {
                if (changedGroups.get(group.categoryId) !== false) return;
                group.items.forEach(item => {
                    const key = `${item.type}:${item.id}`;
                    if (target.has(key) && !hideKeys.has(key)) {
                        itemsToHide.push({ sourceId, itemType: item.type, itemId: String(item.id) });
                        hideKeys.add(key);
                    }
                });
            });

            // Check if there are any changes
            if (itemsToShow.length === 0 && itemsToHide.length === 0) {
                if (saveBtn) {
                    saveBtn.textContent = 'No changes';
                    setTimeout(() => {
                        saveBtn.textContent = '💾 Save Changes';
                        saveBtn.disabled = false;
                    }, 1500);
                }
                return;
            }

            console.log(`[SourceManager] Saving changes: ${itemsToShow.length} to show, ${itemsToHide.length} to hide`);

            if (itemsToHide.length > 0) {
                console.log('[SourceManager] Items to hide:', itemsToHide.map(i => `${i.itemType}:${i.itemId}`));
                // Check if any groups are being hidden
                const hiddenGroups = itemsToHide.filter(i => i.itemType === 'group' || i.itemType.includes('category'));
                if (hiddenGroups.length > 0) {
                    console.warn('[SourceManager] WARNING: Hiding groups:', hiddenGroups);
                }
            }

            // Batch large operations to avoid timeouts (5000 items per batch)
            const BATCH_SIZE = 5000;

            const processBatches = async (items, apiFn, label) => {
                for (let i = 0; i < items.length; i += BATCH_SIZE) {
                    const batch = items.slice(i, i + BATCH_SIZE);
                    console.log(`[SourceManager] ${label}: batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(items.length / BATCH_SIZE)} (${batch.length} items)`);
                    await apiFn(batch);

                    // Update button with progress
                    if (saveBtn) {
                        const progress = Math.round(((i + batch.length) / items.length) * 100);
                        saveBtn.textContent = `⏳ ${progress}%`;
                    }
                }
            };

            // Process show and hide operations sequentially to avoid overwhelming the server
            if (itemsToShow.length > 0) {
                await processBatches(itemsToShow, API.channels.bulkShow, 'Showing');
            }
            if (itemsToHide.length > 0) {
                await processBatches(itemsToHide, API.channels.bulkHide, 'Hiding');
            }

            console.log('[SourceManager] Bulk operations completed');

            // Update originalHiddenSet to reflect saved state
            this.originalHiddenSet = target;
            // #16: one step back is offered until the next save (an Undo is not itself undone).
            this.undoSnapshot = undo ? null : { sourceId: savedSource, hidden: before };
            this.showUndo(!undo);

            // Sync Channel List (it lists only visible channels, so reload it)
            try {
                if (window.app?.channelList?.loadChannels) {
                    await window.app.channelList.loadChannels();
                }
            } catch (e) {
                console.warn('[SourceManager] Channel list sync failed:', e);
            }

            if (saveBtn) {
                saveBtn.textContent = '✓ Saved!';
                setTimeout(() => {
                    saveBtn.textContent = '💾 Save Changes';
                    saveBtn.disabled = false;
                }, 1500);
            }

        } catch (err) {
            console.error('Error saving content changes:', err);
            alert('Failed to save changes: ' + err.message);
            if (saveBtn) {
                saveBtn.textContent = '💾 Save Changes';
                saveBtn.disabled = false;
            }
        } finally {
            this.saving = false;
        }
    }
}

// Export
window.SourceManager = SourceManager;
