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
        this.labels = {}; this.labelsLoaded = false;
        this.heroId = null; this.selectedFollowKey = null; this.pinned = null;
        this.f1Map = null; this.f1Asked = false;
        this.timer = null; this.waiting = null; this.watchCancelled = false;
        this.menu = null;
        this.path = '';
        this.phoneQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 768px)') : null;
        this.phoneQuery?.addEventListener?.('change', () => this.render());
        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', () => {
                if (!this.active) return;
                if (document.hidden) clearTimeout(this.timer);
                else { this.prefs.known = false; this.refresh(); }
            });
        }
        if (this.root) this.wire(this.root);
    }

    // ---------- the address (#sports, #sports/...) ----------

    /** Sport is a page with places in it: the app hands every visit, Back and the nav link to openPath. */
    get opensRoot() { return true; }
    titleParts() { return []; }

    async show(sub) {
        this.active = true;
        this.path = sub || '';
        this.prefs.known = false; // Apple 90: the choice is forgotten until it is read again
        if (this.watchCancelled) { this.watchCancelled = false; UI.toast('Remind me was cancelled because Sport was closed.'); }
        this.render();
        await this.refresh();
    }
    hide() {
        this.active = false;
        clearTimeout(this.timer); this.timer = null;
        if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting = null; this.watchCancelled = true; }
        this.closeMenu();
        this.serial++;
    }
    openPath(sub, history = 'none') {
        const path = sub || '';
        if (history === 'push') this.app?.setLocation?.('sports', path || undefined, 'push');
        this.path = path;
        this.closeMenu();
        this.render();
    }
    /** A place in Sport: a new history entry, so Back returns. */
    go(path) { this.openPath(path, 'push'); }

    // ---------- data ----------

    get phone() { return !!this.phoneQuery?.matches; }
    get hidden() { return SportView.hidden({ known: this.prefs.known, preference: this.prefs.spoilerFree, answer: this.front?.spoilerFree === true }); }
    /** The server's now, moved on by the time since its answer came. */
    now() { return this.front ? this.front.now + Math.max(0, Date.now() - this.received) : Date.now(); }

    /** The account's choice, then the answer (drawn only after it). A failed read leaves the choice unknown: hidden. */
    async refresh() {
        if (!this.active) return;
        clearTimeout(this.timer);
        const serial = ++this.serial;
        try {
            const prefs = await API.request('GET', '/sports/pages/preferences');
            if (serial !== this.serial) return;
            this.prefs = { known: typeof prefs?.spoilerFree === 'boolean', spoilerFree: prefs?.spoilerFree !== false };
        } catch {
            if (serial !== this.serial) return;
            this.prefs = { known: false, spoilerFree: true };
        }
        this.loadLabels();
        try {
            const answer = await API.request('GET', '/sports/front');
            if (serial !== this.serial || !this.active) return;
            if (!answer || typeof answer !== 'object') throw new Error('Invalid sport answer');
            this.apply(answer);
            this.failed = false; this.stale = false; this.updatedAt = Date.now();
        } catch (err) {
            if (serial !== this.serial || !this.active) return;
            console.warn('Sport could not be loaded:', err && err.message);
            if (this.front) this.stale = true; else this.failed = true;
        }
        this.loaded = true;
        this.loadMap();
        this.render();
        this.schedule();
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
            const labels = {};
            for (const s of catalog?.sports || []) for (const l of s.leagues || []) if (l && l.league && l.label) labels[l.league] = l.label;
            this.labels = labels;
            this.render();
        } catch { this.labelsLoaded = false; }
    }
    /** The circuit map behind a race hero (C-P `info.map`), asked once. */
    async loadMap() {
        const g = SportView.game(this.front || {}, this.heroId);
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
            heroId: this.heroId, followIndex: this.followIndex, map: this.f1Map, stale: this.stale, staleSince: this.updatedAt };
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
        if (focusKey) [...(this.root.querySelectorAll?.('[data-key]') || [])].find(n => n.getAttribute('data-key') === focusKey)?.focus?.({ preventScroll: true });
    }

    /** The markup for what is shown now: the header, then the state block or the page. */
    markup() {
        const V = SportView, now = this.now(), hide = this.hidden;
        const head = V.header({ title: 'Sport', now, hide });
        let body;
        if (!this.loaded && !this.front) body = '<div class="sp-state" id="sp-state" data-state="loading"></div>';
        else if (this.failed && !this.front) body = '<div class="sp-state" id="sp-state" data-state="error"></div>';
        else if (this.front && V.isEmpty(this.front)) body = (this.front.scores === 'unavailable' ? V.scoresNote() : '') + '<div class="sp-state" id="sp-state" data-state="empty"></div>';
        else body = V.front(this.context());
        return `<div class="sp${this.phone ? ' is-phone' : ''}">${head}${body}</div>`;
    }

    /** The state block (UI.setState): loading, the error with Try again, or nothing followed. */
    bindState() {
        const box = this.root.querySelector?.('.sp-state');
        if (!box) return;
        const kind = box.getAttribute('data-state');
        if (kind === 'loading') UI.setState(box, 'loading', 'Loading…');
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

    // ---------- events (one listener each on the page; the markup carries data-act) ----------

    wire(root) {
        root.addEventListener('click', (e) => {
            const el = e.target?.closest?.('[data-act]');
            if (!el || !root.contains(el)) return;
            this.act(el.getAttribute('data-act'), el, e);
        });
        // A logo that does not load becomes its monogram disc.
        root.addEventListener('error', (e) => {
            const img = e.target;
            if (!img || img.tagName !== 'IMG' || !img.classList?.contains('badge')) return;
            const disc = document.createElement('span');
            disc.className = 'disc'; disc.setAttribute('aria-hidden', 'true');
            disc.style.cssText = img.style.cssText;
            disc.textContent = img.getAttribute('data-mono') || '';
            img.replaceWith(disc);
        }, true);
        // The carousel's dots follow the card in view.
        root.addEventListener('scroll', (e) => {
            const c = e.target;
            if (!c?.getAttribute || !c.getAttribute('data-carousel')) return;
            const cards = [...c.children], width = cards[0] ? cards[0].offsetWidth + 12 : 1;
            const at = Math.max(0, Math.min(cards.length - 1, Math.round(c.scrollLeft / width)));
            cards.forEach((card, i) => card.classList.toggle('dim', i !== at));
            const d = c.nextElementSibling;
            if (d && d.classList.contains('dots')) d.outerHTML = SportView.dots(cards.length, at);
        }, true);
    }

    act(name, el, ev) {
        const id = el.getAttribute('data-id');
        switch (name) {
            case 'game': return this.select(id, el);
            case 'watch': return this.watch(id);
            case 'remind': return this.remind(id);
            case 'record': return this.record(id);
            case 'follow': return this.selectFollow(Number(el.getAttribute('data-index')));
            case 'retry': return this.refresh();
            case 'back': return typeof history !== 'undefined' && history.length > 1 ? history.back() : this.go('');
            default: return undefined;
        }
    }
    game(id) { return this.front ? SportView.game(this.front, id) : null; }

    /** A card pressed: Watch while its channel airs it (checked now, not when drawn), else its menu. */
    select(id, anchor) {
        const g = this.game(id);
        if (!g) return;
        if (SportView.action(g, this.now()) === 'watch') return this.watch(id);
        if (SportView.terminal(g)) return;
        this.openMenu(g, anchor);
    }

    /** Play the game's best channel, found again in the channel list by its identity (never a stored position). */
    async watch(id) {
        this.closeMenu();
        const g = this.game(id), ev = g && SportView.event(g);
        if (!ev || SportView.action(g, this.now()) !== 'watch') { UI.toast('This game isn’t on your channels right now.'); return; }
        try {
            const cl = this.app.channelList;
            await cl.loadSources(); await cl.loadChannels();
            const key = (c) => `${c.sourceId}:${c.stableId || c.id}`;
            const match = cl.channels.find(c => key(c) === key(ev.channel));
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
        if (ev.start - this.now() <= 60000) { this.watch(id); return; }
        if (this.waiting) clearTimeout(this.waiting.timer);
        const fire = async () => {
            if (!this.active) return;
            await this.refresh();
            const fresh = this.game(id), at = fresh && SportView.event(fresh);
            if (!at) { this.waiting = null; UI.toast(`${g.title} is no longer on your channels.`); return; }
            if (at.start > this.now()) { this.waiting.timer = setTimeout(fire, Math.max(1000, at.start - this.now())); return; }
            this.waiting = null;
            this.watch(id);
        };
        this.waiting = { id, timer: setTimeout(fire, Math.max(0, ev.start - this.now())) };
        UI.toast(`${g.title} plays on ${ev.channel.name} at ${UI.clock(ev.start)}. Keep Sport open.`,
            { action: { label: 'Cancel', run: () => { if (this.waiting) clearTimeout(this.waiting.timer); this.waiting = null; } } });
    }

    /** Record this game: its best channel's airing, with the usual padding, stopping when the game ends (gameId). */
    async record(id) {
        this.closeMenu();
        const g = this.game(id), ev = g && SportView.event(g);
        if (!ev || SportView.terminal(g)) return;
        try {
            const c = ev.channel;
            const made = await API.recordings.schedule({ sourceId: Number(c.sourceId), channelItemId: c.id, channelName: c.name,
                title: g.title, programStart: ev.start, programEnd: ev.end, gameId: g.id });
            const clash = Array.isArray(made?.conflictsWith) && made.conflictsWith.length;
            UI.toast(clash ? `Set to record. It clashes with ${made.conflictsWith.map(x => x.title || x).join(', ')}.` : `Set to record: ${g.title}.`);
            this.refresh();
        } catch (err) {
            UI.toast(UI.errorText(err, 'The recording could not be scheduled.'), { kind: 'error' });
        }
    }

    // ---------- the game's menu (a card that is not on now) ----------

    menuItems(g) {
        const ev = SportView.event(g), now = this.now(), items = [];
        const act = SportView.action(g, now);
        if (act === 'watch') items.push({ act: 'watch', icon: SportView.ICON.play, title: 'Watch', detail: ev.channel.name });
        if (act === 'remind') items.push({ act: 'remind', icon: SportView.ICON.bell, title: 'Remind me', detail: `Plays on ${ev.channel.name} at ${UI.clock(ev.start)}` });
        if (ev && !SportView.terminal(g)) items.push({ act: 'record', icon: SportView.ICON.rec.replace('<svg', '<svg class="red"'), title: 'Record this game', detail: `${UI.clock(ev.start)} – ${UI.clock(ev.end)}, with the usual padding`, section: 'Record' });
        return items;
    }
    menuMarkup(g) {
        const V = SportView, e = V.e, ev = V.event(g), items = this.menuItems(g);
        const sub = ev ? `${ev.channel.name} · ${UI.clock(ev.start)} – ${UI.clock(ev.end)}` : V.channelLine(g) || 'No TV listing found';
        let html = `<div class="mh"><b>${e(g.title)}</b><span>${e(sub)}</span></div>`;
        let section = null;
        for (const it of items) {
            if (it.section && it.section !== section) { section = it.section; html += `<div class="mdiv" role="separator"></div><div class="ms" aria-hidden="true">${e(section)}</div>`; }
            html += `<button type="button" class="mi" role="menuitem" tabindex="-1" data-act="${e(it.act)}" data-id="${e(g.id)}">${it.icon}<span><b>${e(it.title)}</b><span>${e(it.detail)}</span></span></button>`;
        }
        if (!items.length) html += '<p class="mempty">Not on your channels yet.</p>';
        return html;
    }
    openMenu(g, anchor) {
        this.closeMenu();
        const menu = document.createElement('div');
        menu.className = 'rmenu sp-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', g.title);
        menu.innerHTML = this.menuMarkup(g);
        document.body.appendChild(menu);
        const rows = () => [...menu.querySelectorAll('[role=menuitem]')];
        const close = (focus = true) => this.closeMenu(focus);
        menu.addEventListener('click', (e) => {
            const el = e.target?.closest?.('[data-act]');
            if (el) this.act(el.getAttribute('data-act'), el, e);
        });
        menu.addEventListener('keydown', (e) => {
            const list = rows(), i = list.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
            else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
            else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
            else if (e.key === 'Tab') close(false);
        });
        const outside = (e) => { if (!menu.contains(e.target) && !anchor?.contains?.(e.target)) close(false); };
        document.addEventListener('pointerdown', outside, true);
        this.menu = { el: menu, anchor, gameId: g.id, outside };
        anchor?.setAttribute?.('aria-expanded', 'true');
        this.placeMenu();
        (rows()[0] || menu).focus?.();
    }
    placeMenu() {
        const m = this.menu;
        if (!m || !m.anchor?.getBoundingClientRect) return;
        const b = m.anchor.getBoundingClientRect(), r = m.el.getBoundingClientRect ? m.el.getBoundingClientRect() : { width: 360, height: 0 };
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024, vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
        const w = r.width || 360, h = r.height || 0;
        const left = Math.max(8, Math.min(b.left, vw - w - 8));
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
        m.anchor?.setAttribute?.('aria-expanded', 'false');
        if (focus && m.anchor?.isConnected !== false) m.anchor?.focus?.();
    }
}

if (typeof window !== 'undefined') window.SportsPage = SportsPage;
