/**
 * Channel List Component
 * Handles the sidebar channel list
 *
 * 0121 (W2.1): reads /api/library - the same browsing API the Apple client uses -
 * instead of the Xtream-emulation routes. A channel is identified by its bare
 * library id (`pos_412`, or the provider stream id) plus its source; favourites
 * are matched on the channel's identity (stableId), so a channel listed in two
 * categories is one star. Only visible channels are listed (hiding is done in
 * Settings -> Manage Content, or with the context menu's Hide).
 */

class ChannelList {
    constructor() {
        this.container = document.getElementById('channel-list');
        this.searchInput = document.getElementById('channel-search');
        this.sourceSelect = document.getElementById('source-select');
        this.toggleGroupsBtn = document.getElementById('toggle-groups');
        this.contextMenu = document.getElementById('context-menu');

        this.channels = [];            // every visible channel of the selected source(s), in number order
        this.categories = [];          // /api/library/categories, provider order
        this.collapsedGroups = new Set(); // Track collapsed groups
        this._userExpandedGroups = new Set(); // Track groups user has explicitly expanded
        this.favoriteKeys = new Set(); // Set<"sourceId:identity"> (see favKey)
        this.favoriteRows = [];        // /api/library/favourites rows, one per channel
        this.currentChannel = null;
        this.sources = [];
        this.isLoading = false;
        this.renderedChannels = [];

        this.loadCollapsedState();
        this.init();
    }

    /** A logo from a library row is our own /api/logo/ path (unauthenticated), or none. */
    logoUrl(url) {
        return url ? url : '/img/placeholder.png';
    }

    /** What makes two listings the same channel: its identity, else its id. */
    favKey(channel) {
        return `${channel.sourceId}:${channel.stableId || channel.id}`;
    }

    findChannel(sourceId, channelId) {
        return this.channels.find(c =>
            String(c.id) === String(channelId) &&
            (sourceId === undefined || sourceId === null || sourceId === '' || String(c.sourceId) === String(sourceId)));
    }

    /**
     * Load collapsed state from localStorage
     */
    loadCollapsedState() {
        try {
            const saved = localStorage.getItem('pigtv_collapsed_groups');
            if (saved) {
                this.collapsedGroups = new Set(JSON.parse(saved));
                this._hasCollapsedState = true;
            } else {
                this._hasCollapsedState = false; // First load - will collapse all by default
            }
        } catch (err) {
            console.error('Error loading collapsed state:', err);
            this._hasCollapsedState = false;
        }
    }

    /**
     * Save collapsed state to localStorage
     */
    saveCollapsedState() {
        try {
            localStorage.setItem('pigtv_collapsed_groups', JSON.stringify([...this.collapsedGroups]));
        } catch (err) {
            console.error('Error saving collapsed state:', err);
        }
    }

    /**
     * Toggle group collapsed state
     */
    toggleGroup(groupName) {
        if (this.collapsedGroups.has(groupName)) {
            this.collapsedGroups.delete(groupName);
            // Track that user explicitly expanded this group
            this._userExpandedGroups.add(groupName);
        } else {
            this.collapsedGroups.add(groupName);
            // User collapsed it, remove from expanded tracking
            this._userExpandedGroups.delete(groupName);
        }
        this.saveCollapsedState();
    }

    /**
     * Expand all groups
     */
    expandAll() {
        this.collapsedGroups.clear();
        this.saveCollapsedState();

        // Expand all and render channels for empty containers
        this.container.querySelectorAll('.group-header.collapsed').forEach(h => {
            h.classList.remove('collapsed');
            const groupName = h.dataset.group;
            const groupEl = h.closest('.channel-group');
            const channelsContainer = groupEl?.querySelector('.group-channels');
            if (channelsContainer && channelsContainer.children.length === 0) {
                this.renderGroupChannels(groupName, channelsContainer);
            }
        });

        // Update toggle button
        if (this.toggleGroupsBtn) {
            this.toggleGroupsBtn.innerHTML = Icons.collapseAll;
            this.toggleGroupsBtn.title = 'Collapse All';
        }
    }

