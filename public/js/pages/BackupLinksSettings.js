/**
 * Settings -> Backup links (0172, multi-provider brief 2.9). Admin only.
 *
 * The review page for the links between the primary's visible channels and each backup
 * provider's channels (GET /api/links, /api/links/summary; PUT /api/links/:id; POST
 * /api/links, /api/links/approve-pending, /api/links/relink). One row per primary channel, a
 * column per backup showing its rank-1 link (name, how it was found, status) with Approve /
 * Reject / Undo; the other candidates (and rejected ones) are under "more". Paged, 100 a page.
 * A stream address is never in these responses and is never shown. LinkFormat holds the pure
 * helpers (tested without a DOM).
 */

const LinkFormat = {
    PAGE_SIZE: 100,

    STATUS_LABELS: { auto: 'Auto', pending: 'Needs review', approved: 'Approved', manual: 'Manual', rejected: 'Rejected', broken: 'Broken' },
    METHOD_LABELS: { 'raw-name': 'same raw name', 'raw-epg': 'same raw guide id', exact: 'same guide id', number: 'channel number', name: 'same name', manual: 'picked by hand', sibling: 'own backup feed' },

    statusLabel: (s) => LinkFormat.STATUS_LABELS[s] || String(s || ''),
    methodLabel: (m) => LinkFormat.METHOD_LABELS[m] || String(m || ''),

    /** The CSS modifier for a status badge: used links are ok, waiting ones warn, dead ones are bad. */
    badgeClass(status) {
        if (status === 'auto' || status === 'approved' || status === 'manual') return 'ok';
        if (status === 'pending') return 'warn';
        if (status === 'rejected' || status === 'broken') return 'bad';
        return 'none';
    },

    /** Which decision buttons a link gets: [{ action, status, label }]. A broken link's stream is gone, so it can only be rejected. */
    actions(link) {
        const approve = { action: 'approve', status: 'approved', label: 'Approve' };
        const reject = { action: 'reject', status: 'rejected', label: 'Reject' };
        const undo = { action: 'undo', status: 'pending', label: 'Undo' };
        switch (link && link.status) {
            case 'auto': case 'pending': return [approve, reject];
            case 'approved': return [undo, reject];
            case 'manual': return [undo, reject];
            case 'rejected': return [undo];
            case 'broken': return [reject];
            default: return [];
        }
    },

    /** { first, last, page, pages, hasPrev, hasNext } for "Showing 101-200 of 987". */
    pageInfo(total, offset, limit = LinkFormat.PAGE_SIZE) {
        const pages = Math.max(1, Math.ceil(total / limit));
        const page = Math.min(pages, Math.floor(offset / limit) + 1);
        return {
            first: total === 0 ? 0 : offset + 1,
            last: Math.min(total, offset + limit),
            page, pages,
            hasPrev: offset > 0,
            hasNext: offset + limit < total
        };
    },

    /** The filters the page holds -> the ones GET /api/links takes (empty ones dropped). */
    apiFilters(f) {
        const out = {};
        if (f.search && f.search.trim()) out.search = f.search.trim();
        if (f.categoryId) out.categoryId = f.categoryId;
        if (f.status) out.status = f.status;
        if (f.unlinked) out.unlinked = true;
        if (f.backupSourceId) out.backupSourceId = f.backupSourceId;
        return out;
    },

    /** The columns: backups by priority, then the primary's own backup feeds (siblings) when it has any. */
    columns(summary) {
        const providers = (summary && summary.providers) || [];
        const backups = providers.filter(p => p.role === 'backup')
            .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999) || a.backupSourceId - b.backupSourceId);
        const siblings = providers.filter(p => p.role === 'sibling' && Object.values(p.counts || {}).some(n => n > 0));
        return [...backups, ...siblings];
    },

    /** A channel's links at one provider: { top: rank 1 | null, more: the rest, rejected and broken last }. */
    linksAt(channel, backupSourceId) {
        const mine = (channel.links || []).filter(l => l.backupSourceId === backupSourceId).sort((a, b) => a.rank - b.rank);
        const top = mine.find(l => l.rank === 1 && l.status !== 'rejected' && l.status !== 'broken') || null;
        return { top, more: mine.filter(l => l !== top) };
    },

    /** The status line above the table: "3 of 987 channels need review at Trex" style counts for the summary table. */
    countsRow(p) {
        const c = p.counts || {};
        return ['auto', 'pending', 'approved', 'manual', 'rejected', 'broken'].map(s => c[s] || 0);
    }
};

