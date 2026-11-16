/**
 * #57 (D-66): Search, from the magnifier in the top bar of every page. One window: the query on the left and the results
 * on the right on a wide window, one above the other on a narrow one. GET /api/library/search (C-Y) answers; results
 * are grouped Teams, Games, Programmes (LIVE / NEW and the episode), Channels, Recordings, each with its action:
 * Follow (a team, through C-U's PUT /sports/follows), Watch (on now), Record (a programme or a game, through the guide's
 * programme menu: Record, Record every episode, Options), Play (a recording, in the Recordings player).
 * Before anything is typed it shows this browser's recent searches (at most 8); a search with nothing in it says so.
 */
class SearchPanel {
    constructor(app) {
        this.app = app;
        this.dialog = null;
        this.answer = null;
        this.seq = 0;
        this.query = '';
        this.error = '';
    }

    // ---- recent searches (this browser only) ----

    static recent() {
        try {
            const list = JSON.parse(localStorage.getItem(SearchPanel.RECENT_KEY) || '[]');
            return Array.isArray(list) ? list.filter((q) => typeof q === 'string' && q.trim()).slice(0, SearchPanel.RECENT_MAX) : [];
        } catch (e) { return []; }
    }

    static remember(q) {
        const text = String(q || '').trim();
        if (text.length < SearchPanel.MIN_CHARS) return SearchPanel.recent();
        const list = [text, ...SearchPanel.recent().filter((x) => x.toLowerCase() !== text.toLowerCase())].slice(0, SearchPanel.RECENT_MAX);
        try { localStorage.setItem(SearchPanel.RECENT_KEY, JSON.stringify(list)); } catch (e) { /* private window: not kept */ }
        return list;
    }

    static forget() {
        try { localStorage.removeItem(SearchPanel.RECENT_KEY); } catch (e) { /* nothing kept */ }
    }

    // ---- the window ----

