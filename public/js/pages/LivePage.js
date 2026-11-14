/**
 * Home Page Controller
 */

class LivePage {
    constructor(app) {
        this.app = app;
        this.handleKeydown = this.handleKeydown.bind(this);
    }

    /**
     * Update "Now Playing" info in existing channel elements without blocking UI
     */
    updateProgramInfo() {
        const channelItems = Array.from(document.querySelectorAll('.channel-item'));
        if (channelItems.length === 0) return;

        // Build a map for O(1) channel lookups (ids are per source)
        const channelMap = new Map();
        this.app.channelList.channels.forEach(c => channelMap.set(`${c.sourceId}:${c.id}`, c));

        // Process in small batches to avoid blocking UI
        const BATCH_SIZE = 50;
        let index = 0;

        const processBatch = () => {
            const end = Math.min(index + BATCH_SIZE, channelItems.length);

            for (let i = index; i < end; i++) {
                const item = channelItems[i];
                const channel = channelMap.get(`${item.dataset.sourceId}:${item.dataset.channelId}`);

                if (channel) {
                    const programDiv = item.querySelector('.channel-program');
                    if (programDiv) {
                        const programTitle = this.app.channelList.getProgramInfo(channel);
                        programDiv.textContent = programTitle || '';
                    }
                }
            }

            index = end;
            if (index < channelItems.length) {
                // Yield to browser before next batch
                requestAnimationFrame(processBatch);
            }
        };

        // Start processing
        requestAnimationFrame(processBatch);
    }

    handleKeydown(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key) {
            case 'ArrowUp':
                // Check if player handles arrows for volume
                if (this.app.player && !this.app.player.settings.arrowKeysChangeChannel) return;

                e.preventDefault();
                this.app.channelList.selectPrevChannel();
                break;
            case 'ArrowDown':
                // Check if player handles arrows for volume
                if (this.app.player && !this.app.player.settings.arrowKeysChangeChannel) return;

                e.preventDefault();
                this.app.channelList.selectNextChannel();
                break;
        }
    }

    async show() {
        document.addEventListener('keydown', this.handleKeydown);
        // #321: the player is in sight again; the Now playing bar goes.
        if (this.app.player && this.app.player.setAway) this.app.player.setAway(false);
        if (this.app.player && this.app.player.updateTabTitle) this.app.player.updateTabTitle();
        this.app.channelList.setEpgRefreshActive(true);

        // Only reload if channels aren't already loaded
        if (this.app.channelList.channels.length === 0) {
            await this.app.channelList.loadSources();
            await this.app.channelList.loadChannels();
        }
        // The channel last watched, selected and one click from playing (never played unasked).
        if (this.app.player && this.app.player.offerResume) this.app.player.offerResume();
        // Now/next in the list (F7: loaded here, not at start-up), then a refresh check if one is due.
        try {
            const first = !this.app.epgGuide.loaded;
            await this.app.epgGuide.ensureLoaded();
            if (first) { this.app.channelList.clearProgramInfoCache(); this.updateProgramInfo(); }
            else this.app.epgGuide.refreshTick();
        } catch (err) {
            console.warn('EPG load failed:', err);
        }
    }

    hide() {
        document.removeEventListener('keydown', this.handleKeydown);
        this.app.channelList.setEpgRefreshActive(false);
        if (this.app.player && this.app.player.abandonPrompt) this.app.player.abandonPrompt();
        // #321: the stream keeps playing out of sight; the Now playing bar says what, with Stop and Back to Live TV.
        if (this.app.player && this.app.player.setAway) this.app.player.setAway(true);
    }
}

window.LivePage = LivePage;