class BackupLinksSettings {
    constructor() {
        this.summary = null;
        this.channels = [];
        this.total = 0;
        this.offset = 0;
        this.filters = { search: '', categoryId: '', status: '', unlinked: false, backupSourceId: '' };
        this.categories = [];
        this.stale = true;   // reload when the tab is next opened
        this.token = 0;
        this.pick = null;    // the open manual pick: { channel, provider }

        const tab = document.getElementById('tab-backuplinks');
        tab?.addEventListener('click', (e) => {
            const button = e.target?.closest?.('button[data-links-action]');
            if (button) this.act(button.dataset.linksAction, button);
        });
        let timer;
        document.getElementById('links-search')?.addEventListener('input', (e) => {
            clearTimeout(timer);
            timer = setTimeout(() => { this.filters.search = e.target.value; this.reload(0); }, 300);
        });
        for (const [id, key] of [['links-category', 'categoryId'], ['links-status', 'status'], ['links-provider', 'backupSourceId']]) {
            document.getElementById(id)?.addEventListener('change', (e) => { this.filters[key] = e.target.value; this.reload(0); });
        }
        document.getElementById('links-unlinked')?.addEventListener('change', (e) => { this.filters.unlinked = e.target.checked; this.reload(0); });
    }

    /** Providers or links changed elsewhere: reload next time the tab opens. */
    invalidate() { this.stale = true; }

    setStatus(text, isError = false) {
        const status = document.getElementById('links-status-text');
        if (!status) return;
        status.textContent = text;
        status.classList.toggle('error', isError);
    }

    async load() {
        const table = document.getElementById('links-list');
        try {
            const [summary, categories] = await Promise.all([API.links.summary(), API.library.categories().catch(() => [])]);
            this.summary = summary;
            this.categories = Array.isArray(categories) ? categories : [];
            this.renderSummary();
            this.renderFilters();
            this.stale = false;
            await this.reload(this.offset);
        } catch (err) {
            if (table) table.innerHTML = `<tr><td class="hint">Could not load the backup links: ${ProviderFormat.esc(err.message)}</td></tr>`;
        }
    }

    /** Fetch the page at `offset` with the current filters. */
    async reload(offset = this.offset) {
        const mine = ++this.token;
        const table = document.getElementById('links-list');
        try {
            const res = await API.links.list(LinkFormat.apiFilters(this.filters), offset, LinkFormat.PAGE_SIZE);
            if (mine !== this.token) return;
            this.channels = res.channels || [];
            this.total = res.total || 0;
            this.offset = res.offset ?? offset;
            // A page that emptied after decisions (or a filter change): go back to the last real page.
            if (this.channels.length === 0 && this.total > 0 && this.offset >= this.total) {
                return this.reload(Math.max(0, (Math.ceil(this.total / LinkFormat.PAGE_SIZE) - 1) * LinkFormat.PAGE_SIZE));
            }
            this.renderTable();
        } catch (err) {
            if (mine === this.token && table) table.innerHTML = `<tr><td class="hint">Could not load the channels: ${ProviderFormat.esc(err.message)}</td></tr>`;
        }
    }

    // ---- rendering ------------------------------------------------------

