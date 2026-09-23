/**
 * Home Dashboard Page
 * Features "Continue Watching" and "Recently Added" content
 */
class HomePage {
    constructor(app) {
        this.app = app;
        this.container = null; // Will be set in renderLayout
        this.isLoading = false;
    }

    async init() {
        // Initialization if needed
    }

    async show() {
        this.renderLayout();
        await this.loadDashboardData();
    }

    hide() {
        // Cleanup if needed
        if (this.container) {
            this.container.innerHTML = '';
        }
    }

    renderLayout() {
        const pageHome = document.getElementById('page-home');
        if (!pageHome) return;

        pageHome.innerHTML = `
            <div class="dashboard-content" id="home-content">
                <section class="dashboard-section" id="favorite-channels-section">
                    <div class="section-header">
                        <h2>Favorite Channels</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll channel-tiles" id="favorite-channels-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading favorites...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section" id="continue-watching-section">
                    <div class="section-header">
                        <h2>Continue Watching</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="continue-watching-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading history...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section">
                    <div class="section-header">
                        <h2>Recently Added Movies</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="recent-movies-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading recently added...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section">
                    <div class="section-header">
                        <h2>Recently Added Series</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="recent-series-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading recently added...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>
            </div>
        `;
        this.container = document.getElementById('home-content');

        // Attach scroll arrow handlers
        this.initScrollArrows();
    }

