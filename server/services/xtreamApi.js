/**
 * Xtream Codes API v2 Client
 * Handles authentication and API calls to Xtream servers
 */
const { providerFetch } = require('./providerFetch'); // #106: deadline and the configured User-Agent

class XtreamApi {
    constructor(baseUrl, username, password) {
        // Clean up base URL
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.username = username;
        this.password = password;
    }

    /**
     * Build API URL with authentication
     */
    buildApiUrl(action, params = {}) {
        const url = new URL(`${this.baseUrl}/player_api.php`);
        url.searchParams.set('username', this.username);
        url.searchParams.set('password', this.password);
        if (action) {
            url.searchParams.set('action', action);
        }
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, value);
            }
        }
        return url.toString();
    }

    /**
     * Make API request
     */
    async request(action, params = {}) {
        const url = this.buildApiUrl(action, params);
        const response = await providerFetch(url, 'api');
        if (!response.ok) {
            throw new Error(`Xtream API error: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Authenticate and get server/user info
     */
    async authenticate() {
        const data = await this.request(null);
        if (!data.user_info) {
            throw new Error('Invalid credentials or server response');
        }
        return data;
    }

    /**
     * Get live channel categories
     */
    async getLiveCategories() {
        return this.request('get_live_categories');
    }

    /**
     * Get live streams, optionally filtered by category
     */
    async getLiveStreams(categoryId = null) {
        return this.request('get_live_streams', { category_id: categoryId });
    }

    /**
     * Build stream URL for playback
     */
    buildStreamUrl(streamId, type = 'live', container = 'ts') {
        // Only live channels are played: `type` is accepted for the callers that pass 'live'.
        return `${this.baseUrl}/live/${this.username}/${this.password}/${streamId}.${container}`;
    }

    /**
     * Get XMLTV EPG URL
     */
    getXmltvUrl() {
        return `${this.baseUrl}/xmltv.php?username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
    }
}

/**
 * Factory function to create API instance from source
 */
function createFromSource(source) {
    return new XtreamApi(source.url, source.username, source.password);
}

/**
 * Static authenticate for testing
 */
async function authenticate(url, username, password) {
    const api = new XtreamApi(url, username, password);
    return api.authenticate();
}

module.exports = { XtreamApi, createFromSource, authenticate };