    renderSummary() {
        const e = ProviderFormat.esc;
        const el = document.getElementById('links-summary');
        if (!el) return;
        const providers = (this.summary && this.summary.providers) || [];
        if (providers.length === 0) {
            el.innerHTML = '<p class="hint">No backup provider yet. Add a source, then set its role to Backup on the Providers tab.</p>';
            return;
        }
        el.innerHTML = `
            <p class="setting-hint">${(this.summary.linkable ?? 0).toLocaleString()} of ${(this.summary.channels ?? 0).toLocaleString()} visible channels can be linked (event and pay-per-view slots never are).</p>
            <div class="user-list-container"><table class="user-table status-table"><thead><tr>
                <th>Provider</th><th>Auto</th><th>Needs review</th><th>Approved</th><th>Manual</th><th>Rejected</th><th>Broken</th><th>Channels linked</th><th>Without a link</th>
            </tr></thead><tbody>${providers.map(p => `<tr>
                <td>${e(p.role === 'sibling' ? `${p.name} (its own backup feeds)` : p.name)}${p.enabled === false ? ' <span class="setting-hint inline">disabled</span>' : ''}</td>
                ${LinkFormat.countsRow(p).map(n => `<td>${n.toLocaleString()}</td>`).join('')}
                <td>${(p.linked ?? 0).toLocaleString()}</td><td>${(p.unlinked ?? 0).toLocaleString()}</td>
            </tr>`).join('')}</tbody></table></div>`;
    }

    renderFilters() {
        const e = ProviderFormat.esc;
        const cat = document.getElementById('links-category');
        if (cat) {
            cat.innerHTML = '<option value="">All categories</option>' + this.categories
                .map(c => `<option value="${e(c.id)}">${e(c.name)}</option>`).join('');
            cat.value = this.filters.categoryId;
        }
        const prov = document.getElementById('links-provider');
        if (prov) {
            prov.innerHTML = '<option value="">Any provider</option>' + LinkFormat.columns(this.summary)
                .map(p => `<option value="${p.backupSourceId}">${e(p.name)}</option>`).join('');
            prov.value = this.filters.backupSourceId;
        }
        this.renderBulk();
    }

    /** "Approve all pending in <category>", one button per backup, only once a category is chosen. */
    renderBulk() {
        const e = ProviderFormat.esc;
        const el = document.getElementById('links-bulk');
        if (!el) return;
        const cat = this.categories.find(c => String(c.id) === String(this.filters.categoryId));
        if (!cat) { el.innerHTML = ''; return; }
        const backups = LinkFormat.columns(this.summary).filter(p => p.role === 'backup');
        el.innerHTML = `<span class="setting-hint inline">Approve all pending in ${e(cat.name)}:</span>
            ${backups.map(p => `<button type="button" class="btn btn-sm btn-secondary" data-links-action="approve-category" data-backup="${p.backupSourceId}">${e(p.name)}</button>`).join('')}
            ${backups.length > 1 ? '<button type="button" class="btn btn-sm btn-secondary" data-links-action="approve-category" data-backup="">All backups</button>' : ''}`;
    }

    linkHtml(l, compact) {
        const e = ProviderFormat.esc;
        const buttons = LinkFormat.actions(l).map(a =>
            `<button type="button" class="btn btn-sm btn-secondary link-btn ${a.action}" data-links-action="decide" data-id="${l.id}" data-status="${a.status}">${a.label}</button>`).join('');
        return `<div class="link-item${compact ? ' compact' : ''}">
            <div class="link-name">${e(l.name || 'Channel no longer listed')}</div>
            <div class="link-meta"><span class="link-badge ${LinkFormat.badgeClass(l.status)}">${e(LinkFormat.statusLabel(l.status))}</span>
                <span class="setting-hint inline">${e(LinkFormat.methodLabel(l.method))}${l.category ? ` · ${e(l.category)}` : ''}</span></div>
            <div class="link-buttons">${buttons}</div>
        </div>`;
    }

    cellHtml(channel, col, index) {
        const { top, more } = LinkFormat.linksAt(channel, col.backupSourceId);
        const pick = col.role === 'backup'
            ? `<button type="button" class="btn btn-sm btn-secondary link-btn" data-links-action="pick" data-channel="${index}" data-backup="${col.backupSourceId}">Pick...</button>` : '';
        const rest = more.length
            ? `<details class="link-more"><summary>${more.length} more</summary>${more.map(l => this.linkHtml(l, true)).join('')}</details>` : '';
        if (!top) {
            const why = channel.event ? 'Event slot' : 'No match';
            return `<td><div class="setting-hint">${why}</div>${pick}${rest}</td>`;
        }
        return `<td>${this.linkHtml(top, false)}${pick}${rest}</td>`;
    }

