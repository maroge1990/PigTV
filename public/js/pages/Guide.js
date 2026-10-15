/**
 * Guide Page Controller
 */

class GuidePage {
    constructor(app) {
        this.app = app;
    }

    async init() {
        // EPG guide will lazy load when shown
    }

    async show() {
        // The guide reads its own channels from /api/library/guide (0121); the
        // channel list is only needed when a channel is played from it.
        // Only load EPG data if not already loaded
        if (!this.app.epgGuide.loaded) {
            await this.app.epgGuide.loadEpg();
        } else {
            // The cached guide at once (updates time position), then a version check if one
            // is due (F7): a return after a while does not show stale data for 5 minutes.
            this.app.epgGuide.render();
            this.app.epgGuide.refreshTick();
        }
    }

    hide() {
        // Page is hidden
    }
}

window.GuidePage = GuidePage;
