/**
 * #63: first run. Live TV shows this checklist where the empty channel list was, for an admin, until the first
 * provider's first sync has worked: add a provider, test it, the first sync, guide matching, pairing an Apple TV. Each
 * step ticks off from what the server already says (no setup state of its own, apart from a passed connection test,
 * which this browser remembers). Once channels are listed, ChannelList draws them instead and this is gone; the steps
 * still open after the first sync (guide matching, pairing) stay as a slim banner above the list until both are done
 * or the admin closes it (Mark, 15 Nov 2026). The closing is kept per account in this browser's localStorage: the
 * server has no per-account preference store that fits (/api/settings is global, the sport preferences are sport's).
 *
 * Reads GET /api/sources/providers and /status, /api/epg/mappings and /unmatched?limit=1, /api/devices; runs
 * POST /api/sources/:id/test and /:id/sync. ProviderFormat (pages/ProvidersSettings.js) words the sync's state and
 * paces the polls.
 */

class FirstRun {
    /** `onSynced` runs when the first sync finishes while the checklist is on screen (ChannelList reloads its list). */
    constructor({ onSynced } = {}) {
        this.onSynced = onSynced || (() => {});
        this.gen = 0;
        this.timer = null;
        this.polls = 0;
        this.testing = false;
        this.testResult = null; // { ok, text } of the last test run here
    }

    /** Whether the person signed in is an admin (only an admin can add a provider). */
    static isAdmin() {
        return window.app?.currentUser?.role === 'admin';
    }

    /** The provider that is first: the primary, else the first one (an install from before roles). */
    static primaryOf(providers) {
        const list = (Array.isArray(providers) ? providers : []).filter(p => p.type !== 'epg');
        return list.find(p => p.role === 'primary') || list.find(p => p.role !== 'backup') || list[0] || null;
    }

    /** The id of the provider whose connection test passed in this browser, or null. */
    static testedId() {
        try { return localStorage.getItem('pigtv_first_run_tested'); } catch { return null; }
    }

    static rememberTested(id) {
        try { localStorage.setItem('pigtv_first_run_tested', String(id)); } catch { /* only a tick is lost */ }
    }

    /** What the server says, for steps(). Each read that fails leaves its part unknown (null) rather than failing all. */
    static async read() {
        const [providers, statuses] = await Promise.all([API.sources.providers(), API.sources.getStatus().catch(() => null)]);
        const primary = FirstRun.primaryOf(providers);
        const row = primary && Array.isArray(statuses)
            ? statuses.find(r => r.source_id === primary.id && r.type === 'all') || null : null;
        const synced = Boolean(row && row.status === 'success');
        const [mappings, unmatched, devices] = await Promise.all([
            synced ? API.epg.mappings().catch(() => null) : null,
            synced ? API.request('GET', '/epg/unmatched?limit=1').catch(() => null) : null,
            API.request('GET', '/devices').catch(() => null)
        ]);
        return {
            primary, row,
            tested: Boolean(primary && String(FirstRun.testedId()) === String(primary.id)),
            mappings: Array.isArray(mappings) ? mappings.length : null,
            unmatched: unmatched && Number.isFinite(unmatched.total) ? unmatched.total : null,
            devices: Array.isArray(devices) ? devices.length : null
        };
    }

    /** Shown while there is no provider, or the first one has not synced yet. */
    static shouldShow(facts) {
        return !facts.primary || !(facts.row && facts.row.status === 'success');
    }

    /** The banner's key: one per account, so another admin on this browser still sees it. */
    static bannerKey() {
        return `pigtv_first_run_banner_closed:${window.app?.currentUser?.username || window.app?.currentUser?.id || ''}`;
    }

    static bannerClosed() {
        try { return localStorage.getItem(FirstRun.bannerKey()) === '1'; } catch { return false; }
    }

    static closeBanner() {
        try { localStorage.setItem(FirstRun.bannerKey(), '1'); } catch { /* it shows again next time */ }
    }

    /**
     * After the first sync: the steps still open of guide matching and pairing, for the banner above the channel list
     * ([] when there is nothing to show: not synced yet, both done, or the banner was closed).
     */
    static bannerSteps(facts, { closed = false } = {}) {
        if (closed || !facts || FirstRun.shouldShow(facts)) return [];
        return FirstRun.steps(facts).filter(s => (s.key === 'guide' || s.key === 'device') && !s.done);
    }

    static bannerHtml(steps) {
        const e = UI.escape;
        return `<div class="first-run-banner" role="region" aria-label="Finish setting up">
            <span class="first-run-banner-text">Finish setting up:</span>
            ${steps.map(s => `<button type="button" class="btn btn-sm btn-secondary" data-first-run="${e(s.action.run)}">${e(s.title)}</button>`).join('')}
            <button type="button" class="first-run-banner-close" data-first-run-close aria-label="Close the setup steps" title="Close the setup steps">&times;</button>
        </div>`;
    }