    renderTable() {
        const e = ProviderFormat.esc;
        const head = document.getElementById('links-head');
        const list = document.getElementById('links-list');
        if (!head || !list) return;
        const cols = LinkFormat.columns(this.summary);
        head.innerHTML = `<tr><th>Channel</th>${cols.map(c => `<th>${e(c.role === 'sibling' ? 'Own backup feed' : c.name)}</th>`).join('')}</tr>`;
        if (cols.length === 0) {
            list.innerHTML = '<tr><td class="hint">No backup provider to link to.</td></tr>';
        } else if (this.channels.length === 0) {
            list.innerHTML = `<tr><td colspan="${cols.length + 1}" class="hint">No channels match</td></tr>`;
        } else {
            list.innerHTML = this.channels.map((c, i) => `<tr class="links-row">
                <td class="link-channel"><strong>${c.number ? `${e(c.number)} ` : ''}${e(c.name)}</strong>
                    <div class="setting-hint">${e(c.categoryName || '')}${c.tvgId ? ` · ${e(c.tvgId)}` : ''}</div></td>
                ${cols.map(col => this.cellHtml(c, col, i)).join('')}
            </tr>`).join('');
        }
        const info = LinkFormat.pageInfo(this.total, this.offset);
        const pager = document.getElementById('links-pager');
        if (pager) {
            pager.innerHTML = this.total === 0 ? '' : `
                <button type="button" class="btn btn-sm btn-secondary" data-links-action="prev"${info.hasPrev ? '' : ' disabled'}>&larr; Previous</button>
                <span class="setting-hint inline">${info.first.toLocaleString()}-${info.last.toLocaleString()} of ${this.total.toLocaleString()} channels (page ${info.page} of ${info.pages})</span>
                <button type="button" class="btn btn-sm btn-secondary" data-links-action="next"${info.hasNext ? '' : ' disabled'}>Next &rarr;</button>`;
        }
        this.renderBulk();
    }

    // ---- actions --------------------------------------------------------

    async act(action, button) {
        if (action === 'prev') return this.reload(Math.max(0, this.offset - LinkFormat.PAGE_SIZE));
        if (action === 'next') return this.reload(this.offset + LinkFormat.PAGE_SIZE);
        if (action === 'decide') return this.decide(Number(button.dataset.id), button.dataset.status, button);
        if (action === 'relink') return this.relink(button);
        if (action === 'approve-category') return this.approveCategory(button.dataset.backup ? Number(button.dataset.backup) : null, button);
        if (action === 'pick') return this.openPick(this.channels[Number(button.dataset.channel)], Number(button.dataset.backup));
    }

    async refreshAfterChange() {
        // The counts change with every decision; the page itself is fetched again so it shows the server's ranking.
        try { this.summary = await API.links.summary(); this.renderSummary(); } catch { /* keep the old counts */ }
        await this.reload(this.offset);
    }

    async decide(id, status, button) {
        if (button) button.disabled = true;
        this.setStatus('Saving...');
        try {
            await API.links.setStatus(id, status);
            await this.refreshAfterChange();
            this.setStatus('');
        } catch (err) {
            if (button) button.disabled = false;
            this.setStatus(err.message || 'Could not save the decision', true);
        }
    }

    async approveCategory(backupSourceId, button) {
        const cat = this.categories.find(c => String(c.id) === String(this.filters.categoryId));
        if (!cat) return;
        const provider = backupSourceId ? LinkFormat.columns(this.summary).find(p => p.backupSourceId === backupSourceId)?.name : 'every backup';
        if (!confirm(`Approve every pending link in ${cat.name} for ${provider}?`)) return;
        if (button) button.disabled = true;
        this.setStatus('Approving...');
        try {
            const res = await API.links.approvePending(cat.id, backupSourceId);
            await this.refreshAfterChange();
            this.setStatus(`Approved ${res.approved ?? 0} link${res.approved === 1 ? '' : 's'}`);
        } catch (err) {
            this.setStatus(err.message || 'Could not approve the pending links', true);
        }
        if (button) button.disabled = false;
    }