    /**
     * Collapse all groups
     */
    collapseAll() {
        this.container.querySelectorAll('.group-header').forEach(h => {
            const groupName = h.dataset.group;
            this.collapsedGroups.add(groupName);
            h.classList.add('collapsed');
        });
        this.saveCollapsedState();

        // Update toggle button
        if (this.toggleGroupsBtn) {
            this.toggleGroupsBtn.innerHTML = Icons.expandAll;
            this.toggleGroupsBtn.title = 'Expand All';
        }
    }

    /**
     * Toggle between expand/collapse all
     */
    toggleAllGroups() {
        const allHeaders = this.container.querySelectorAll('.group-header');
        const allCollapsed = [...allHeaders].every(h => h.classList.contains('collapsed'));

        if (allCollapsed) {
            this.expandAll();
        } else {
            this.collapseAll();
        }
    }

    init() {
        // Search handler (debounced)
        let searchTimeout;
        this.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.render();
            }, 300);
        });

        // Source filter handler
        this.sourceSelect.addEventListener('change', () => this.loadChannels());

        // Context menu handlers
        document.addEventListener('click', (e) => {
            // Don't close if clicking inside context menu
            if (!this.contextMenu.contains(e.target)) {
                this.hideContextMenu();
            }
        });

        this.contextMenu.querySelectorAll('.context-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent document click from firing
                this.handleContextAction(e);
            });
        });

        // Intersection Observer for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                this.renderNextBatch();
            }
        }, { rootMargin: '100px' });

        // Start EPG refresh timer (updates visible program info every 60 seconds)
        this.startEpgRefreshTimer();
    }

    /**
     * Start timer to refresh EPG info in visible channel items
     * Updates every 60 seconds to keep "Now Playing" program info current
     */
    startEpgRefreshTimer() {
        // Clear any existing timer
        if (this._epgRefreshTimer) {
            clearInterval(this._epgRefreshTimer);
        }

        // Refresh every 60 seconds
        this._epgRefreshTimer = setInterval(() => {
            this.updateVisibleEpgInfo();
        }, 60000);
    }

    /**
     * Update EPG info for visible channel items without full re-render
     * Only updates the program text, not the entire channel item
     */
    updateVisibleEpgInfo() {
        // Clear the cache so we get fresh data
        this.clearProgramInfoCache();

        // Find all visible channel items and update their program info
        const channelItems = this.container.querySelectorAll('.channel-item');
        channelItems.forEach(item => {
            const channel = this.findChannel(item.dataset.sourceId, item.dataset.channelId);
            if (channel) {
                const programInfo = this.getProgramInfo(channel);
                const programElement = item.querySelector('.channel-program');
                if (programElement) {
                    programElement.textContent = programInfo || '';
                }
            }
        });
    }

    /**
     * Current programme title - cached per minute. The guide's data covers the
     * whole window it loaded; the row's own now/next (from /api/library/channels)
     * covers the time before the guide has loaded.
     */
    getProgramInfo(channel) {
        try {
            const currentMinute = Math.floor(Date.now() / 60000);
            const cacheKey = `${channel.sourceId}:${channel.id}:${currentMinute}`;

            if (this._programInfoCache && this._programInfoCache.has(cacheKey)) {
                return this._programInfoCache.get(cacheKey);
            }

            // Clear old cache entries if minute changed
            if (!this._lastCacheMinute || this._lastCacheMinute !== currentMinute) {
                this._programInfoCache = new Map();
                this._lastCacheMinute = currentMinute;
            }

            let result = null;
            const program = window.app?.epgGuide?.getCurrentProgramFor?.(channel);
            if (program) {
                result = program.title;
            } else {
                const now = Date.now();
                const live = (p) => p && p.startTime <= now && p.endTime > now;
                if (live(channel.now)) result = channel.now.title;
                else if (live(channel.next)) result = channel.next.title;
            }

            this._programInfoCache.set(cacheKey, result);
            return result;
        } catch (e) {
            console.warn("Error in getProgramInfo", e);
            return null;
        }
    }

    /**
     * Clear program info cache
     * Useful when EPG data has been updated
     */
    clearProgramInfoCache() {
        if (this._programInfoCache) {
            this._programInfoCache.clear();
        }
    }

    escapeHtml(text) {
        if (text === null || text === undefined || text === '') return '';
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * The markup of one channel row. `renderId`/`renderGroup` tie it to its place
     * in renderedChannels (for up/down navigation).
     */
    channelItemHtml(channel, { isActive = false, isNavActive = false, renderId = '', renderGroup = '' } = {}) {
        const isFavorite = this.favoriteKeys.has(this.favKey(channel));
        const number = channel.number !== null && channel.number !== undefined
            ? `<span class="channel-number">${this.escapeHtml(channel.number)}</span>` : '';
        return `
          <div class="channel-item ${isActive ? 'active' : ''} ${isNavActive ? 'nav-active' : ''}"
               data-channel-id="${this.escapeHtml(channel.id)}"
               data-source-id="${this.escapeHtml(channel.sourceId)}"
               data-fav-key="${this.escapeHtml(this.favKey(channel))}"
               data-render-id="${renderId}"
               data-render-group="${this.escapeHtml(renderGroup)}">
            ${number}
            <img class="channel-logo" src="${this.escapeHtml(this.logoUrl(channel.tvgLogo))}"
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>
        `;
    }

    /** Channels of the favourites list that are in the loaded (source-filtered) list. */
    getFavoriteChannels() {
        const out = [];
        const seen = new Set();
        for (const row of this.favoriteRows) {
            const key = `${row.sourceId}:${row.stableId || row.id}`;
            if (seen.has(key)) continue;
            // The listing the channel list has, or any listing of the same channel.
            const channel = this.findChannel(row.sourceId, row.id)
                || this.channels.find(c => this.favKey(c) === key);
            if (channel) {
                seen.add(key);
                out.push(channel);
            }
        }
        const numberOf = (c) => (c.number === null || c.number === undefined ? Infinity : c.number);
        return out.sort((a, b) => numberOf(a) - numberOf(b) || String(a.name).localeCompare(String(b.name)));
    }

    /**
     * Render channel list
     */
    render() {
        const searchTerm = this.searchInput.value.toLowerCase();

        // Reset batching
        this.currentBatch = 0;
        this.batchSize = 100; // Number of groups to render per batch
        this.container.innerHTML = ''; // Clear container

        const groupedChannels = {};

        // 1. Filter
        this.filteredChannels = this.channels;
        if (searchTerm) {
            this.filteredChannels = this.channels.filter(ch =>
                String(ch.name ?? "").toLowerCase().includes(searchTerm) ||
                String(ch.groupTitle ?? "").toLowerCase().includes(searchTerm) ||
                (ch.number !== null && ch.number !== undefined && String(ch.number) === searchTerm.trim())
            );
        }

        // 2. Group (channels arrive in number order, so each group is in number order too)
        this.filteredChannels.forEach(ch => {
            const groupKey = ch.groupTitle || 'Uncategorized';
            if (!groupedChannels[groupKey]) {
                groupedChannels[groupKey] = [];
            }
            groupedChannels[groupKey].push(ch);
        });

        // 3. Groups in the provider's category order (placeholder/header categories
        // sit directly above the ones they introduce); anything not in the category
        // list keeps its first-appearance order after them.
        const categoryOrder = new Map();
        this.categories.forEach((c, i) => { if (!categoryOrder.has(c.name)) categoryOrder.set(c.name, i); });
        const allGroups = Object.keys(groupedChannels)
            .map((name, i) => ({ name, i, order: categoryOrder.has(name) ? categoryOrder.get(name) : Infinity }))
            .sort((a, b) => (a.order - b.order) || (a.i - b.i))
            .map(g => g.name);

        // 4. Favorites first
        const favoritedChannels = this.getFavoriteChannels();
        if (favoritedChannels.length > 0) {
            groupedChannels['Favorites'] = favoritedChannels;
            allGroups.unshift('Favorites');
        }

        this.sortedGroups = allGroups;
        this.groupedChannels = groupedChannels;

        // Collapse all groups by default on first load (for large playlists)
        if (!this._hasCollapsedState && this.sortedGroups.length > 0) {
            this.sortedGroups.forEach(groupName => {
                if (groupName !== 'Favorites') {
                    this.collapsedGroups.add(groupName);
                }
            });
            this._hasCollapsedState = true;
            this.saveCollapsedState();
        }

        // Build rendered channel list for navigation (matches visual order)
        this.renderedChannels = [];
        this._renderedByKey = new Map();
        this.sortedGroups.forEach(groupName => {
            this.groupedChannels[groupName].forEach(ch => {
                const rendered = {
                    ...ch,
                    _renderId: `rid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    _renderGroup: groupName // Track visual group for navigation
                };
                this.renderedChannels.push(rendered);
                this._renderedByKey.set(`${groupName}\u0000${ch.sourceId}:${ch.id}`, rendered);
            });
        });

        // Empty State.
        if (this.sortedGroups.length === 0) {
            let message, hint;
            if (searchTerm) {
                message = 'No channels match your search';
                hint = 'Try a different search term';
            } else if (this.sources.length > 0) {
                message = 'No channels to show';
                hint = 'Choose what to show under Settings → Manage Content';
            } else {
                message = 'No channels loaded';
                hint = 'Add a source in Settings to get started';
            }
            this.container.innerHTML = `
        <div class="empty-state">
          <p>${message}</p>
          <p class="hint">${hint}</p>
        </div>
      `;
            return;
        }

        // Wrap container content in a specific list div to append to
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'channel-list-content';
        this.container.appendChild(this.listContainer);

        // Add loader element at bottom
        this.loader = document.createElement('div');
        this.loader.className = 'batch-loader';
        this.loader.innerHTML = '<div class="loading-spinner"></div>';
        this.loader.style.opacity = '0'; // Hide initially
        this.container.appendChild(this.loader);

        // Render initial batches - load just enough to fill visible area + buffer
        const maxInitialBatches = 2;
        for (let i = 0; i < maxInitialBatches; i++) {
            if (this.currentBatch * this.batchSize >= this.sortedGroups.length) break;
            this.renderNextBatch();
        }

        // Start observing loader for additional batches
        this.observer.observe(this.loader);
    }

    /**
     * Render next batch of groups
     */
    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const groupsToRender = this.sortedGroups.slice(start, end);

        if (groupsToRender.length === 0) {
            // No more groups
            this.loader.style.display = 'none';
            return;
        }

        this.loader.style.opacity = '1';
        let html = '';

        for (const groupName of groupsToRender) {
            const channels = this.groupedChannels[groupName];
            if (!channels || channels.length === 0) continue;

            const isFavoritesGroup = groupName === 'Favorites';

            // Default new groups to collapsed (except Favorites)
            if (!isFavoritesGroup && !this.collapsedGroups.has(groupName) && !this._userExpandedGroups?.has(groupName)) {
                this.collapsedGroups.add(groupName);
            }

            html += `
        <div class="channel-group">
          <div class="group-header ${this.collapsedGroups.has(groupName) ? 'collapsed' : ''} ${isFavoritesGroup ? 'favorites-group' : ''}" data-group="${this.escapeHtml(groupName)}">
            <span class="group-toggle">${Icons.chevronDown}</span>
            <span class="group-name">${this.escapeHtml(groupName)}</span>
            <span class="group-count">${channels.length}</span>
          </div>
          <div class="group-channels">
      `;

            // Skip rendering channel items if group is collapsed (major performance optimization)
            // Channels will be rendered when user expands the group
            if (!this.collapsedGroups.has(groupName)) {
                html += this.groupChannelsHtml(groupName);
            }
            html += '</div></div>';
        }

        // Append to list container
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        while (tempDiv.firstElementChild) {
            const groupEl = tempDiv.firstElementChild;
            this.attachGroupListeners(groupEl);
            this.listContainer.appendChild(groupEl);
        }

        this.currentBatch++;

        // Hide loader if we might be done (next batch check will confirm)
        if (end >= this.sortedGroups.length) {
            this.loader.style.display = 'none';
        }
    }

    /** The rows of one group, each tied to its entry in renderedChannels. */
    groupChannelsHtml(groupName) {
        const channels = this.groupedChannels[groupName] || [];
        let html = '';
        for (const channel of channels) {
            const rendered = this._renderedByKey?.get(`${groupName}\u0000${channel.sourceId}:${channel.id}`);
            html += this.channelItemHtml(channel, {
                isActive: this.isCurrent(channel),
                isNavActive: !!(this.currentRenderId && rendered && rendered._renderId === this.currentRenderId),
                renderId: rendered?._renderId || '',
                renderGroup: groupName
            });
        }
        return html;
    }

    isCurrent(channel) {
        return !!this.currentChannel && this.currentChannel.id === channel.id
            && String(this.currentChannel.sourceId) === String(channel.sourceId);
    }

    attachChannelListeners(item) {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) return;
            this.selectChannel(item.dataset);
        });
        item.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', item.dataset));

        const favBtn = item.querySelector('.favorite-btn');
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.channelId);
            });
        }
    }

    attachGroupListeners(groupEl) {
        const header = groupEl.querySelector('.group-header');
        if (header) {
            header.addEventListener('click', () => {
                const groupName = header.dataset.group;
                const isCollapsed = header.classList.contains('collapsed');

                header.classList.toggle('collapsed');
                this.toggleGroup(groupName);

                // If expanding, render channels if they weren't rendered initially
                if (isCollapsed) {
                    const channelsContainer = groupEl.querySelector('.group-channels');
                    if (channelsContainer && channelsContainer.children.length === 0) {
                        this.renderGroupChannels(groupName, channelsContainer);
                    }
                }
            });
            header.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'group', header.dataset));
        }

        groupEl.querySelectorAll('.channel-item').forEach(item => this.attachChannelListeners(item));
    }

    /**
     * Render channels for a specific group (called when expanding a collapsed group)
     */
    renderGroupChannels(groupName, container) {
        const channels = this.groupedChannels[groupName];
        if (!channels || channels.length === 0) return;

        container.innerHTML = this.groupChannelsHtml(groupName);
        container.querySelectorAll('.channel-item').forEach(item => this.attachChannelListeners(item));
    }

    /**
     * Load sources into dropdown
     */
    async loadSources() {
        try {
            this.sources = await API.sources.getAll();
            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled);
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled);

            if (xtreamSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'Xtream';
                xtreamSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `xtream:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }

            if (m3uSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'M3U';
                m3uSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `m3u:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    /**
     * A library row as the channel object the web app passes around. `id` is the
     * bare library id, which is what resolve, favourites and recordings take.
     */
    fromLibraryRow(row, categoryNames, sourceTypes) {
        return {
            id: row.id,
            streamId: row.id,
            sourceId: row.sourceId,
            sourceType: sourceTypes.get(Number(row.sourceId)) || 'm3u',
            stableId: row.stableId || null,
            number: row.number ?? null,
            name: row.name,
            tvgId: row.tvgId || null,
            tvgLogo: row.logo || null,
            groupId: row.category,
            groupTitle: categoryNames.get(`${row.sourceId}:${row.category}`) || row.category || 'Uncategorized',
            now: row.now || null,
            next: row.next || null
        };
    }

    /**
     * Load channels (from all enabled sources, or the one selected)
     */
    async loadChannels() {
        if (this.isLoading) return;
        this.isLoading = true;
        this.currentRenderId = null; // Reset render tracking

        const sourceValue = this.sourceSelect.value;
        const onlySource = sourceValue ? sourceValue.split(':')[1] : null;

        try {
            this.container.innerHTML = '<div class="loading"></div>';

            const [categories, rows] = await Promise.all([
                API.library.categories(),
                API.library.allChannels(),
                this.loadFavorites()
            ]);

            const enabled = new Set(this.sources.filter(s => s.enabled).map(s => String(s.id)));
            const wanted = (sourceId) => (onlySource ? String(sourceId) === String(onlySource)
                : (enabled.size === 0 || enabled.has(String(sourceId))));

            this.categories = (categories || []).filter(c => wanted(c.sourceId));
            const categoryNames = new Map((categories || []).map(c => [`${c.sourceId}:${c.id}`, c.name]));
            const sourceTypes = new Map(this.sources.map(s => [Number(s.id), s.type]));
            this.channels = (rows || [])
                .filter(r => wanted(r.sourceId))
                .map(r => this.fromLibraryRow(r, categoryNames, sourceTypes));

            this.render();
        } catch (err) {
            console.error('Error loading channels:', err);
            this.container.innerHTML = `<div class="empty-state"><p>Error loading channels</p><p class="hint">${this.escapeHtml(err.message)}</p></div>`;
        } finally {
            this.isLoading = false;
        }
    }

    /** Kept for callers from before 0121: every load is now a full one. */
    async loadAllChannels() {
        return this.loadChannels();
    }

    /**
     * Load favorites (one row per channel, from /api/library/favourites)
     */
    async loadFavorites() {
        try {
            const rows = await API.library.favourites();
            this.favoriteRows = Array.isArray(rows) ? rows : [];
            this.favoriteKeys = new Set(this.favoriteRows.map(r => `${r.sourceId}:${r.stableId || r.id}`));
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    /**
     * Check if channel is favorite
     */
    isFavorite(sourceId, channelId) {
        const channel = this.findChannel(sourceId, channelId);
        return this.favoriteKeys.has(channel ? this.favKey(channel) : `${sourceId}:${channelId}`);
    }

    /** Every star for this channel, in every group and listing. */
    setFavoriteButtons(key, isFavorite) {
        const safe = String(key).replace(/"/g, '\\"');
        document.querySelectorAll(`.channel-item[data-fav-key="${safe}"] .favorite-btn`).forEach(btn => {
            btn.classList.toggle('active', isFavorite);
            btn.innerHTML = isFavorite ? Icons.favorite : Icons.favoriteOutline;
            btn.title = isFavorite ? 'Remove from Favorites' : 'Add to Favorites';
        });
    }

    /**
     * Toggle favorite status
     */
    async toggleFavorite(sourceId, channelId) {
        const channel = this.findChannel(sourceId, channelId);
        if (!channel) return;
        const key = this.favKey(channel);
        const wasFavorite = this.favoriteKeys.has(key);

        const apply = (isFavorite) => {
            if (isFavorite) this.favoriteKeys.add(key);
            else this.favoriteKeys.delete(key);
            this.setFavoriteButtons(key, isFavorite);
            this.updateFavoritesGroup(channel, isFavorite);
        };

        try {
            apply(!wasFavorite); // Optimistic; do NOT call this.render() - it causes lag

            // The bare id: favourites are stored and matched on the channel's identity.
            if (wasFavorite) {
                await API.favorites.remove(channel.sourceId, channel.id, 'channel');
            } else {
                await API.favorites.add(channel.sourceId, channel.id, 'channel');
            }

            // Sync to EPG Guide
            if (window.app?.epgGuide) {
                window.app.epgGuide.syncFavorite(channel.sourceId, channel.id, !wasFavorite);
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            apply(wasFavorite); // Revert on error
        }
    }

    /**
     * Update Favorites group in DOM and data
     */
    updateFavoritesGroup(channel, isAdded) {
        const key = this.favKey(channel);

        // 1. Update Data
        this.favoriteRows = this.favoriteRows.filter(r => `${r.sourceId}:${r.stableId || r.id}` !== key);
        if (isAdded) this.favoriteRows.push({ sourceId: channel.sourceId, id: channel.id, stableId: channel.stableId });
        if (!this.groupedChannels) return;
        const favArray = this.getFavoriteChannels();
        this.groupedChannels['Favorites'] = favArray;

        // 2. Update DOM
        const groupHeader = this.listContainer?.querySelector('.group-header[data-group="Favorites"]');

        if (!groupHeader) {
            // The first favourite: the group has to be created, which a full render does.
            if (isAdded && favArray.length === 1) {
                this.render();
            }
            return;
        }

        const groupChannels = groupHeader.nextElementSibling; // .group-channels
        const countSpan = groupHeader.querySelector('.group-count');
        const safe = String(key).replace(/"/g, '\\"');
        const existingEl = groupChannels.querySelector(`.channel-item[data-fav-key="${safe}"]`);

        if (isAdded) {
            if (!existingEl) groupChannels.appendChild(this.createChannelElement(channel));
        } else if (existingEl) {
            existingEl.remove();
        }

        // Update count
        if (countSpan) countSpan.textContent = favArray.length;

        if (favArray.length === 0) {
            groupHeader.classList.add('hidden');
            groupHeader.style.display = 'none';
        } else {
            groupHeader.classList.remove('hidden');
            groupHeader.style.display = '';
        }
    }

    createChannelElement(channel) {
        const temp = document.createElement('div');
        temp.innerHTML = this.channelItemHtml(channel, { isActive: this.isCurrent(channel), renderGroup: 'Favorites' });
        const div = temp.firstElementChild;
        this.attachChannelListeners(div);
        return div;
    }

    /**
     * Select and play a channel
     */
    async selectChannel(dataset) {
        const channel = this.findChannel(dataset.sourceId, dataset.channelId);
        if (!channel) return;

        this.currentChannel = channel;
        this.currentRenderId = dataset.renderId; // Track which visual instance is active
        this.currentRenderGroup = dataset.renderGroup; // Track which group the selection came from

        // Update active state in DOM
        this.container.querySelectorAll('.channel-item.active').forEach(el => {
            el.classList.remove('active');
            el.classList.remove('nav-active');
        });

        // Try to find specific render instance first
        let activeItem = this.currentRenderId
            ? this.container.querySelector(`[data-render-id="${this.currentRenderId}"]`) : null;

        // If not found in DOM, it might be in a future batch not yet rendered
        // Render batches until we find it or run out
        if (!activeItem && this.renderedChannels.length > 0 && this.sortedGroups) {
            let safety = 0;
            while (!activeItem && this.currentBatch * this.batchSize < this.sortedGroups.length && safety < 20) {
                this.renderNextBatch();
                if (this.currentRenderId) {
                    activeItem = this.container.querySelector(`[data-render-id="${this.currentRenderId}"]`);
                }
                safety++;
            }
        }

        // Fallback checks if still not found
        if (!activeItem) {
            const safeId = String(channel.id).replace(/"/g, '\\"');
            activeItem = this.container.querySelector(`[data-channel-id="${safeId}"][data-source-id="${channel.sourceId}"]`);
            // If we fell back to channel ID, update currentRenderId to match what we found
            if (activeItem && activeItem.dataset.renderId) {
                this.currentRenderId = activeItem.dataset.renderId;
            }
        }

        if (activeItem) {
            activeItem.classList.add('active');
            activeItem.classList.add('nav-active'); // Add specific class for navigation tracking

            // Handle Group Expansion & Scrolling (Focus Mode)
            const groupHeader = activeItem.closest('.channel-group')?.querySelector('.group-header');
            if (groupHeader) {
                const groupName = groupHeader.dataset.group;

                // 1. Expand current group if needed
                if (this.collapsedGroups.has(groupName)) {
                    this.collapsedGroups.delete(groupName);
                    groupHeader.classList.remove('collapsed');
                    this.saveCollapsedState();
                }

                // 2. Collapse ALL other groups (Focus Mode)
                document.querySelectorAll('.group-header').forEach(header => {
                    if (header !== groupHeader && !header.classList.contains('collapsed')) {
                        const otherGroup = header.dataset.group;
                        this.collapsedGroups.add(otherGroup);
                        header.classList.add('collapsed');
                    }
                });
                this.saveCollapsedState();

                // 3. Scroll Group to Top
                setTimeout(() => {
                    groupHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    setTimeout(() => {
                        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }, 50);
                }, 50);
            } else {
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        // Play: the player asks the server to resolve this channel by its source and
        // bare id (POST /api/playback/resolve). The web never holds a stream URL.
        if (window.app?.player) {
            window.app.player.play(channel, null);
        }
    }

    /**
     * Show context menu
     */
    showContextMenu(e, type, data) {
        e.preventDefault();
        this.contextMenu.dataset.type = type;
        this.contextMenu.dataset.sourceId = data.sourceId || '';
        this.contextMenu.dataset.itemId = type === 'group' ? data.group : data.channelId;

        this.contextMenu.style.left = `${e.clientX}px`;
        this.contextMenu.style.top = `${e.clientY}px`;
        this.contextMenu.classList.add('active');
    }

    /**
     * Hide context menu
     */
    hideContextMenu() {
        this.contextMenu.classList.remove('active');
    }

    /**
     * Handle context menu action
     */
    async handleContextAction(e) {
        const action = e.target.dataset.action;
        const { type, sourceId, itemId } = this.contextMenu.dataset;

        switch (action) {
            case 'play':
                if (type === 'channel') {
                    await this.selectChannel({ channelId: itemId, sourceId });
                }
                break;
            case 'hide':
                if (type === 'channel') {
                    try {
                        await API.channels.hide(parseInt(sourceId), 'channel', itemId);
                        // The library lists only visible channels: drop it here too.
                        this.channels = this.channels.filter(c => !(c.id === itemId && String(c.sourceId) === String(sourceId)));
                        this.render();
                    } catch (err) {
                        console.error('Error hiding channel:', err);
                    }
                }
                break;
        }

        this.hideContextMenu();
    }

    /**
     * Sync favorite status from external source (e.g. EPG) without API call
     */
    syncFavorite(sourceId, channelId, isFavorite) {
        const channel = this.findChannel(sourceId, channelId);
        const key = channel ? this.favKey(channel) : `${sourceId}:${channelId}`;
        if (this.favoriteKeys.has(key) === isFavorite) return; // No change needed

        if (isFavorite) this.favoriteKeys.add(key);
        else this.favoriteKeys.delete(key);
        this.setFavoriteButtons(key, isFavorite);
        if (channel) this.updateFavoritesGroup(channel, isFavorite);
    }

    /** Where the current channel sits in renderedChannels, or -1. */
    currentRenderIndex() {
        if (!this.currentChannel || !this.renderedChannels || this.renderedChannels.length === 0) return -1;

        let currentIndex = -1;
        // Try to find by render ID first (strict visual order)
        if (this.currentRenderId) {
            currentIndex = this.renderedChannels.findIndex(c => c._renderId === this.currentRenderId);
        }
        // Fallback: Find matching channel, prioritizing same render group
        if (currentIndex === -1 && this.currentRenderGroup) {
            currentIndex = this.renderedChannels.findIndex(c =>
                this.isCurrent(c) && c._renderGroup === this.currentRenderGroup);
        }
        if (currentIndex === -1) {
            currentIndex = this.renderedChannels.findIndex(c => this.isCurrent(c));
        }
        return currentIndex;
    }

    selectRendered(index) {
        const ch = this.renderedChannels[index];
        this.selectChannel({
            channelId: ch.id,
            sourceId: ch.sourceId,
            renderId: ch._renderId, // Pass the unique render ID
            renderGroup: ch._renderGroup
        });
    }

    /**
     * Select next channel in the current list
     */
    selectNextChannel() {
        const currentIndex = this.currentRenderIndex();
        if (currentIndex === -1) return;
        this.selectRendered((currentIndex + 1) % this.renderedChannels.length);
    }

    /**
     * Select previous channel in the current list
     */
    selectPrevChannel() {
        const currentIndex = this.currentRenderIndex();
        if (currentIndex === -1) return;
        this.selectRendered((currentIndex - 1 + this.renderedChannels.length) % this.renderedChannels.length);
    }

    /**
     * Visible channels in number order (the library lists only visible ones)
     */
    getVisibleChannels() {
        return this.channels;
    }
}

// Export
window.ChannelList = ChannelList;
