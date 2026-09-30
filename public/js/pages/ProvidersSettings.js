/**
 * Settings -> Providers (0172, multi-provider brief 2.9). Admin only.
 *
 * One card per provider (a non-EPG source): role, order (backups), account info read from
 * the provider (status, expiry and where it came from, connections, last check, error), and
 * the editable provider fields. Uses GET /api/sources/providers, /api/sources/status,
 * /api/sources/:id/account (and POST .../account/check), PUT /api/sources/:id, POST .../sync.
 *
 * The backup's ID overlay address is a login in URL form: it is write-only here. The page
 * shows "set" or "not set"; an empty box on Save keeps the stored one, "Remove" sends ''.
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

    /**
     * "Tue 30 Mar 2027". A manual or term date is a calendar date the server ends at 23:59 UTC, so it
     * is written in UTC (the date that was typed); the account's date is an instant, written in local time.
     */
    formatDate(ms, utc = false) {
        const d = new Date(ms);
        const get = utc
            ? [d.getUTCDay(), d.getUTCDate(), d.getUTCMonth(), d.getUTCFullYear()]
            : [d.getDay(), d.getDate(), d.getMonth(), d.getFullYear()];
        return `${ProviderFormat.DAYS[get[0]]} ${get[1]} ${ProviderFormat.MONTHS[get[2]]} ${get[3]}`;
    },

    EXPIRY_FROM: { manual: 'set by hand', term: 'from the purchase date and term', account: 'from the account' },

    /** { text, level } for the effective expiry: "Tue 30 Mar 2027 · from the account" (+ " · 5 days left" / " · expired"). */
    formatExpiry(effective, now = Date.now()) {
        const at = effective?.expiresAt;
        if (!Number.isFinite(at)) return { text: 'Unknown', level: 'none' };
        const from = effective.expirySource;
        let text = ProviderFormat.formatDate(at, from === 'manual' || from === 'term');
        if (ProviderFormat.EXPIRY_FROM[from]) text += ` · ${ProviderFormat.EXPIRY_FROM[from]}`;
        const days = Math.ceil((at - now) / 86400000);
        if (at < now) return { text: `${text} · expired`, level: 'expired' };
        if (days <= 7) return { text: `${text} · ${days} day${days === 1 ? '' : 's'} left`, level: 'soon' };
        return { text, level: 'ok' };
    },

    /** "1 of 2 in use · limit 2 (from the account)". */
    formatConnections(source, account, effective) {
        const limit = effective?.limit ?? 1;
        const from = Number.isInteger(source?.maxConnections) ? 'set by hand'
            : (Number.isInteger(account?.maxConnections) && account.maxConnections > 0 ? 'from the account' : 'assumed');
        const used = account && Number.isInteger(account.activeCons) ? `${account.activeCons} of ${limit} in use · ` : '';
        return `${used}limit ${limit} (${from})`;
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

    /** The priority changes { id, priority } that move a backup up (-1) or down (+1); renumbers 1..n. */
    reorder(list, id, direction) {
        const backups = ProviderFormat.order(list).filter(p => p.role === 'backup');
        const from = backups.findIndex(p => p.id === id);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= backups.length) return [];
        [backups[from], backups[to]] = [backups[to], backups[from]];
        return backups.map((p, i) => ({ id: p.id, priority: i + 1 })).filter((c, i) => backups[i].priority !== c.priority);
    },

    /** A whole number as typed becomes a number; anything else goes as typed, for the server to refuse in words. */
    wholeOrText(text) {
        const t = String(text ?? '').trim();
        return /^\d+$/.test(t) ? parseInt(t, 10) : t;
    },

    /**
     * The PUT body for a card: only what changed. `values` = { role, maxConnections, purchasedAt,
     * termMonths, endsAt, overlay, clearOverlay } as typed. Overlay: '' (empty) means "keep".
     */
    buildUpdate(provider, values) {
        const body = {};
        if (values.role && values.role !== provider.role) body.role = values.role;
        const limit = String(values.maxConnections ?? '').trim();
        if (limit !== (provider.maxConnections == null ? '' : String(provider.maxConnections))) {
            body.maxConnections = limit === '' ? null : ProviderFormat.wholeOrText(limit);
        }
        const sub = provider.subscription || {};
        const typed = {
            purchasedAt: String(values.purchasedAt ?? '').trim(),
            termMonths: String(values.termMonths ?? '').trim(),
            endsAt: String(values.endsAt ?? '').trim()
        };
        const was = { purchasedAt: sub.purchasedAt || '', termMonths: sub.termMonths == null ? '' : String(sub.termMonths), endsAt: sub.endsAt || '' };
        if (typed.purchasedAt !== was.purchasedAt || typed.termMonths !== was.termMonths || typed.endsAt !== was.endsAt) {
            body.subscription = {
                purchasedAt: typed.purchasedAt,
                termMonths: typed.termMonths === '' ? '' : ProviderFormat.wholeOrText(typed.termMonths),
                endsAt: typed.endsAt
            };
        }
        if (values.clearOverlay) body.idOverlayUrl = '';
        else if (String(values.overlay ?? '').trim()) body.idOverlayUrl = String(values.overlay).trim();
        return body;
    }
};

