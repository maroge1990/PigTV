/**
 * Settings -> Providers (0172, multi-provider brief 2.9; one section since 0182). Admin only.
 *
 * One card per provider, every card the same: its account as the provider reports it (status,
 * expiry, connections), its sync state, and one form (name, login or playlist address, guide
 * address, channel ID list). The order of the cards is the whole of the roles: the first is
 * the primary, whose channels and guide are shown; the rest are backups tried in that order.
 * Uses GET /api/sources/providers, /api/sources/status, /api/sources/:id (the form),
 * /api/sources/:id/account (and POST .../account/check), POST/PUT/DELETE /api/sources,
 * PUT /api/sources/order, POST .../sync, .../toggle, .../test.
 *
 * ProviderFormat holds the pure helpers (tested without a DOM).
 */

const ProviderFormat = {
    esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    },

    /** Server text is client-safe already; this is belt and braces so no address or login is ever shown. */
    safeText(value) {
        return String(value ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]');
    },

    DAYS: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],

    /** "Tue 30 Mar 2027", in local time (the account's end is an instant). */
    formatDate(ms) {
        const d = new Date(ms);
        return `${ProviderFormat.DAYS[d.getDay()]} ${d.getDate()} ${ProviderFormat.MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    },

    /** { text, level } for the expiry the account reports: "Tue 30 Mar 2027" (+ " · 5 days left" / " · expired"). */
    formatExpiry(effective, now = Date.now()) {
        const at = effective?.expiresAt;
        if (!Number.isFinite(at)) return { text: 'Not reported by the provider', level: 'none' };
        const text = ProviderFormat.formatDate(at);
        const days = Math.ceil((at - now) / 86400000);
        if (at < now) return { text: `${text} · expired`, level: 'expired' };
        if (days <= 7) return { text: `${text} · ${days} day${days === 1 ? '' : 's'} left`, level: 'soon' };
        return { text, level: 'ok' };
    },

    /** "1 of 2 in use", or "limit 1 (assumed)" when the account does not say. */
    formatConnections(account, effective) {
        const limit = effective?.limit ?? 1;
        const known = Number.isInteger(account?.maxConnections) && account.maxConnections > 0;
        if (account && Number.isInteger(account.activeCons)) return `${account.activeCons} of ${limit} in use${known ? '' : ' (limit assumed)'}`;
        return `limit ${limit}${known ? '' : ' (assumed)'}`;
    },

    /** "5 minutes ago", "3 hours ago", else the date. */
    ago(ms, now = Date.now()) {
        if (!Number.isFinite(ms)) return 'never';
        const mins = Math.floor((now - ms) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
        const days = Math.floor(hours / 24);
        return `${days} day${days === 1 ? '' : 's'} ago`;
    },

    /** The sync_status row of a source ('all'), as { text, level }. */
    formatSync(row, now = Date.now()) {
        if (!row) return { text: 'Not synced yet', level: 'none' };
        if (row.status === 'syncing') return { text: 'Syncing...', level: 'busy' };
        if (row.status === 'error') {
            return { text: `Failed ${ProviderFormat.ago(row.last_sync, now)}${row.error ? `: ${ProviderFormat.safeText(row.error)}` : ''}`, level: 'error' };
        }
        return { text: `Synced ${ProviderFormat.ago(row.last_sync, now)}`, level: 'ok' };
    },

    roleLabel(provider, backupIndex) {
        return provider.role === 'backup' ? `Backup ${backupIndex}` : 'Primary';
    },

    /** Primary first, then backups by priority (empty last) then id. */
    order(list) {
        const rank = p => (p.role === 'backup' ? 1 : 0);
        return [...list].sort((a, b) => rank(a) - rank(b)
            || (a.role === 'backup' ? (a.priority ?? 999) - (b.priority ?? 999) : 0) || a.id - b.id);
    },

    /** The ids in card order after moving one card up (-1) or down (+1); null when it cannot move. */
    moved(list, id, direction) {
        const ids = ProviderFormat.order(list).map(p => p.id);
        const from = ids.indexOf(id);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= ids.length) return null;
        [ids[from], ids[to]] = [ids[to], ids[from]];
        return ids;
    },

    /**
     * The request body for a card's form: everything for a new provider, only what changed for
     * an existing one (`saved` = GET /api/sources/:id). An empty password keeps the saved one.
     * Returns { body } or { error } (a plain sentence).
     */
    buildSave(saved, values) {
        const v = (k) => String(values[k] ?? '').trim();
        const type = saved ? saved.type : v('type');
        if (!v('name')) return { error: 'Give the provider a name' };
        if (!v('url')) return { error: type === 'xtream' ? 'Enter the server address' : 'Enter the playlist address' };
        if (!saved) {
            if (type === 'xtream' && (!v('username') || !v('password'))) return { error: 'Enter the username and password' };
            const body = { type, name: v('name'), url: v('url') };
            if (type === 'xtream') { body.username = v('username'); body.password = v('password'); }
            if (v('epgUrl')) body.epgUrl = v('epgUrl');
            if (v('idOverlayUrl')) body.idOverlayUrl = v('idOverlayUrl');
            return { body };
        }
        const body = {};
        for (const k of ['name', 'url']) if (v(k) !== String(saved[k] ?? '')) body[k] = v(k);
        if (type === 'xtream') {
            if (v('username') !== String(saved.username ?? '')) body.username = v('username');
            if (v('password')) body.password = v('password');
        }
        for (const k of ['epgUrl', 'idOverlayUrl']) if (v(k) !== String(saved[k] ?? '')) body[k] = v(k);
        return { body };
    }
};

class ProvidersSettings {
    constructor() {
        this.providers = [];
        this.guides = [];            // standalone EPG sources left from before 0182
        this.accounts = new Map();   // id -> { account, effective }
        this.syncRows = new Map();   // id -> { all, epg } sync_status rows
        this.polls = new Map();      // id -> polls left while a sync runs
        this.open = new Map();       // id (or 'new') -> the saved source the open form edits (null for new)
        this.token = 0;
        const tab = document.getElementById('tab-providers');
        tab?.addEventListener('click', (e) => {
            const button = e.target?.closest?.('button[data-provider-action]');
            if (button) this.act(button.dataset.providerAction, button.dataset.id, button);
        });
        tab?.addEventListener('change', (e) => {
            if (e.target?.matches?.('[data-field="type"]')) this.syncTypeFields(e.target.closest('.provider-card'));
        });
    }

    setStatus(text, isError = false) {
        const status = document.getElementById('providers-status');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('error', isError);
    }

    setSyncRows(statuses) {
        this.syncRows = new Map();
        for (const r of Array.isArray(statuses) ? statuses : []) {
            if (r.type !== 'all' && r.type !== 'epg') continue;
            const entry = this.syncRows.get(r.source_id) || {};
            entry[r.type] = r;
            this.syncRows.set(r.source_id, entry);
        }
    }

    async load() {
        const mine = ++this.token;
        const list = document.getElementById('providers-list');
        try {
            const [providers, statuses, all] = await Promise.all([
                API.sources.providers(),
                API.sources.getStatus().catch(() => []),
                API.sources.getAll().catch(() => [])
            ]);
            if (mine !== this.token) return;
            this.providers = Array.isArray(providers) ? providers : [];
            this.guides = (Array.isArray(all) ? all : []).filter(s => s.type === 'epg');
            this.setSyncRows(statuses);
            const accounts = await Promise.all(this.providers.map(p => API.sources.account(p.id).catch(() => null)));
            if (mine !== this.token) return;
            this.accounts = new Map(this.providers.map((p, i) => [p.id, accounts[i]]));
            this.render();
        } catch (err) {
            if (list) list.innerHTML = `<p class="hint">Could not load the providers: ${ProviderFormat.esc(err.message)}</p>`;
        }
    }

    guideFact(p) {
        const F = ProviderFormat;
        if (p.role === 'backup') return p.hasEpg ? 'Saved; used when this provider is first' : 'None';
        const row = (this.syncRows.get(p.id) || {}).epg;
        if (!row) return p.hasEpg || p.type === 'xtream' ? 'Not synced yet' : 'None: add a guide address';
        const sync = F.formatSync(row);
        return `<span class="provider-${sync.level}">${F.esc(sync.text)}</span>${p.hasEpg ? '' : ' · the provider\'s own'}`;
    }

    infoHtml(p) {
        const F = ProviderFormat;
        const e = F.esc;
        const detail = this.accounts.get(p.id) || {};
        const account = detail.account || null;
        const effective = detail.effective || {};
        const expiry = F.formatExpiry(effective);
        const sync = F.formatSync((this.syncRows.get(p.id) || {}).all);
        const rows = [];
        rows.push(['Account', account
            ? `${e(account.status || 'Unknown')}${account.isTrial ? ' (trial)' : ''} · checked ${e(F.ago(account.checkedAt))}`
            : 'Not read yet']);
        rows.push(['Expires', `<span class="provider-${expiry.level}">${e(expiry.text)}</span>`]);
        rows.push(['Connections', e(F.formatConnections(account, effective))]);
        if (account && account.error) {
            rows.push(['Check error', `<span class="provider-error">${e(F.safeText(account.error))}</span>${account.ok ? '' : ' <span class="setting-hint inline">The last good values are kept.</span>'}`]);
        }
        rows.push(['Channels', `<span class="provider-${sync.level}">${e(sync.text)}</span>`]);
        rows.push(['Guide', this.guideFact(p)]);
        if (p.role === 'backup') {
            rows.push(['Backup channels', `${e(Number(p.backupChannels || 0).toLocaleString())}
                <button type="button" class="btn btn-sm btn-secondary provider-inline" data-provider-action="links" data-id="${p.id}">Review links</button>`]);
        }
        return `<dl class="provider-facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    }

    /** 0181: a provider with the same server and login as another counts as one connection with it. */
    sharedAccountHtml(p) {
        const ids = Array.isArray(p.sharesAccountWith) ? p.sharesAccountWith : [];
        if (!ids.length) return '';
        const names = ids.map(id => (this.providers.find(o => o.id === id) || {}).name).filter(Boolean);
        if (!names.length) return '';
        return `<p class="provider-warning provider-error" role="alert">Same server and login as ${ProviderFormat.esc(names.join(', '))}: these count as one connection. Check this provider's settings.</p>`;
    }

    /** The one form every card has. `saved` is GET /api/sources/:id, or null for a new provider. */
    formHtml(id, saved) {
        const e = ProviderFormat.esc;
        const s = saved || {};
        const type = s.type || 'xtream';
        const xtream = type === 'xtream';
        return `
            <div class="provider-form" data-type="${e(type)}">
                <div class="provider-field">
                    <label>Name</label>
                    <input type="text" class="form-input" data-field="name" value="${e(s.name)}" placeholder="My provider">
                </div>
                <div class="provider-field">
                    <label>Connects with</label>
                    <select class="form-input" data-field="type"${saved ? ' disabled' : ''}>
                        <option value="xtream"${xtream ? ' selected' : ''}>Xtream login</option>
                        <option value="m3u"${xtream ? '' : ' selected'}>M3U playlist address</option>
                    </select>
                </div>
                <div class="provider-field wide">
                    <label data-label="url">${xtream ? 'Server address' : 'Playlist address'}</label>
                    <input type="text" class="form-input" data-field="url" value="${e(s.url)}" autocomplete="off"
                           placeholder="${xtream ? 'http://server.com:port' : 'https://example.com/playlist.m3u'}">
                </div>
                <div class="provider-field provider-login${xtream ? '' : ' hidden'}">
                    <label>Username</label>
                    <input type="text" class="form-input" data-field="username" value="${e(s.username)}" autocomplete="off">
                </div>
                <div class="provider-field provider-login${xtream ? '' : ' hidden'}">
                    <label>Password</label>
                    <input type="password" class="form-input" data-field="password" autocomplete="new-password"
                           placeholder="${s.hasPassword ? 'Leave empty to keep the saved password' : ''}">
                </div>
                <div class="provider-field wide">
                    <label>Guide (EPG) address</label>
                    <input type="text" class="form-input" data-field="epgUrl" value="${e(s.epgUrl)}" autocomplete="off"
                           placeholder="https://example.com/guide.xml">
                    <span class="setting-hint">This provider's guide, shown while it is first. Empty: an Xtream login uses the provider's own guide.</span>
                </div>
                <div class="provider-field wide">
                    <label>Channel ID list (an EPGenius M3U)</label>
                    <input type="text" class="form-input" data-field="idOverlayUrl" value="${e(s.idOverlayUrl)}" autocomplete="off"
                           placeholder="Optional">
                    <span class="setting-hint">Optional. Gives this provider's channels the ids that match them to the first provider's, while it is a backup.</span>
                </div>
            </div>
            <div class="provider-save">
                <button type="button" class="btn btn-primary btn-sm" data-provider-action="save" data-id="${id}">${saved ? 'Save' : 'Add provider'}</button>
                <button type="button" class="btn btn-secondary btn-sm" data-provider-action="cancel" data-id="${id}">Cancel</button>
                ${saved ? `<button type="button" class="btn btn-secondary btn-sm" data-provider-action="test" data-id="${id}">Test connection</button>
                <button type="button" class="btn btn-secondary btn-sm" data-provider-action="toggle" data-id="${id}">${saved.enabled ? 'Disable' : 'Enable'}</button>
                <button type="button" class="btn btn-danger btn-sm" data-provider-action="delete" data-id="${id}">Delete</button>` : ''}
                <span class="lineup-status" id="provider-status-${id}"></span>
            </div>`;
    }

    cardHtml(p, index, count) {
        const F = ProviderFormat;
        const e = F.esc;
        const isBackup = p.role === 'backup';
        const editing = this.open.has(p.id);
        return `
        <div class="provider-card${p.enabled ? '' : ' disabled'}" data-id="${p.id}">
            <div class="provider-head">
                <div class="provider-title">
                    <span class="provider-place">${index + 1}</span>
                    <strong>${e(p.name)}</strong>
                    <span class="provider-badge ${isBackup ? 'backup' : 'primary'}">${e(F.roleLabel(p, index))}</span>
                    <span class="provider-badge">${e(String(p.type || '').toUpperCase())}</span>
                    ${p.enabled ? '' : '<span class="provider-badge off">Disabled</span>'}
                </div>
                <div class="provider-actions">
                    <button type="button" class="btn btn-sm btn-secondary" data-provider-action="up" data-id="${p.id}" title="Move up" aria-label="Move ${e(p.name)} up"${index === 0 ? ' disabled' : ''}>&uarr;</button>
                    <button type="button" class="btn btn-sm btn-secondary" data-provider-action="down" data-id="${p.id}" title="Move down" aria-label="Move ${e(p.name)} down"${index === count - 1 ? ' disabled' : ''}>&darr;</button>
                    <button type="button" class="btn btn-sm btn-secondary" data-provider-action="check" data-id="${p.id}">Check account</button>
                    <button type="button" class="btn btn-sm btn-secondary" data-provider-action="sync" data-id="${p.id}">Sync now</button>
                    <button type="button" class="btn btn-sm btn-secondary" data-provider-action="edit" data-id="${p.id}"${editing ? ' disabled' : ''}>Edit</button>
                </div>
            </div>
            ${this.sharedAccountHtml(p)}
            <div class="provider-body">
                <div class="provider-info" id="provider-info-${p.id}">${this.infoHtml(p)}</div>
                ${editing ? this.formHtml(p.id, this.open.get(p.id)) : `<span class="lineup-status" id="provider-status-${p.id}"></span>`}
            </div>
        </div>`;
    }

    newCardHtml(index) {
        return `
        <div class="provider-card" data-id="new">
            <div class="provider-head">
                <div class="provider-title">
                    <span class="provider-place">${index + 1}</span>
                    <strong>New provider</strong>
                    <span class="provider-badge ${index ? 'backup' : 'primary'}">${index ? `Backup ${index}` : 'Primary'}</span>
                </div>
            </div>
            <div class="provider-body">${this.formHtml('new', null)}</div>
        </div>`;
    }

    guidesHtml() {
        if (!this.guides.length) return '';
        const e = ProviderFormat.esc;
        return `
        <div class="provider-card provider-legacy">
            <div class="provider-head"><div class="provider-title"><strong>Other guide sources</strong></div></div>
            <p class="setting-hint">Added before a guide address lived on each provider's card. They still sync and are merged into the guide.
                To keep one, copy it to a provider's guide address; then delete it here.</p>
            ${this.guides.map(g => `
            <div class="provider-head">
                <div class="provider-title">${e(g.name)}${g.enabled ? '' : ' <span class="provider-badge off">Disabled</span>'}</div>
                <div class="provider-actions">
                    <button type="button" class="btn btn-sm btn-secondary" data-provider-action="sync-guide" data-id="${g.id}">Sync now</button>
                    <button type="button" class="btn btn-sm btn-danger" data-provider-action="delete-guide" data-id="${g.id}">Delete</button>
                </div>
            </div>`).join('')}
        </div>`;
    }

    render() {
        const list = document.getElementById('providers-list');
        if (!list) return;
        const ordered = ProviderFormat.order(this.providers);
        // With nothing set up yet there is one card, waiting to be filled in.
        const adding = this.open.has('new') || ordered.length === 0;
        list.innerHTML = ordered.map((p, i) => this.cardHtml(p, i, ordered.length)).join('')
            + (adding ? this.newCardHtml(ordered.length) : '')
            + (adding ? '' : `<button type="button" class="btn btn-primary provider-add" data-provider-action="add" data-id="new">+ Add a ${ordered.length ? 'backup ' : ''}provider</button>`)
            + this.guidesHtml();
    }

    /** The login boxes and the address label follow "Connects with" (a new card only). */
    syncTypeFields(card) {
        const xtream = card?.querySelector('[data-field="type"]')?.value !== 'm3u';
        card?.querySelectorAll('.provider-login').forEach(el => el.classList.toggle('hidden', !xtream));
        const label = card?.querySelector('[data-label="url"]');
        if (label) label.textContent = xtream ? 'Server address' : 'Playlist address';
        const url = card?.querySelector('[data-field="url"]');
        if (url) url.placeholder = xtream ? 'http://server.com:port' : 'https://example.com/playlist.m3u';
    }

    cardStatus(id, text, isError = false) {
        const el = document.getElementById(`provider-status-${id}`);
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('error', isError);
    }

    readForm(card) {
        const out = {};
        for (const f of ['name', 'type', 'url', 'username', 'password', 'epgUrl', 'idOverlayUrl']) {
            out[f] = card.querySelector(`[data-field="${f}"]`)?.value ?? '';
        }
        return out;
    }

    async act(action, rawId, button) {
        if (action === 'add') { this.open.set('new', null); return this.render(); }
        if (action === 'cancel') { this.open.delete(rawId === 'new' ? 'new' : Number(rawId)); return this.render(); }
        if (action === 'save' && rawId === 'new') return this.create(button);
        const id = Number(rawId);
        if (action === 'sync-guide' || action === 'delete-guide') return this.guideAct(action, id, button);
        const p = this.providers.find(x => x.id === id);
        if (!p) return;
        if (action === 'edit') return this.edit(p, button);
        if (action === 'save') return this.save(p, button);
        if (action === 'up' || action === 'down') return this.move(p, action === 'up' ? -1 : 1);
        if (action === 'check') return this.check(p, button);
        if (action === 'sync') return this.sync(p, button);
        if (action === 'test') return this.test(p, button);
        if (action === 'toggle') return this.toggle(p, button);
        if (action === 'delete') return this.remove(p, button);
        if (action === 'links') return window.app?.pages?.settings?.showBackupLinks?.(p.id);
    }

    /** The lists that show channels follow a change of provider. */
    async refreshChannels() {
        window.app?.pages?.settings?.backupLinks?.invalidate?.();
        try {
            await window.app?.channelList?.loadSources?.();
            await window.app?.channelList?.loadChannels?.();
        } catch { /* the lists reload on their own next time */ }
    }

    async edit(p, button) {
        button.disabled = true;
        try {
            this.open.set(p.id, await API.sources.getById(p.id));
            this.render();
        } catch (err) {
            button.disabled = false;
            this.cardStatus(p.id, err.message || 'Could not load the provider', true);
        }
    }

    /** A very large playlist is worth a warning before it is synced. */
    async largePlaylistOk(url) {
        try {
            const estimate = await API.sources.estimateByUrl(url, 'm3u');
            if (!estimate.needsWarning) return true;
            return confirm(`This playlist has ${Number(estimate.count).toLocaleString()} channels. Syncing may take several minutes. Add it anyway?`);
        } catch { return true; }
    }

    async create(button) {
        const card = button.closest('.provider-card');
        const built = ProviderFormat.buildSave(null, this.readForm(card));
        if (built.error) { this.cardStatus('new', built.error, true); return; }
        button.disabled = true;
        this.cardStatus('new', 'Adding...');
        try {
            if (built.body.type === 'm3u' && !(await this.largePlaylistOk(built.body.url))) {
                button.disabled = false;
                this.cardStatus('new', '');
                return;
            }
            const created = await API.sources.create(built.body);
            this.open.delete('new');
            await this.load();
            if (created?.id) { this.cardStatus(created.id, 'Added. Syncing...'); this.polls.set(created.id, 40); this.pollSync(created.id); }
            this.refreshChannels();
        } catch (err) {
            button.disabled = false;
            this.cardStatus('new', err.message || 'Could not add the provider', true); // the server's own words
        }
    }

    async save(p, button) {
        const card = button.closest('.provider-card');
        const built = ProviderFormat.buildSave(this.open.get(p.id), this.readForm(card));
        if (built.error) { this.cardStatus(p.id, built.error, true); return; }
        if (Object.keys(built.body).length === 0) { this.open.delete(p.id); this.render(); return; }
        button.disabled = true;
        this.cardStatus(p.id, 'Saving...');
        try {
            await API.sources.update(p.id, built.body);
            this.open.delete(p.id);
            await this.load();
            // Any change here starts a sync of the provider.
            this.cardStatus(p.id, 'Saved. Syncing...');
            this.polls.set(p.id, 40);
            this.pollSync(p.id);
        } catch (err) {
            button.disabled = false;
            this.cardStatus(p.id, err.message || 'Could not save', true); // the server's own words
        }
    }

    async move(p, direction) {
        const ids = ProviderFormat.moved(this.providers, p.id, direction);
        if (!ids) return;
        const first = ProviderFormat.order(this.providers)[0];
        if (ids[0] !== first.id) {
            const next = this.providers.find(x => x.id === ids[0]);
            if (!confirm(`Make ${next.name} the primary provider?\n\nIts channels and guide replace ${first.name}'s, and ${first.name} becomes a backup. `
                + 'Both are synced again, which can take a few minutes. Favourites, channel numbers and scheduled recordings belong to the current primary\'s channels.')) return;
        }
        this.setStatus('Saving the order...');
        try {
            const result = await API.sources.setOrder(ids);
            await this.load();
            this.setStatus(result?.primaryChanged ? 'Order saved. Syncing the providers that changed...' : 'Order saved');
            if (result?.primaryChanged) for (const id of ids.slice(0, 2)) { this.polls.set(id, 60); this.pollSync(id); }
            this.refreshChannels();
        } catch (err) {
            this.setStatus(err.message || 'Could not save the order', true);
            await this.load();
        }
    }

    async check(p, button) {
        button.disabled = true;
        this.cardStatus(p.id, 'Checking...');
        try {
            this.accounts.set(p.id, await API.sources.checkAccount(p.id));
            const info = document.getElementById(`provider-info-${p.id}`);
            if (info) info.innerHTML = this.infoHtml(p);
            this.cardStatus(p.id, '');
        } catch (err) {
            this.cardStatus(p.id, err.message || 'Could not check the account', true);
        }
        button.disabled = false;
    }

    async sync(p, button) {
        button.disabled = true;
        this.cardStatus(p.id, 'Starting the sync...');
        try {
            await API.sources.sync(p.id);
            this.cardStatus(p.id, 'Sync started');
            this.polls.set(p.id, 40);
            this.pollSync(p.id);
        } catch (err) {
            this.cardStatus(p.id, err.message || 'Could not start the sync', true);
        }
        button.disabled = false;
    }

    async test(p, button) {
        button.disabled = true;
        this.cardStatus(p.id, 'Testing the saved connection...');
        try {
            const result = await API.sources.test(p.id);
            if (result.success) this.cardStatus(p.id, 'Connection successful');
            else this.cardStatus(p.id, `Connection failed: ${ProviderFormat.safeText(result.error || result.message || 'no reply')}`, true);
        } catch (err) {
            this.cardStatus(p.id, `Connection failed: ${ProviderFormat.safeText(err.message)}`, true);
        }
        button.disabled = false;
    }

    async toggle(p, button) {
        button.disabled = true;
        try {
            await API.sources.toggle(p.id);
            this.open.delete(p.id);
            await this.load();
            this.refreshChannels();
        } catch (err) {
            button.disabled = false;
            this.cardStatus(p.id, err.message || 'Could not change the provider', true);
        }
    }

    async remove(p, button) {
        const ordered = ProviderFormat.order(this.providers);
        const next = ordered[0].id === p.id ? ordered[1] : null;
        if (!confirm(`Delete ${p.name}? Its channels, guide and backup links are removed.`
            + (next ? `\n\n${next.name} becomes the primary provider.` : ''))) return;
        button.disabled = true;
        try {
            await API.sources.delete(p.id);
            this.open.delete(p.id);
            await this.load();
            this.refreshChannels();
        } catch (err) {
            button.disabled = false;
            this.cardStatus(p.id, err.message || 'Could not delete the provider', true);
        }
    }

    async guideAct(action, id, button) {
        const g = this.guides.find(x => x.id === id);
        if (!g) return;
        button.disabled = true;
        try {
            if (action === 'sync-guide') {
                await API.sources.sync(id);
                this.setStatus(`Syncing ${g.name}...`);
            } else if (confirm(`Delete the guide source ${g.name}? Its programmes are removed from the guide.`)) {
                await API.sources.delete(id);
                await this.load();
                return;
            }
        } catch (err) {
            this.setStatus(err.message || 'Could not do that', true);
        }
        button.disabled = false;
    }

    /** Refresh one card's facts every few seconds until its sync has finished. */
    pollSync(id) {
        setTimeout(async () => {
            const left = this.polls.get(id) || 0;
            if (left <= 0) return;
            this.polls.set(id, left - 1);
            try {
                const rows = await API.sources.getStatus();
                this.setSyncRows(rows);
                const mine = this.syncRows.get(id) || {};
                const [p, detail, list] = [this.providers.find(x => x.id === id), await API.sources.account(id).catch(() => null),
                    await API.sources.providers().catch(() => null)];
                if (detail) this.accounts.set(id, detail);
                if (list) { const fresh = list.find(x => x.id === id); if (fresh && p) p.backupChannels = fresh.backupChannels; }
                const info = document.getElementById(`provider-info-${id}`);
                if (info && p) info.innerHTML = this.infoHtml(p);
                const busy = [mine.all, mine.epg].some(r => r && r.status === 'syncing');
                if (mine.all && !busy) { this.polls.delete(id); this.cardStatus(id, ''); return; }
            } catch { /* try again */ }
            this.pollSync(id);
        }, 3000);
    }
}

window.ProviderFormat = ProviderFormat;
window.ProvidersSettings = ProvidersSettings;
