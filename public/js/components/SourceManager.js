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

        this.init();
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
        if (!sourceId) {
            this.contentTree.innerHTML = '<p class="hint">Select a source to view groups and channels</p>';
            return;
        }
        this.loadContentTree(parseInt(sourceId));
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
                select.innerHTML += `<option value="${source.id}">${source.name} (${source.type})</option>`;
            });
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
                               data-type="${item.type}" 
                               data-id="${item.id}" 
                               data-source-id="${this.treeData.sourceId}" 
                               ${!itemHidden ? 'checked' : ''}>
                        <span class="channel-name">${item.number !== null && item.number !== undefined ? `<span class="channel-number">${this.escapeHtml(item.number)}</span> ` : ''}${this.escapeHtml(item.name)}</span>
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
                               data-id="${this.escapeHtml(group.name)}" 
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
                        title="Sport category: a live-looking programme on its channels (Live, vs, v) counts as sport (Settings → Sports)">Sport${group.sport ? ' ✓' : ''}</button>`;
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
        button.textContent = group.sport ? 'Sport ✓' : 'Sport';
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
        const groupName = groupCb.dataset.id;
        const group = this.treeData.groups.find(g => g.name === groupName);
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
     * Set visibility for all items and IMMEDIATELY persist to server
     * Uses fast bulk API endpoint (single SQL statement) instead of item-by-item
     */
    async setAllVisibility(visible) {
        if (!this.treeData || !this.treeData.groups) return;

        const saveBtn = document.getElementById('content-save');
        const showAllBtn = document.querySelector('.content-actions button:first-child');
        const hideAllBtn = document.querySelector('.content-actions button:nth-child(2)');

        // Disable buttons during operation
        if (showAllBtn) showAllBtn.disabled = true;
        if (hideAllBtn) hideAllBtn.disabled = true;
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = visible ? '⏳ Showing all...' : '⏳ Hiding all...';
        }

        try {
            const sourceId = this.treeData.sourceId;
            const contentType = this.treeData.type; // 'channels'

            // Use fast API endpoint (single SQL UPDATE statement)
            if (visible) {
                await API.channels.showAll(sourceId, contentType);
            } else {
                await API.channels.hideAll(sourceId, contentType);
            }

            // Update local state to match. A group's checkbox is drawn from the
            // category's own key, not from its items (see getGroupHtml), so that
            // has to change too - otherwise the server hides everything but the
            // group boxes stay ticked until the page is reloaded.
            const groupItemType = this.groupItemType();
            this.treeData.groups.forEach(group => {
                if (group.categoryId) {
                    const groupKey = `${groupItemType}:${group.categoryId}`;
                    if (visible) {
                        this.hiddenSet.delete(groupKey);
                    } else {
                        this.hiddenSet.add(groupKey);
                    }
                }
                group.items.forEach(item => {
                    const key = `${item.type}:${item.id}`;
                    if (visible) {
                        this.hiddenSet.delete(key);
                    } else {
                        this.hiddenSet.add(key);
                    }
                });
            });

            // Update originalHiddenSet to match current state
            this.originalHiddenSet = new Set(this.hiddenSet);

            // Sync Channel List (it lists only visible channels, so reload it)
            try {
                if (window.app?.channelList?.loadChannels) {
                    await window.app.channelList.loadChannels();
                }
            } catch (e) {
                console.warn('[SourceManager] Channel list sync failed:', e);
            }

            // Re-render to reflect changes
            this.renderTree();

            if (saveBtn) {
                saveBtn.textContent = '✓ Done!';
                setTimeout(() => {
                    saveBtn.textContent = '💾 Save Changes';
                    saveBtn.disabled = false;
                }, 1500);
            }

        } catch (err) {
            console.error('Error setting all visibility:', err);
            alert('Failed: ' + err.message);
            if (saveBtn) {
                saveBtn.textContent = '💾 Save Changes';
                saveBtn.disabled = false;
            }
        } finally {
            if (showAllBtn) showAllBtn.disabled = false;
            if (hideAllBtn) hideAllBtn.disabled = false;
        }
    }

    /**
     * Save all content visibility changes to the server
     */
    async saveContentChanges() {
        if (!this.treeData) {
            alert('No content loaded to save');
            return;
        }

        const saveBtn = document.getElementById('content-save');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Saving...';
        }

        try {
            const sourceId = this.treeData.sourceId;
            const itemsToShow = [];
            const itemsToHide = [];

            // Only collect items that have CHANGED from their original state
            // Track group changes for redundancy check
            const changedGroups = new Map(); // categoryId -> isHidden

            // First pass: Identify all changed groups
            this.treeData.groups.forEach(group => {
                const groupItemType = this.groupItemType();

                if (group.categoryId) {
                    const groupKey = `${groupItemType}:${group.categoryId}`;
                    const isGroupNowHidden = this.hiddenSet.has(groupKey);
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
                    const isNowHidden = this.hiddenSet.has(key);
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
                        } else {
                            itemsToShow.push({ sourceId, itemType: item.type, itemId: String(item.id) });
                        }
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
            this.originalHiddenSet = new Set(this.hiddenSet);

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
        }
    }
}

// Export
window.SourceManager = SourceManager;