class ProvidersSettings {
    constructor() {
        this.providers = [];
        this.accounts = new Map();   // id -> { account, effective }
        this.syncRows = new Map();   // id -> sync_status row ('all')
        this.polls = new Map();      // id -> polls left while a sync runs
        this.token = 0;
        document.getElementById('tab-providers')?.addEventListener('click', (e) => {
            const button = e.target?.closest?.('button[data-provider-action]');
            if (button) this.act(button.dataset.providerAction, Number(button.dataset.id), button);
        });
        document.getElementById('tab-providers')?.addEventListener('change', (e) => {
            if (e.target?.matches?.('[data-field="role"]')) this.syncRoleFields(e.target.closest('.provider-card'));
        });
    }

    setStatus(text, isError = false) {
        const status = document.getElementById('providers-status');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('error', isError);
    }

    async load() {
        const mine = ++this.token;
        const list = document.getElementById('providers-list');
        try {
            const [providers, statuses] = await Promise.all([
                API.sources.providers(),
                API.sources.getStatus().catch(() => [])
            ]);
            if (mine !== this.token) return;
            this.providers = Array.isArray(providers) ? providers : [];
            this.syncRows = new Map((Array.isArray(statuses) ? statuses : []).filter(r => r.type === 'all').map(r => [r.source_id, r]));
            const accounts = await Promise.all(this.providers.map(p => API.sources.account(p.id).catch(() => null)));
            if (mine !== this.token) return;
            this.accounts = new Map(this.providers.map((p, i) => [p.id, accounts[i]]));
            this.render();
        } catch (err) {
            if (list) list.innerHTML = `<p class="hint">Could not load the providers: ${ProviderFormat.esc(err.message)}</p>`;
        }
    }

