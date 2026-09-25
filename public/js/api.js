/**
 * API Client - Frontend API wrapper for PigTV
 */

const API = {
    /**
     * Make API request
     */
    async request(method, endpoint, data = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        // Add authentication token if available
        const token = localStorage.getItem('authToken');
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }

        if (data) {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(`/api${endpoint}`, options);

        let result;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            result = await response.json();
        } else {
            const text = await response.text();
            result = { error: text || 'API request failed' };
        }

        if (!response.ok) {
            // If unauthorized, redirect to login
            if (response.status === 401) {
                localStorage.removeItem('authToken');
                window.location.href = '/login.html';
                throw new Error('Authentication required');
            }
            throw new Error(result.error || `Server responded with ${response.status}`);
        }

        return result;
    },

    /**
     * Append this browser's auth token to a same-origin stream URL.
     *
     * A <video src> and hls.js's XHR-based segment loader can't send an
     * Authorization header, so the server's stream endpoints
     * (/api/transcode, /api/proxy/stream) accept the token as
     * a query parameter instead - the same mechanism native clients use,
     * and the reason those URLs are already documented as bearer tokens
     * in their own right. Harmless to include even when requireStreamAuth
     * is off (streamAuth only rejects a *missing* token when enforcement
     * is on), and required once it's on, since none of these URLs can
     * carry a header. The server carries this token forward onto every
     * child playlist/segment URI on its own once it sees it on the
     * top-level request - the caller only needs to get it onto that one.
     */
    withStreamToken(url) {
        if (!url) return url;
        const token = localStorage.getItem('authToken');
        if (!token) return url;
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}token=${encodeURIComponent(token)}`;
    },

    /**
     * Plain fetch with the Authorization header attached when a token is
     * available, for the handful of /api/transcode management calls that
     * return their own response shape rather than API.request's envelope
     * (and so call fetch directly instead of going through it).
     */
    streamFetch(url, options = {}) {
        const token = localStorage.getItem('authToken');
        const headers = { ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        return fetch(url, { ...options, headers });
    },

    // Sources
    sources: {
        getAll: () => API.request('GET', '/sources'),
        getByType: (type) => API.request('GET', `/sources/type/${type}`),
        getById: (id) => API.request('GET', `/sources/${id}`),
        create: (data) => API.request('POST', '/sources', data),
        update: (id, data) => API.request('PUT', `/sources/${id}`, data),
        delete: (id) => API.request('DELETE', `/sources/${id}`),
        toggle: (id) => API.request('POST', `/sources/${id}/toggle`),
        test: (id) => API.request('POST', `/sources/${id}/test`),
        sync: (id) => API.request('POST', `/sources/${id}/sync`), // Manual sync
        getStatus: () => API.request('GET', '/sources/status'), // Get all statuses
        estimate: (id) => API.request('GET', `/sources/${id}/estimate`), // Estimate M3U size
        estimateByUrl: (url, type) => API.request('POST', '/sources/estimate', { url, type }), // Estimate by URL (before creation)
        catalogue: (id) => API.request('GET', `/sources/${id}/catalogue?type=live`), // Sources picker (0120)
    },

    // Library (0121, W2.1): the same browsing API the Apple client uses. Rows carry
    // the bare channel id, its number, a /api/logo/ path and now/next; only visible
    // channels are listed.
    library: {
        categories: () => API.request('GET', '/library/categories'),
        setCategorySport: (sourceId, categoryId, sport) => API.request('PUT', '/library/categories/sport', { sourceId, categoryId, sport }), // 0146 (C-H)
        channels: ({ limit = 200, offset = 0, category = null, search = null } = {}) => {
            const params = [`limit=${limit}`, `offset=${offset}`];
            if (category) params.push(`category=${encodeURIComponent(category)}`);
            if (search) params.push(`search=${encodeURIComponent(search)}`);
            return API.request('GET', `/library/channels?${params.join('&')}`);
        },
        // Every visible channel, page by page (the route returns at most 200 at a time).
        allChannels: async () => {
            const first = await API.library.channels({ limit: 200, offset: 0 });
            const pages = [first];
            const rest = [];
            for (let offset = first.channels.length; offset < first.total && first.channels.length > 0; offset += 200) {
                rest.push(API.library.channels({ limit: 200, offset }));
            }
            pages.push(...await Promise.all(rest));
            return pages.flatMap(p => p.channels || []);
        },
        guide: ({ start, end, limit = 500, cursor = null, category = null } = {}) => {
            const params = [`start=${start}`, `end=${end}`, `limit=${limit}`];
            if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
            if (category) params.push(`category=${encodeURIComponent(category)}`);
            return API.request('GET', `/library/guide?${params.join('&')}`);
        },
        favourites: () => API.request('GET', '/library/favourites')
    },

    // Server status (admin; 0124)
    status: {
        get: () => API.request('GET', '/status')
    },

    // Sport (C-I; admin)
    sports: {
        categories: () => API.request('GET', '/sports/categories'), // 0147
        follow: () => API.request('GET', '/sports/follow'), // 0148
        setFollow: (keywords) => API.request('PUT', '/sports/follow', { keywords }),
        preview: () => API.request('GET', '/sports/preview')
    },

    // Channel numbers (admin; 0117 C-A, web editor 0123)
    lineup: {
        get: () => API.request('GET', '/lineup'),
        saveNumbers: (numbers) => API.request('PUT', '/lineup/numbers', { numbers })
    },

    // EPG matching (admin, 0134)
    epg: {
        unmatched: () => API.request('GET', '/epg/unmatched'),
        searchChannels: (search) => API.request('GET', `/epg/channels?search=${encodeURIComponent(search)}`),
        mappings: () => API.request('GET', '/epg/mappings'),
        setMapping: (sourceId, channelId, tvgId) => API.request('PUT', '/epg/mapping', { sourceId, channelId, tvgId })
    },

    // Channels (hidden items)
    channels: {
        getHidden: (sourceId = null) => API.request('GET', `/channels/hidden${sourceId ? `?sourceId=${sourceId}` : ''}`),
        hide: (sourceId, itemType, itemId) => API.request('POST', '/channels/hide', { sourceId, itemType, itemId }),
        show: (sourceId, itemType, itemId) => API.request('POST', '/channels/show', { sourceId, itemType, itemId }),
        isHidden: (sourceId, itemType, itemId) => API.request('GET', `/channels/hidden/check?sourceId=${sourceId}&itemType=${itemType}&itemId=${itemId}`),
        bulkHide: (items) => API.request('POST', '/channels/hide/bulk', { items }),
        bulkShow: (items) => API.request('POST', '/channels/show/bulk', { items }),
        // Fast bulk operations - single SQL statement
        showAll: (sourceId, contentType) => API.request('POST', '/channels/show/all', { sourceId, contentType }),
        hideAll: (sourceId, contentType) => API.request('POST', '/channels/hide/all', { sourceId, contentType })
    },

    // Favorites
    favorites: {
        getAll: (sourceId = null, itemType = null) => {
            let url = '/favorites';
            const params = [];
            if (sourceId) params.push(`sourceId=${sourceId}`);
            if (itemType) params.push(`itemType=${itemType}`);
            if (params.length) url += '?' + params.join('&');
            return API.request('GET', url);
        },
        add: (sourceId, itemId, itemType = 'channel') =>
            API.request('POST', '/favorites', { sourceId, itemId, itemType }),
        remove: (sourceId, itemId, itemType = 'channel') =>
            API.request('DELETE', '/favorites', { sourceId, itemId, itemType }),
        check: (sourceId, itemId, itemType = 'channel') =>
            API.request('GET', `/favorites/check?sourceId=${sourceId}&itemId=${itemId}&itemType=${itemType}`)
    },

    // Settings
    settings: {
        get: () => API.request('GET', '/settings'),
        update: (data) => API.request('PUT', '/settings', data),
        reset: () => API.request('DELETE', '/settings'),
        getDefaults: () => API.request('GET', '/settings/defaults')
    },

    // DVR / Recordings
    transcode: {
        // Mounted behind the same streamAuth middleware as every other
        // /api/transcode route (segments, playlists). Enforcement is off
        // by default, so these worked unauthenticated until now — but
        // that was the setting being off, not these routes being exempt.
        getSessions: () => API.streamFetch('/api/transcode/sessions').then(r => r.json()),
        killSession: (id) => API.streamFetch(`/api/transcode/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(r => r.json()),
        killAllSessions: () => API.streamFetch('/api/transcode/sessions/all', { method: 'DELETE' }).then(r => r.json())
    },

    recordings: {
        schedule: (data) => API.request('POST', '/recordings/schedule', data),
        getScheduled: () => API.request('GET', '/recordings/scheduled'),
        getActive: () => API.request('GET', '/recordings/active'),
        compress: (id) => API.request('POST', `/recordings/${id}/compress`),
        getMarkers: (id) => API.request('GET', `/recordings/${id}/markers`),
        detectAds: (id) => API.request('POST', `/recordings/${id}/detect-ads`),
        clearMarkers: (id) => API.request('DELETE', `/recordings/${id}/markers`),
        cancelScheduled: (id) => API.request('DELETE', `/recordings/scheduled/${id}`),
        getAll: () => API.request('GET', '/recordings'),
        delete: (id) => API.request('DELETE', `/recordings/${id}`),
        streamUrl: (id) => API.withStreamToken(`/api/recordings/${id}/stream`),
        downloadUrl: (id) => API.withStreamToken(`/api/recordings/${id}/download`)
    },

    // Users (admin only)
    users: {
        getAll: () => API.request('GET', '/auth/users'),
        create: (data) => API.request('POST', '/auth/users', data),
        update: (id, data) => API.request('PUT', `/auth/users/${id}`, data),
        delete: (id) => API.request('DELETE', `/auth/users/${id}`)
    }
};

// Make API available globally
window.API = API;