    /**
     * Put the banner at the top of `container` (ChannelList, after drawing its channels), when it is due. Reads at most
     * once a minute however often the list redraws (a search redraws on every key).
     */
    async banner(container, { now = Date.now() } = {}) {
        if (!FirstRun.isAdmin() || FirstRun.bannerClosed()) return;
        const mine = (this.bannerGen = (this.bannerGen || 0) + 1);
        if (!this.bannerFacts || now - this.bannerReadAt > 60000) {
            try {
                this.bannerFacts = await FirstRun.read();
                this.bannerReadAt = now;
            } catch (err) {
                console.error('First run: the setup steps could not be read:', err);
                return;
            }
        }
        if (mine !== this.bannerGen) return; // the list was drawn again meanwhile; that draw puts its own
        const steps = FirstRun.bannerSteps(this.bannerFacts, { closed: FirstRun.bannerClosed() });
        if (!steps.length) return;
        container.querySelector?.('.first-run-banner')?.remove?.();
        const el = document.createElement('div');
        el.innerHTML = FirstRun.bannerHtml(steps);
        const box = el.firstElementChild || el;
        box.querySelectorAll?.('[data-first-run]').forEach(b => b.addEventListener('click', () => this.act(b.dataset.firstRun, container, b)));
        box.querySelector?.('[data-first-run-close]')?.addEventListener('click', () => { FirstRun.closeBanner(); box.remove?.(); });
        container.insertBefore(box, container.firstChild);
    }

    /** The five steps, in order: { key, title, detail, done, action: { label, run } | null, busy }. */
    static steps(facts, { testing = false, testResult = null, now = Date.now() } = {}) {
        const { primary, row } = facts;
        const synced = Boolean(row && row.status === 'success');
        const syncing = Boolean(row && row.status === 'syncing');
        const syncText = row && typeof ProviderFormat !== 'undefined' ? ProviderFormat.formatSync(row, now).text : '';
        const tested = facts.tested || synced;
        const guideDone = (facts.mappings || 0) > 0 || (synced && facts.unmatched === 0);
        return [
            {
                key: 'provider', title: 'Add a provider', done: Boolean(primary),
                detail: primary ? `${primary.name} is added.` : 'Your provider\'s Xtream login or M3U address.',
                action: primary ? null : { label: 'Add a provider', run: 'provider' }
            },
            {
                key: 'test', title: 'Test the connection', done: tested,
                detail: testing ? 'Testing…'
                    : testResult ? testResult.text
                        : tested ? 'The provider answered.' : 'Checks that the address and login work.',
                error: Boolean(testResult && !testResult.ok),
                action: !primary || tested || testing ? null : { label: 'Test connection', run: 'test' }
            },
            {
                key: 'sync', title: 'First sync', done: synced, busy: syncing,
                detail: synced ? 'Your channels are in.'
                    : syncing ? `${syncText}. A large list can take a while; you can leave this page.`
                        : row ? syncText
                            : primary ? 'Starts by itself once the provider is added.' : 'Starts once a provider is added.',
                error: Boolean(row && (row.status === 'error' || row.status === 'held')),
                action: row && (row.status === 'error' || row.status === 'held') ? { label: 'Sync again', run: 'sync' } : null
            },
            {
                key: 'guide', title: 'Match channels to the guide', done: guideDone,
                detail: guideDone ? 'Channels are matched to the guide.' : 'Most match by themselves; the rest you pick by hand.',
                action: guideDone ? null : { label: 'Open guide matching', run: 'guide' }
            },
            {
                key: 'device', title: 'Pair an Apple TV', done: (facts.devices || 0) > 0,
                detail: (facts.devices || 0) > 0 ? 'A device is paired.' : 'Open PigTV on the Apple TV and type the code it shows.',
                action: (facts.devices || 0) > 0 ? null : { label: 'Pair a device', run: 'device' }
            }
        ];
    }