    infoHtml(p) {
        const F = ProviderFormat;
        const e = F.esc;
        const detail = this.accounts.get(p.id) || {};
        const account = detail.account || null;
        const effective = detail.effective || {};
        const expiry = F.formatExpiry(effective);
        const sync = F.formatSync(this.syncRows.get(p.id));
        const rows = [];
        rows.push(['Account', account
            ? `${e(account.status || 'Unknown')}${account.isTrial ? ' (trial)' : ''}`
            : 'Not read yet']);
        rows.push(['Expires', `<span class="provider-${expiry.level}">${e(expiry.text)}</span>`]);
        rows.push(['Connections', e(F.formatConnections(p, account, effective))]);
        rows.push(['Last checked', account ? e(F.ago(account.checkedAt)) : 'never']);
        if (account && account.error) {
            rows.push(['Check error', `<span class="provider-error">${e(F.safeText(account.error))}</span>${account.ok ? '' : ' <span class="setting-hint inline">The last good values are kept.</span>'}`]);
        }
        rows.push(['Sync', `<span class="provider-${sync.level}">${e(sync.text)}</span>`]);
        if (p.role === 'backup') rows.push(['Backup channels', e(Number(p.backupChannels || 0).toLocaleString())]);
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

    cardHtml(p, backupIndex, backupCount) {
        const F = ProviderFormat;
        const e = F.esc;
        const sub = p.subscription || {};
        const isBackup = p.role === 'backup';
        const move = isBackup ? `
            <button type="button" class="btn btn-sm btn-secondary" data-provider-action="up" data-id="${p.id}" title="Try this provider earlier" aria-label="Move ${e(p.name)} up"${backupIndex === 1 ? ' disabled' : ''}>&uarr;</button>
            <button type="button" class="btn btn-sm btn-secondary" data-provider-action="down" data-id="${p.id}" title="Try this provider later" aria-label="Move ${e(p.name)} down"${backupIndex === backupCount ? ' disabled' : ''}>&darr;</button>` : '';
        return `
        <div class="provider-card${p.enabled ? '' : ' disabled'}" data-id="${p.id}">
            <div class="provider-head">
                <div class="provider-title">
                    <strong>${e(p.name)}</strong>
                    <span class="provider-badge ${isBackup ? 'backup' : 'primary'}">${e(F.roleLabel(p, backupIndex))}</span>
                    <span class="provider-badge">${e(String(p.type || '').toUpperCase())}</span>
                    ${p.enabled ? '' : '<span class="provider-badge off">Disabled</span>'}
                </div>
                <div class="provider-actions">
                    ${move}
                    <button type="button" class="btn btn-sm btn-secondary" data-provider-action="check" data-id="${p.id}">Check now</button>
                    <button type="button" class="btn btn-sm btn-secondary" data-provider-action="sync" data-id="${p.id}">Sync now</button>
                </div>
            </div>
            ${this.sharedAccountHtml(p)}
            <div class="provider-body">
                <div class="provider-info" id="provider-info-${p.id}">${this.infoHtml(p)}</div>
                <div class="provider-form">
                    <div class="provider-field">
                        <label>Role</label>
                        <select class="form-input" data-field="role">
                            <option value="primary"${isBackup ? '' : ' selected'}>Primary (shown in the guide)</option>
                            <option value="backup"${isBackup ? ' selected' : ''}>Backup (list only)</option>
                        </select>
                    </div>
                    <div class="provider-field">
                        <label>Connection limit</label>
                        <input type="text" inputmode="numeric" class="form-input" data-field="maxConnections"
                               value="${e(p.maxConnections ?? '')}" placeholder="From the account">
                    </div>
                    <div class="provider-field">
                        <label>Purchased</label>
                        <input type="date" class="form-input" data-field="purchasedAt" value="${e(sub.purchasedAt || '')}">
                    </div>
                    <div class="provider-field">
                        <label>Term (months)</label>
                        <input type="text" inputmode="numeric" class="form-input" data-field="termMonths" value="${e(sub.termMonths ?? '')}" placeholder="e.g. 12">
                    </div>
                    <div class="provider-field">
                        <label>Or ends on</label>
                        <input type="date" class="form-input" data-field="endsAt" value="${e(sub.endsAt || '')}">
                    </div>
                    <div class="provider-field wide provider-overlay${isBackup ? '' : ' hidden'}">
                        <label>ID overlay address (an EPGenius M3U): <strong>${p.hasIdOverlay ? 'set' : 'not set'}</strong></label>
                        <input type="password" class="form-input" data-field="overlay" autocomplete="off"
                               placeholder="${p.hasIdOverlay ? 'Leave empty to keep the saved address' : 'Paste the address'}">
                        ${p.hasIdOverlay ? '<label class="provider-clear"><input type="checkbox" data-field="clearOverlay"> Remove the saved address</label>' : ''}
                    </div>
                </div>
                <div class="provider-save">
                    <button type="button" class="btn btn-primary btn-sm" data-provider-action="save" data-id="${p.id}">Save</button>
                    <span class="lineup-status" id="provider-status-${p.id}"></span>
                </div>
            </div>
        </div>`;
    }

    render() {
        const list = document.getElementById('providers-list');
        if (!list) return;
        if (this.providers.length === 0) {
            list.innerHTML = '<p class="hint">No providers yet. Add an Xtream or M3U source on the Sources tab.</p>';
            return;
        }
        const ordered = ProviderFormat.order(this.providers);
        const backups = ordered.filter(p => p.role === 'backup').length;
        let n = 0;
        list.innerHTML = ordered.map(p => this.cardHtml(p, p.role === 'backup' ? ++n : 0, backups)).join('');
    }

    /** Show the overlay box only while Role says backup. */
    syncRoleFields(card) {
        const role = card?.querySelector('[data-field="role"]')?.value;
        card?.querySelector('.provider-overlay')?.classList.toggle('hidden', role !== 'backup');
    }

    cardStatus(id, text, isError = false) {
        const el = document.getElementById(`provider-status-${id}`);
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('error', isError);
    }

    readForm(card) {
        const val = (f) => card.querySelector(`[data-field="${f}"]`)?.value ?? '';
        return {
            role: val('role'), maxConnections: val('maxConnections'), purchasedAt: val('purchasedAt'),
            termMonths: val('termMonths'), endsAt: val('endsAt'), overlay: val('overlay'),
            clearOverlay: Boolean(card.querySelector('[data-field="clearOverlay"]')?.checked)
        };
    }

    async act(action, id, button) {
        const p = this.providers.find(x => x.id === id);
        if (!p) return;
        if (action === 'save') return this.save(p, button);
        if (action === 'up' || action === 'down') return this.move(p, action === 'up' ? -1 : 1);
        if (action === 'check') return this.check(p, button);
        if (action === 'sync') return this.sync(p, button);
    }

    async save(p, button) {
        const card = button.closest('.provider-card');
        const body = ProviderFormat.buildUpdate(p, this.readForm(card));
        if (Object.keys(body).length === 0) { this.cardStatus(p.id, 'No changes'); return; }
        button.disabled = true;
        this.cardStatus(p.id, 'Saving...');
        try {
            await API.sources.update(p.id, body);
            await this.load();
            this.cardStatus(p.id, 'Saved');
            // The new role or dates show elsewhere; a role change also starts a sync of that provider.
            if (body.role) window.app?.pages?.settings?.backupLinks?.invalidate?.();
        } catch (err) {
            button.disabled = false;
            this.cardStatus(p.id, err.message || 'Could not save', true); // the server's own words
        }
    }

    async move(p, direction) {
        const changes = ProviderFormat.reorder(this.providers, p.id, direction);
        if (changes.length === 0) return;
        this.setStatus('Saving the order...');
        try {
            for (const c of changes) await API.sources.update(c.id, { priority: c.priority });
            await this.load();
            this.setStatus('Order saved');
            window.app?.pages?.settings?.backupLinks?.invalidate?.();
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

    /** Refresh one card's facts every few seconds until its sync has finished. */
    pollSync(id) {
        setTimeout(async () => {
            const left = this.polls.get(id) || 0;
            if (left <= 0) return;
            this.polls.set(id, left - 1);
            try {
                const rows = await API.sources.getStatus();
                const row = (rows || []).find(r => r.source_id === id && r.type === 'all');
                if (row) this.syncRows.set(id, row);
                const [p, detail, list] = [this.providers.find(x => x.id === id), await API.sources.account(id).catch(() => null),
                    await API.sources.providers().catch(() => null)];
                if (detail) this.accounts.set(id, detail);
                if (list) { const fresh = list.find(x => x.id === id); if (fresh && p) p.backupChannels = fresh.backupChannels; }
                const info = document.getElementById(`provider-info-${id}`);
                if (info && p) info.innerHTML = this.infoHtml(p);
                if (row && row.status !== 'syncing') { this.polls.delete(id); this.cardStatus(id, ''); return; }
            } catch { /* try again */ }
            this.pollSync(id);
        }, 3000);
    }
}

window.ProviderFormat = ProviderFormat;
window.ProvidersSettings = ProvidersSettings;