    initScrollArrows() {
        this.container.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            const scrollContainer = wrapper.querySelector('.horizontal-scroll');
            const leftBtn = wrapper.querySelector('.scroll-left');
            const rightBtn = wrapper.querySelector('.scroll-right');

            if (!scrollContainer || !leftBtn || !rightBtn) return;

            const scrollAmount = 300; // pixels to scroll per click

            leftBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
            });

            rightBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: scrollAmount, behavior: 'smooth' });
            });

            // Update arrow visibility based on scroll position
            const updateArrows = () => {
                const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
                leftBtn.classList.toggle('hidden', scrollLeft <= 0);
                rightBtn.classList.toggle('hidden', scrollLeft + clientWidth >= scrollWidth - 5);
            };

            // Store reference for later updates
            wrapper._updateArrows = updateArrows;

            scrollContainer.addEventListener('scroll', updateArrows);
            // Initial check after content loads
            setTimeout(updateArrows, 100);
        });
    }

    /**
     * Re-check scroll arrow visibility for all sections
     * Call this after dynamically loading content
     */
    updateScrollArrows() {
        this.container?.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            if (wrapper._updateArrows) {
                wrapper._updateArrows();
            }
        });
    }


    async loadDashboardData() {
        if (this.isLoading) return;
        this.isLoading = true;

        try {
            // 0. Load Favorite Channels (first section)
            await this.renderFavoriteChannels();

            // 1. Load Watch History
            const history = await window.API.request('GET', '/history?limit=12');
            if (history && Array.isArray(history)) {
                this.renderHistory(history);
            }

            // 2. Load Recent Items
            if (window.app?._showMovies !== false) {
                this.renderRecentMovies();
            } else {
                const ms = document.getElementById('recent-movies-list');
                if (ms) ms.closest('.dashboard-section').style.display = 'none';
            }
            if (window.app?._showSeries !== false) {
                this.renderRecentSeries();
            } else {
                const ss = document.getElementById('recent-series-list');
                if (ss) ss.closest('.dashboard-section').style.display = 'none';
            }

        } catch (err) {
            console.error('[Dashboard] Error loading data:', err);
        } finally {
            this.isLoading = false;
        }
    }

    async renderFavoriteChannels() {
        const list = document.getElementById('favorite-channels-list');
        const section = document.getElementById('favorite-channels-section');
        if (!list || !section) return;

        try {
            // 0121 (W2.1): the favourites as library rows - name, number, logo and
            // the bare id - one per channel, in one request.
            const favourites = await window.API.library.favourites();
            const numberOf = (c) => (c.number === null || c.number === undefined ? Infinity : c.number);
            const channels = (Array.isArray(favourites) ? favourites : [])
                .slice()
                .sort((a, b) => numberOf(a) - numberOf(b) || String(a.name).localeCompare(String(b.name)));

            if (channels.length === 0) {
                list.innerHTML = '<div class="empty-state hint">Add channels to favorites from Live TV</div>';
                return;
            }

            // Render channel tiles
            list.innerHTML = channels.map(ch => this.createChannelTile(ch)).join('');

            // Attach click handlers
            list.querySelectorAll('.channel-tile').forEach(tile => {
                tile.addEventListener('click', () => {
                    this.playChannel(tile.dataset.channelId, tile.dataset.sourceId);
                });
            });

            // Update scroll arrows after content renders
            this.updateScrollArrows();

        } catch (err) {
            console.error('[Dashboard] Error loading favorite channels:', err);
            list.innerHTML = '<div class="empty-state hint">Error loading favorites</div>';
        }
    }

    escapeHtml(text) {
        if (text === null || text === undefined || text === '') return '';
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    /** A tile for a /api/library/favourites row (its logo is our own /api/logo/ path). */
    createChannelTile(channel) {
        const logoUrl = channel.logo || '/img/placeholder.png';
        const name = this.escapeHtml(channel.name || 'Unknown');
        const number = channel.number !== null && channel.number !== undefined
            ? `<span class="tile-number">${this.escapeHtml(channel.number)}</span> ` : '';

        return `
            <div class="channel-tile" data-channel-id="${this.escapeHtml(channel.id)}" data-source-id="${this.escapeHtml(channel.sourceId)}">
                <div class="tile-logo">
                    <img src="${this.escapeHtml(logoUrl)}" alt="${name}" loading="lazy" onerror="this.onerror=null;this.src='/img/placeholder.png'">
                </div>
                <div class="tile-name" title="${name}">${number}${name}</div>
            </div>
        `;
    }

    async playChannel(channelId, sourceId) {
        // Navigate to Live TV and select the channel
        this.app.navigateTo('live');

        const channelList = this.app.channelList;
        if (!channelList) return;
        // Small delay to ensure page is ready, and the list loaded if it never was
        await new Promise(r => setTimeout(r, 100));
        if (!channelList.channels || channelList.channels.length === 0) {
            await channelList.loadSources();
            await channelList.loadChannels();
        }
        const channel = channelList.findChannel(sourceId, channelId);
        if (channel) {
            channelList.selectChannel({ channelId: channel.id, sourceId: channel.sourceId });
        }
    }

    renderHistory(items) {
        const list = document.getElementById('continue-watching-list');
        const section = document.getElementById('continue-watching-section');

        if (!list || !section) return;

        if (items.length === 0) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        list.innerHTML = items.map(item => this.createCard(item)).join('');

        // Attach click listeners
        list.querySelectorAll('.dashboard-card').forEach(card => {
            card.addEventListener('click', () => {
                const id = card.dataset.id;
                const item = items.find(i => i.item_id === id);
                if (item) {
                    const type = item.item_type || item.type;

                    // IF it's a series, checking details is better than blind resume
                    // BUT for "Continue Watching", we ideally want to resume

                    // Prioritize playing directly for resume tiles
                    this.playItem(item, true); // true for resume
                }
            });
        });

        // Update scroll arrows after content renders
        this.updateScrollArrows();
    }

    navigateToSeries(item) {
        if (!this.app.pages.series) return;

        // Prepare the series object as expected by SeriesPage.showSeriesDetails
        const series = {
            series_id: item.item_id,
            sourceId: item.source_id,
            name: item.name || (item.data ? item.data.title : 'Series'),
            cover: item.stream_icon || (item.data ? item.data.poster : null),
            plot: item.data ? item.data.description : '',
            year: item.data ? item.data.year : ''
        };

        // Switch page
        this.app.navigateTo('series');

        // Show details (delay slightly to ensure page is visible)
        setTimeout(() => {
            this.app.pages.series.showSeriesDetails(series);
        }, 100);
    }

    async renderRecentMovies() {
        const list = document.getElementById('recent-movies-list');
        if (!list) return;

        try {
            const movies = await window.API.request('GET', '/channels/recent?type=movie&limit=12');
            if (!movies || movies.length === 0) {
                list.innerHTML = '<div class="empty-state hint">No recently added movies found</div>';
                return;
            }

            list.innerHTML = movies.map(item => this.createRecentCard(item)).join('');

            // Attach listeners
            list.querySelectorAll('.dashboard-card').forEach(card => {
                card.addEventListener('click', () => {
                    const id = card.dataset.id;
                    const item = movies.find(m => m.item_id === id);
                    if (item) this.playItem(item);
                });
            });

            // Update scroll arrows after content renders
            this.updateScrollArrows();
        } catch (err) {
            console.error('[Dashboard] Error loading recent movies:', err);
        }
    }

    async renderRecentSeries() {
        const list = document.getElementById('recent-series-list');
        if (!list) return;

        try {
            const series = await window.API.request('GET', '/channels/recent?type=series&limit=12');
            if (!series || series.length === 0) {
                list.innerHTML = '<div class="empty-state hint">No recently added series found</div>';
                return;
            }

            list.innerHTML = series.map(item => this.createRecentCard(item)).join('');

            // Attach listeners
            list.querySelectorAll('.dashboard-card').forEach(card => {
                card.addEventListener('click', () => {
                    const id = card.dataset.id;
                    const item = series.find(s => s.item_id === id);
                    if (item) this.navigateToSeries(item);
                });
            });

            // Update scroll arrows after content renders
            this.updateScrollArrows();
        } catch (err) {
            console.error('[Dashboard] Error loading recent series:', err);
        }
    }

    createCard(item) {
        const { data, progress, duration, item_id } = item;
        const type = item.item_type || item.type;
        const percent = Math.min(100, Math.round((progress / duration) * 100));

        // Proxy the poster if it's an external URL
        const poster = data.poster || '/img/poster-placeholder.jpg';
        const posterUrl = poster.startsWith('http') ? `/api/proxy/image?url=${encodeURIComponent(poster)}` : poster;

        return `
            <div class="dashboard-card" data-id="${item_id}" data-type="${type}">
                <div class="card-image">
                    <img src="${posterUrl}" alt="${data.title || item.name}" loading="lazy" onerror="this.onerror=null;this.src='/img/poster-placeholder.jpg'">
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width: ${percent}%"></div>
                    </div>
                    <div class="play-icon-overlay">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </div>
                <div class="card-info">
                    <div class="card-title" title="${item.name || data.title}">${item.name || data.title || 'Unknown Title'}</div>
                    <div class="card-subtitle">${data.subtitle || (type === 'movie' ? 'Movie' : 'Series')}</div>
                </div>
            </div>
        `;
    }

    createRecentCard(item) {
        const { data, item_id } = item;
        const type = item.type || item.item_type;
        const poster = item.stream_icon || data.poster || '/img/poster-placeholder.jpg';
        const posterUrl = poster.startsWith('http') ? `/api/proxy/image?url=${encodeURIComponent(poster)}` : poster;

        return `
            <div class="dashboard-card" data-id="${item_id}" data-type="${type}">
                <div class="card-image">
                    <img src="${posterUrl}" alt="${item.name}" loading="lazy" onerror="this.onerror=null;this.src='/img/poster-placeholder.jpg'">
                    <div class="play-icon-overlay">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </div>
                <div class="card-info">
                    <div class="card-title" title="${item.name || (data && data.title)}">${item.name || (data && data.title) || 'Unknown Title'}</div>
                    <div class="card-subtitle">${(data && data.subtitle) || (type === 'movie' ? 'Movie' : 'Series')}</div>
                </div>
            </div>
        `;
    }

    async playItem(item, isResume = false) {
        if (!this.app.pages.watch) return;

        try {
            const type = item.item_type || item.type;
            const streamType = type === 'movie' ? 'movie' : 'series';
            const sourceId = item.source_id || (item.data && item.data.sourceId);
            const streamId = item.item_id;
            const container = item.container_extension || (item.data && item.data.containerExtension) || 'mp4';

            const result = await window.API.request('GET', `/proxy/xtream/${sourceId}/stream/${streamId}/${streamType}?container=${container}`);

            if (result && result.url) {
                const content = {
                    id: item.item_id,
                    type: type,
                    title: item.name || item.data.title,
                    subtitle: item.data.subtitle || (type === 'movie' ? 'Movie' : 'Series'),
                    poster: item.stream_icon || item.data.poster,
                    sourceId: sourceId,
                    resumeTime: isResume ? item.progress : 0,
                    containerExtension: container
                };

                // For episodes, try to restore series data for next episode functionality
                if (type === 'episode' && item.data) {
                    content.seriesId = item.data.seriesId || null;
                    content.currentSeason = item.data.currentSeason || null;
                    content.currentEpisode = item.data.currentEpisode || null;

                    // Fetch seriesInfo if we have a seriesId
                    if (content.seriesId && sourceId) {
                        try {
                            const seriesInfo = await window.API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${content.seriesId}`);
                            if (seriesInfo) {
                                content.seriesInfo = seriesInfo;
                            }
                        } catch (e) {
                            console.warn('[Dashboard] Could not fetch seriesInfo for next episode:', e);
                        }
                    }
                }

                // Switch to watch page
                this.app.navigateTo('watch');

                this.app.pages.watch.play(content, result.url);
            }
        } catch (err) {
            console.error('[Dashboard] Playback failed:', err);
        }
    }
}

window.HomePage = HomePage;
