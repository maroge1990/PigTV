/**
 * PigTV Application Entry Point
 */

class App {
    constructor() {
        this.currentPage = 'live';
        this.pages = {};
        this.currentUser = null;

        // Initialize components
        this.player = new VideoPlayer();
        this.channelList = new ChannelList();
        this.sourceManager = new SourceManager();
        this.epgGuide = new EpgGuide();

        // Initialize page controllers
        this.pages.live = new LivePage(this);
        this.pages.guide = new GuidePage(this);
        this.pages.sports = new SportsPage(this);
        this.pages.recordings = new RecordingsPage(this);
        this.pages.settings = new SettingsPage(this);
        this.pages.status = new StatusPage(this);

        this.init();
    }

    async init() {
        // Check authentication first
        await this.checkAuth();
        if (!this.currentUser) return;
        if (this.currentUser.role === 'admin') {
            this.showProviderReminders();
        }

        // Mobile menu toggle
        const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
        const navbarMenu = document.getElementById('navbar-menu');

        if (mobileMenuToggle && navbarMenu) this.wireMobileMenu(mobileMenuToggle, navbarMenu);

        // Channel drawer toggle (mobile)
        const channelToggleBtn = document.getElementById('channel-toggle-btn');
        const channelSidebar = document.getElementById('channel-sidebar');
        const channelOverlay = document.getElementById('channel-sidebar-overlay');

        if (channelToggleBtn && channelSidebar && channelOverlay) {
            const toggleChannelDrawer = () => {
                channelSidebar.classList.toggle('active');
                channelOverlay.classList.toggle('active');
            };

            channelToggleBtn.addEventListener('click', toggleChannelDrawer);
            channelOverlay.addEventListener('click', toggleChannelDrawer);

            // Close drawer when a channel is selected
            channelSidebar.addEventListener('click', (e) => {
                // #276 (C2): shut in the tap itself. The channel's own handler is on the item, below this one, so it
                // has already run by the time the click reaches the sidebar; nothing waits on a timer.
                if (e.target.closest('.channel-item')) {
                    channelSidebar.classList.remove('active');
                    channelOverlay.classList.remove('active');
                }
            });
        }

        // Desktop sidebar collapse toggle
        const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
        const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');
        const homeLayout = document.querySelector('.home-layout');

        const toggleSidebarCollapse = () => {
            channelSidebar?.classList.toggle('collapsed');
            homeLayout?.classList.toggle('sidebar-collapsed');

            // Persist preference
            const isCollapsed = channelSidebar?.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed ? 'true' : 'false');
        };

        sidebarCollapseBtn?.addEventListener('click', toggleSidebarCollapse);
        sidebarExpandBtn?.addEventListener('click', toggleSidebarCollapse);

        // Restore sidebar state from localStorage
        if (localStorage.getItem('sidebarCollapsed') === 'true') {
            channelSidebar?.classList.add('collapsed');
            homeLayout?.classList.add('sidebar-collapsed');
        }