    open(opener) {
        if (this.dialog && this.dialog.isOpen()) { this.input?.focus(); return this.dialog; }
        const dialog = UI.dialog.create({ title: 'Search', className: 'search-window', onClose: () => { this.dialog = null; } });
        this.dialog = dialog;
        dialog.body.innerHTML = `
      <div class="search-layout">
        <div class="search-side">
          <label class="visually-hidden" for="global-search-input">Search</label>
          <div class="search-wrapper">
            <input type="search" id="global-search-input" class="search-input" autocomplete="off" enterkeyhint="search"
              placeholder="Teams, games, programmes, channels…" maxlength="${SearchPanel.MAX_CHARS}" autofocus>
          </div>
          <div id="global-search-recent" class="search-recent"></div>
        </div>
        <div id="global-search-results" class="search-results" aria-live="polite"></div>
      </div>`;
        this.input = dialog.body.querySelector('#global-search-input');
        this.resultsEl = dialog.body.querySelector('#global-search-results');
        this.recentEl = dialog.body.querySelector('#global-search-recent');
        this.input.value = this.query;
        this.input.addEventListener('input', () => this.searchSoon());
        this.input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            SearchPanel.remember(this.input.value);
            this.run(this.input.value);
        });
        dialog.body.addEventListener('click', (e) => this.onClick(e));
        dialog.open(opener);
        this.render();
        if (this.query.trim().length >= SearchPanel.MIN_CHARS) this.run(this.query);
        return dialog;
    }

    close() { if (this.dialog) this.dialog.close(); }

    searchSoon() {
        if (!this._soon) this._soon = UI.debounce(() => this.run(this.input ? this.input.value : ''), SearchPanel.PAUSE_MS);
        this.query = this.input ? this.input.value : '';
        if (this.query.trim().length < SearchPanel.MIN_CHARS) { this.seq++; this.answer = null; this.error = ''; this.render(); return; }
        this._soon();
    }

    /** Ask the server for `q`; an answer to an older question than the latest is dropped. */
    async run(q) {
        const text = String(q || '').trim();
        this.query = String(q || '');
        const seq = ++this.seq;
        if (text.length < SearchPanel.MIN_CHARS) { this.answer = null; this.error = ''; this.render(); return; }
        this.loading = true;
        this.render();
        let answer = null, error = '';
        try { answer = await API.library.search(text); } catch (err) { error = UI.errorText(err, 'Search did not answer. Try again.'); }
        if (seq !== this.seq) return;
        this.loading = false;
        this.answer = answer;
        this.error = error;
        this.render();
    }

    render() {
        if (this.recentEl) this.recentEl.innerHTML = this.query.trim().length >= SearchPanel.MIN_CHARS ? '' : this.recentHtml(SearchPanel.recent());
        if (this.resultsEl) this.resultsEl.innerHTML = this.resultsHtml();
    }

    recentHtml(list) {
        if (!list.length) return '';
        const items = list.map((q, i) => `<li><button type="button" class="search-recent-item" data-recent="${i}">${UI.escape(q)}</button></li>`).join('');
        return `<div class="search-recent-head"><h3 class="search-group-title">Recent searches</h3>`
            + `<button type="button" class="btn btn-ghost btn-sm" data-recent-clear>Clear</button></div><ul class="search-recent-list">${items}</ul>`;
    }

    /** The right-hand side: the hint before typing, the answer grouped, or why there is none. */
    resultsHtml() {
        const text = this.query.trim();
        if (text.length < SearchPanel.MIN_CHARS) {
            return UI.stateBlock('empty', 'Search for a team, a game, a programme, a channel or a recording.', null, { className: 'search-state' });
        }
        if (this.error) return UI.stateBlock('error', this.error, null, { className: 'search-state' });
        const a = this.answer;
        if (!a) return UI.stateBlock('loading', 'Searching…', null, { className: 'search-state' });
        const groups = [
            ['Teams', 'team', a.teams],
            ['Games', 'event', a.events],
            ['Programmes', 'programme', a.programmes],
            ['Channels', 'channel', a.channels],
            ['Recordings', 'recording', a.recordings]
        ].filter(([, , list]) => Array.isArray(list) && list.length);
        if (!groups.length) return UI.stateBlock('empty', `Nothing found for “${text}”`, null, { className: 'search-state' });
        return groups.map(([title, kind, list]) => `<section class="search-group" aria-label="${title}"><h3 class="search-group-title">${title}</h3>`
            + `<ul class="search-list">${list.map((item, i) => `<li class="search-hit">${this.hitHtml(kind, item, i)}</li>`).join('')}</ul></section>`).join('');
    }

    hitHtml(kind, item, i) {
        const now = Date.now();
        const e = UI.escape;
        const button = (action, label, primary) => `<button type="button" class="btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm" data-action="${action}" data-kind="${kind}" data-index="${i}">${label}</button>`;
        const logo = (src) => (src ? `<img class="search-hit-logo" src="${e(src)}" alt="" loading="lazy">` : '<span class="search-hit-logo" aria-hidden="true"></span>');
        const when = (start, end) => (start <= now && end > now ? `On now · until ${UI.clock(end)}` : UI.dateRange(start, end));
        const row = (image, title, meta, badges, actions) => `${image}<div class="search-hit-text"><p class="search-hit-title">${badges}${e(title)}</p>`
            + `${meta ? `<p class="search-hit-meta">${meta}</p>` : ''}</div><div class="search-hit-actions">${actions}</div>`;
        if (kind === 'team') {
            return row(logo(item.logo), item.name, e(item.league), '',
                item.followed ? '<span class="search-hit-note">Following</span>' : button('follow', 'Follow', true));
        }
        if (kind === 'event') {
            const ch = (item.channels || [])[0];
            const start = ch?.start ?? item.start, end = ch?.end ?? item.end;
            const onNow = start <= now && end > now;
            const meta = `${e(item.league || 'Sport')} · ${e(when(start, end))}${ch ? ` · ${e(ch.name)}` : ''}`;
            return row(logo(ch?.logo), item.title, meta, onNow ? SearchPanel.badge('live') : '',
                (onNow && ch ? button('watch', 'Watch', true) : '') + (ch ? button('record', 'Record', !onNow) : ''));
        }
        if (kind === 'programme') {
            const ch = item.channel || {};
            const onNow = item.start <= now && item.end > now;
            const badges = (item.live ? SearchPanel.badge('live') : '') + (item.new ? SearchPanel.badge('new') : '');
            const episode = [item.episode, item.subtitle].filter(Boolean).map(e).join(' · ');
            const meta = [episode, e(when(item.start, item.end)), e(ch.name || '')].filter(Boolean).join(' · ');
            return row(logo(item.image || ch.logo), item.title, meta, badges,
                (onNow ? button('watch', 'Watch', true) : '') + button('record', 'Record', !onNow));
        }
        if (kind === 'channel') {
            const meta = item.number !== null && item.number !== undefined ? `Channel ${e(item.number)}` : '';
            return row(logo(item.logo), item.name, meta, '', button('watch', 'Watch', true));
        }
        const status = item.status === 'recording' ? 'Recording now' : (item.started_at ? `Recorded ${UI.date(item.started_at)}` : 'Recorded');
        return row(logo(item.image || item.channel_logo), item.title, `${e(status)}${item.channel_name ? ` · ${e(item.channel_name)}` : ''}`,
            item.status === 'recording' ? SearchPanel.badge('rec') : '', button('play', 'Play', true));
    }

    static badge(kind) {
        const text = { live: 'LIVE', new: 'NEW', rec: 'REC' }[kind];
        return `<span class="search-badge search-badge-${kind}">${text}</span> `;
    }

    onClick(e) {
        const t = e.target;
        if (!t || !t.closest) return;
        const recent = t.closest('[data-recent]');
        if (recent) {
            const q = SearchPanel.recent()[Number(recent.getAttribute('data-recent'))];
            if (q && this.input) { this.input.value = q; this.run(q); }
            return;
        }
        if (t.closest('[data-recent-clear]')) { SearchPanel.forget(); this.render(); return; }
        const btn = t.closest('[data-action]');
        if (btn) this.act(btn.getAttribute('data-action'), btn.getAttribute('data-kind'), Number(btn.getAttribute('data-index')));
    }

    /** The item's list in the answer for a kind. */
    listOf(kind) {
        const a = this.answer || {};
        return { team: a.teams, event: a.events, programme: a.programmes, channel: a.channels, recording: a.recordings }[kind] || [];
    }

    async act(action, kind, index) {
        const item = this.listOf(kind)[index];
        if (!item) return;
        SearchPanel.remember(this.query);
        if (action === 'watch') {
            const ch = kind === 'channel' ? item : kind === 'event' ? (item.channels || [])[0] : item.channel;
            if (!ch) return;
            this.close();
            return this.app?.epgGuide?.playChannel(ch.name, ch.id, ch.sourceId);
        }
        if (action === 'record') return this.record(kind, item);
        if (action === 'follow') return this.follow(item);
        if (action === 'play') {
            this.close();
            return this.app?.pages?.recordings?.play(item.id, { watch: item.status === 'recording' && !!item.watch_live });
        }
    }

    /** The guide's programme menu for this airing (Record, Record every episode, the buffers), over this window. */
    async record(kind, item) {
        const guide = this.app?.epgGuide;
        if (!guide) return;
        const ch = kind === 'event' ? (item.channels || [])[0] : item.channel;
        if (!ch) return;
        const start = kind === 'event' ? (ch.start ?? item.start) : item.start;
        const end = kind === 'event' ? (ch.end ?? item.end) : item.end;
        await guide.loadSchedules();
        return guide.showProgramDetails({
            title: item.title || '', description: kind === 'programme' ? [item.episode, item.subtitle].filter(Boolean).join(' · ') : '',
            start: new Date(start).toISOString(), stop: new Date(end).toISOString(), recordable: String(end > Date.now()),
            sourceId: String(ch.sourceId), channelId: String(ch.id), channelName: ch.name || '', channelLogo: ch.logo || ''
        });
    }

    /** Follow a team: the account's follows (C-U) with this name added to its sport (and its league when not followed). */
    async follow(team) {
        try {
            const [catalog, follows] = await Promise.all([API.request('GET', '/sports/catalog'), API.request('GET', '/sports/follows')]);
            const sport = (catalog.sports || []).find((s) => (s.leagues || []).some((l) => (typeof l === 'string' ? l : l.league) === team.league));
            if (!sport) throw new Error(`${team.league} cannot be followed.`);
            const sports = (follows.sports || []).map((s) => ({ sport: s.sport, leagues: [...(s.leagues || [])], teams: [...(s.teams || [])] }));
            let entry = sports.find((s) => s.sport === sport.sport);
            if (!entry) { entry = { sport: sport.sport, leagues: [], teams: [] }; sports.push(entry); }
            if (!entry.leagues.includes(team.league)) entry.leagues.push(team.league);
            if (!entry.teams.some((n) => n.toLowerCase() === team.name.toLowerCase())) entry.teams.push(team.name);
            await API.request('PUT', '/sports/follows', { sports });
            team.followed = true;
            UI.toast(`Following ${team.name}`);
        } catch (err) {
            UI.toast(UI.errorText(err, `Could not follow ${team.name}.`), { kind: 'error' });
        }
        this.render();
    }
}

SearchPanel.MIN_CHARS = 2;
SearchPanel.MAX_CHARS = 100;
SearchPanel.PAUSE_MS = 250;
SearchPanel.RECENT_MAX = 8;
SearchPanel.RECENT_KEY = 'pigtvRecentSearches';

if (typeof window !== 'undefined') window.SearchPanel = SearchPanel;