    static html(steps) {
        const e = UI.escape;
        const current = steps.findIndex(s => !s.done);
        const items = steps.map((s, i) => {
            const state = s.done ? 'is-done' : i === current ? 'is-current' : 'is-waiting';
            const button = s.action
                ? `<button type="button" class="btn btn-sm ${i === current ? 'btn-primary' : 'btn-secondary'}" data-first-run="${e(s.action.run)}">${e(s.action.label)}</button>`
                : '';
            return `<li class="first-run-step ${state}${s.busy ? ' is-busy' : ''}" data-step="${e(s.key)}">
                <span class="first-run-mark" aria-hidden="true">${s.done ? '' : i + 1}</span>
                <div class="first-run-text">
                    <strong class="first-run-step-title">${e(s.title)}</strong>${s.done ? '<span class="visually-hidden"> (done)</span>' : ''}
                    <span class="first-run-detail${s.error ? ' error' : ''}">${e(s.detail)}</span>
                    ${button}
                </div>
            </li>`;
        }).join('');
        return `<section class="first-run" aria-labelledby="first-run-title">
            <h2 class="first-run-title" id="first-run-title">Set up PigTV</h2>
            <p class="first-run-lead">A few steps, and your channels show here.</p>
            <ol class="first-run-steps">${items}</ol>
        </section>`;
    }

    /** Stop drawing into the list (it has channels now, or is drawing something else). */
    stop() {
        this.gen++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    /**
     * Draw into `container`: the checklist when it is due, else the empty state `fallback` ChannelList would have shown.
     * Re-reads while it is on screen: as ProviderFormat paces a running sync, and every 15 s otherwise, so a step done
     * in Settings ticks off here.
     */
    async show(container, fallback) {
        this.stop();
        const mine = this.gen;
        this.container = container;
        this.fallback = fallback;
        if (!container.querySelector?.('.first-run')) UI.setState(container, 'loading');
        let facts;
        try {
            facts = await FirstRun.read();
        } catch (err) {
            console.error('First run: the providers could not be read:', err);
            if (mine === this.gen) UI.setState(container, 'empty', fallback);
            return;
        }
        if (mine !== this.gen) return;
        if (!FirstRun.shouldShow(facts)) {
            if (this.facts && FirstRun.shouldShow(this.facts)) { this.facts = facts; this.onSynced(); return; }
            this.facts = facts;
            UI.setState(container, 'empty', fallback);
            return;
        }
        this.facts = facts;
        this.draw(container);
        const syncing = Boolean(facts.row && facts.row.status === 'syncing') || (facts.primary && !facts.row);
        this.polls = syncing ? this.polls + 1 : 0;
        const wait = syncing && typeof ProviderFormat !== 'undefined' ? ProviderFormat.pollDelay(this.polls) : 15000;
        this.timer = setTimeout(() => this.again(mine), wait);
    }

    /** The next read, unless the list moved on; while the tab is in the background it waits instead of reading. */
    again(mine) {
        if (mine !== this.gen) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            this.timer = setTimeout(() => this.again(mine), 15000);
            return;
        }
        this.show(this.container, this.fallback);
    }

    draw(container) {
        container.innerHTML = FirstRun.html(FirstRun.steps(this.facts, { testing: this.testing, testResult: this.testResult }));
        container.querySelectorAll?.('[data-first-run]').forEach(button => {
            button.addEventListener('click', () => this.act(button.dataset.firstRun, container, button));
        });
    }

    async act(what, container, button) {
        const app = window.app;
        if (what === 'provider') return app?.navigateTo?.('settings', 'push', 'providers');
        if (what === 'guide') return app?.navigateTo?.('settings', 'push', 'channels/epg');
        if (what === 'device') {
            app?.navigateTo?.('settings', 'push', 'system');
            document.getElementById('tab-devices')?.scrollIntoView?.({ block: 'start' });
            document.getElementById('pair-code')?.focus?.();
            return;
        }
        const primary = this.facts?.primary;
        if (!primary) return;
        if (what === 'test') return this.test(primary, container);
        if (what === 'sync') {
            if (button) button.disabled = true;
            try {
                await API.sources.sync(primary.id);
            } catch (err) {
                UI.toast(UI.errorText(err, 'The sync could not be started.'), { kind: 'error' });
            }
            this.polls = 0;
            return this.show(container, this.fallback);
        }
    }

    async test(primary, container) {
        this.testing = true;
        this.testResult = null;
        this.draw(container);
        try {
            const result = await API.sources.test(primary.id);
            if (result && result.success) {
                FirstRun.rememberTested(primary.id);
                this.facts.tested = true;
                this.testResult = { ok: true, text: 'Connection successful.' };
            } else {
                const why = typeof ProviderFormat !== 'undefined'
                    ? ProviderFormat.safeText((result && (result.error || result.message)) || 'no reply') : 'no reply';
                this.testResult = { ok: false, text: `Connection failed: ${why}. Check the address and login under Settings → Providers.` };
            }
        } catch (err) {
            this.testResult = { ok: false, text: UI.errorText(err, 'The connection test could not be run.') };
        }
        this.testing = false;
        if (this.facts) this.draw(container);
    }
}

window.FirstRun = FirstRun;