        // Navigation handling
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo(link.dataset.page);
            });
        });

        // Toggle groups button
        document.getElementById('toggle-groups').addEventListener('click', () => {
            this.channelList.toggleAllGroups();
        });

        // Search clear buttons (global handler for all)
        document.querySelectorAll('.search-clear').forEach(btn => {
            btn.addEventListener('click', () => {
                const wrapper = btn.closest('.search-wrapper');
                const input = wrapper?.querySelector('.search-input');
                if (input) {
                    input.value = '';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.focus();
                }
            });
        });

        // Keyboard (review F4): an element marked data-key-activate (role="button",
        // tabindex="0") acts on Enter and Space like a native button, through its
        // existing click handler. Only when it is itself the target, so a button
        // inside it (a favourite star) keeps its own keys.
        document.addEventListener('keydown', (e) => this.activateFromKeyboard(e));

        // Handle browser back/forward buttons
        window.addEventListener('popstate', (e) => {
            // A state-less entry (the first one, or a hand-typed hash) is read from the hash like a start-up.
            // An entry naming a page that no longer exists ({page:'home'}, written before 0535) goes to Live TV (navigateTo).
            const route = e.state?.page ? { page: e.state.page, sub: e.state.sub } : this.parseHash(window.location.hash.slice(1));
            this.navigateTo(route.page, 'none', route.sub); // the browser already moved through history
        });

        // The guide is loaded when Live TV or the Guide first needs it (review F7), not here:
        // Recordings and Settings show no guide data.

        // Navigate to the page from the URL hash, or Live TV (also for an old #home link); the entry is
        // replaced, so Back does not return to the old hash. The splash goes as soon as that page is shown.
        const route = this.parseHash(window.location.hash.slice(1)); // Remove #
        this.navigateTo(route.page, 'replace', route.sub);
        this.hideSplash();

        // Keep an eye on in-progress recordings so the user knows why live
        // playback might misbehave while one is running.
        this.startRecordingWatch();

        // Theme is applied before this in the page head to avoid a flash;
        // this only wires up the response to a system theme change.
        Theme.watchSystem();

        console.log('PigTV initialized');
    }

    /** The page a start-up hash names; Live TV for none, an unknown one or the retired #home. */
    initialPage(hash) {
        return this.parseHash(hash).page;
    }

    /**
     * #276 (C14): "settings/channels/lineup" is the page "settings" and, for a page that has places inside it, the
     * place "channels/lineup" ("sub"). Unknown pages, and #home, are Live TV.
     */
    parseHash(hash) {
        const [first, ...rest] = String(hash || '').split('/');
        if (!first || !Object.prototype.hasOwnProperty.call(this.pages, first)) return { page: 'live', sub: undefined };
        return { page: first, sub: rest.join('/') || undefined };
    }

    /** "Settings · Recording · PigTV": what the browser tab, history and bookmarks call this place. */
    titleFor(pageName, sub) {
        const names = { live: 'Live TV', guide: 'TV Guide', sports: 'Sport', recordings: 'Recordings', status: 'Status', settings: 'Settings' };
        const inner = (this.pages[pageName] && this.pages[pageName].titleParts && this.pages[pageName].titleParts(sub)) || [];
        return [names[pageName] || 'PigTV', ...inner, 'PigTV'].join(' \u00b7 ');
    }

    /**
     * A place inside the current page (a Settings tab) became the one shown: the address follows, as a new history entry
     * (Back returns to the tab before), or `historyMode` 'replace'. Nothing happens if the address already says so.
     */
    setLocation(pageName, sub, historyMode = 'push') {
        const hash = sub ? `${pageName}/${sub}` : pageName;
        document.title = this.titleFor(pageName, sub);
        if (typeof window !== 'undefined' && window.location && window.location.hash === `#${hash}`) return;
        const state = { page: pageName, sub };
        if (historyMode === 'replace') history.replaceState(state, '', `#${hash}`);
        else if (historyMode === 'push') history.pushState(state, '', `#${hash}`);
    }

    /** Remove the brand splash (#app-splash, in index.html). Safe to call twice. */
    hideSplash() {
        document.getElementById('app-splash')?.remove();
    }

    startRecordingWatch() {
        // #239 (0485): the banner is one subscriber of the shared feed (RecordingsFeed: one request per 30 s for every
        // page, none while the tab is hidden, at once on return; #129).
        if (!this.recordingsFeed) this.recordingsFeed = new RecordingsFeed();
        if (!this._bannerUnsubscribe) {
            this._bannerUnsubscribe = this.recordingsFeed.subscribe((rows, err) => this.updateRecordingBanner(rows, err));
        }
    }

    updateRecordingBanner(activeRecordings = [], err = null) {
        const banner = document.getElementById('recording-conflict-banner');
        const text = document.getElementById('recording-banner-text');
        if (!banner || !text) return;
        if (err) {
            // Never let this break the page - just hide the banner.
            banner.style.display = 'none';
            return;
        }

        if (!Array.isArray(activeRecordings) || activeRecordings.length === 0) {
            banner.style.display = 'none';
            return;
        }

        const first = activeRecordings[0];
        const until = new Date(first.program_end + ((first.post_buffer_min || 0) * 60000));
        const untilStr = UI.time(until);
        const extra = activeRecordings.length > 1 ? ` (+${activeRecordings.length - 1} more)` : '';

        // Bug 9 (0226): a recording on a shared provider connection (Wave 5) leaves room for watching,
        // so the one-stream warning is only for recordings that hold a connection of their own.
        const warn = activeRecordings.some(r => !r.ingestKey)
            ? ` Live playback may fail while this runs if your provider allows only one stream.` : '';
        text.textContent = this.currentPage === 'sports'
            ? `Recording in progress until ${untilStr}${extra}.${warn}`
            : `Recording "${first.title}" on ${first.channel_name || 'an unknown channel'} until ${untilStr}${extra}.${warn}`;
        banner.style.display = 'flex';
    }

    async showProviderReminders() {
        const banner = document.getElementById('provider-reminder-banner');
        const text = document.getElementById('provider-reminder-text');
        const closeBtn = document.getElementById('provider-reminder-close');
        if (!banner || !text || !closeBtn) return;
        const R = window.ProviderReminders;
        banner.style.display = 'none';
        if (R.dismissedToday(localStorage)) return;
        try {
            const reminders = await API.request('GET', '/providers/reminders');
            if (!Array.isArray(reminders) || reminders.length === 0) return;
            text.innerHTML = R.lines(reminders).map(l => `<div>${UI.escape(l)}</div>`).join('');
            // Assigned, not added: a second sign-in must not stack listeners.
            closeBtn.onclick = (e) => {
                e.preventDefault();
                R.dismiss(localStorage);
                banner.style.display = 'none';
            };
            banner.style.display = 'flex';
        } catch (err) {
            console.warn('Could not fetch provider reminders:', err.message);
        }
    }

    async checkAuth() {
        const token = localStorage.getItem('authToken');

        if (!token) {
            // No token, redirect to login (replace to avoid back button issues)
            window.location.replace('/login.html');
            return;
        }

        try {
            // Verify token with server
            const response = await fetch('/api/auth/me', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error('Invalid token');
            }

            this.currentUser = await response.json();

            // Hide settings for viewers; the Status page is for admins only
            if (this.currentUser.role === 'viewer') {
                const settingsLink = document.querySelector('.nav-link[data-page="settings"]');
                if (settingsLink) {
                    settingsLink.style.display = 'none';
                }
            }
            if (this.currentUser.role === 'admin') {
                document.querySelectorAll('.nav-link.admin-only').forEach(link => { link.style.display = ''; });
            }

            // Add logout button to navbar
            this.addLogoutButton();

        } catch (err) {
            console.error('Authentication error:', err);
            localStorage.removeItem('authToken');
            window.location.replace('/login.html');
        }
    }

    addLogoutButton() {
        const navbar = document.querySelector('.navbar-menu');
        if (!navbar || document.getElementById('logout-btn')) return;

        const logoutLink = document.createElement('a');
        logoutLink.href = '#';
        logoutLink.className = 'nav-link';
        logoutLink.id = 'logout-btn';
        logoutLink.setAttribute('aria-label', 'Sign out');
        logoutLink.title = 'Sign out';
        logoutLink.innerHTML = `
            <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon">
                <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
            </svg></span>
            <span>Sign out</span>
        `;

        logoutLink.addEventListener('click', (e) => {
            e.preventDefault();
            this.signOut();
        });

        navbar.appendChild(logoutLink);
    }

    /**
     * Sign out. #276 review: a change still waiting for its Undo notice (a delete, a cancel, a rule stopped) is sent
     * first, while the sign-in still works, and waited for (at most 5 s, then only until it has been sent); after
     * sign-out it would be refused.
     */
    async signOut() {
        // At most 5 s for the answers; past that, only until the requests (keepalive) have been sent, and logged.
        if (typeof UI !== 'undefined' && UI.flushPending) await UI.flushPending(5000).catch(() => {});
        const token = localStorage.getItem('authToken');
        if (token) {
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
        }
        localStorage.removeItem('authToken');
        window.location.replace('/login.html');
    }

    /**
     * The phone menu (the button and #navbar-menu): the button opens and closes it; a link chosen, a click outside,
     * Escape (focus back on the button) and Tab out of it (#276 review) close it.
     */
    wireMobileMenu(toggle, menu) {
        const isOpen = () => menu.classList.contains('active');
        const close = () => {
            toggle.classList.remove('active');
            menu.classList.remove('active');
            toggle.setAttribute('aria-expanded', 'false');
        };
        toggle.addEventListener('click', () => {
            toggle.classList.toggle('active');
            menu.classList.toggle('active');
            toggle.setAttribute('aria-expanded', String(isOpen()));
        });
        menu.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', close));
        document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('.navbar')) close(); });
        const inside = (el) => !!el && (menu.contains(el) || toggle.contains(el));
        const onKey = (e) => {
            if (e.key !== 'Escape' || !isOpen()) return;
            e.preventDefault();
            close();
            toggle.focus();
        };
        toggle.addEventListener('keydown', onKey);
        menu.addEventListener('keydown', onKey);
        // Focus leaving the button and the menu (Tab past the last link, Shift+Tab before the button) closes it.
        const onFocusOut = (e) => { if (isOpen() && !inside(e.relatedTarget)) close(); };
        toggle.addEventListener('focusout', onFocusOut);
        menu.addEventListener('focusout', onFocusOut);
    }

    /** Enter or Space on a [data-key-activate] element clicks it (see init). */
    activateFromKeyboard(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return false;
        const el = e.target;
        if (!el || !el.hasAttribute || !el.hasAttribute('data-key-activate')) return false;
        e.preventDefault();
        el.click();
        return true;
    }

    /**
     * Show a page. `historyMode` says what happens to the browser's history:
     * 'push' (a click: a new entry), 'replace' (start-up, a redirect: rewrite this
     * entry), 'none' (Back/Forward: the browser has already moved, so writing an
     * entry here would cut off the forward history it is traversing).
     */
    navigateTo(pageName, historyMode = 'push', sub) {
        // #276 review: a page that does not exist (an old {page:'home'} history entry, a typo) is Live TV, in place.
        if (!Object.prototype.hasOwnProperty.call(this.pages, pageName)) {
            pageName = 'live';
            historyMode = 'replace';
            sub = undefined;
        }
        if ((pageName === 'settings' || pageName === 'status') && this.currentUser?.role !== 'admin') {
            pageName = 'live';
            historyMode = 'replace';
            sub = undefined;
        }
        const controller = this.pages[pageName];
        if (!controller?.openPath) sub = undefined; // only a page with places inside it (Settings) has a sub-address
        // Already on this page: a place inside it (a Settings tab named by Back or a link) is still opened.
        if (this.currentPage === pageName && historyMode !== 'replace') {
            if (sub !== undefined && controller?.openPath) controller.openPath(sub);
            return;
        }
        // Back on a page that has places in it (Settings): the one it was left on.
        if (sub === undefined && controller?.currentPath) sub = controller.currentPath();
        // The shared banner may still contain raw guide/result prose from the previous page.
        // Mask it before Sport becomes visible, including before preferences are known.
        if (pageName === 'sports') {
            const bannerText = document.getElementById('recording-banner-text');
            if (bannerText) bannerText.textContent = 'Recording in progress.';
        }

        const hash = sub ? `${pageName}/${sub}` : pageName;
        if (historyMode === 'replace') {
            history.replaceState({ page: pageName, sub }, '', `#${hash}`);
        } else if (historyMode === 'push') {
            history.pushState({ page: pageName, sub }, '', `#${hash}`);
        }
        document.title = this.titleFor(pageName, sub);

        // Update nav
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.page === pageName);
            if (link.dataset.page === pageName) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });

        // Update pages
        document.querySelectorAll('.page').forEach(page => {
            page.classList.toggle('active', page.id === `page-${pageName}`);
        });

        // Notify page controllers
        if (this.pages[this.currentPage]?.hide) {
            this.pages[this.currentPage].hide();
        }

        this.currentPage = pageName;

        // The page's own show() (it may load things): handed back, so a caller that needs the page ready can wait for it.
        if (this.pages[pageName]?.show) {
            return this.pages[pageName].show(sub);
        }
    }
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();

    // Fetch and display version badge. Prefer the server's ready-made
    // `display` string (e.g. "v3.7.0 · build 0048") so the top-left badge
    // says exactly which build is running; fall back to the bare version for
    // an older server that predates /api/version's build fields.
    fetch('/api/version')
        .then(res => res.json())
        .then(data => {
            const badge = document.getElementById('version-badge');
            if (!badge) return;
            if (data.display) badge.textContent = data.display;
            else if (data.version) badge.textContent = `v${data.version}`;
        })
        .catch(() => { });
});
