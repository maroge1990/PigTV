/**
 * Home Dashboard Page
 * The favourite channels (0122: the movie/series rows went with VOD).
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
            await this.renderFavoriteChannels();
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
}

window.HomePage = HomePage;
