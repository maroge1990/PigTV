/**
 * #323: the web Sport section, ported from the Apple apps (D-43, D-44; mocks approved 14 Nov 2026). The front page reads
 * C-R (`GET /api/sports/front`); the account's Hide scores choice is read from C-P's `GET /api/sports/pages/preferences`
 * before every answer is drawn (unknown or a failed read counts as hidden: SportView.hidden). What is drawn is SportView's
 * (pure); this file fetches, polls, keeps the hero, and runs Watch, Remind me and Record.
 *
 * Polling (SportFrontModel): every 20 s while a game is under way or within an hour of its start, else every 60 s, only
 * while the page is shown and the browser tab visible. A failed refresh keeps what is shown under a slim notice.
 * No server change: every route here already exists.
 */
class SportsPage {
    constructor(app) {
        this.app = app;
        this.root = typeof document !== 'undefined' ? document.getElementById('page-sports') : null;
        this.active = false;
        this.lookup = 0; // #345: a recording lookup's token; a newer press, a route change or leaving Sport invalidates it
        this.serial = 0;
        this.front = null; this.loaded = false; this.failed = false; this.stale = false; this.updatedAt = null; this.received = 0;
        this.prefs = { known: false, spoilerFree: true };
        // #323 review (high): scores are disclosed only by a refresh whose preference read said shown and whose answer has
        // come; a read that hides, fails or has not answered yet takes them off the page at once (cached answer included).
        this.mayShow = false;
        this.labels = {}; this.labelsLoaded = false;
        this.heroId = null; this.selectedFollowKey = null; this.pinned = null;
        this.f1Map = null; this.f1Asked = false;
        this.timer = null; this.waiting = null; this.watchCancelled = false;
        this.menu = null;
        this.path = '';
        this.stack = [];      // the Sport places this visit pushed, so the page's own Back can go back through history
        this.chosen = {};     // a sport page's chosen league, by sport
        this.features = null; // /api/info's flags: which league pages the server has
        this.leaguePages = {}; // a league's own page (C-T, C-Q), by key: { answer, failed, loaded, stale, updatedAt }
        this.fixtureChoice = {}; // its chosen round, standings view and table group, by key
        this.prefsAnswer = null; // the preferences as read (the followed names per league)
        this.cancels = new Map(); // Opus review of #327: recordings cancelled while their Undo is open, by schedule id
        this.phoneQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 768px)') : null;
        this.phoneQuery?.addEventListener?.('change', () => { this.render(); if (this.active && this.shownLeague()) this.loadLeague(); });
        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', () => {
                if (!this.active) return;
                if (document.hidden) clearTimeout(this.timer);
                else { this.prefs.known = false; this.refresh(); }
            });
        }
        // #327: a window made wider or narrower changes which rails run on past the screen
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('resize', () => this.updateRails());
        if (this.root) this.wire(this.root);
    }

    // ---------- the address (#sports, #sports/...) ----------

    /** Sport is a page with places in it: the app hands every visit, Back and the nav link to openPath. */
    get opensRoot() { return true; }
    /** "Sport · Football · PigTV", "Sport · Football · Premier League · PigTV". */
    titleParts(sub) {
        const { sport, league } = SportsPage.parse(sub);
        return [sport, league && SportView.label(league, this.labels)].filter(Boolean);
    }
    /** "Football/EPL" -> { sport: 'Football', league: 'EPL' }; each part URL-encoded in the address. */
    static parse(path) {
        const parts = String(path || '').split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
        return { sport: parts[0] || null, league: parts[1] || null };
    }
    static path(sport, league) { return [sport, league].filter(Boolean).map(encodeURIComponent).join('/'); }
    get route() { return SportsPage.parse(this.path); }

    async show(sub) {
        this.active = true;
        this.path = sub || '';
        this.stack = [];
        this.prefs.known = false; this.mayShow = false; // Apple 90: the choice is forgotten until it is read again
        if (this.watchCancelled) { this.watchCancelled = false; UI.toast('Remind me was cancelled because Sport was closed.'); }
        this.render();
        await this.refresh();
    }
    hide() {
        this.active = false;
        this.lookup++;
        clearTimeout(this.timer); this.timer = null;
        if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting = null; this.watchCancelled = true; }
        this.closeMenu();
        this.closeWindow();
        this.serial++;
    }
    openPath(sub, history = 'none') {
        const path = sub || '';
        if (history === 'push' || history === 'replace') this.app?.setLocation?.('sports', path || undefined, history);
        else {
            // Back or Forward: the browser has moved; a place this visit pushed is popped
            if (this.stack.length && this.stack[this.stack.length - 1] === path) this.stack.pop();
            if (typeof document !== 'undefined' && this.app?.titleFor) document.title = this.app.titleFor('sports', path || undefined);
        }
        if (history === 'push' && path !== this.path) this.stack.push(this.path);
        this.path = path;
        this.lookup++;
        this.closeMenu();
        this.render();
        this.loadMap();
        if (this.shownLeague() && this.active) this.loadLeague();
        if (this.root?.scrollTo && history !== 'none') this.root.scrollTo(0, 0);
    }
    /** A place in Sport: a new history entry, so Back returns. */
    go(path) { this.openPath(path, 'push'); }
    /** The page's own back button: Back through history when this visit came from there, else up one place. */
    back() {
        const { sport, league } = this.route;
        const up = league ? SportsPage.path(sport) : '';
        if (this.stack.length && this.stack[this.stack.length - 1] === up && typeof history !== 'undefined') history.back();
        else this.openPath(up, 'replace');
    }

    // ---------- data ----------

    get phone() { return !!this.phoneQuery?.matches; }
    get hidden() { return !this.mayShow || SportView.hidden({ known: this.prefs.known, preference: this.prefs.spoilerFree, answer: this.front?.spoilerFree === true }); }
    /** The server's now, moved on by the time since its answer came. */
    now() { return this.front ? this.front.now + Math.max(0, Date.now() - this.received) : Date.now(); }

    /** The account's choice, then the answer (drawn only after it). A failed read leaves the choice unknown: hidden. */
    async refresh() {
        if (!this.active) return;
        clearTimeout(this.timer);
        const serial = ++this.serial;
        // the choice not known (a first visit, a return, the tab shown again): what is on the page is hidden now
        if (!this.prefs.known) this.conceal();
        try {
            const prefs = await API.request('GET', '/sports/pages/preferences');
            if (serial !== this.serial) return;
            this.prefs = { known: typeof prefs?.spoilerFree === 'boolean', spoilerFree: prefs?.spoilerFree !== false };
            this.prefsAnswer = prefs && typeof prefs === 'object' ? prefs : null;
        } catch {
            if (serial !== this.serial) return;
            this.prefs = { known: false, spoilerFree: true };
        }
        // hidden or unread: off the page before the answer is waited for (it may be slow, or never come)
        if (!this.prefs.known || this.prefs.spoilerFree) this.conceal();
        this.loadLabels();
        this.loadFeatures();
        let answered = false;
        try {
            const answer = await API.request('GET', '/sports/front');
            if (serial !== this.serial || !this.active) return;
            if (!answer || typeof answer !== 'object') throw new Error('Invalid sport answer');
            this.apply(answer);
            this.failed = false; this.stale = false; this.updatedAt = Date.now();
            answered = true;
        } catch (err) {
            if (serial !== this.serial || !this.active) return;
            console.warn('Sport could not be loaded:', err && err.message);
            if (this.front) this.stale = true; else this.failed = true;
        }
        this.loaded = true;
        // only this refresh's own answer is disclosed; a failed one leaves the page as it was (concealed stays concealed)
        if (answered) this.mayShow = this.prefs.known && !this.prefs.spoilerFree;
        this.loadMap();
        this.render();
        this.schedule();
        if (this.shownLeague()) this.loadLeague();
    }
    /** Take every score off the page now: the cached answer is redrawn hidden until a refresh discloses again. */
    conceal() {
        if (!this.mayShow) return;
        this.mayShow = false;
        this.render();
    }
    schedule() {
        clearTimeout(this.timer);
        if (!this.active || (typeof document !== 'undefined' && document.hidden)) return;
        const fast = this.front && SportView.fastRefresh(this.front, this.now());
        this.timer = setTimeout(() => this.refresh(), fast ? 20000 : 60000);
    }
    /** The catalogue's league labels ("EPL" -> "Premier League"), once; the codes show until they come. */
    async loadLabels() {
        if (this.labelsLoaded) return;
        this.labelsLoaded = true;
        try {
            const catalog = await API.request('GET', '/sports/catalog');
            const labels = {}, sports = {};
            for (const s of catalog?.sports || []) {
                for (const l of s.leagues || []) {
                    if (l && l.league && l.label) labels[l.league] = l.label;
                    if (l && l.league && s && typeof s.sport === 'string' && s.sport) sports[l.league] = s.sport;
                }
            }
            this.labels = labels;
            this.leagueSports = sports;
            this.render();
        } catch { this.labelsLoaded = false; }
    }
    /** /api/info's flags, once: which league pages the server has (ESPN fixtures can be off). */
    async loadFeatures() {
        if (this.features) return this.featuresAsked;
        this.features = {};
        this.featuresAsked = (async () => {
            try { this.features = (await API.request('GET', '/info'))?.features || {}; } catch { this.features = null; }
            this.featuresLoaded = true;
            this.render();
        })();
        return this.featuresAsked;
    }
    /**
     * The league whose own page is shown: the route's; on a wide window a sport page's chosen (or opening) league too,
     * embedded under the banner as on iPad (#326). A phone's sport page links the league page instead.
     */
    shownLeague() {
        const { sport, league } = this.route;
        if (league) return league;
        if (!sport || this.phone || !this.front) return null;
        return SportView.openingLeague(sport, this.front, this.chosen[sport] || null);
    }
    /** What the shown league's page is: 'league', 'nfl', … ('games': its C-R games only). */
    leagueKind() {
        const { sport } = this.route, league = this.shownLeague();
        return league ? SportView.leagueContent(league, sport, this.features || {}) : null;
    }
    leagueKey() {
        const kind = this.leagueKind(), league = this.shownLeague();
        return kind === 'nfl' || kind === 'f1' || kind === 'cricket' ? kind : kind === 'league' || kind === 'events' ? `${kind}:${league}` : null;
    }
    /**
     * The route's league page (C-T or C-Q), asked with every refresh while it is shown (the server keeps ESPN's answer
     * 2 to 60 minutes). A failed read keeps what was shown, marked out of date. One request at a time per page.
     */
    async loadLeague() {
        await this.loadFeatures();
        const key = this.leagueKey(), league = this.shownLeague();
        if (!key || !this.active) return;
        const lp = this.leaguePages[key] || (this.leaguePages[key] = { answer: null, failed: false, loaded: false, stale: false, updatedAt: null });
        if (lp.asking) return lp.asking;
        lp.asking = this.askLeague(key, league, lp).finally(() => { lp.asking = null; });
        return lp.asking;
    }
    async askLeague(key, league, lp) {
        const url = ['nfl', 'f1', 'cricket'].includes(key) ? `/sports/pages/${key}`
            : key.startsWith('events:') ? `/sports/pages/events?league=${encodeURIComponent(league)}` : `/sports/pages/league/${encodeURIComponent(league)}`;
        try {
            const answer = await API.request('GET', url);
            if (!answer || typeof answer !== 'object') throw new Error('Invalid league answer');
            // "not ready yet" keeps a page already shown
            if (answer.available === false && lp.answer && lp.answer.available !== false) lp.stale = true;
            else { lp.answer = answer; lp.stale = false; lp.updatedAt = Date.now(); }
            lp.failed = false;
        } catch (err) {
            console.warn('Sport: the league page could not be loaded:', err && err.message);
            if (lp.answer) lp.stale = true; else lp.failed = true;
        }
        lp.loaded = true;
        this.render();
    }
    /** The followed names in a league (the account's teams there; the NFL's older single follow too). */
    followingIn(league) {
        const p = this.prefsAnswer || {};
        const names = [...((p.teams && p.teams[league]) || [])];
        if (league === 'NFL' && p.following && p.following.NFL) names.push(p.following.NFL);
        if (league === 'F1' && p.following && p.following.F1 && !names.includes(p.following.F1)) names.push(p.following.F1);
        return names.filter(n => typeof n === 'string');
    }
    /** The game the banner's hero shows here: the front page's hero, or a sport page's. */
    shownHeroId() {
        const { sport } = this.route;
        if (!this.front) return null;
        return sport ? SportView.sportHero(sport, this.front).gameId : this.heroId;
    }
    /** The circuit map behind a race hero (C-P `info.map`), asked once. */
    async loadMap() {
        const g = SportView.game(this.front || {}, this.shownHeroId());
        if (!g || g.league !== 'F1' || this.f1Asked) return;
        this.f1Asked = true;
        try {
            const page = await API.request('GET', '/sports/pages/f1');
            const info = page?.weekend?.info;
            const dark = typeof document !== 'undefined' && document.documentElement?.getAttribute?.('data-theme') === 'dark';
            const pick = (dark && info?.mapDark) || info?.map;
            this.f1Map = typeof pick === 'string' && /^\/api\/logo\/[A-Za-z0-9_.-]+(\?size=\d+)?$/.test(pick) ? pick : null;
            this.render();
        } catch { this.f1Asked = false; }
    }

    /** A new answer: a follow gone live takes the hero from a flip; a pinned card that left or finished is let go. */
    apply(answer) {
        const V = SportView, previous = this.front;
        const wentLive = V.followsGoneLive(previous, answer);
        if (wentLive.length) this.selectedFollowKey = null;
        if (this.pinned) { const p = V.game(answer, this.pinned); if (!p || V.terminal(p)) this.pinned = null; }
        if (this.selectedFollowKey) {
            const follows = answer.follows || [];
            const index = follows.findIndex(f => V.followKey(f) === this.selectedFollowKey);
            const was = previous && V.game(previous, this.heroId), is = V.game(answer, this.heroId);
            const finished = index >= 0 && V.game(answer, follows[index].gameId) && V.terminal(V.game(answer, follows[index].gameId));
            if (index < 0 || (was && V.underWay(was.status) && !(is && V.underWay(is.status))) || finished) this.selectedFollowKey = null;
        }
        const selected = this.selectedFollowKey ? (answer.follows || []).findIndex(f => V.followKey(f) === this.selectedFollowKey) : -1;
        this.heroId = V.resolveHero({ current: this.heroId, front: answer, wentLive, selectedFollow: selected >= 0 ? selected : null, pinned: this.pinned });
        this.front = answer;
        this.received = Date.now();
        this.hideCancelled();
    }
    selectFollow(index) {
        const f = this.front?.follows?.[index];
        if (!f) return;
        this.pinned = null;
        this.selectedFollowKey = SportView.followKey(f);
        this.heroId = SportView.resolveHero({ current: this.heroId, front: this.front, selectedFollow: index });
        this.loadMap();
        this.render();
    }
    get followIndex() {
        if (!this.front) return null;
        const selected = this.selectedFollowKey ? this.front.follows.findIndex(f => SportView.followKey(f) === this.selectedFollowKey) : -1;
        return SportView.heroFollowIndex(this.front, this.heroId, selected >= 0 ? selected : null);
    }

    // ---------- drawing ----------

    context() {
        return { front: this.front, hide: this.hidden, now: this.now(), labels: this.labels, phone: this.phone,
            heroId: this.heroId, followIndex: this.followIndex, map: this.f1Map, stale: this.stale, staleSince: this.updatedAt,
            links: true, features: this.features || {}, pages: SportsPage.PAGES, chosen: this.chosen[this.route.sport] || null,
            following: this.shownLeague() ? this.followingIn(this.shownLeague()) : [], dark: this.isDark(),
            leaguePage: this.leaguePages[this.leagueKey()] || null, featuresLoaded: !!this.featuresLoaded,
            leagues: this.route.sport && this.front ? SportView.sportLeagues(this.route.sport, this.front).map(x => x.league) : [], ...(this.fixtureChoice[this.leagueKey()] || {}) };
    }

    /** Dark pages draw the dark circuit map. */
    isDark() {
        if (typeof document === 'undefined') return true;
        const t = document.documentElement?.getAttribute?.('data-theme');
        if (t === 'light' || t === 'dark') return t === 'dark';
        return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    /** The whole page, keeping the focused control and each rail's scroll across a redraw. */
    render() {
        if (!this.active || !this.root) return;
        const focusKey = typeof document !== 'undefined' && this.root.contains?.(document.activeElement) ? document.activeElement?.getAttribute?.('data-key') : null;
        const scrolls = {};
        for (const el of this.root.querySelectorAll?.('[data-rail], [data-carousel]') || []) scrolls[el.getAttribute('data-rail') || el.getAttribute('data-carousel')] = el.scrollLeft;
        this.root.innerHTML = this.markup();
        this.bindState();
        for (const el of this.root.querySelectorAll?.('[data-rail], [data-carousel]') || []) {
            const k = el.getAttribute('data-rail') || el.getAttribute('data-carousel');
            if (scrolls[k]) el.scrollLeft = scrolls[k];
        }
        this.updateRails();
        if (focusKey) [...(this.root.querySelectorAll?.('[data-key]') || [])].find(n => n.getAttribute('data-key') === focusKey)?.focus?.({ preventScroll: true });
        if (this.menu) { const a = this.anchorFor(this.menu); if (a) { this.menu.anchor = a; a.setAttribute?.('aria-expanded', 'true'); } }
    }

    /** The markup for what is shown now: the header, then the state block or the page. */
    markup() {
        const V = SportView, now = this.now(), hide = this.hidden, { sport } = this.route;
        const loading = !this.loaded && !this.front, failed = this.failed && !this.front;
        let head, body;
        if (sport && this.route.league) {
            // a league's own page: "‹ Football" and its name, then its rounds, games and standings
            const league = this.route.league, kind = this.leagueKind();
            // Formula 1 on a computer keeps the banner (mock 07): its back button is there, the h2 unseen
            head = (kind === 'f1' || kind === 'events') && !this.phone && !loading && !failed && this.featuresLoaded ? `<h2 class="visually-hidden">${V.e(V.label(league, this.labels))}</h2>`
                : V.header({ title: V.label(league, this.labels), now, hide, back: sport });
            if (loading || !this.featuresLoaded) body = V.placeholder(['f1', 'cricket', 'events'].includes(kind) ? kind : 'league', this.phone);
            else if (failed) body = '<div class="sp-state" id="sp-state" data-state="error"></div>';
            else body = V.leaguePage(sport, league, kind, this.leaguePages[this.leagueKey()], this.context());
        } else if (sport) {
            // a sport's page: on a phone the "‹ Sport" header; on a computer the banner holds the back button (its h2 unseen)
            head = this.phone || loading || failed ? V.header({ title: sport, now, hide, back: 'Sport' })
                : `<h2 class="visually-hidden">${V.e(sport)}</h2>`;
            if (loading) body = V.placeholder('sport', this.phone);
            else if (failed) body = '<div class="sp-state" id="sp-state" data-state="error"></div>';
            else body = V.sportPage(sport, this.context());
        } else {
            head = V.header({ title: 'Sport', now, hide });
            if (loading) body = V.placeholder('front', this.phone);
            else if (failed) body = '<div class="sp-state" id="sp-state" data-state="error"></div>';
            else if (V.isEmpty(this.front)) body = (this.front.scores === 'unavailable' ? V.scoresNote() : '') + '<div class="sp-state" id="sp-state" data-state="empty"></div>';
            else body = V.front(this.context());
        }
        return `<div class="sp${this.phone ? ' is-phone' : ''}">${head}${body}</div>`;
    }

    /** The state block (UI.setState): loading, the error with Try again, or nothing followed. */
    bindState() {
        const box = this.root.querySelector?.('.sp-state');
        if (!box) return;
        const kind = box.getAttribute('data-state');
        if (kind === 'loading') UI.setState(box, 'loading', 'Loading…');
        else if (kind === 'league-error') {
            UI.setState(box, 'error', { title: box.getAttribute('data-title'), detail: box.getAttribute('data-detail') },
                { label: 'Try again', run: () => { const lp = this.leaguePages[this.leagueKey()]; if (lp) lp.failed = false; this.render(); this.loadLeague(); } });
        }
        else if (kind === 'error') {
            UI.setState(box, 'error', { title: 'Sport didn’t load', detail: 'PigTV couldn’t get today’s games from your server. The TV Guide and your recordings still work.' },
                { label: 'Try again', run: () => { this.failed = false; this.loaded = false; this.render(); this.refresh(); } });
        } else if (kind === 'empty') {
            const admin = this.app?.currentUser?.role === 'admin';
            UI.setState(box, 'empty', { title: 'Follow a sport to start',
                detail: admin ? 'Choose the sports, leagues and teams you follow. Their games show here, on every device.'
                    : 'Choose the sports, leagues and teams you follow in the PigTV app on Apple TV, iPad or iPhone. Their games show here, on every device.' },
                admin ? { label: 'Choose your sport', primary: true, run: () => this.app.navigateTo('settings', 'push', 'sport') } : null,
                { className: 'sp-empty' });
        }
    }

    // ---------- a rail's ‹ › (#327: wide windows; a phone swipes) ----------

    /** Every rail's buttons, after a redraw or a resize. */
    updateRails() {
        if (!this.root?.querySelectorAll) return;
        for (const rail of this.root.querySelectorAll('.rail-wrap .rail')) this.updateRail(rail);
    }
    /**
     * A button shows only while the row runs on past its end (more than a pixel: rounding), never on a phone. A focused
     * button that goes (its end reached) hands focus to the other one, else to the row's first card.
     */
    updateRail(rail) {
        const wrap = rail?.parentNode;
        if (!wrap?.classList?.contains('rail-wrap')) return;
        const prev = wrap.querySelector('.rail-arrow.prev'), next = wrap.querySelector('.rail-arrow.next');
        const max = (rail.scrollWidth || 0) - (rail.clientWidth || 0), x = rail.scrollLeft || 0, over = !this.phone && max > 1;
        const focused = typeof document !== 'undefined' ? document.activeElement : null;
        if (prev) prev.hidden = !(over && x > 8); // the rail rests on its 4 px padding (scroll snap)
        if (next) next.hidden = !(over && x < max - 8);
        const lost = [prev, next].find(b => b && b === focused && b.hidden);
        if (lost) {
            const other = lost === prev ? next : prev;
            (other && !other.hidden ? other : rail.querySelector?.('[data-act]'))?.focus?.({ preventScroll: true });
        }
    }
    /** About a page of cards: as many whole cards as the row shows (at least one), smoothly unless motion is reduced. */
    scrollRail(button, dir) {
        const rail = button?.parentNode?.querySelector?.('.rail');
        if (!rail) return;
        const card = rail.firstElementChild || rail.children?.[0];
        const step = card && card.offsetWidth ? card.offsetWidth + 12 : 0;
        const width = rail.clientWidth || 0;
        const by = step ? Math.max(1, Math.floor(width / step)) * step : Math.max(1, width - 48);
        const reduce = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
        if (typeof rail.scrollBy === 'function') rail.scrollBy({ left: dir * by, behavior: reduce ? 'auto' : 'smooth' });
        else rail.scrollLeft = (rail.scrollLeft || 0) + dir * by;
        this.updateRail(rail);
    }

    // ---------- events (one listener each on the page; the markup carries data-act) ----------

    wire(root) {
        root.addEventListener('click', (e) => {
            const el = e.target?.closest?.('[data-act]');
            if (!el || !root.contains(el)) return;
            this.act(el.getAttribute('data-act'), el, e);
        });
        // Right-click (a long press on a phone) on a game opens its menu, as the ⋯ does.
        root.addEventListener('contextmenu', (e) => {
            const el = e.target?.closest?.('[data-act="game"]');
            if (!el || !root.contains(el)) return;
            const g = this.game(el.getAttribute('data-id'));
            if (!g) return;
            e.preventDefault();
            this.openMenu(g, el, { point: Number.isFinite(e.clientX) && e.clientX > 0 ? { x: e.clientX, y: e.clientY } : null });
        });
        // A logo that does not load becomes its monogram disc.
        root.addEventListener('error', (e) => this.badgeFallback(e), true);
        // The carousel's dots follow the card in view; a rail's ‹ › follow its ends.
        root.addEventListener('scroll', (e) => {
            const c = e.target;
            if (c?.classList?.contains?.('rail')) { this.updateRail(c); return; }
            if (!c?.getAttribute || !c.getAttribute('data-carousel')) return;
            const cards = [...c.children], width = cards[0] ? cards[0].offsetWidth + 12 : 1;
            const at = Math.max(0, Math.min(cards.length - 1, Math.round(c.scrollLeft / width)));
            cards.forEach((card, i) => card.classList.toggle('dim', i !== at));
            const d = c.nextElementSibling;
            if (d && d.classList.contains('dots')) d.outerHTML = SportView.dots(cards.length, at);
        }, true);
    }

    /** A badge whose logo does not load becomes its monogram disc. */
    badgeFallback(e) {
        const img = e.target;
        if (!img || img.tagName !== 'IMG' || !img.classList?.contains('badge')) return;
        const disc = document.createElement('span');
        disc.className = `disc ${img.getAttribute('data-tone') || ''}`.trim(); disc.setAttribute('aria-hidden', 'true');
        disc.style.cssText = img.style.cssText;
        if (img.getAttribute('data-fill')) disc.style.background = img.getAttribute('data-fill');
        disc.textContent = img.getAttribute('data-mono') || '';
        img.replaceWith(disc);
    }

    act(name, el, ev) {
        const id = el.getAttribute('data-id');
        switch (name) {
            case 'game': return this.select(id, el);
            case 'watch': return this.watch(id);
            case 'remind': return this.remind(id);
            case 'record': return this.record(id);
            case 'more': case 'record-menu': { const g = this.game(id); return g ? this.openMenu(g, el) : undefined; }
            case 'record-every': return this.recordEvery(id);
            // #327: iOS's record page (More options…, Change recording)
            // #347 (Codex): Change recording edits the schedule the card names; More options always picks an airing first
            case 'change-recording': return this.openRecord(id, { opener: this.openerFor(el) });
            case 'record-options': return this.openRecord(id, { opener: this.openerFor(el), pick: true });
            case 'record-listed': return this.recordListed(id);
            case 'unlisted-cancel': return this.recordListed(id, true);
            case 'pin': return this.pin(id);
            case 'rail-prev': return this.scrollRail(el, -1);
            case 'rail-next': return this.scrollRail(el, 1);
            case 'watch-channel': return this.watch(id, el.getAttribute('data-channel'));
            case 'follow': return this.selectFollow(Number(el.getAttribute('data-index')));
            case 'retry': return this.refresh();
            case 'back': return this.back();
            case 'open-sport': return this.go(SportsPage.path(el.getAttribute('data-sport')));
            case 'open-league': return this.go(SportsPage.path(el.getAttribute('data-sport'), el.getAttribute('data-league')));
            case 'league': return this.chooseLeague(el);
            case 'league-page': {
                // an events page's banner list: another of the sport's leagues, in place
                const { sport } = this.route, l = this.front && SportView.sportLeagues(sport, this.front)[Number(el.getAttribute('data-index'))];
                return l ? this.openPath(SportsPage.path(sport, l.league), 'replace') : undefined;
            }
            case 'round': return this.chooseFixture({ round: el.getAttribute('data-round') });
            case 'standings-view': return this.chooseFixture({ standingsView: el.getAttribute('data-view'), tableGroup: null });
            case 'table-group': return this.chooseFixture({ tableGroup: el.getAttribute('data-group') });
            default: return undefined;
        }
    }
    game(id) {
        let g;
        if (typeof id === 'string' && id.startsWith('fx:')) g = this.fixtureById(id);
        else if (typeof id === 'string' && (id.startsWith('f1s:') || id.startsWith('ck:'))) g = this.pageGame(id);
        else g = this.front ? SportView.game(this.front, id) : null;
        // a recording whose cancel waits for its Undo is gone from the game at once (iOS: it leaves the lists at once)
        return g && g.recording && this.cancels.has(g.recording.scheduleId) ? { ...g, recording: null } : g;
    }
    /** The front page's games drop a recording whose cancel waits for its Undo (their cards lose the mark at once). */
    hideCancelled() {
        for (const g of (this.front && this.front.games) || []) if (g && g.recording && this.cancels.has(g.recording.scheduleId)) g.recording = null;
    }
    /**
     * Before a new action on a game, a cancel of its recording still waiting for its Undo is sent now and awaited (iOS:
     * commitPendingUndo): Record then makes a new recording, never one that the waiting cancel would remove later.
     */
    async settleCancels(g) {
        const key = SportsPage.cancelKey(g);
        for (const entry of [...this.cancels.values()]) {
            if (entry.gameId !== key) continue;
            const sending = entry.send();
            entry.notice?.close?.(); // its Undo is gone
            await sending.catch(() => {});
        }
    }
    /**
     * #347 (Codex, high): the one identity a waiting cancel is held and settled by, the same for a front card and the sport
     * page's item for the same game (its `card`): the game's recording id (gameIdOf), else its own id.
     */
    static cancelKey(g) {
        return SportsPage.gameIdOf(g) || (g && g.id) || null;
    }
    /** A league page's game without a C-R card, as a game on its own channels ("fx:<league>:<id>"). */
    fixtureById(id) {
        const kind = this.leagueKind(), lp = this.leaguePages[this.leagueKey()], league = this.shownLeague();
        if (!lp || !lp.answer || (kind !== 'league' && kind !== 'nfl')) return null;
        const fx = kind === 'nfl' ? SportView.nflFixture(lp.answer, [], true) : SportView.leagueFixture(lp.answer, league, [], true);
        for (const r of fx.rounds) for (const g of r.games) if (`fx:${fx.league}:${g.id}` === id) return SportView.fixtureGame(g, fx);
        return null;
    }
    /** A Formula 1 session ("f1s:<id>") or a cricket match ("ck:<id>") on the page shown, as a game on its channels. */
    pageGame(id) {
        const lp = this.leaguePages[this.leagueKey()], a = lp && lp.answer;
        if (!a) return null;
        if (id.startsWith('f1s:') && a.weekend) {
            const s = (a.weekend.sessions || []).find(x => `f1s:${x.id}` === id);
            return s ? SportView.sessionGame(s, a.weekend, this.now()) : null;
        }
        const m = [a.lead, ...(a.others || [])].find(x => x && `ck:${x.id}` === id);
        if (m) return SportView.cricketGame(m);
        // #347: a match of the lead's tour (its series list), with the lead's teams for its title
        const sm = ((a.series && a.series.matches) || []).find(x => x && `ck:${x.id}` === id);
        return sm ? SportView.cricketGame({ teams: a.lead && a.lead.teams, ...sm, channels: [] }) : null;
    }
    /** A round, a standings view or a table group chosen on a league page. */
    chooseFixture(choice) {
        const key = this.leagueKey();
        if (!key) return;
        this.fixtureChoice[key] = { ...(this.fixtureChoice[key] || {}), ...choice };
        this.render();
    }
    /** A league chosen on a sport page (the banner's list, or a chip on a phone): its games show below. */
    chooseLeague(el) {
        const { sport } = this.route;
        if (!sport || !this.front) return;
        const index = el.getAttribute('data-index');
        const league = el.getAttribute('data-league') || (index != null ? SportView.sportLeagues(sport, this.front)[Number(index)]?.league : null);
        if (!league) return;
        this.chosen[sport] = league;
        this.render();
        this.loadLeague();
    }

    /**
     * A card pressed (#345): Watch while its channel airs it (checked now, not when drawn); a game not started, or not
     * listed yet, its record options (its menu: Record when it's listed); a finished game its recording, when PigTV has
     * one; a next round nothing.
     */
    select(id, anchor) {
        const g = this.game(id);
        this.lookup++; // a newer press ends a recording lookup still on its way
        if (!g) return undefined;
        if (SportView.isNextRound(g)) return undefined;
        if (SportView.terminal(g)) return this.playRecordingOf(g);
        const act = SportView.action(g, this.now());
        if (act === 'watch') return this.watch(id);
        if (act === 'details') return this.playRecordingOf(g); // its airing is over, the feed has not called it final
        return this.openMenu(g, anchor);
    }

    /**
     * #345: this game's recording (recordings[].gameId = the card's id), in this order: a whole completed one (not partial:
     * the longest, then the earliest start); else one still recording that can be watched from its start (watch_live);
     * else a partial completed one (the longest, then the earliest start).
     */
    static recordingFor(rows, g) {
        const id = SportsPage.gameIdOf(g);
        if (!id || !Array.isArray(rows)) return null;
        const mine = rows.filter(r => r && r.gameId === id);
        const best = (list) => list.slice().sort((a, b) => (b.duration_sec || 0) - (a.duration_sec || 0) || (a.started_at || 0) - (b.started_at || 0))[0] || null;
        const done = mine.filter(r => r.status === 'completed');
        return best(done.filter(r => !r.is_partial))
            || mine.find(r => r.status === 'recording' && r.watch_live === true)
            || best(done) || null;
    }
    /**
     * The game's id as a recording carries it (`gameId`): a card's own id; a sport page's game without a card (a fixture,
     * an F1 session, a cricket match) its `card`, the C-R card id of the same game (#347); null when it has none.
     */
    static gameIdOf(g) {
        if (!g) return null;
        if (!g.synthetic) return g.id || null;
        return typeof g.card === 'string' && g.card ? g.card : null;
    }
    /** Play this game's recording in the Recordings player (from its start while it still records, never offering Go to live: the live edge of a finished game shows the result); nothing when there is none. */
    async playRecordingOf(g) {
        this.closeMenu();
        const token = this.lookup;
        let rows;
        try { rows = await API.request('GET', '/recordings'); } catch (err) { return undefined; }
        if (token !== this.lookup || !this.active) return undefined; // an older answer never plays over a newer press
        const rec = SportsPage.recordingFor(rows, g);
        const recordings = this.app && this.app.pages && this.app.pages.recordings;
        if (!rec || !recordings || typeof recordings.play !== 'function') return undefined;
        return recordings.play(rec.id, rec.status === 'recording' ? { watch: true, noLive: true } : {});
    }

    /** Play the game's best channel, found again in the channel list by its identity (never a stored position). */
    async watch(id, channelKey = null) {
        this.lookup++; // #345: a finished card's recording lookup still on its way never opens over a live watch
        this.closeMenu();
        const g = this.game(id), ev = g && SportView.event(g);
        // a chosen channel is judged on its own airing (#327: a details row), the best channel on the game's action; a
        // result or a next round plays nothing on any channel (Opus review of #327: the same check on both paths)
        const over = !ev || SportView.terminal(g) || SportView.isNextRound(g);
        if (over || (!channelKey && SportView.action(g, this.now()) !== 'watch')) { UI.toast('This game isn’t on your channels right now.'); return; }
        const key = (c) => `${c.sourceId}:${c.stableId || c.id}`;
        // "Watch on…": the chosen channel, while it still shows the game now
        const chosen = channelKey ? this.channelsOnAir(g).find(c => key(c) === channelKey) : ev.channel;
        if (!chosen) { UI.toast('That channel isn’t showing the game now.'); return; }
        try {
            const cl = this.app.channelList;
            await cl.loadSources(); await cl.loadChannels();
            const match = cl.channels.find(c => key(c) === key(chosen));
            if (!match) { UI.toast('That channel isn’t in your channel list. Refresh the library and try again.'); return; }
            this.app.navigateTo('live');
            // #334 (D-67): played from Sport, Live TV's sidebar lists the live games, this one marked, until a channel is
            // chosen elsewhere; scores as this page shows them (hidden unless the account's choice was read as shown)
            if (cl.startGames) cl.startGames({ gameId: g.id, front: this.front, prefs: { known: this.prefs.known && this.mayShow, spoilerFree: this.prefs.spoilerFree }, received: this.received });
            await cl.selectChannel({ sourceId: match.sourceId, channelId: match.id }, { game: g.id });
        } catch (err) {
            console.warn('Sport: watch failed', err && err.message);
            UI.toast('The game could not be played. Try again.', { kind: 'error' });
        }
    }

    /** Remind me: play the game on its channel when that channel starts showing it, while Sport stays open. */
    remind(id) {
        this.closeMenu();
        const g = this.game(id), ev = g && SportView.event(g);
        if (!ev) return;
        // already started on its channel: Watch now; any time before (a minute away too), wait for it
        if (ev.start <= this.now()) { this.watch(id); return; }
        if (this.waiting) clearTimeout(this.waiting.timer);
        // #323 review: this reminder's own token; Cancel, a newer Remind me or leaving Sport replaces or clears it, and a
        // timer (or the refresh it waits for) that finds it gone does nothing.
        const token = { id };
        const current = () => this.active && this.waiting === token;
        const fire = async () => {
            if (!current()) return;
            await this.refresh();
            if (!current()) return;
            const fresh = this.game(id), at = fresh && SportView.event(fresh);
            if (!at) { this.waiting = null; UI.toast(`${g.title} is no longer on your channels.`); return; }
            if (at.start > this.now()) { token.timer = setTimeout(fire, Math.max(1000, at.start - this.now())); return; }
            this.waiting = null;
            this.watch(id);
        };
        token.timer = setTimeout(fire, Math.max(0, ev.start - this.now()));
        this.waiting = token;
        UI.toast(`${g.title} plays on ${ev.channel.name} at ${UI.clock(ev.start)}. Keep Sport open.`,
            { action: { label: 'Cancel', run: () => { if (this.waiting === token) { clearTimeout(token.timer); this.waiting = null; } } } });
    }

    /** Record this game: its best channel's airing, padded as usual, stopping when the game ends (gameId). */
    async record(id) {
        this.closeMenu();
        const g = this.game(id), ev = g && SportView.event(g);
        if (!ev || SportView.terminal(g)) return;
        if (SportsPage.cancellingFor(g, ev)) { UI.toast(SportsPage.CANCELLING); return; } // #353 (D-72)
        await this.settleCancels(g);
        try {
            const c = ev.channel;
            const made = await API.recordings.schedule({ sourceId: Number(c.sourceId), channelItemId: c.id, channelName: c.name,
                title: g.title, programStart: ev.start, programEnd: ev.end, ...(SportsPage.gameIdOf(g) ? { gameId: SportsPage.gameIdOf(g) } : {}) });
            const clash = Array.isArray(made?.conflictsWith) && made.conflictsWith.length;
            UI.toast(SportsPage.already(made) || (clash ? `Set to record. It clashes with ${made.conflictsWith.map(x => x.title || x).join(', ')}.` : `Set to record: ${g.title}.`));
            this.refresh();
        } catch (err) {
            UI.toast(UI.errorText(err, 'The recording could not be scheduled.'), { kind: 'error' });
        }
    }

    // ---------- the game's menu: Apple's record menu (SportRecordMenu / ProgrammeMenu) ----------

    /** The followed team "Record every <team> game" is for: the follow the game is for, else its followed side. */
    teamFor(g) {
        if (!g || g.synthetic || !this.front || !Array.isArray(g.competitors) || g.competitors.length !== 2) return null;
        // #323 review: only the game's own sport's follows (an NFL "Giants" is not the AFL's GWS Giants), and the rule's
        // sport is the game's
        const sport = SportView.sportOf(g.league, null, this.front);
        const follows = (this.front.follows || []).filter(f => (f.sport || SportView.sportOf(f.league, null, this.front)) === sport);
        const same = (a, b) => { const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase(); return x === y || x.endsWith(` ${y}`) || y.endsWith(` ${x}`); };
        const own = follows.find(f => f.gameId === g.id && g.competitors.some(c => same(c.name, f.name)));
        // the server's followedSides are its own match within the game's sport; a name decides only within it
        const side = own ? null : SportView.followedSide(g, follows.map(f => f.name));
        const f = own || (side != null ? follows.find(x => same(x.name, g.competitors[side].name)) : null);
        if (!f) return null;
        return { name: f.name, sport };
    }
    /** The channels airing a game now (its own times), for "Watch on…". */
    channelsOnAir(g) {
        const now = this.now();
        if (!SportView.event(g)) return [];
        // each on its own airing; a channel without times on the game's (never "always on air": Opus review of #327)
        return (g.channels || []).filter(c => { const a = this.airing(g, c); return a.start <= now && now < a.end; });
    }
    /**
     * The items: Remind me before a game; "Watch on… (n channels)" when several channels show it now; RECORD: Record this
     * game (or Change recording when it is set), Record every <team> game, More options…; for a game the TV Guide does not
     * list yet, Record when it's listed (or Don't record it); on the front page, Make this the hero.
     */
    menuItems(g, { front = false } = {}) {
        const V = SportView, ev = V.event(g), now = this.now(), items = [], act = V.action(g, now), red = V.ICON.rec.replace('<svg', '<svg class="red"');
        if (act === 'watch') {
            // #345: Watch another channel, only when another channel shows it now (D-65: one row per channel name; one name
            // in several qualities still opens the list, its chips); the card's own press is Watch
            const rows = V.channelGroups(this.channelsOnAir(g)), qualities = rows.length === 1 ? rows[0].chips.length : 0;
            if (rows.length > 1 || qualities > 1) items.push({ act: 'watch-on', icon: V.ICON.channels, title: 'Watch another channel', detail: rows.map(SportsPage.rowName).join(', '), expands: true });
        }
        if (ev && !V.terminal(g) && ev.end > now) {
            const r = g.recording;
            if (r && r.scheduleId != null && r.status) items.push({ act: 'change-recording', icon: red, title: 'Change recording', detail: '', section: 'Record' });
            // #353 (D-72): a recording of this airing being cancelled (here or elsewhere): Record waits until it has finished
            else if (SportsPage.cancellingFor(g, ev)) items.push({ act: 'record', icon: red, title: 'Cancelling…', detail: '', section: 'Record', disabled: true });
            else items.push({ act: 'record', icon: red, title: 'Record this game', detail: '', section: 'Record' });
            const team = this.teamFor(g);
            if (team) items.push({ act: 'record-every', icon: V.ICON.repeat, title: `Record every ${team.name} game`, detail: '', section: 'Record' });
            items.push({ act: 'record-options', icon: V.ICON.sliders, title: 'More options…', detail: '', section: 'Record' });
        } else if (!ev && !g.synthetic && g.status === 'scheduled' && (g.competitors || []).length === 2 && !g.recording && g.start > now) {
            // #234: a game the TV Guide does not list yet is recorded once it is
            if (g.recordWhenListed && g.recordWhenListed.ruleId != null) items.push({ act: 'unlisted-cancel', icon: red, title: 'Don’t record it', detail: 'It records when the TV Guide lists it', section: 'Record' });
            else items.push({ act: 'record-listed', icon: red, title: 'Record when it’s listed', detail: '', section: 'Record' });
        }
        // #345: Remind me is only here, and only before the game starts (a live one plays at once)
        if (act === 'remind') items.push({ act: 'remind', icon: V.ICON.bell, title: 'Remind me', detail: '', section: '' });
        if (front && !g.synthetic && this.heroId !== g.id) items.push({ act: 'pin', icon: V.ICON.star, title: 'Make this the hero', detail: 'Show it in the banner', section: '' });
        return items;
    }
    menuMarkup(g, opts = {}) {
        const V = SportView, e = V.e, ev = V.event(g), items = this.menuItems(g, opts);
        const sub = ev ? `${ev.channel.name} · ${UI.clock(ev.start)} – ${UI.clock(ev.end)}` : V.channelLine(g) || 'No TV listing found';
        let html = `<div class="mh"><b>${e(g.title)}</b><span>${e(sub)}</span></div>`;
        let section = null;
        for (const it of items) {
            if (it.section != null && it.section !== section) {
                section = it.section;
                html += `<div class="mdiv" role="separator"></div>${section ? `<div class="ms" aria-hidden="true">${e(section)}</div>` : ''}`;
            }
            html += `<button type="button" class="mi" role="menuitem" tabindex="-1" data-act="${e(it.act)}" data-id="${e(g.id)}"${it.expands ? ' aria-expanded="false"' : ''}${it.disabled ? ' disabled aria-disabled="true"' : ''}>${it.icon}<span><b>${e(it.title)}</b>${it.detail ? `<span>${e(it.detail)}</span>` : ''}</span></button>`;
            if (it.expands) html += `<div class="msub" hidden>${V.channelGroups(this.channelsOnAir(g)).map(row => {
                const copies = row.chips.flatMap(x => x.channels), c = copies[0], single = copies.length === 1;
                // a row whose chips show has no best badge of its own (its first chip is it): only a closed row (phone) has it
                const badge = single ? V.copyBadge(c) : row.chips.length > 1 ? this.bestBadge(row, row.chips[0].q) : V.qualityBadge(row.chips[0].q);
                const main = `<button type="button" class="mi" role="menuitem" tabindex="-1" data-act="watch-channel" data-id="${e(g.id)}" data-channel="${e(SportsPage.channelKey(c))}">${V.ICON.play}<span><b>${e(single ? c.name : row.name)}</b>${badge ? `<span>${badge}</span>` : ''}</span></button>`;
                if (row.chips.length < 2) return main;
                const chips = this.chipsHtml(row, (chip) => ` type="button" role="menuitem" tabindex="-1" data-act="watch-channel" data-id="${e(g.id)}" data-channel="${e(SportsPage.channelKey(chip.channels[0]))}" aria-label="${e(`Watch ${row.name} in ${SportsPage.chipWords(row, chip)}`)}"`);
                return `<div class="mgrp"${this.phone ? ` data-hold="${e(row.key)}"` : ''}>${main}${chips}</div>`;
            }).join('')}</div>`;
        }
        if (!items.length) html += '<p class="mempty">Not on your channels yet.</p>';
        return html;
    }
    /** The menu for a game: under its card or button on a computer, on its card on a phone too. */
    openMenu(g, anchor, opts = {}) {
        this.closeMenu();
        const menu = document.createElement('div');
        menu.className = 'rmenu sp-menu'; // #345: on its card on a phone too (no bottom sheet), kept on screen by placeMenu
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', g.title);
        menu.innerHTML = this.menuMarkup(g, { front: opts.front ?? !this.route.sport });
        document.body.appendChild(menu);
        this.held = null;
        this.holdRows(menu);
        this.watchChips(menu);
        const rows = () => [...menu.querySelectorAll('[role=menuitem]')].filter(r => !r.closest?.('[hidden]'));
        const close = (focus = true) => this.closeMenu(focus);
        menu.addEventListener('click', (e) => {
            const el = e.target?.closest?.('[data-act]');
            if (!el) return;
            const name = el.getAttribute('data-act');
            if (name === 'watch-on') {
                const list = el.nextElementSibling, open = list && list.hidden;
                if (list) { list.hidden = !open; el.setAttribute('aria-expanded', String(!!open)); if (open) list.querySelector('[role=menuitem]')?.focus?.(); }
                return;
            }
            this.act(name, el, e);
        });
        menu.addEventListener('keydown', (e) => {
            const list = rows(), i = list.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
            else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
            else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
            else if (e.key === 'Tab') close(true); // focus back on the card, so Tab goes on from there
        });
        const outside = (e) => { if (!menu.contains(e.target) && !anchor?.contains?.(e.target)) close(false); };
        document.addEventListener('pointerdown', outside, true);
        this.menu = { el: menu, anchor, key: anchor?.getAttribute?.('data-key') || null, gameId: g.id, outside };
        anchor?.setAttribute?.('aria-expanded', 'true');
        this.placeMenu(opts.point);
        (rows()[0] || menu).focus?.();
    }
    placeMenu(point = null) {
        const m = this.menu;
        if (!m) return;
        const b = point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : m.anchor?.getBoundingClientRect ? m.anchor.getBoundingClientRect() : null;
        if (!b) return;
        const r = m.el.getBoundingClientRect ? m.el.getBoundingClientRect() : { width: 360, height: 0 };
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024, vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
        const w = r.width || 360, h = r.height || 0;
        const left = Math.max(8, Math.min(point ? b.left : b.right - w, vw - w - 8));
        let top = b.bottom + 4;
        if (top + h > vh - 8 && b.top - h - 4 >= 8) top = b.top - h - 4;
        m.el.style.left = `${Math.round(left)}px`;
        top = Math.min(top, vh - h - 8); // never off the bottom (a menu taller than the window scrolls: CSS max-height)
        m.el.style.top = `${Math.round(Math.max(8, top))}px`;
    }
    closeMenu(focus = false) {
        const m = this.menu;
        if (!m) return;
        this.menu = null;
        document.removeEventListener('pointerdown', m.outside, true);
        m.el.remove();
        // #323 review: a poll may have redrawn the page under the menu: its card is found again by its data-key
        const anchor = this.anchorFor(m);
        anchor?.setAttribute?.('aria-expanded', 'false');
        if (focus) anchor?.focus?.();
    }
    /** The menu's card as the page now draws it: the same element, else the one with its data-key. */
    anchorFor(m) {
        if (m.anchor && m.anchor.isConnected !== false) return m.anchor;
        if (!m.key || !this.root?.querySelectorAll) return null;
        return [...this.root.querySelectorAll('[data-key]')].find(n => n.getAttribute('data-key') === m.key) || null;
    }

    // ---------- what the menu's items do ----------

    /** Record every <team> game: a household rule (C-M `team`), the team's games from the fixture, never a replay. */
    async recordEvery(id) {
        this.closeMenu(true);
        const g = this.game(id), team = this.teamFor(g);
        if (!team) return;
        try {
            await API.recordings.addRule({ kind: 'team', match: team.name, sport: team.sport });
            UI.toast(`Recording every ${team.name} game.`);
            this.refresh();
        } catch (err) { UI.toast(UI.errorText(err, `Every ${team.name} game could not be set to record.`), { kind: 'error' }); }
    }
    /** #234: record a game once the TV Guide lists it (C-M `game`), or stop waiting for it. */
    async recordListed(id, cancel = false) {
        this.closeMenu(true);
        const g = this.game(id);
        if (!g) return;
        try {
            if (cancel) { await API.recordings.deleteRule(g.recordWhenListed.ruleId); UI.toast(`${g.title} won’t be recorded.`); }
            else { await API.recordings.addRule({ kind: 'game', gameId: g.id }); UI.toast(`${g.title} records when the TV Guide lists it.`); }
            this.refresh();
        } catch (err) { UI.toast(UI.errorText(err, 'The recording could not be changed.'), { kind: 'error' }); }
    }
    /** Make this the hero (the front page's banner), while its game is on the page. */
    pin(id) {
        this.closeMenu(true);
        if (!this.game(id)) return;
        this.selectedFollowKey = null; this.pinned = id; this.heroId = id;
        this.loadMap(); this.render();
    }
    // ---------- iOS's windows (#327): the game's details (SportEventDetails) and the record page (RecordPage) ----------

    /** A channel's identity in the channel list (never a stored position). */
    static channelKey(c) { return `${c.sourceId}:${c.stableId || c.id}`; }
    /** A picker row's name: a single copy's own name, else the name its copies share (quality words aside). */
    static rowName(row) { const copies = row.chips.flatMap(x => x.channels); return copies.length === 1 ? copies[0].name : row.name; }
    /** "4K at 50 fps", "1080", "HD (not measured)": a chip's quality for a screen reader. */
    static qualityWords(q) { return `${q.label || 'unknown quality'}${q.fps ? ` at ${q.fps} fps` : ''}${q.measured ? '' : ' (not measured)'}`; }
    /** A chip's quality for a screen reader, with its start when its airing is not the row's (`days`: every chip's day and time). */
    static chipWords(row, chip, days = false) {
        const lead = row.chips[0];
        if (days && chip.start !== null) return `${SportsPage.qualityWords(chip.q)}, starting ${SportsPage.dayTime(chip.start)}`;
        return `${SportsPage.qualityWords(chip.q)}${chip !== lead && chip.start !== null && chip.start !== lead.start ? `, starting ${UI.clock(chip.start)}` : ''}`;
    }
    /** #353: "Sat 7:30 pm": the app's short weekday (UI.date's) and the clock. */
    static dayTime(ms) { return `${UI.date(ms).split(' ')[0]} ${UI.clock(ms)}`; }
    /** #353: a row whose chips are on more than one airing (a Test's two days on one channel). */
    static severalAirings(row) { return new Set(row.chips.map(c => c.start).filter(x => x !== null)).size > 1; }
    /**
     * D-65: a picker row's quality chips, best first: a button with `attrs(chip)` (its action), or a plain badge when
     * that quality has nothing to do. Wide: shown; narrow (iPhone layout): hidden until the row is touched and held.
     */
    chipsHtml(row, attrs, chosen = null, days = false) {
        const V = SportView;
        // a chip on another airing than the row's (its best copy's) says when it starts; `days` (#353, the record
        // picker's row on several airings): every chip says its day and time
        const lead = row.chips[0];
        const chips = row.chips.map(chip => {
            const a = attrs(chip), on = !!chosen && chip.channels.includes(chosen);
            const note = days && chip.start !== null ? SportsPage.dayTime(chip.start)
                : chip !== lead && chip.start !== null && chip.start !== lead.start ? UI.clock(chip.start) : '';
            return a ? V.qualityBadge(chip.q, { tag: 'button', cls: `qchip${on ? ' on' : ''}`, note, attrs: `${a}${chosen ? ` aria-pressed="${on}"` : ''}` }) : V.qualityBadge(chip.q, { note });
        }).join('');
        const shown = !this.phone || this.held === row.key;
        return `<span class="qchips" role="group" aria-label="${V.e(`${row.name}: qualities`)}"${shown ? '' : ' hidden'}>${chips}</span>`;
    }
    /** A row with chips: its best badge only where the chips are not shown (a closed row on a phone), else nothing. */
    bestBadge(row, q) {
        if (!this.phone) return '';
        return SportView.qualityBadge(q, { cls: 'qbest', attrs: this.held === row.key ? ' hidden' : '' });
    }
    /** D-65: a chip row wider than its box fades at the edge(s) it overflows, the cue that it scrolls; none when it fits. */
    static fadeEdges(el) {
        if (!el || !el.classList) return;
        const max = (Number(el.scrollWidth) || 0) - (Number(el.clientWidth) || 0), at = Number(el.scrollLeft) || 0;
        el.classList.toggle('fade-l', max > 1 && at > 1);
        el.classList.toggle('fade-r', max > 1 && at < max - 1);
    }
    /** Every chip row under `root` keeps its fade right: now, and when its size changes (shown, the window resized). */
    watchChips(root) {
        if (!root || !root.querySelectorAll) return;
        if (!this._chipSizes && typeof ResizeObserver !== 'undefined') this._chipSizes = new ResizeObserver(list => list.forEach(x => SportsPage.fadeEdges(x.target)));
        for (const el of root.querySelectorAll('.qchips')) { SportsPage.fadeEdges(el); this._chipSizes?.observe(el); }
    }
    /**
     * D-65 (iPhone): touch and hold a picker row (`data-hold`) opens its chips in place (another hold closes them); the
     * click that ends a hold does nothing. A right-click (a long press in most phone browsers) does the same.
     */
    holdRows(root) {
        if (!root || root.dataset?.holdRows) return;
        if (root.dataset) root.dataset.holdRows = '1';
        let timer = null, at = null, heldAt = 0;
        const toggle = (row) => {
            const k = row.getAttribute('data-hold');
            this.held = this.held === k ? null : k;
            heldAt = Date.now();
            for (const r of root.querySelectorAll('[data-hold]')) {
                const open = r.getAttribute('data-hold') === this.held, chips = r.querySelector('.qchips');
                if (chips) { chips.hidden = !open; if (open) SportsPage.fadeEdges(chips); }
                for (const b of r.querySelectorAll('.qbest')) b.hidden = open; // the open row's chips show its best
            }
        };
        const cancel = () => { clearTimeout(timer); timer = null; };
        root.addEventListener('pointerdown', (e) => {
            const row = e.target?.closest?.('[data-hold]');
            cancel();
            if (!row || e.target?.closest?.('.qchip')) return;
            at = { x: e.clientX || 0, y: e.clientY || 0 };
            timer = setTimeout(() => { timer = null; toggle(row); }, SportsPage.HOLD_MS);
        });
        root.addEventListener('pointermove', (e) => { if (timer && at && Math.hypot((e.clientX || 0) - at.x, (e.clientY || 0) - at.y) > 10) cancel(); });
        root.addEventListener('pointerup', cancel);
        root.addEventListener('scroll', (e) => { if (e.target?.classList?.contains?.('qchips')) SportsPage.fadeEdges(e.target); }, true);
        root.addEventListener('pointercancel', cancel);
        root.addEventListener('contextmenu', (e) => {
            const row = e.target?.closest?.('[data-hold]');
            if (!row) return;
            e.preventDefault();
            cancel();
            if (Date.now() - heldAt > SportsPage.HOLD_MS) toggle(row);
        });
        root.addEventListener('click', (e) => {
            if (Date.now() - heldAt < SportsPage.HOLD_MS && e.target?.closest?.('[data-hold]') && !e.target?.closest?.('.qchip')) { e.stopImmediatePropagation?.(); e.preventDefault?.(); }
        }, true);
    }
    /**
     * Whether a `recordings/scheduled` row records on channel `c` (ARCHITECTURE › Channel identity): a row with a stable
     * id matches only that stable id, never its stored pos_N (a playlist reorder moves positions); a row without one
     * matches by position.
     */
    static rowOnChannel(r, c) {
        if (!r || !c || Number(r.source_id) !== Number(c.sourceId)) return false;
        if (r.channel_stable_id) return !!c.stableId && String(c.stableId) === String(r.channel_stable_id);
        return String(c.id) === String(r.channel_item_id);
    }
    /** A channel's own airing of the game (C-R #20), else the game's on its best channel. */
    airing(g, c) {
        const ev = SportView.event(g);
        return { start: Number.isFinite(c.start) ? c.start : ev.start, end: Number.isFinite(c.end) ? c.end : ev.end };
    }
    /** "Today", "Tomorrow", "Yesterday", else "Saturday 21 November" (DetailText.day). */
    static day(ms, now) {
        const at = new Date(ms).toDateString(), d = (n) => { const x = new Date(now); x.setDate(x.getDate() + n); return x.toDateString(); };
        if (at === d(0)) return 'Today';
        if (at === d(1)) return 'Tomorrow';
        if (at === d(-1)) return 'Yesterday';
        return SportView.headerDate(ms);
    }
    /** "12 min", "1 h 5 min", "2 h", rounded up (SportRows.span). */
    static span(ms) {
        const minutes = Math.max(1, Math.ceil(ms / 60000));
        if (minutes < 60) return `${minutes} min`;
        return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
    }
    static range(a) { return `${UI.clock(a.start)} – ${UI.clock(a.end)}`; }
    /** The status word of a schedule's status (ScheduledRecording.statusWord). */
    static statusWord(status) { return status === 'recording' ? 'Recording now' : status === 'waiting' ? 'Waiting to record' : 'Recording scheduled'; }
    /**
     * #353 (D-72): the card's schedule of airing `a` ({ start, end }) whose cancel is under way (C-R `recordingCancelling`,
     * here or from another tab or client), or null: Record of that airing waits until it has finished.
     */
    static cancellingFor(g, a) {
        const list = g && Array.isArray(g.recordingCancelling) ? g.recordingCancelling : [];
        return (a && list.find(x => x && Number.isFinite(x.start) && Number.isFinite(x.end) && x.start < a.end && x.end > a.start)) || null;
    }
    /** #353: a card's channel-and-airing choices: C-R `slots` when sent, else its `channels`. */
    static slotsOf(g) { return (g && Array.isArray(g.slots) && g.slots.length ? g.slots : g && g.channels) || []; }
    /** The game's recording as C-R tells it: its schedule id and status, or null. */
    static recordingOf(g) {
        const r = g && g.recording;
        if (!r || r.scheduleId == null || !r.status) return null;
        return { id: r.scheduleId, status: r.status, word: SportsPage.statusWord(r.status) };
    }

    /** The element a window gives focus back to: the menu's card when it came from the menu, else the pressed control. */
    openerFor(el) {
        const a = this.menu ? this.anchorFor(this.menu) : null;
        return a || (el && el.isConnected !== false ? el : null);
    }
    /** One window at a time (iOS: one page at a time); the open one is closed first. */
    closeWindow() {
        const w = this.window;
        this.window = null;
        if (w) { clearTimeout(w.timer); w.d.close(); }
    }
    /** A window: a dialog (a sheet from the bottom on a phone), its content redrawn from `draw`, focus kept by data-key. */
    makeWindow({ kind, id, title, label, draw, opener, act }) {
        this.closeWindow();
        const d = UI.dialog.create({ title, className: 'sp-dialog sp-window',
            onClose: () => { if (this.window && this.window.d === d) { clearTimeout(this.window.timer); this.window = null; } } });
        if (label) { d.el.removeAttribute('aria-labelledby'); d.el.setAttribute('aria-label', label); }
        const w = { kind, id, d, timer: null };
        w.redraw = () => {
            const key = typeof document !== 'undefined' && d.el.contains?.(document.activeElement) ? document.activeElement?.getAttribute?.('data-key') : null;
            const { body, footer } = draw();
            d.body.innerHTML = `<div class="sp sp-win">${body}</div>`;
            d.footer.replaceChildren(...(footer || []));
            this.watchChips(d.body);
            if (key) [...(d.el.querySelectorAll?.('[data-key]') || [])].find(n => n.getAttribute('data-key') === key)?.focus?.({ preventScroll: true });
        };
        d.el.addEventListener('click', (e) => {
            const el = e.target?.closest?.('[data-act]');
            if (!el || !d.el.contains(el) || el.disabled) return;
            act(el.getAttribute('data-act'), el, e);
        });
        // a logo that does not load becomes its monogram disc, as on the page
        d.el.addEventListener('error', (e) => this.badgeFallback(e), true);
        this.held = null;
        this.holdRows(d.el);
        this.window = w;
        w.redraw();
        d.open(opener || undefined);
        return w;
    }

    // ----- the record page (iOS RecordPage: More options…, Record in the details, Change recording) -----

    static chipTitle(m) { return m == null ? 'Usual' : m === 0 ? 'On time' : `${m} min`; }
    /** Change recording's choices: the schedule's own value added when it is not one of them, and never Usual. */
    static chips(base, current, changing) {
        if (!changing) return base;
        const minutes = base.filter(m => m != null);
        if (Number.isFinite(current) && !minutes.includes(current)) { minutes.push(current); minutes.sort((a, b) => a - b); }
        return minutes;
    }

    /** The What choices (RecordPlan.whats): this game; every game of the followed team, else of each side; every game of its league. */
    recordWhats(g) {
        const out = [{ kind: 'this' }];
        const team = this.teamFor(g);
        const names = team ? [team.name] : Array.isArray(g.competitors) && g.competitors.length === 2 ? g.competitors.map(c => c && c.name).filter(Boolean) : [];
        // the sport is resolved when drawn and when saved (the catalogue may come after the page opened)
        for (const name of names) out.push({ kind: 'team', name, sport: team ? team.sport : null });
        const league = String(g.league || '').trim();
        if (league && league.toLowerCase() !== 'sport') out.push({ kind: 'league', league });
        return out;
    }
    /**
     * A league's catalogue sport, whether or not anyone follows it (Codex #327: a league page's fixture): the catalogue
     * (/api/sports/catalog), else the front page's `sports[]`, else the Sport page the league is shown on.
     */
    sportOfLeague(league) {
        if (!league) return null;
        const own = this.leagueSports && Object.hasOwn(this.leagueSports, league) ? this.leagueSports[league] : null;
        if (own) return own;
        const followed = ((this.front && this.front.sports) || []).find(s => s.league === league)?.sport;
        if (followed) return followed;
        const { sport } = this.route;
        return sport && (this.route.league === league || this.shownLeague() === league) ? sport : null;
    }
    /** A team choice's sport: the follow's, else its league's; null when it cannot be told (the choice is then off). */
    teamSport(w, g) { return w.sport || this.sportOfLeague(g.league); }
    whatLabel(w, st) {
        const a = st.airings[0];
        if (w.kind === 'this') return { title: 'This game', detail: a ? `${SportsPage.day(a.start, this.now())} ${UI.clock(a.start)}` : '' };
        if (w.kind === 'team') return { title: `Every ${w.name} game`, detail: this.teamSport(w, st.g) ? '' : 'Not available: PigTV doesn’t know this league’s sport' };
        const name = SportView.label(w.league, this.labels);
        return { title: (st.g.competitors || []).length === 2 ? `Every ${name} game` : `Everything in ${name}`, detail: '' };
    }

    /**
     * The record page for a game, on `channel` (a details row's Record) or its best channel. A game already set to record
     * (C-R `recording`) opens as Change recording on that schedule (0662: its padding is changed with PUT, never a second
     * schedule), whichever channel was asked for.
     */
    /**
     * The record window: Change recording of the schedule the card names, or (none, or `pick`: More options) Record with
     * its airing to choose; the choice then edits a schedule of that airing or makes one (recordNow).
     */
    openRecord(id, { channel = null, opener = null, pick = false } = {}) {
        const g = this.game(id), ev = g && SportView.event(g);
        if (!ev || SportView.terminal(g)) return undefined;
        opener = opener || this.openerFor(null);
        this.closeMenu();
        const now = this.now();
        // #353: the card's `slots` when it has them (a Test's day two on day one's channel is a choice of its own)
        let airings = SportsPage.slotsOf(g).map(c => ({ c, key: SportsPage.channelKey(c), ...this.airing(g, c) })).filter(a => a.end > now);
        if (!airings.length) airings = [{ c: ev.channel, key: SportsPage.channelKey(ev.channel), start: ev.start, end: ev.end }];
        const rec = pick ? null : SportsPage.recordingOf(g);
        // Opus review of #327: the chosen channel is never switched silently: one whose airing has ended by now leaves
        // the choice to the person
        const index = channel ? airings.findIndex(a => a.key === channel) : 0;
        const lost = index < 0 ? (g.channels || []).find(c => SportsPage.channelKey(c) === channel) : null;
        const st = { g, airings, index, what: 0, whats: rec ? [] : this.recordWhats(g),
            pre: null, post: null, schedule: null, rec, loaded: !rec, gone: false, busy: false, want: channel, move: null,
            error: lost && !rec ? `${lost.name} isn’t showing the game any more. Choose a channel to record on.` : null };
        const w = this.makeWindow({ kind: 'record', id, title: g.title, opener, label: `${rec ? 'Change recording of' : 'Record'} ${g.title}`,
            draw: () => this.recordMarkup(st), act: (name, el) => this.recordAct(name, el, st) });
        w.st = st;
        w.d.el.addEventListener('change', (e) => {
            const t = e.target, v = t ? String(t.value) : '';
            const n = v === '' ? null : Number(v);
            if (t?.id === 'sp-rec-pre') st.pre = n; else if (t?.id === 'sp-rec-post') st.post = n; else return;
            w.redraw();
        });
        if (rec) this.loadSchedule(st, w);
        return w;
    }
    /** Change recording's schedule as `GET /recordings/scheduled` lists it: its padding and status (C-M since 0444). */
    async loadSchedule(st, w) {
        try {
            const rows = await API.request('GET', '/recordings/scheduled');
            const row = (Array.isArray(rows) ? rows : []).find(r => r && r.id === st.rec.id);
            if (!row || !['scheduled', 'waiting', 'recording'].includes(row.status)) st.gone = true;
            else {
                st.schedule = row;
                // the page shows the channel the schedule records, never another one (RecordPlan.bind)
                // #353 (Codex round 1, medium): on its channel AND its own guide slot (a Test's two days on one channel are
                // two airings); none of them: the schedule's own times
                const slotEnd = Number.isFinite(row.program_end_original) ? row.program_end_original : row.program_end;
                const timed = Number.isFinite(row.program_start) && Number.isFinite(slotEnd);
                const at = st.airings.findIndex(x => x.key && SportsPage.rowOnChannel(row, x.c) && (!timed || (row.program_start < x.end && slotEnd > x.start)));
                if (at >= 0) st.index = at;
                else if (row.channel_name && Number.isFinite(row.program_start) && Number.isFinite(row.program_end)) {
                    st.airings = [...st.airings, { c: { name: row.channel_name }, key: null, start: row.program_start, end: row.program_end }];
                    st.index = st.airings.length - 1;
                }
                st.pre = Number.isFinite(row.pre_buffer_min) ? row.pre_buffer_min : null;
                st.post = Number.isFinite(row.post_buffer_min) ? row.post_buffer_min : null;
                // Opus review of #327: "Record on B" for a game set to record on A: Change recording of A, with a way to
                // move it to B (never a second recording; not while A records, which a move would stop)
                const target = st.want ? st.airings.find(x => x.key === st.want) : null;
                st.move = target && target !== st.airings[st.index] && row.status !== 'recording' ? target : null;
            }
            st.loaded = true;
        } catch (err) {
            st.error = UI.errorText(err, 'The recording could not be read. Close this and try again.');
        }
        if (this.window === w) w.redraw();
    }
    /**
     * #347: the active schedule that already records the chosen airing `a` ({ c, start, end }), or null. It must be active
     * and its guide slot (`program_start` to its first `program_end`) overlap the chosen airing; then it is this game's:
     * - a row naming a game (`gameId`): only this game's id (a row of another game never is, whatever its channel);
     * - the schedule the card names (C-R `recording`);
     * - an older row naming no game: on one of the game's channels, overlapping the game's own airing THERE too (a channel
     *   that carries the game hours later does not make another programme on it this game).
     * A schedule of another airing of the game (a Test's other day, an earlier showing) is not this one.
     */
    scheduleForAiring(g, a, rows) {
        if (!a) return null;
        const active = (r) => r && ['scheduled', 'waiting', 'recording'].includes(r.status);
        const named = SportsPage.recordingOf(this.game(g.id) || g), id = SportsPage.gameIdOf(g);
        const slotEnd = (r) => (Number.isFinite(r.program_end_original) ? r.program_end_original : r.program_end);
        const overlaps = (r, w) => r.program_start < w.end && slotEnd(r) > w.start;
        const ours = (r) => {
            if (r.gameId) return Boolean(id) && r.gameId === id;
            if (named && r.id === named.id) return true;
            return SportsPage.slotsOf(g).some(c => SportsPage.rowOnChannel(r, c) && overlaps(r, this.airing(g, c)));
        };
        return rows.find(r => active(r) && overlaps(r, a) && ours(r)) || null;
    }
    /** What Save changes sends (RecordPlan.change): only what changed, Start early not once it records; null when nothing has. */
    static change(st) {
        const row = st.schedule;
        if (!row) return null;
        const body = {};
        if (row.status !== 'recording' && st.pre != null && st.pre !== row.pre_buffer_min) body.preBufferMin = st.pre;
        if (st.post != null && st.post !== row.post_buffer_min) body.postBufferMin = st.post;
        return Object.keys(body).length ? body : null;
    }
    /** The record page's content (no score: title, league, times and channels only) and its buttons. */
    recordMarkup(st) {
        const V = SportView, e = V.e, P = SportsPage, now = this.now(), g = st.g, changing = !!st.rec;
        const chosen = st.airings[st.index] || null, a = chosen || st.airings[0], leagueName = V.label(g.league, this.labels);
        const status = changing ? (st.gone ? 'ENDED' : P.statusWord(st.schedule ? st.schedule.status : st.rec.status).toUpperCase()) : null;
        const kicker = [changing ? 'CHANGE RECORDING' : 'RECORD', status, leagueName ? String(leagueName).toUpperCase() : null].filter(Boolean).join(' · ');
        const two = Array.isArray(g.competitors) && g.competitors.length === 2;
        let html = `<div class="rhead">${two ? `<span class="rbadges" aria-hidden="true">${g.competitors.map(c => V.badge(c.name, c.logo, 40, g.league)).join('')}</span>` : ''}`
            + `<span class="rht"><span class="rk">${e(kicker)}</span><span class="rmeta pig-amount">${e(`${P.day(a.start, now)} · ${P.range(a)}${chosen ? ` · ${chosen.c.name}` : ''}`)}</span></span></div>`;
        if (changing && st.move && !st.gone) {
            const on = (st.airings[st.index] && st.airings[st.index].c.name) || st.schedule.channel_name || '';
            html += `<div class="rmove"><p>${e(on ? `Set to record on ${on}.` : 'Set to record on another channel.')}</p>`
                + `<button type="button" class="pill" data-act="r-move" data-key="r:move"${st.busy ? ' disabled' : ''}>${V.ICON.rec}${e(`Record on ${st.move.c.name} instead`)}</button></div>`;
        }
        // What: this game, or a rule (not on Change recording: it is one schedule)
        if (st.whats.length) {
            html += '<h3 class="rsec" id="sp-rec-what">What</h3><div class="rwhat" role="radiogroup" aria-labelledby="sp-rec-what">';
            st.whats.forEach((w, i) => {
                const l = this.whatLabel(w, st), on = i === st.what, off = w.kind === 'team' && !this.teamSport(w, g);
                html += `<button type="button" class="rchoice${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-act="r-what" data-index="${i}" data-key="r:what:${i}"${off ? ' disabled' : ''}><b>${e(l.title)}</b>${l.detail ? `<span class="pig-amount">${e(l.detail)}</span>` : ''}</button>`;
            });
            html += '</div>';
        }
        // When it stops: with the game (ESPN) for a card's game or a schedule linked to one, else the guide's end
        const withGame = changing && st.schedule ? st.schedule.endsWith === 'event' : Boolean(SportsPage.gameIdOf(g));
        const stop = withGame ? 'When the game ends (ESPN)' : 'When the guide says it ends';
        html += `<h3 class="rsec">When it stops</h3><div class="rstop"><span class="rradio on" aria-hidden="true"></span><span class="rcht"><b>${e(stop)}</b></span></div>`;
        const startLocked = changing && (!st.schedule || st.schedule.status === 'recording' || st.gone);
        const endLocked = changing && (!st.schedule || st.gone);
        const select = (id, title, options, value, locked) => `<label class="rrow" for="${id}"><span>${e(title)}</span><select id="${id}" data-key="r:${id}"${locked ? ' disabled' : ''}>`
            + options.map(m => `<option value="${m == null ? '' : m}"${m === value ? ' selected' : ''}>${e(P.chipTitle(m))}</option>`).join('') + '</select></label>';
        html += select('sp-rec-pre', 'Start early', P.chips(P.START_EARLY, st.schedule && st.schedule.pre_buffer_min, changing), st.pre, startLocked);
        html += select('sp-rec-post', 'Finish late', P.chips(P.FINISH_LATE, st.schedule && st.schedule.post_buffer_min, changing), st.post, endLocked);
        // Record on: when several channels carry it, each on its own airing
        if (!changing && (st.airings.length > 1 || !chosen)) {
            html += `<div class="rsech"><h3 class="rsec" id="sp-rec-on">Record on</h3></div><div class="ron" role="radiogroup" aria-labelledby="sp-rec-on">`;
            const first = st.airings[0];
            // D-65: one row per channel name; a row with several qualities has its chips (the chosen one pressed)
            const indexOf = (c) => st.airings.findIndex(x => x.c === c);
            V.channelGroups(st.airings.map(x => x.c)).forEach((row, n) => {
                const copies = row.chips.flatMap(x => x.channels), single = copies.length === 1;
                const picked = copies.find(c => indexOf(c) === st.index) || null;
                const i = indexOf(picked || row.chips[0].channels[0]), x = st.airings[i], on = !!picked, times = `${P.day(x.start, now)} ${P.range(x)}`;
                const detail = n === 0 ? `Best channel · ${times}` : x.start === first.start && x.end === first.end ? 'Same times' : times;
                const days = P.severalAirings(row);
                const chips = row.chips.length > 1 ? this.chipsHtml(row, (chip) => { const k = indexOf(chip.channels[0]);
                    return ` type="button" data-act="r-on" data-index="${k}" data-key="r:q:${k}" aria-label="${e(`Record ${row.name} in ${P.chipWords(row, chip, days)}`)}"`; }, picked, days) : '';
                const shownChip = picked ? row.chips.find(ch => ch.channels.includes(picked)) : row.chips[0];
                const badge = row.chips.length > 1 ? this.bestBadge(row, shownChip.q) : single ? V.copyBadge(x.c) : V.qualityBadge(row.chips[0].q);
                const button = `<button type="button" class="rchoice rch${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-act="r-on" data-index="${i}" data-key="r:on:${i}"><span class="rradio${on ? ' on' : ''}" aria-hidden="true"></span><span class="rcht"><b>${e(single ? x.c.name : row.name)}</b><span class="pig-amount">${e(detail)}</span></span>${badge}</button>`;
                html += chips ? `<div class="rchg"${this.phone ? ` data-hold="${e(row.key)}"` : ''}>${button}${chips}</div>` : button;
            });
            html += '</div>';
        }
        // the note, then any error
        let note;
        if (changing) note = st.gone ? P.GONE : !st.schedule ? '' : st.schedule.status === 'recording' ? 'It is recording: only Finish late can change.' : 'Changes apply to this recording only.';
        else if (a.start <= now) note = 'It has started: only the rest of it is recorded.';
        if (note) html += `<p class="rnote">${e(note)}</p>`;
        if (st.error) html += `<p class="rerr" role="alert">${e(st.error)}</p>`;
        // the buttons: Cancel (Close); Cancel recording (Stop recording); Record game / Record every game / Save changes
        const button = (text, cls, name, disabled = false) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = cls; b.textContent = text; b.setAttribute('data-act', name); b.setAttribute('data-key', `r:${name}`);
            if (disabled) b.disabled = true;
            return b;
        };
        const what = st.whats[st.what];
        // #353 (D-72): this airing's recording is being cancelled: a disabled "Cancelling…" in place of Record game
        const going = !changing && chosen && (!what || what.kind === 'this') && P.cancellingFor(g, chosen);
        const primary = changing ? 'Save changes' : what && what.kind !== 'this' ? 'Record every game' : going ? 'Cancelling…' : 'Record game';
        const off = st.busy || !!going || (changing && (!st.loaded || st.gone || !P.change(st))) || (!changing && !chosen && (!what || what.kind === 'this'));
        const footer = [button(changing ? 'Close' : 'Cancel', 'btn btn-secondary', 'r-close', st.busy)];
        if (changing) footer.push(button((st.schedule ? st.schedule.status : st.rec.status) === 'recording' ? 'Stop recording' : 'Cancel recording', 'btn btn-danger', 'r-cancel', st.busy || st.gone));
        footer.push(button(primary, 'btn btn-primary', 'r-save', off));
        return { body: html, footer };
    }
    recordAct(name, el, st) {
        const w = this.window;
        switch (name) {
            case 'r-what': st.what = Number(el.getAttribute('data-index')) || 0; return w?.redraw();
            case 'r-on': st.index = Number(el.getAttribute('data-index')) || 0; st.error = null; return w?.redraw();
            case 'r-close': return this.closeWindow();
            case 'r-cancel': return this.cancelRecording(st);
            case 'r-move': return this.moveRecording(st, w);
            case 'r-save': return this.saveRecord(st, w);
            default: return undefined;
        }
    }
    /** Cancel recording (Stop recording): at once, with the 10 s Undo; the window closes first. */
    cancelRecording(st) {
        if (!st.rec || st.gone) return;
        const g = st.g, id = st.rec.id, recording = { scheduleId: id, status: st.rec.status };
        this.closeWindow();
        // Opus review of #327: the card loses its recording at once and keeps it lost through refreshes until the cancel
        // is sent and a new answer has come; Undo puts it back. The cancel is sent once: when the notice ends, or first
        // by a new action on the game (settleCancels).
        const restore = () => {
            this.cancels.delete(id);
            const fresh = this.front && SportView.game(this.front, g.id);
            if (fresh && !fresh.recording) fresh.recording = recording;
            this.render();
        };
        const entry = { id, gameId: SportsPage.cancelKey(g), notice: null, sending: null };
        entry.send = (keepalive = false) => {
            if (!entry.sending) {
                entry.sending = API.request('DELETE', `/recordings/scheduled/${id}`, null, { keepalive }).then(
                    () => { Promise.resolve(this.refresh()).finally(() => this.cancels.delete(id)); },
                    (err) => { restore(); throw err; });
            }
            return entry.sending;
        };
        this.cancels.set(id, entry);
        this.hideCancelled();
        this.render();
        entry.notice = UI.undoable(`Recording of ${g.title} ${recording.status === 'recording' ? 'stopped' : 'cancelled'}.`, {
            undo: () => { if (!entry.sending) restore(); },
            failText: 'The recording could not be cancelled.',
            commit: ({ keepalive } = {}) => entry.send(keepalive) });
    }
    /**
     * "Record on B instead": the schedule on A moves to B on the server (POST /recordings/scheduled/:id/move, #329), with
     * its game and padding, in one step; a refusal leaves A as it was and says why.
     */
    async moveRecording(st, w) {
        const to = st.move, from = st.schedule;
        if (!to || !from || st.busy) return;
        st.busy = true; st.error = null; w?.redraw();
        const was = (st.airings[st.index] && st.airings[st.index].c.name) || from.channel_name || 'the other channel';
        const c = to.c;
        let moved;
        try {
            // #329 (Codex round 1): one request, one transaction on the server: the schedule itself moves (its game, padding
            // and id kept), or nothing changes (already recording, finished, or the channel refused)
            moved = await API.request('POST', `/recordings/scheduled/${from.id}/move`, { sourceId: Number(c.sourceId), channelItemId: c.id,
                channelName: c.name, programStart: to.start, programEnd: to.end });
        } catch (err) {
            st.busy = false;
            const words = UI.errorText(err, `It couldn’t be set to record on ${c.name}.`);
            st.error = err && err.status === 409 ? words : `${words} It still records on ${was}.`;
            if (this.window === w) w.redraw(); else UI.toast(st.error, { kind: 'error' });
            return;
        }
        const text = `Now recording on ${(moved && moved.channel_name) || c.name} instead of ${was}.`;
        st.busy = false;
        if (this.window === w) this.closeWindow();
        UI.toast(text);
        this.refresh();
    }
    /** The primary button: Save changes (PUT), a rule (C-M `team`, or `sport` for a league), or this game on the chosen channel. */
    async saveRecord(st, w) {
        if (st.busy) return;
        if (st.rec && (st.gone || !st.schedule || !SportsPage.change(st))) {
            if (st.gone || !st.schedule) { st.error = SportsPage.GONE; w?.redraw(); }
            return;
        }
        st.busy = true; st.error = null; w?.redraw();
        let toast = null;
        try { toast = await this.recordNow(st); }
        catch (err) { st.error = err && err.plain ? err.message : UI.errorText(err, (err && err.failText) || 'The recording could not be scheduled.'); }
        st.busy = false;
        if (toast) {
            if (this.window === w) this.closeWindow();
            UI.toast(toast);
            this.refresh();
        } else if (this.window === w) w.redraw();
        // Opus review of #327: the window was closed while it saved: its failure is still told
        else if (st.error) UI.toast(st.error, { kind: 'error' });
    }
    /** What the primary button does; answers the notice to show, or null (the page says why); throws a failure. */
    async recordNow(st) {
        await this.settleCancels(st.g);
        const g = st.g, pad = { ...(st.pre != null ? { preBufferMin: st.pre } : {}), ...(st.post != null ? { postBufferMin: st.post } : {}) };
        const plain = (message) => Object.assign(new Error(message), { plain: true });
        const failing = (failText, run) => Promise.resolve().then(run).catch((err) => { if (err && !err.plain && !err.failText) err.failText = failText; throw err; });
        const rows = async (unreadText) => {
            try { const r = await API.request('GET', '/recordings/scheduled'); return Array.isArray(r) ? r : []; }
            catch { throw plain(unreadText); }
        };
        if (st.rec) {
            // Opus review of #327: read again at the press: it may have started recording (Start early then cannot
            // change: the server would answer 409) or gone since the page opened
            const row = (await rows('PigTV couldn’t read this recording again, so nothing was changed. Try again.'))
                .find(r => r && r.id === st.rec.id && ['scheduled', 'waiting', 'recording'].includes(r.status));
            if (!row) { st.gone = true; throw plain(SportsPage.GONE); }
            const wanted = SportsPage.change(st);
            st.schedule = row;
            if (row.status === 'recording') st.pre = Number.isFinite(row.pre_buffer_min) ? row.pre_buffer_min : null;
            const body = SportsPage.change(st);
            if (wanted && wanted.preBufferMin != null && row.status === 'recording') throw plain('It has started recording, so only Finish late can change now. Nothing was changed.');
            if (!body) return null;
            await failing('The recording could not be changed.', () => API.request('PUT', `/recordings/scheduled/${st.rec.id}`, body));
            return 'Recording changed.';
        }
        const what = st.whats[st.what] || { kind: 'this' };
        if (what.kind === 'team') {
            // always a `team` rule (the team's games from the fixture), never a guide keyword
            const sport = this.teamSport(what, g);
            if (!sport) throw plain('PigTV doesn’t know this league’s sport, so every game of the team can’t be recorded.');
            await failing('The rule could not be added.', () => API.recordings.addRule({ kind: 'team', match: what.name, sport, ...pad }));
            return `Recording every ${what.name} game.`;
        }
        if (what.kind === 'league') {
            await failing('The rule could not be added.', () => API.recordings.addRule({ kind: 'sport', match: what.league, ...pad }));
            return `Recording every ${SportView.label(what.league, this.labels)} game.`;
        }
        // #347 (Codex sign-off, high): the chosen airing first; only a schedule of THAT airing is this recording
        const a = st.airings[st.index];
        if (!a) throw plain('Choose a channel to record on.');
        if (SportsPage.cancellingFor(g, a)) throw plain(SportsPage.CANCELLING);
        // Codex #327 (high): set to record meanwhile (another tab, person or rule)? Then the person's padding goes to that
        // recording (0662: never a second schedule); a list that cannot be read records nothing.
        const row = this.scheduleForAiring(g, a, await rows(SportsPage.UNCHECKED));
        if (row) {
            const body = SportsPage.change({ schedule: row, pre: st.pre, post: st.post });
            if (body) await failing('The recording could not be changed.', () => API.request('PUT', `/recordings/scheduled/${row.id}`, body));
            return body ? 'This game was already set to record, so your changes went to that recording.' : 'This game is already set to record.';
        }
        const c = a.c;
        const made = await failing('The recording could not be scheduled.', () => API.recordings.schedule({ sourceId: Number(c.sourceId), channelItemId: c.id,
            channelName: c.name, title: g.title, programStart: a.start, programEnd: a.end, ...pad, ...(SportsPage.gameIdOf(g) ? { gameId: SportsPage.gameIdOf(g) } : {}) }));
        const already = SportsPage.already(made);
        if (already) return already;
        const clash = Array.isArray(made?.conflictsWith) && made.conflictsWith.length;
        return clash ? `Set to record on ${c.name}. It clashes with ${made.conflictsWith.map(x => x.title || x).join(', ')}.` : `Set to record on ${c.name}: ${g.title}.`;
    }
}

/** #329: the words for a schedule answer that found the game already set to record (`alreadyScheduled`), else null. */
SportsPage.already = (made) => (made && made.alreadyScheduled
    ? (made.channel_name ? `Already set to record on ${made.channel_name}.` : 'Already set to record.') : null);

/** RecordPlan's Start early and Finish late, in minutes; null is the server's usual padding. */
SportsPage.HOLD_MS = 500; // D-65: touch and hold, as iOS's long press
SportsPage.START_EARLY = [null, 0, 1, 2, 5, 10];
SportsPage.FINISH_LATE = [null, 0, 2, 5, 10, 15, 30];
SportsPage.UNCHECKED = 'PigTV couldn’t check whether this game is already set to record, so nothing was recorded. Try again.';
SportsPage.CANCELLING = 'A recording of this is being cancelled. You can record it again once that has finished.';
SportsPage.GONE = 'This recording has finished or no longer exists, so it cannot be changed.';

/** The league pages built so far (#323 steps 3-5); a league whose page is not here shows no "Rounds and standings ›". */
SportsPage.PAGES = ['league', 'nfl', 'f1', 'cricket', 'events'];

if (typeof window !== 'undefined') window.SportsPage = SportsPage;
