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
        // the details follow a new answer (its channels and recording); the record page keeps the person's choices
        if (this.window && this.window.kind === 'details') this.window.redraw();
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
        if (prev) prev.hidden = !(over && x > 1);
        if (next) next.hidden = !(over && x < max - 1);
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
            // #327: iOS's record page (More options…, Change recording) and the game's details
            case 'record-options': case 'change-recording': return this.openRecord(id, { opener: this.openerFor(el) });
            case 'details': return this.openDetails(id, this.openerFor(el));
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
        if (typeof id === 'string' && id.startsWith('fx:')) return this.fixtureById(id);
        if (typeof id === 'string' && (id.startsWith('f1s:') || id.startsWith('ck:'))) return this.pageGame(id);
        return this.front ? SportView.game(this.front, id) : null;
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
        return m ? SportView.cricketGame(m) : null;
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
     * A card pressed (iOS SportGamePress): Watch while its channel airs it (checked now, not when drawn); before or after
     * its airing the game's details; a game with no channel yet its menu (Record when it's listed); a result nothing.
     */
    select(id, anchor) {
        const g = this.game(id);
        if (!g) return undefined;
        const act = SportView.action(g, this.now());
        if (act === 'watch') return this.watch(id);
        if (act === 'remind' || act === 'details') return this.openDetails(id, anchor);
        if (SportView.terminal(g)) return undefined;
        return this.openMenu(g, anchor);
    }

    /** Play the game's best channel, found again in the channel list by its identity (never a stored position). */
    async watch(id, channelKey = null) {
        this.closeMenu();
        const g = this.game(id), ev = g && SportView.event(g);
        // a chosen channel is judged on its own airing (#327: a details row), the best channel on the game's action
        if (!ev || (!channelKey && SportView.action(g, this.now()) !== 'watch')) { UI.toast('This game isn’t on your channels right now.'); return; }
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
            await cl.selectChannel({ sourceId: match.sourceId, channelId: match.id });
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

    /** Record this game: its best channel's airing, with the usual padding, stopping when the game ends (gameId). */
    async record(id) {
        this.closeMenu();
        const g = this.game(id), ev = g && SportView.event(g);
        if (!ev || SportView.terminal(g)) return;
        try {
            const c = ev.channel;
            const made = await API.recordings.schedule({ sourceId: Number(c.sourceId), channelItemId: c.id, channelName: c.name,
                title: g.title, programStart: ev.start, programEnd: ev.end, ...(g.synthetic ? {} : { gameId: g.id }) });
            const clash = Array.isArray(made?.conflictsWith) && made.conflictsWith.length;
            UI.toast(clash ? `Set to record. It clashes with ${made.conflictsWith.map(x => x.title || x).join(', ')}.` : `Set to record: ${g.title}.`);
            this.refresh();
        } catch (err) {
            UI.toast(UI.errorText(err, 'The recording could not be scheduled.'), { kind: 'error' });
        }
    }

    // ---------- the game's menu: Apple's record menu (SportRecordMenu / ProgrammeMenu), a sheet on a phone ----------

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
        return (g.channels || []).filter(c => (Number.isFinite(c.start) ? c.start <= now : true) && (Number.isFinite(c.end) ? now < c.end : true));
    }
    /**
     * The items: Remind me before a game; "Watch on… (n channels)" when several channels show it now; RECORD: Record this
     * game (or Change recording when it is set), Record every <team> game, More options…; for a game the TV Guide does not
     * list yet, Record when it's listed (or Don't record it); on the front page, Make this the hero.
     */
    menuItems(g, { front = false } = {}) {
        const V = SportView, ev = V.event(g), now = this.now(), items = [], act = V.action(g, now), red = V.ICON.rec.replace('<svg', '<svg class="red"');
        if (act === 'remind') items.push({ act: 'remind', icon: V.ICON.bell, title: 'Remind me', detail: `Plays on ${ev.channel.name} at ${UI.clock(ev.start)}` });
        if (act === 'watch') {
            const on = this.channelsOnAir(g);
            if (on.length > 1) items.push({ act: 'watch-on', icon: V.ICON.channels, title: `Watch on… (${on.length} channels)`, detail: on.map(c => c.name).join(', '), expands: true });
            else items.push({ act: 'watch', icon: V.ICON.play, title: 'Watch', detail: ev.channel.name });
        }
        // #327: iOS's details: every channel airing it, each with Watch and Record
        if (ev && !V.terminal(g)) items.push({ act: 'details', icon: V.ICON.info, title: 'Details', detail: 'Every channel showing it, to watch or record' });
        if (ev && !V.terminal(g) && ev.end > now) {
            const r = g.recording;
            if (r && r.scheduleId != null && r.status) items.push({ act: 'change-recording', icon: red, title: 'Change recording', detail: r.status === 'recording' ? 'Recording now' : 'Recording scheduled', section: 'Record' });
            else items.push({ act: 'record', icon: red, title: 'Record this game', detail: `${UI.clock(ev.start)} – ${UI.clock(ev.end)}, with the usual padding`, section: 'Record' });
            const team = this.teamFor(g);
            if (team) items.push({ act: 'record-every', icon: V.ICON.repeat, title: `Record every ${team.name} game`, detail: 'Every game of the team, never replays', section: 'Record' });
            items.push({ act: 'record-options', icon: V.ICON.sliders, title: 'More options…', detail: 'Start early, finish late', section: 'Record' });
        } else if (!ev && !g.synthetic && g.status === 'scheduled' && (g.competitors || []).length === 2 && !g.recording && g.start > now) {
            // #234: a game the TV Guide does not list yet is recorded once it is
            if (g.recordWhenListed && g.recordWhenListed.ruleId != null) items.push({ act: 'unlisted-cancel', icon: red, title: 'Don’t record it', detail: 'It records when the TV Guide lists it', section: 'Record' });
            else items.push({ act: 'record-listed', icon: red, title: 'Record when it’s listed', detail: 'Not in the TV Guide yet', section: 'Record' });
        }
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
            html += `<button type="button" class="mi" role="menuitem" tabindex="-1" data-act="${e(it.act)}" data-id="${e(g.id)}"${it.expands ? ' aria-expanded="false"' : ''}>${it.icon}<span><b>${e(it.title)}</b><span>${e(it.detail)}</span></span></button>`;
            if (it.expands) html += `<div class="msub" hidden>${this.channelsOnAir(g).map(c => `<button type="button" class="mi" role="menuitem" tabindex="-1" data-act="watch-channel" data-id="${e(g.id)}" data-channel="${e(`${c.sourceId}:${c.stableId || c.id}`)}">${V.ICON.play}<span><b>${e(c.name)}</b>${c.quality ? `<span>${e(c.quality)}</span>` : ''}</span></button>`).join('')}</div>`;
        }
        if (!items.length) html += '<p class="mempty">Not on your channels yet.</p>';
        return html;
    }
    /** The menu for a game: under its card or button on a computer, a sheet from the bottom on a phone. */
    openMenu(g, anchor, opts = {}) {
        this.closeMenu();
        const sheet = this.phone;
        const menu = document.createElement('div');
        menu.className = `rmenu sp-menu${sheet ? ' sheet' : ''}`;
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', g.title);
        menu.innerHTML = (sheet ? '<div class="grab" aria-hidden="true"></div>' : '') + this.menuMarkup(g, { front: opts.front ?? !this.route.sport })
            + (sheet ? '<button type="button" class="pill cancel" data-act="menu-cancel">Cancel</button>' : '');
        let scrim = null;
        if (sheet) {
            scrim = document.createElement('div');
            scrim.className = 'sp-scrim';
            scrim.setAttribute('aria-hidden', 'true');
            document.body.appendChild(scrim);
        }
        document.body.appendChild(menu);
        const rows = () => [...menu.querySelectorAll('[role=menuitem]')].filter(r => !r.closest?.('[hidden]'));
        const close = (focus = true) => this.closeMenu(focus);
        menu.addEventListener('click', (e) => {
            const el = e.target?.closest?.('[data-act]');
            if (!el) return;
            const name = el.getAttribute('data-act');
            if (name === 'menu-cancel') { close(); return; }
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
        this.menu = { el: menu, scrim, anchor, key: anchor?.getAttribute?.('data-key') || null, gameId: g.id, outside };
        anchor?.setAttribute?.('aria-expanded', 'true');
        if (!sheet) this.placeMenu(opts.point);
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
        m.el.style.top = `${Math.round(Math.max(8, top))}px`;
    }
    closeMenu(focus = false) {
        const m = this.menu;
        if (!m) return;
        this.menu = null;
        document.removeEventListener('pointerdown', m.outside, true);
        m.el.remove();
        m.scrim?.remove();
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
            if (key) [...(d.el.querySelectorAll?.('[data-key]') || [])].find(n => n.getAttribute('data-key') === key)?.focus?.({ preventScroll: true });
        };
        d.el.addEventListener('click', (e) => {
            const el = e.target?.closest?.('[data-act]');
            if (!el || !d.el.contains(el) || el.disabled) return;
            act(el.getAttribute('data-act'), el, e);
        });
        // a logo that does not load becomes its monogram disc, as on the page
        d.el.addEventListener('error', (e) => this.badgeFallback(e), true);
        this.window = w;
        w.redraw();
        d.open(opener || undefined);
        return w;
    }

    // ----- the details (iOS SportEventDetails: a press on a game to come, or Details in its menu) -----

    /** The game's details: its kicker, times and state, Watch and Record, then every channel airing it, each with Watch and Record. */
    openDetails(id, opener = null) {
        const first = this.game(id);
        if (!first || !SportView.event(first)) return undefined;
        opener = opener || this.openerFor(null);
        this.closeMenu();
        let last = first;
        const current = () => (last = this.game(id) || last);
        const w = this.makeWindow({ kind: 'details', id, title: first.title, opener,
            draw: () => ({ body: this.detailsMarkup(current()) }),
            act: (name, el) => this.detailsAct(name, el, current()) });
        // the clock moves while it is open (TimelineView every 30 s): Watch, the times and the channels follow it
        const tick = () => { if (this.window !== w) return; w.redraw(); w.timer = setTimeout(tick, 30000); };
        w.timer = setTimeout(tick, 30000);
        return w;
    }
    detailsAct(name, el, g) {
        const key = el.getAttribute('data-channel');
        switch (name) {
            // Watch is decided again at the press (watch() checks the channel airs it now)
            case 'd-watch': this.closeWindow(); return this.watch(g.id);
            case 'd-watch-on': this.closeWindow(); return this.watch(g.id, key);
            case 'd-remind': this.closeWindow(); return this.remind(g.id);
            case 'd-unwait': if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting = null; } return this.window?.redraw();
            case 'd-record': this.closeWindow(); return this.openRecord(g.id);
            case 'd-record-on': this.closeWindow(); return this.openRecord(g.id, { channel: key });
            default: return undefined;
        }
    }
    /**
     * The details' content. Never a score, a result or a winner, whatever Hide scores says: only the game's title, league,
     * times and channels (#327: the hidden-scores rule holds for this window by construction).
     */
    detailsMarkup(g) {
        const V = SportView, e = V.e, ev = V.event(g), now = this.now(), P = SportsPage;
        if (!ev) return '<p class="sp-muted">Not on your channels yet.</p>';
        const best = ev.channel, live = ev.start <= now && now < ev.end, ended = ev.end <= now;
        const league = V.label(g.league, this.labels).toUpperCase(), rec = P.recordingOf(g);
        const kicker = live ? `LIVE · ${league}` : `${league} · ${P.day(ev.start, now).toUpperCase()}`;
        const when = live ? `ends in ${P.span(ev.end - now)}` : ended ? 'ended' : `starts in ${P.span(ev.start - now)}`;
        let html = `<div class="dk${live ? ' live' : ''}">${live ? V.dot() : ''}<span>${e(kicker)}</span></div>`
            + `<p class="dline pig-amount">${e(`${P.range(ev)} · ${when}${rec && !live ? ` · ${rec.word}` : ''}`)}</p>`;
        if (live) html += `<div class="dprog" aria-hidden="true"><i style="width:${Math.round(100 * Math.min(1, Math.max(0, (now - ev.start) / (ev.end - ev.start))))}%"></i></div>`;
        // Watch (or Watch when it starts, or Don't watch at …) and Record (Change recording when it is set)
        const pending = !!(this.waiting && this.waiting.id === g.id);
        let actions = '';
        if (pending) actions += `<button type="button" class="pill" data-act="d-unwait" data-key="d:watch">Don’t watch at ${e(UI.clock(ev.start))}</button>`;
        else if (ended) actions += '<button type="button" class="pill" disabled data-key="d:watch">Not on now</button>';
        else if (live) actions += `<button type="button" class="pill primary" data-act="d-watch" data-key="d:watch">${V.ICON.play}Watch ${e(best.name)}</button>`;
        else actions += `<button type="button" class="pill primary" data-act="d-remind" data-key="d:watch">${V.ICON.bell}Watch ${e(best.name)} when it starts</button>`;
        if (!V.terminal(g) && ev.end > now) actions += `<button type="button" class="pill" data-act="d-record" data-key="d:record">${V.ICON.rec}${rec ? 'Change recording' : 'Record'}</button>`;
        html += `<div class="dacts">${actions}</div>`;
        if (pending) html += `<p class="dnote">PigTV will start ${e(best.name)} at ${e(UI.clock(ev.start))} while Sport stays open.</p>`;
        const channels = g.channels || [];
        html += `<h3 class="dsec">${channels.length === 1 ? 'Channel' : 'Channels'}</h3><ul class="dchs">`;
        channels.forEach((c, i) => {
            const a = this.airing(g, c), on = a.start <= now && now < a.end, gone = a.end <= now, k = P.channelKey(c);
            const sub = [i === 0 && channels.length > 1 ? 'Recommended' : '', gone ? 'Not on now' : on || (a.start === ev.start && a.end === ev.end) ? '' : `${P.day(a.start, now)} ${P.range(a)}`].filter(Boolean);
            let btns = '';
            if (on) btns += `<button type="button" class="pill primary" data-act="d-watch-on" data-channel="${e(k)}" data-key="d:w:${e(k)}" aria-label="${e(`Watch on ${c.name}`)}">${V.ICON.play}Watch</button>`;
            if (!gone && !V.terminal(g)) btns += `<button type="button" class="pill" data-act="d-record-on" data-channel="${e(k)}" data-key="d:r:${e(k)}" aria-label="${e(`Record on ${c.name}`)}">${V.ICON.rec}Record</button>`;
            html += `<li class="dch"><span class="dct"><b>${e(c.name)}</b>${c.number != null ? ` <span class="num pig-amount">${e(c.number)}</span>` : ''}${c.quality ? ` <span class="qual">${e(c.quality)}</span>` : ''}${sub.length ? `<span class="dsub">${e(sub.join(' · '))}</span>` : ''}</span><span class="dca">${btns}</span></li>`;
        });
        return `${html}</ul>`;
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
        if (w.kind === 'team') return { title: `Every ${w.name} game`, detail: this.teamSport(w, st.g) ? 'Never replays' : 'Not available: PigTV doesn’t know this league’s sport' };
        const name = SportView.label(w.league, this.labels);
        return { title: (st.g.competitors || []).length === 2 ? `Every ${name} game` : `Everything in ${name}`, detail: 'On your channels, never replays' };
    }

    /**
     * The record page for a game, on `channel` (a details row's Record) or its best channel. A game already set to record
     * (C-R `recording`) opens as Change recording on that schedule (0662: its padding is changed with PUT, never a second
     * schedule), whichever channel was asked for.
     */
    openRecord(id, { channel = null, opener = null } = {}) {
        const g = this.game(id), ev = g && SportView.event(g);
        if (!ev || SportView.terminal(g)) return undefined;
        opener = opener || this.openerFor(null);
        this.closeMenu();
        const now = this.now();
        let airings = (g.channels || []).map(c => ({ c, key: SportsPage.channelKey(c), ...this.airing(g, c) })).filter(a => a.end > now);
        if (!airings.length) airings = [{ c: ev.channel, key: SportsPage.channelKey(ev.channel), start: ev.start, end: ev.end }];
        const rec = SportsPage.recordingOf(g);
        const st = { g, airings, index: Math.max(0, channel ? airings.findIndex(a => a.key === channel) : 0), what: 0, whats: rec ? [] : this.recordWhats(g),
            pre: null, post: null, schedule: null, rec, loaded: !rec, gone: false, busy: false, error: null };
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
                const at = st.airings.findIndex(x => x.key === `${row.source_id}:${row.channel_stable_id || row.channel_item_id}`);
                if (at >= 0) st.index = at;
                else if (row.channel_name && Number.isFinite(row.program_start) && Number.isFinite(row.program_end)) {
                    st.airings = [...st.airings, { c: { name: row.channel_name }, key: null, start: row.program_start, end: row.program_end }];
                    st.index = st.airings.length - 1;
                }
                st.pre = Number.isFinite(row.pre_buffer_min) ? row.pre_buffer_min : null;
                st.post = Number.isFinite(row.post_buffer_min) ? row.post_buffer_min : null;
            }
            st.loaded = true;
        } catch (err) {
            st.error = UI.errorText(err, 'The recording could not be read. Close this and try again.');
        }
        if (this.window === w) w.redraw();
    }
    /**
     * The game's active schedule in `GET /recordings/scheduled` rows: the one C-R names for it now, else one on any of its
     * channels (its identity) whose times overlap that channel's airing of the game. Rows do not carry the game's id.
     */
    scheduleOf(g, rows) {
        const active = (r) => r && ['scheduled', 'waiting', 'recording'].includes(r.status);
        const named = SportsPage.recordingOf(this.game(g.id) || g);
        const byId = named && rows.find(r => active(r) && r.id === named.id);
        if (byId) return byId;
        const airings = (g.channels || []).map(c => ({ keys: [SportsPage.channelKey(c), `${c.sourceId}:${c.id}`], ...this.airing(g, c) }));
        return rows.find(r => active(r) && airings.some(a => (a.keys.includes(`${r.source_id}:${r.channel_stable_id || r.channel_item_id}`) || a.keys.includes(`${r.source_id}:${r.channel_item_id}`))
            && r.program_start < a.end && r.program_end > a.start)) || null;
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
        const a = st.airings[st.index] || st.airings[0], leagueName = V.label(g.league, this.labels);
        const status = changing ? (st.gone ? 'ENDED' : P.statusWord(st.schedule ? st.schedule.status : st.rec.status).toUpperCase()) : null;
        const kicker = [changing ? 'CHANGE RECORDING' : 'RECORD', status, leagueName ? String(leagueName).toUpperCase() : null].filter(Boolean).join(' · ');
        const two = Array.isArray(g.competitors) && g.competitors.length === 2;
        let html = `<div class="rhead">${two ? `<span class="rbadges" aria-hidden="true">${g.competitors.map(c => V.badge(c.name, c.logo, 40, g.league)).join('')}</span>` : ''}`
            + `<span class="rht"><span class="rk">${e(kicker)}</span><span class="rmeta pig-amount">${e(`${P.day(a.start, now)} · ${P.range(a)} · ${a.c.name}`)}</span></span></div>`;
        // What: this game, or a rule (not on Change recording: it is one schedule)
        if (st.whats.length) {
            html += '<h3 class="rsec" id="sp-rec-what">What</h3><div class="rwhat" role="radiogroup" aria-labelledby="sp-rec-what">';
            st.whats.forEach((w, i) => {
                const l = this.whatLabel(w, st), on = i === st.what, off = w.kind === 'team' && !this.teamSport(w, g);
                html += `<button type="button" class="rchoice${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-act="r-what" data-index="${i}" data-key="r:what:${i}"${off ? ' disabled' : ''}><b>${e(l.title)}</b><span class="pig-amount">${e(l.detail)}</span></button>`;
            });
            html += '</div>';
        }
        // When it stops: with the game (ESPN) for a card's game or a schedule linked to one, else the guide's end
        const withGame = changing && st.schedule ? st.schedule.endsWith === 'event' : !g.synthetic;
        const end = UI.clock(a.end);
        const stop = withGame ? ['When the game ends (ESPN)', `Else the guide end, ${end}, + Finish late`] : ['When the guide says it ends', `${end} + Finish late`];
        html += `<h3 class="rsec">When it stops</h3><div class="rstop"><span class="rradio on" aria-hidden="true"></span><span class="rcht"><b>${e(stop[0])}</b><span class="pig-amount">${e(stop[1])}</span></span></div>`;
        const startLocked = changing && (!st.schedule || st.schedule.status === 'recording' || st.gone);
        const endLocked = changing && (!st.schedule || st.gone);
        const select = (id, title, options, value, locked) => `<label class="rrow" for="${id}"><span>${e(title)}</span><select id="${id}" data-key="r:${id}"${locked ? ' disabled' : ''}>`
            + options.map(m => `<option value="${m == null ? '' : m}"${m === value ? ' selected' : ''}>${e(P.chipTitle(m))}</option>`).join('') + '</select></label>';
        html += select('sp-rec-pre', 'Start early', P.chips(P.START_EARLY, st.schedule && st.schedule.pre_buffer_min, changing), st.pre, startLocked);
        html += select('sp-rec-post', 'Finish late', P.chips(P.FINISH_LATE, st.schedule && st.schedule.post_buffer_min, changing), st.post, endLocked);
        // Record on: when several channels carry it, each on its own airing
        if (!changing && st.airings.length > 1) {
            html += `<div class="rsech"><h3 class="rsec" id="sp-rec-on">Record on</h3><span>${st.airings.length} channels in your guide carry it</span></div><div class="ron" role="radiogroup" aria-labelledby="sp-rec-on">`;
            const first = st.airings[0];
            st.airings.forEach((x, i) => {
                const on = i === st.index, times = `${P.day(x.start, now)} ${P.range(x)}`;
                const detail = i === 0 ? `Best channel · ${times}` : x.start === first.start && x.end === first.end ? 'Same times' : times;
                html += `<button type="button" class="rchoice rch${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-act="r-on" data-index="${i}" data-key="r:on:${i}"><span class="rradio${on ? ' on' : ''}" aria-hidden="true"></span><span class="rcht"><b>${e(x.c.name)}</b><span class="pig-amount">${e(detail)}</span></span>${x.c.quality ? `<span class="qual">${e(x.c.quality)}</span>` : ''}</button>`;
            });
            html += '</div>';
        }
        // the note, then any error
        let note;
        if (changing) note = st.gone ? P.GONE : !st.schedule ? '' : st.schedule.status === 'recording' ? 'It is recording: only Finish late can change.' : 'Changes apply to this recording only.';
        else if (a.start <= now) note = 'It has started: only the rest of it is recorded.';
        else note = `If every provider connection is in use ${st.pre == null ? 'when it starts' : `at ${UI.clock(a.start - st.pre * 60000)}`}, the recording waits for one to free up.`;
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
        const primary = changing ? 'Save changes' : what && what.kind !== 'this' ? 'Record every game' : 'Record game';
        const off = st.busy || (changing && (!st.loaded || st.gone || !P.change(st)));
        const footer = [button(changing ? 'Close' : 'Cancel', 'btn btn-secondary', 'r-close', st.busy)];
        if (changing) footer.push(button((st.schedule ? st.schedule.status : st.rec.status) === 'recording' ? 'Stop recording' : 'Cancel recording', 'btn btn-danger', 'r-cancel', st.busy || st.gone));
        footer.push(button(primary, 'btn btn-primary', 'r-save', off));
        return { body: html, footer };
    }
    recordAct(name, el, st) {
        const w = this.window;
        switch (name) {
            case 'r-what': st.what = Number(el.getAttribute('data-index')) || 0; return w?.redraw();
            case 'r-on': st.index = Number(el.getAttribute('data-index')) || 0; return w?.redraw();
            case 'r-close': return this.closeWindow();
            case 'r-cancel': return this.cancelRecording(st);
            case 'r-save': return this.saveRecord(st, w);
            default: return undefined;
        }
    }
    /** Cancel recording (Stop recording): at once, with the 10 s Undo; the window closes first. */
    cancelRecording(st) {
        if (!st.rec || st.gone) return;
        const g = st.g, id = st.rec.id;
        this.closeWindow();
        UI.undoable(`Recording of ${g.title} cancelled.`, { undo: () => {}, failText: 'The recording could not be cancelled.',
            commit: ({ keepalive } = {}) => API.request('DELETE', `/recordings/scheduled/${id}`, null, { keepalive }).then(() => this.refresh()) });
    }
    /** The primary button: Save changes (PUT), a rule (C-M `team`, or `sport` for a league), or this game on the chosen channel. */
    async saveRecord(st, w) {
        if (st.busy) return;
        const g = st.g, pad = { ...(st.pre != null ? { preBufferMin: st.pre } : {}), ...(st.post != null ? { postBufferMin: st.post } : {}) };
        let toast = null, failText = 'The recording could not be scheduled.';
        if (st.rec) {
            failText = 'The recording could not be changed.';
            if (st.gone || !st.schedule) { st.error = SportsPage.GONE; w?.redraw(); return; }
            if (!SportsPage.change(st)) return;
        }
        st.busy = true; st.error = null; w?.redraw();
        try {
            if (st.rec) {
                await API.request('PUT', `/recordings/scheduled/${st.rec.id}`, SportsPage.change(st));
                toast = 'Recording changed.';
            } else {
                const what = st.whats[st.what] || { kind: 'this' };
                if (what.kind === 'team') {
                    // always a `team` rule (the team's games from the fixture), never a guide keyword
                    failText = 'The rule could not be added.';
                    const sport = this.teamSport(what, g);
                    if (!sport) { failText = 'PigTV doesn’t know this league’s sport, so every game of the team can’t be recorded.'; throw new Error('no sport'); }
                    await API.recordings.addRule({ kind: 'team', match: what.name, sport, ...pad });
                    toast = `Recording every ${what.name} game.`;
                } else if (what.kind === 'league') {
                    failText = 'The rule could not be added.';
                    await API.recordings.addRule({ kind: 'sport', match: what.league, ...pad });
                    toast = `Recording every ${SportView.label(what.league, this.labels)} game.`;
                } else {
                    // Codex #327 (high): set to record meanwhile (another tab, person or rule)? Then the person's padding goes
                    // to that recording (0662: never a second schedule); a list that cannot be read records nothing.
                    failText = SportsPage.UNCHECKED;
                    const rows = await API.request('GET', '/recordings/scheduled');
                    const row = this.scheduleOf(st.g, Array.isArray(rows) ? rows : []);
                    if (row) {
                        failText = 'The recording could not be changed.';
                        const body = SportsPage.change({ schedule: row, pre: st.pre, post: st.post });
                        if (body) await API.request('PUT', `/recordings/scheduled/${row.id}`, body);
                        toast = body ? 'This game was already set to record, so your changes went to that recording.' : 'This game is already set to record.';
                    } else {
                        failText = 'The recording could not be scheduled.';
                        const a = st.airings[st.index] || st.airings[0], c = a.c;
                        const made = await API.recordings.schedule({ sourceId: Number(c.sourceId), channelItemId: c.id, channelName: c.name, title: g.title,
                            programStart: a.start, programEnd: a.end, ...pad, ...(g.synthetic ? {} : { gameId: g.id }) });
                        const clash = Array.isArray(made?.conflictsWith) && made.conflictsWith.length;
                        toast = clash ? `Set to record on ${c.name}. It clashes with ${made.conflictsWith.map(x => x.title || x).join(', ')}.` : `Set to record on ${c.name}: ${g.title}.`;
                    }
                }
            }
        } catch (err) {
            // a list that could not be read says so in plain words (the server's own error text is for the others)
            st.error = failText === SportsPage.UNCHECKED ? failText : UI.errorText(err, failText);
        }
        st.busy = false;
        if (toast) {
            if (this.window === w) this.closeWindow();
            UI.toast(toast);
            this.refresh();
        } else if (this.window === w) w.redraw();
    }
}

/** RecordPlan's Start early and Finish late, in minutes; null is the server's usual padding. */
SportsPage.START_EARLY = [null, 0, 1, 2, 5, 10];
SportsPage.FINISH_LATE = [null, 0, 2, 5, 10, 15, 30];
SportsPage.UNCHECKED = 'PigTV couldn’t check whether this game is already set to record, so nothing was recorded. Try again.';
SportsPage.GONE = 'This recording has finished or no longer exists, so it cannot be changed.';

/** The league pages built so far (#323 steps 3-5); a league whose page is not here shows no "Rounds and standings ›". */
SportsPage.PAGES = ['league', 'nfl', 'f1', 'cricket', 'events'];

if (typeof window !== 'undefined') window.SportsPage = SportsPage;
