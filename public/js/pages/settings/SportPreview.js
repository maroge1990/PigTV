/**
 * Settings › Sport (admin): the leagues followed and what the server recognises as sport (0149, 0151). What one account follows is SportSettings.js.
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
    // ---- Sports tab (0149, contract C-I) --------------------------------
    //
    // The leagues that count as sport (GET /api/sports/follow: since D-42 the leagues any account follows, read-only; the
    // admin keyword list is retired) and, below, the events the server recognises in the next 72 hours (GET
    // /api/sports/preview) with the rule that matched and the channels (expandable). 0151: the preview is grouped by kind
    // (0150): Events, then Replays, then Shows and Placeholders collapsed (a click on the heading opens one); each row
    // says why it is that kind and lists the guide titles merged into it.

    initSports() {
        this.sportsKeywords = [];
        this.sportsEvents = [];
        this.sportsOpenKinds = new Set(['event', 'replay']);
        document.getElementById('sports-preview-list')?.addEventListener('click', (e) => {
            const button = e.target?.closest?.('button[data-sports-kind]');
            if (button) this.toggleSportsKind(button.dataset.sportsKind);
        });
    },

    toggleSportsKind(kind) {
        if (this.sportsOpenKinds.has(kind)) this.sportsOpenKinds.delete(kind);
        else this.sportsOpenKinds.add(kind);
        this.renderSportsPreview();
    },

    setSportsStatus(text, isError = false) {
        const status = document.getElementById('sports-status');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('error', isError);
    },

    async loadSports() {
        try {
            const follow = await API.sports.follow();
            this.sportsKeywords = [...(follow?.keywords || [])];
            this.renderSportsFollow();
        } catch (err) {
            console.error('Followed leagues failed to load:', err);
            UI.setState(document.getElementById('sports-follow-chips'), 'error', 'The followed leagues could not be loaded.', { run: () => this.loadSports() });
        }
        await this.loadSportsPreview();
    },

    async loadSportsPreview() {
        const list = document.getElementById('sports-preview-list');
        try {
            const preview = await API.sports.preview();
            this.sportsEvents = preview?.events || [];
            this.renderSportsPreview();
        } catch (err) {
            console.error('Sport preview failed to load:', err);
            UI.setState(list, 'error', 'The sport preview could not be loaded.', { run: () => this.loadSportsPreview() }, { colspan: 5 });
        }
    },

    renderSportsFollow() {
        const e = (v) => UI.escape(v);
        const chips = document.getElementById('sports-follow-chips');
        if (chips) {
            chips.innerHTML = this.sportsKeywords.length
                ? this.sportsKeywords.map(k => `<span class="btn btn-secondary epg-candidate sports-chip">${e(k)}</span>`).join('')
                : UI.stateBlock('empty', { title: 'No account follows a league yet', detail: 'Each account chooses its own under Your sport, above.' });
        }
    },

    sportsTime(ev) {
        return UI.dateRange(ev.start, ev.end);
    },

    renderSportsPreview() {
        const e = (v) => UI.escape(v);
        const list = document.getElementById('sports-preview-list');
        if (!list) return;
        if (this.sportsEvents.length === 0) {
            UI.setState(list, 'empty', 'No sport recognised in the next 72 hours', null, { colspan: 5 });
            return;
        }
        const rules = { keyword: 'Keyword', category: 'Guide category', sportChannel: 'Sport category, live title' };
        const groups = [['event', 'Events'], ['replay', 'Replays'], ['show', 'Shows'], ['placeholder', 'Placeholders']];
        const row = (ev) => {
            const n = (ev.channels || []).length;
            const names = (ev.channels || []).map(c => `<li>${c.number ? `${e(c.number)} ` : ''}${e(c.name)}${c.quality ? ` <span class="setting-hint">${e(c.quality)}</span>` : ''}</li>`).join('');
            const aliases = (ev.aliases || []).filter(a => a !== ev.title);
            const titles = aliases.length
                ? `<details class="sports-aliases"><summary><span class="pig-amount">${aliases.length}</span> guide title${aliases.length === 1 ? '' : 's'}</summary><ul class="sports-channel-list">${aliases.map(a => `<li>${e(a)}</li>`).join('')}</ul></details>`
                : '';
            return `
                <tr class="sports-event-row">
                    <td><span class="pig-amount">${e(this.sportsTime(ev))}</span>${ev.live ? ' <span class="status-event status-failure">Live</span>' : ''}</td>
                    <td>${e(ev.title)}${titles}</td>
                    <td>${e(ev.league)}</td>
                    <td>${e(rules[ev.rule] || ev.rule || '–')}${ev.match ? `<div class="setting-hint">${e(ev.match)}</div>` : ''}${ev.kindRule ? `<div class="setting-hint">${e(ev.kindRule)}</div>` : ''}</td>
                    <td><details><summary><span class="pig-amount">${n}</span> channel${n === 1 ? '' : 's'}</summary><ul class="sports-channel-list">${names}</ul></details></td>
                </tr>`;
        };
        list.innerHTML = groups.map(([kind, label]) => {
            const items = this.sportsEvents.filter(ev => (ev.kind || 'event') === kind);
            if (!items.length) return '';
            const open = this.sportsOpenKinds.has(kind);
            return `
                <tr class="sports-kind-row"><th colspan="5">
                    <button type="button" class="sports-kind-toggle" data-sports-kind="${kind}" aria-expanded="${open}">${open ? '▾' : '▸'} ${label} (${items.length})</button>
                </th></tr>${open ? items.map(row).join('') : ''}`;
        }).join('');
    },
});
