/**
 * EPG Guide Component
 * Cable TV-style program guide grid
 */

class EpgGuide {
    constructor() {
        this.container = document.getElementById('epg-grid');
        this.dateDisplay = document.getElementById('guide-date');
        this.prevBtn = document.getElementById('guide-prev');
        this.nextBtn = document.getElementById('guide-next');
        this.groupSelect = document.getElementById('epg-group-select');
        this.searchInput = document.getElementById('epg-search');

        // 0121 (W2.1): the guide reads /api/library/guide - visible channels, in
        // number order, each with its programmes across the loaded window.
        this.rows = [];              // guide rows as channel objects (see fromGuideRow)
        this.programmes = [];        // every loaded programme (flat), for "is anything loaded"
        this.loaded = false;
        this.window = null;          // { start, end } in ms that this.rows covers
        this.categories = [];
        this.byChannel = new Map();  // "sourceId:id" -> programmes
        this.byTvgId = new Map();    // tvgId -> programmes
        this.byName = new Map();     // lower-case channel name -> programmes
        this.currentDate = new Date();
        this.timeOffset = 0; // Hours offset from now
        this.pixelsPerMinute = 6.67; // Width scaling (30min = 200px)
        this.favorites = new Set(); // Set<"sourceId:identity"> (see favKey)
        this.selectedGroup = 'Favorites'; // Default to Favorites

        // Virtual scrolling properties
        this.filteredChannels = [];
        this.rowHeight = 60; // Height of each channel row in pixels
        this.bufferRows = 5; // Extra rows to render above/below viewport
        this.startTime = null;
        this.endTime = null;
        this.epgContainer = null;
        this.epgSpacer = null;
        this.scrollContainer = null;
        this.visibleRows = new Map(); // Map<index, rowElement>
        this._scrollHandler = null;
        this._lastVisibleStart = -1;
        this._lastVisibleEnd = -1;

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

    escapeHtml(text) {
        if (text === null || text === undefined || text === '') return '';
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    init() {
        this.prevBtn.addEventListener('click', () => this.navigate(-2));
        this.nextBtn.addEventListener('click', () => this.navigate(2));

        // Group filter change
        this.groupSelect?.addEventListener('change', () => {
            this.selectedGroup = this.groupSelect.value;
            this.render();
        });

        // Search input
        if (this.searchInput) {
            this.searchInput.addEventListener('input', this.debounce(() => {
                this.render();
            }, 300));
        }

        // Update current time indicator every minute
        setInterval(() => this.updateNowIndicator(), 60000);

        this.initResizer();
    }

    /**
     * Initialize sidebar resizer
     */
    initResizer() {
        let isResizing = false;
        let startX, startWidth;

        document.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('resize-handle')) {
                isResizing = true;
                startX = e.clientX;
                const sidebar = document.querySelector('.epg-channel-info');
                startWidth = sidebar.getBoundingClientRect().width;
                e.target.classList.add('active');
                document.body.style.cursor = 'col-resize';
                e.preventDefault(); // Prevent text selection
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const diff = e.clientX - startX;
            const newWidth = Math.max(150, Math.min(500, startWidth + diff)); // Min 150px, Max 500px

            document.documentElement.style.setProperty('--epg-sidebar-width', `${newWidth}px`);
            this.updateNowIndicator(); // Update line position
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.querySelectorAll('.resize-handle').forEach(h => h.classList.remove('active'));
                document.body.style.cursor = '';
            }
        });
    }

    /**
     * Navigate time
     */
    async navigate(hours) {
        this.timeOffset += hours;
        // The guide is fetched for the window it shows: moving it fetches again.
        const { start } = this.renderWindow();
        if (!this.window || this.window.start !== start) {
            try {
                await this.fetchEpgData();
            } catch (err) {
                console.error('Error loading EPG:', err);
            }
        }
        this.render();
    }

    /** The 24 h the grid shows: from the top of the hour, moved by timeOffset. */
    renderWindow() {
        const start = new Date();
        start.setHours(start.getHours() + this.timeOffset);
        start.setMinutes(0, 0, 0);
        return { start: start.getTime(), end: start.getTime() + 24 * 60 * 60 * 1000 };
    }

    /**
     * Start background EPG display refresh timer
     * This only refreshes the UI from the server's data.
     * The actual sync runs on the server independently.
     */
    startBackgroundRefresh() {
        this.stopBackgroundRefresh();

        const refreshIntervalMs = 5 * 60 * 1000; // 5 minutes

        this._backgroundRefreshTimer = setInterval(async () => {
            try {
                await this.fetchEpgData();

                // Update channel list program info if visible
                if (window.app?.channelList) {
                    window.app.channelList.clearProgramInfoCache();
                    window.app.channelList.updateVisibleEpgInfo?.();
                }
            } catch (err) {
                console.error('[EPG] Display refresh failed:', err);
            }
        }, refreshIntervalMs);
    }

    /**
     * Stop background EPG refresh timer
     */
    stopBackgroundRefresh() {
        if (this._backgroundRefreshTimer) {
            clearInterval(this._backgroundRefreshTimer);
            this._backgroundRefreshTimer = null;
        }
    }

    /**
     * Get last refresh time for display
     */
    getLastRefreshTime() {
        return this.lastRefreshTime || null;
    }

    /**
     * Load EPG data and draw the grid
     */
    async loadEpg() {
        try {
            this.container.innerHTML = '<div class="loading"></div>';
            await this.fetchEpgData();
            this.lastRefreshTime = new Date();
            this.render();

            // The channel list's "now" line can use the loaded window from here on
            if (window.app?.channelList) {
                window.app.channelList.clearProgramInfoCache();
                window.app.channelList.updateVisibleEpgInfo?.();
            }

            // Keep the data fresh while the app is open
            this.startBackgroundRefresh();
        } catch (err) {
            console.error('Error loading EPG:', err);
            this.container.innerHTML = `
        <div class="empty-state">
          <p>Error loading EPG</p>
          <p class="hint">${this.escapeHtml(err.message)}</p>
        </div>
      `;
        }
    }

    /** A programme as the grid and its callers use it (ISO times, like the old feed). */
    toProgramme(p) {
        return {
            title: p.title,
            description: p.description || '',
            start: new Date(p.startTime).toISOString(),
            stop: new Date(p.endTime).toISOString(),
            startMs: p.startTime,
            stopMs: p.endTime
        };
    }

    /** A guide row as the channel object the web app passes around (bare library id). */
    fromGuideRow(row, categoryNames) {
        return {
            id: row.id,
            sourceId: row.sourceId,
            stableId: row.stableId || null,
            number: row.number ?? null,
            name: row.name,
            tvgId: row.tvgId || null,
            tvgLogo: row.logo || null,
            groupTitle: categoryNames.get(`${row.sourceId}:${row.category}`) || row.category || 'Uncategorized',
            programmes: (row.programmes || []).map(p => this.toProgramme(p))
        };
    }

    /**
     * Fetch the guide for the window on screen: every visible channel, 500 rows a
     * request, following the cursor. Also the category names and favourites.
     */
    async fetchEpgData() {
        const { start, end } = this.renderWindow();
        const [categories, favourites] = await Promise.all([
            API.library.categories(),
            API.library.favourites()
        ]);

        const rows = [];
        let cursor = null;
        for (let page = 0; page < 100; page++) { // 50,000 channels is far beyond any lineup
            const result = await API.library.guide({ start, end, limit: 500, cursor });
            rows.push(...(result.channels || []));
            cursor = result.nextCursor;
            if (!cursor) break;
        }

        this.categories = categories || [];
        const categoryNames = new Map(this.categories.map(c => [`${c.sourceId}:${c.id}`, c.name]));
        this.rows = rows.map(r => this.fromGuideRow(r, categoryNames));
        this.window = { start, end };

        // Indexes for the channel list and the player's now/next
        this.byChannel = new Map();
        this.byTvgId = new Map();
        this.byName = new Map();
        this.programmes = [];
        for (const ch of this.rows) {
            this.byChannel.set(`${ch.sourceId}:${ch.id}`, ch.programmes);
            if (ch.tvgId && ch.programmes.length && !this.byTvgId.has(ch.tvgId)) this.byTvgId.set(ch.tvgId, ch.programmes);
            const name = String(ch.name || '').toLowerCase();
            if (name && ch.programmes.length && !this.byName.has(name)) this.byName.set(name, ch.programmes);
            this.programmes.push(...ch.programmes);
        }

        this.favorites = new Set((favourites || []).map(f => this.favKey(f)));
        this.loaded = true;
    }

    /** The programmes loaded for a channel: its own row, else one with the same tvg-id or name. */
    getProgrammesFor(channel) {
        if (!channel) return [];
        return this.byChannel.get(`${channel.sourceId}:${channel.id}`)
            || (channel.tvgId && this.byTvgId.get(channel.tvgId))
            || this.byName.get(String(channel.name || '').toLowerCase())
            || [];
    }

    /** What is on a channel now, from the loaded window, or null. */
    getCurrentProgramFor(channel) {
        const now = Date.now();
        return this.getProgrammesFor(channel).find(p => p.startMs <= now && p.stopMs > now) || null;
    }

    /**
     * Get current program for a channel by tvg-id, else by name
     * @returns {object|null} Program object with title, start, stop, description
     */
    getCurrentProgram(tvgId, channelName) {
        return this.getCurrentProgramFor({ tvgId, name: channelName });
    }

    /**
     * Update filtered channels based on search or group
     */
    updateFilteredChannels() {
        const searchTerm = this.searchInput ? this.searchInput.value.toLowerCase().trim() : '';

        // SEARCH MODE: Filter all channels by name (or an exact channel number)
        if (searchTerm) {
            this.filteredChannels = this.allMatchedChannels.filter(ch =>
                String(ch.name || '').toLowerCase().includes(searchTerm) ||
                (ch.number !== null && ch.number !== undefined && String(ch.number) === searchTerm));
            return;
        }

        // GROUP MODE (Default)
        if (this.selectedGroup === 'Favorites') {
            // One row per channel, even when it is listed in more than one category.
            const seen = new Set();
            this.filteredChannels = this.allMatchedChannels.filter(ch => {
                const key = this.favKey(ch);
                if (!this.favorites.has(key) || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            return;
        }

        if (!this.selectedGroup || this.selectedGroup === 'All') {
            this.filteredChannels = [...this.allMatchedChannels];
        } else {
            this.filteredChannels = this.allMatchedChannels.filter(ch =>
                (ch.groupTitle || 'Uncategorized') === this.selectedGroup);
        }
    }

    /**
     * Render the EPG grid
     */
    render() {
        const allChannels = this.rows || [];

        if (allChannels.length === 0) {
            this.container.innerHTML = `
                <div class="empty-state">
                    <p>No visible channels available</p>
                    <p class="hint">Check your content settings or add a source</p>
                </div>
            `;
            return;
        }

        // Groups in the provider's category order; any the category list lacks
        // follow in the order they first appear.
        const categoryOrder = new Map();
        this.categories.forEach((c, i) => { if (!categoryOrder.has(c.name)) categoryOrder.set(c.name, i); });
        const groups = [...new Set(allChannels.map(ch => ch.groupTitle || 'Uncategorized'))]
            .map((name, i) => ({ name, i, order: categoryOrder.has(name) ? categoryOrder.get(name) : Infinity }))
            .sort((a, b) => (a.order - b.order) || (a.i - b.i))
            .map(g => g.name);

        // Add Favorites at the top if there are any
        const hasFavorites = this.favorites.size > 0;

        // Only rebuild dropdown if groups have changed (performance optimization)
        const groupsKey = groups.join('|') + (hasFavorites ? '|FAV' : '');
        if (this.groupSelect && this._lastGroupsKey !== groupsKey) {
            this._lastGroupsKey = groupsKey;
            const currentValue = this.selectedGroup;
            let optionsHtml = '';

            if (hasFavorites) {
                optionsHtml += `<option value="Favorites" ${currentValue === 'Favorites' ? 'selected' : ''}>Favorites</option>`;
            }

            optionsHtml += `<option value="" ${currentValue === '' ? 'selected' : ''}>All Groups</option>`;
            optionsHtml += groups.map(g => `<option value="${this.escapeHtml(g)}" ${g === currentValue ? 'selected' : ''}>${this.escapeHtml(g)}</option>`).join('');

            this.groupSelect.innerHTML = optionsHtml;
        } else if (this.groupSelect) {
            // Just update the selected value without rebuilding
            this.groupSelect.value = this.selectedGroup;
        }

        // Handle case where we defaulted to Favorites but user has none
        if (this.selectedGroup === 'Favorites' && !hasFavorites) {
            this.selectedGroup = ''; // Fallback to 'All Groups'
            if (this.groupSelect) this.groupSelect.value = '';
        }

        // Store all channels for filtering
        this.allMatchedChannels = allChannels;
        this.updateFilteredChannels();

        // Calculate time range and store for batch rendering
        const win = this.renderWindow();
        this.startTime = new Date(win.start);
        this.endTime = new Date(win.end); // Show 24 hours of programming

        // Update date display
        this.updateDateDisplay(this.startTime);

        // Generate time slots
        const timeSlots = this.generateTimeSlots(this.startTime, this.endTime);

        // Calculate total height for virtual scrolling
        const totalHeight = this.filteredChannels.length * this.rowHeight;

        // Build HTML structure - header is INSIDE scroll container for natural sync
        this.container.innerHTML = `
      <div class="epg-container" style="position: relative;">
        <div class="epg-scroll-container" style="overflow: auto; max-height: calc(100vh - 200px);">
          <div class="epg-time-header">
            <div class="epg-header-corner"></div>
            <div class="epg-time-slots">
              ${timeSlots.map(slot => `
                <div class="epg-time-slot" style="width: ${30 * this.pixelsPerMinute}px;">
                  ${slot.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              `).join('')}
            </div>
          </div>
          <div class="epg-spacer" style="height: ${totalHeight}px; position: relative;">
            <div class="epg-channel-rows" style="position: absolute; top: 0; left: 0; right: 0;"></div>
          </div>
        </div>
      </div>
    `;

        // Get references for virtual scrolling
        this.scrollContainer = this.container.querySelector('.epg-scroll-container');
        this.epgSpacer = this.container.querySelector('.epg-spacer');
        this.epgContainer = this.container.querySelector('.epg-channel-rows');

        // Clear visible rows cache
        this.visibleRows.clear();
        this._lastVisibleStart = -1;
        this._lastVisibleEnd = -1;

        // Remove old scroll handler if exists
        if (this._scrollHandler) {
            this.scrollContainer?.removeEventListener('scroll', this._scrollHandler);
        }

        // Get reference to time slots container for horizontal scroll sync
        this.timeSlotsContainer = this.container.querySelector('.epg-time-slots');

        // Set up scroll handler for virtual scrolling (debounced for performance)
        this._scrollHandler = this.debounce(() => this.updateVisibleRows(), 16); // ~60fps
        this.scrollContainer.addEventListener('scroll', this._scrollHandler);

        // Initial render of visible rows
        this.updateVisibleRows();

        // Sync header corner width with actual sidebar width (handles CSS overrides)
        this.syncHeaderCornerWidth();

        // Add now indicator and set up periodic refresh
        this.updateNowIndicator();
        if (this._nowIndicatorInterval) {
            clearInterval(this._nowIndicatorInterval);
        }
        this._nowIndicatorInterval = setInterval(() => this.updateNowIndicator(), 60000);
    }

    /**
     * Sync header corner width with actual sidebar width
     * This handles cases where CSS variables are overridden on mobile
     */
    syncHeaderCornerWidth() {
        const sidebar = this.container.querySelector('.epg-channel-info');
        const headerCorner = this.container.querySelector('.epg-header-corner');
        if (sidebar && headerCorner) {
            const actualWidth = sidebar.offsetWidth;
            headerCorner.style.width = `${actualWidth}px`;
        }
    }

    /**
     * Update visible rows based on scroll position (Virtual Scrolling)
     */
    updateVisibleRows() {
        if (!this.scrollContainer || !this.epgContainer) return;

        const scrollTop = this.scrollContainer.scrollTop;
        const viewportHeight = this.scrollContainer.clientHeight;

        // Calculate visible range
        const startIndex = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.bufferRows);
        const endIndex = Math.min(
            this.filteredChannels.length - 1,
            Math.ceil((scrollTop + viewportHeight) / this.rowHeight) + this.bufferRows
        );

        // Skip if nothing changed
        if (startIndex === this._lastVisibleStart && endIndex === this._lastVisibleEnd) {
            return;
        }

        this._lastVisibleStart = startIndex;
        this._lastVisibleEnd = endIndex;

        // Determine which rows to add and remove
        const newVisibleSet = new Set();
        for (let i = startIndex; i <= endIndex; i++) {
            newVisibleSet.add(i);
        }

        // Remove rows that are no longer visible
        for (const [index, row] of this.visibleRows) {
            if (!newVisibleSet.has(index)) {
                row.remove();
                this.visibleRows.delete(index);
            }
        }

        // Add new visible rows
        for (let i = startIndex; i <= endIndex; i++) {
            if (!this.visibleRows.has(i) && i < this.filteredChannels.length) {
                const row = this.createChannelRow(i);
                this.visibleRows.set(i, row);
                this.epgContainer.appendChild(row);
            }
        }
    }

    /**
     * Create a channel row element for virtual scrolling
     */
    createChannelRow(index) {
        const channel = this.filteredChannels[index];
        const isFavorite = this.favorites.has(this.favKey(channel));

        const channelProgrammes = (channel.programmes || [])
            .filter(p => p.startMs < this.endTime.getTime() && p.stopMs > this.startTime.getTime());

        const row = document.createElement('div');
        row.className = 'epg-channel-row';
        row.dataset.channelId = channel.id;
        row.dataset.sourceId = channel.sourceId;
        row.dataset.favKey = this.favKey(channel);
        row.dataset.channelName = channel.name || '';
        row.dataset.index = index;
        // Position absolutely for virtual scrolling
        row.style.position = 'absolute';
        row.style.top = `${index * this.rowHeight}px`;
        row.style.left = '0';
        row.style.right = '0';
        row.style.height = `${this.rowHeight}px`;

        const number = channel.number !== null && channel.number !== undefined
            ? `<span class="epg-channel-number">${this.escapeHtml(channel.number)}</span>` : '';

        row.innerHTML = `
          <div class="epg-channel-info">
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
            ${number}
            <img class="epg-channel-logo" src="${this.escapeHtml(this.logoUrl(channel.tvgLogo))}"
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <span class="epg-channel-name">${this.escapeHtml(channel.name)}</span>
            <div class="resize-handle"></div>
          </div>
          <div class="epg-programs">
            ${this.renderProgrammes(channelProgrammes, this.startTime, this.endTime, channel)}
          </div>
        `;

        this.attachRowListeners(row);
        return row;
    }

    /**
     * Attach event listeners to an EPG row
     */
    attachRowListeners(row) {
        // Program click handlers
        row.querySelectorAll('.epg-program').forEach(prog => {
            prog.addEventListener('click', () => this.showProgramDetails(prog.dataset));
        });

        const info = row.querySelector('.epg-channel-info');
        if (info) {
            const channelId = row.dataset.channelId;
            const sourceId = row.dataset.sourceId;
            const channelName = row.dataset.channelName;

            // The whole channel cell tunes the channel, not just the text.
            // Anything with its own click behaviour (favourite star, the
            // column resize handle) is excluded via closest().
            info.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn') || e.target.closest('.resize-handle')) return;
                e.stopPropagation();
                this.playChannel(channelName, channelId, sourceId);
            });

            // Favorite click
            const favBtn = info.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const sourceId = parseInt(row.dataset.sourceId);
                    const channelId = row.dataset.channelId;
                    await this.toggleFavorite(sourceId, channelId);
                });
            }
        }
    }

    /** Every star for this channel in the grid, whichever listing it is. */
    setFavoriteButtons(key, isFavorite) {
        const safe = String(key).replace(/"/g, '\\"');
        this.container.querySelectorAll(`.epg-channel-row[data-fav-key="${safe}"] .favorite-btn`).forEach(btn => {
            btn.classList.toggle('active', isFavorite);
            btn.innerHTML = isFavorite ? Icons.favorite : Icons.favoriteOutline;
            btn.title = isFavorite ? 'Remove from Favorites' : 'Add to Favorites';
        });
    }

    findRow(sourceId, channelId) {
        return (this.rows || []).find(r => String(r.id) === String(channelId) && String(r.sourceId) === String(sourceId)) || null;
    }

    /**
     * Toggle favorite (bare id; stored and matched on the channel's identity)
     */
    async toggleFavorite(sourceId, channelId) {
        const channel = this.findRow(sourceId, channelId) || { sourceId, id: channelId };
        const key = this.favKey(channel);
        const wasFavorite = this.favorites.has(key);
        const isNowFavorite = !wasFavorite;

        const apply = (isFavorite) => {
            if (isFavorite) this.favorites.add(key);
            else this.favorites.delete(key);
            this.setFavoriteButtons(key, isFavorite);
            window.app?.channelList?.syncFavorite(sourceId, channelId, isFavorite);
        };

        apply(isNowFavorite); // Optimistic

        try {
            if (wasFavorite) {
                await API.favorites.remove(sourceId, channelId, 'channel');
            } else {
                await API.favorites.add(sourceId, channelId, 'channel');
            }

            // Re-render if viewing Favorites group (so new favorites appear immediately)
            if (this.selectedGroup === 'Favorites') {
                this.render();
            }
        } catch (err) {
            console.error('Error toggling favorite in EPG:', err);
            apply(wasFavorite); // Revert
        }
    }

    /**
     * Sync favorite status from external source (e.g. ChannelList) without API call
     */
    syncFavorite(sourceId, channelId, isFavorite) {
        const channel = this.findRow(sourceId, channelId) || { sourceId, id: channelId };
        const key = this.favKey(channel);
        if (this.favorites.has(key) === isFavorite) return; // No change needed

        if (isFavorite) this.favorites.add(key);
        else this.favorites.delete(key);
        this.setFavoriteButtons(key, isFavorite);

        // Note: We don't call render() here - the favorites Set is updated
        // and will be used when the user navigates to Guide or switches groups
    }

    /**
     * Generate time slots
     */
    generateTimeSlots(start, end) {
        const slots = [];
        const current = new Date(start);

        while (current < end) {
            slots.push(new Date(current));
            current.setMinutes(current.getMinutes() + 30);
        }

        return slots;
    }

    /**
     * Render programmes for a channel
     */
    renderProgrammes(programmes, startTime, endTime, channel) {
        // Recordable channels must actually map to a playable stream (source + bare id)
        const canRecord = !!(channel && channel.sourceId && channel.id);
        const channelAttrs = canRecord
            ? `data-source-id="${this.escapeHtml(channel.sourceId)}" data-channel-id="${this.escapeHtml(channel.id)}" data-channel-name="${this.escapeHtml(channel.name || '')}" data-channel-logo="${this.escapeHtml(channel.tvgLogo || '')}"`
            : '';

        if (programmes.length === 0) {
            const width = (endTime - startTime) / 60000 * this.pixelsPerMinute;
            return `<div class="epg-program" style="width: ${width}px;"><span class="epg-program-title">No data</span></div>`;
        }

        const now = Date.now();
        let html = '';
        let currentPos = startTime.getTime();

        for (const prog of programmes) {
            const progStart = Math.max(prog.startMs, startTime.getTime());
            const progEnd = Math.min(prog.stopMs, endTime.getTime());

            // Fill gap if needed
            if (progStart > currentPos) {
                const gapWidth = (progStart - currentPos) / 60000 * this.pixelsPerMinute;
                html += `<div class="epg-program" style="width: ${gapWidth}px;"></div>`;
            }

            const width = (progEnd - progStart) / 60000 * this.pixelsPerMinute;
            const isCurrent = prog.startMs <= now && prog.stopMs > now;
            const isRecordable = canRecord && prog.stopMs > now; // can't record something already over

            html += `
        <div class="epg-program ${isCurrent ? 'current' : ''}"
             style="width: ${width}px;"
             data-title="${this.escapeHtml(prog.title || '')}"
             data-description="${this.escapeHtml(prog.description || '')}"
             data-start="${prog.start}"
             data-stop="${prog.stop}"
             data-recordable="${isRecordable}"
             ${channelAttrs}>
          <div class="epg-program-title">${this.escapeHtml(prog.title || 'Unknown')}</div>
          <div class="epg-program-time">
            ${new Date(prog.startMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      `;

            currentPos = progEnd;
        }

        return html;
    }

    /**
     * Update date display
     */
    updateDateDisplay(date) {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        if (date.toDateString() === today.toDateString()) {
            this.dateDisplay.textContent = 'Today';
        } else if (date.toDateString() === tomorrow.toDateString()) {
            this.dateDisplay.textContent = 'Tomorrow';
        } else {
            this.dateDisplay.textContent = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        }
    }

    /**
     * Debounce utility
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    updateNowIndicator() {
        const now = new Date();
        // Place indicator inside the spacer so it scrolls with content
        const spacer = this.container.querySelector('.epg-spacer');
        if (!spacer) return;

        // Remove existing indicator
        const existing = spacer.querySelector('.epg-now-line');
        if (existing) existing.remove();

        // Calculate position relative to EPG start time
        const minutesFromStart = (now - this.startTime) / 60000;
        if (minutesFromStart < 0 || minutesFromStart > 1440) return; // Not in visible 24h range

        // Get sidebar width to offset the indicator
        const sidebar = this.container.querySelector('.epg-channel-info');
        const sidebarWidth = sidebar ? sidebar.offsetWidth : 150;

        // Position is sidebar + time offset
        const leftPos = sidebarWidth + (minutesFromStart * this.pixelsPerMinute);

        const indicator = document.createElement('div');
        indicator.className = 'epg-now-line';
        indicator.style.left = `${leftPos}px`;
        spacer.appendChild(indicator);
    }

    /**
     * Show program details modal
     */
    async showProgramDetails(data) {
        const modal = document.getElementById('modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');

        title.textContent = data.title || 'Program Details';

        const start = new Date(data.start);
        const stop = new Date(data.stop);
        const canRecord = data.recordable === 'true' && data.sourceId && data.channelId;

        // Default buffer minutes come from settings, falling back to sane defaults
        let defaultPre = 1, defaultPost = 5;
        try {
            const settings = await API.settings.get();
            if (settings.defaultPreBufferMin !== undefined) defaultPre = settings.defaultPreBufferMin;
            if (settings.defaultPostBufferMin !== undefined) defaultPost = settings.defaultPostBufferMin;
        } catch (e) { /* use defaults */ }

        body.innerHTML = `
      <p><strong>Time:</strong> ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${stop.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      <p><strong>Description:</strong></p>
      <p>${this.escapeHtml(data.description || 'No description available')}</p>
      ${canRecord ? `
        <div class="record-options">
          <label>Start recording (min before): <input type="number" id="record-pre-buffer" min="0" max="60" value="${defaultPre}" style="width: 60px;"></label>
          <label style="margin-left: 12px;">Stop recording (min after): <input type="number" id="record-post-buffer" min="0" max="120" value="${defaultPost}" style="width: 60px;"></label>
        </div>
      ` : ''}
    `;

        footer.innerHTML = `
      ${canRecord ? '<button class="btn btn-primary" id="modal-record">Record</button>' : ''}
      <button class="btn btn-secondary" id="modal-close">Close</button>
    `;

        modal.classList.add('active');
        const close = () => modal.classList.remove('active');
        document.getElementById('modal-close').onclick = close;
        modal.querySelector('.modal-close').onclick = close;

        if (canRecord) {
            document.getElementById('modal-record').onclick = async () => {
                const preBufferMin = parseInt(document.getElementById('record-pre-buffer').value, 10) || 0;
                const postBufferMin = parseInt(document.getElementById('record-post-buffer').value, 10) || 0;
                await this.scheduleRecording({ ...data, preBufferMin, postBufferMin });
                close();
            };
        }
    }

    /**
     * Schedule a DVR recording for an EPG program
     */
    async scheduleRecording(data) {
        try {
            await API.recordings.schedule({
                sourceId: parseInt(data.sourceId),
                channelItemId: data.channelId,
                channelName: data.channelName,
                channelLogo: data.channelLogo,
                title: data.title,
                description: data.description,
                programStart: new Date(data.start).getTime(),
                programEnd: new Date(data.stop).getTime(),
                preBufferMin: data.preBufferMin,
                postBufferMin: data.postBufferMin
            });

            if (window.app?.showToast) {
                window.app.showToast(`Recording scheduled: ${data.title}`);
            } else {
                alert(`Recording scheduled: ${data.title}`);
            }
        } catch (err) {
            console.error('Failed to schedule recording:', err);
            alert(`Failed to schedule recording: ${err.message}`);
        }
    }

    /**
     * Play channel from EPG
     */
    async playChannel(channelName, channelId, sourceId) {
        if (!window.app?.channelList) return;

        const cl = window.app.channelList;

        // Navigate to the Live TV page FIRST so the player element is in
        // the DOM when selectChannel tries to play.
        window.app.navigateTo('live');

        // Ensure channels are loaded (they may not be if the user hasn't
        // visited Live TV yet this session). Wait a tick after navigation
        // so the page controller's show() has run.
        await new Promise(r => setTimeout(r, 100));
        if (cl.channels.length === 0) {
            await cl.loadChannels();
        }

        // The guide and the channel list share the library's ids.
        let channel = cl.findChannel(sourceId, channelId);
        if (!channel && channelName) {
            const lower = channelName.toLowerCase();
            channel = cl.channels.find(c => (c.name || '').toLowerCase() === lower);
        }

        if (channel) {
            await cl.selectChannel({ channelId: channel.id, sourceId: channel.sourceId });
        } else {
            console.warn('[EpgGuide] Could not find channel:', channelName, channelId);
        }
    }
}

// Export
window.EpgGuide = EpgGuide;