    async relink(button) {
        if (button) button.disabled = true;
        this.setStatus('Relinking (this can take a little while)...');
        try {
            const res = await API.links.relink();
            await this.load();
            this.setStatus(res && res.skipped ? 'Nothing to relink: no enabled backup provider' : 'Relinked');
        } catch (err) {
            this.setStatus(err.message || 'Could not relink', true);
        }
        if (button) button.disabled = false;
    }

    // ---- manual pick ----------------------------------------------------

    openPick(channel, backupSourceId) {
        const col = LinkFormat.columns(this.summary).find(p => p.backupSourceId === backupSourceId);
        if (!channel || !col) return;
        this.pick = { channel, provider: col, token: 0 };
        const modal = document.getElementById('modal');
        document.getElementById('modal-title').textContent = `Link ${channel.name} to a ${col.name} channel`;
        document.getElementById('modal-body').innerHTML = `
            <p class="setting-hint">Search ${ProviderFormat.esc(col.name)}'s channels by name, category or guide id, then pick the one that is the same channel. Your pick is used at once and kept across syncs.</p>
            <div class="search-wrapper"><input type="text" id="links-pick-search" class="search-input" placeholder="Search ${ProviderFormat.esc(col.name)}..." value="${ProviderFormat.esc(channel.name)}"></div>
            <div id="links-pick-results" class="links-pick-results"><span class="setting-hint">Searching...</span></div>
            <div id="links-pick-error" class="lineup-status error"></div>`;
        document.getElementById('modal-footer').innerHTML = '<button class="btn btn-secondary" id="modal-cancel">Cancel</button>';
        modal.classList.add('active');
        const close = () => { modal.classList.remove('active'); this.pick = null; };
        modal.querySelector('.modal-close').onclick = close;
        document.getElementById('modal-cancel').onclick = close;
        const input = document.getElementById('links-pick-search');
        let timer;
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this.searchPick(input.value), 300); });
        document.getElementById('links-pick-results').addEventListener('click', (e) => {
            const b = e.target?.closest?.('button[data-stream]');
            if (b) this.choose(b.dataset.stream);
        });
        input.focus();
        this.searchPick(input.value);
    }

    async searchPick(query) {
        const pick = this.pick;
        if (!pick) return;
        const mine = ++pick.token;
        const box = document.getElementById('links-pick-results');
        try {
            const rows = await API.sources.backupChannels(pick.provider.backupSourceId, query, 50);
            if (this.pick !== pick || mine !== pick.token || !box) return;
            const e = ProviderFormat.esc;
            box.innerHTML = rows.length
                ? rows.map(r => `<button type="button" class="links-pick-row" data-stream="${e(r.stream_id)}">
                    <span>${e(r.name)}</span><span class="setting-hint inline">${e(r.category_name || '')}${r.overlay_tvg_id || r.tvg_id ? ` · ${e(r.overlay_tvg_id || r.tvg_id)}` : ''}</span></button>`).join('')
                : '<span class="setting-hint">No channels match. Try a shorter search, or part of the guide id.</span>';
        } catch (err) {
            if (box && this.pick === pick) box.innerHTML = `<span class="setting-hint">Could not search: ${ProviderFormat.esc(err.message)}</span>`;
        }
    }

    async choose(streamId) {
        const pick = this.pick;
        if (!pick) return;
        const error = document.getElementById('links-pick-error');
        if (error) error.textContent = '';
        try {
            await API.links.addManual(pick.channel.sourceId, pick.channel.key, pick.provider.backupSourceId, streamId);
            document.getElementById('modal')?.classList.remove('active');
            this.pick = null;
            await this.refreshAfterChange();
            this.setStatus(`Linked ${pick.channel.name} to ${pick.provider.name}`);
        } catch (err) {
            if (error) error.textContent = err.message || 'Could not save the link';
        }
    }
}

window.LinkFormat = LinkFormat;
window.BackupLinksSettings = BackupLinksSettings;
