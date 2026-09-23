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
            // Just re-render with existing data (updates time position)
            this.app.epgGuide.render();
        }
    }

    hide() {
        // Page is hidden
    }
}

window.GuidePage = GuidePage;
