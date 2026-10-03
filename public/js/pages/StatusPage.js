/**
 * Status Page (admin; 0124, roadmap W2.2)
 *
 * What the server is doing now, from GET /api/status: live sessions, recordings,
 * the last plays (first-picture times, cold/warm/profile starts, failures), sync
 * health per source, free disk, and the build. Refreshed every 5 seconds while
 * the page is shown, and not at all when it is not.
 */

class StatusPage {
    constructor(app) {
        this.app = app;
        this.timer = null;
        this.refreshMs = 5000;
        this.shown = false;
        this.rendered = new Map(); // R16: section key -> the html last drawn, so an unchanged section is left alone
        // R16: nothing is polled while the tab is hidden; on return it refreshes at once.
        document.addEventListener?.('visibilitychange', () => {
            if (!this.shown) return;
            if (document.hidden) this.stopTimer();
            else this.start();
        });
        // 0182: stopping a stuck stream moved here from Settings -> Debug. The table is rebuilt
        // every 5 s, so the buttons are handled where they bubble to.
        document.getElementById('status-content')?.addEventListener('click', (e) => {
            const button = e.target?.closest?.('button[data-kill-session], button[data-kill-all]');
            if (button) this.kill(button);
        });
    }

    async init() { }

    async kill(button) {
        const all = button.dataset.killAll !== undefined;
        if (all && !confirm('Stop every live stream? Anyone watching is cut off; recordings are not affected.')) return;
        button.disabled = true;
        try {
            if (all) await API.transcode.killAllSessions();
            else await API.transcode.killSession(button.dataset.killSession);
        } catch (err) {
            alert(`Could not stop the stream: ${err.message}`);
        }
        await this.refresh();
    }

    show() {
        this.shown = true;
        this.loadEpgCategories();
        if (document.hidden) return; // refreshed when the tab is next visible
        this.start();
    }

    start() {
        this.refresh();
        this.stopTimer();
        this.timer = setInterval(() => this.refresh(), this.refreshMs);
    }

    stopTimer() {
        clearInterval(this.timer);
        this.timer = null;
    }

    hide() {
        this.shown = false;
        this.stopTimer();
    }

    /**
     * R16: draw only the sections whose html changed. Falls back to one full draw when the set of
     * sections changed or a section's element is missing. An open <details> inside a redrawn
     * section stays open, and the scroll position is put back.
     */
    paint(content, status) {
        const parts = this.parts(status);
        const keys = parts.map(p => p[0]).join('|');
        const sameShape = this.rendered.size === parts.length && [...this.rendered.keys()].join('|') === keys;
        const scroller = content.closest?.('.page') || content.parentElement || null;
        const top = scroller ? scroller.scrollTop : 0;
        const open = [...(content.querySelectorAll?.('details') || [])].map(d => !!d.open);
        let changed = 0;
        const wrap = (k, html) => `<div class="status-part" data-status-section="${k}">${html}</div>`;
        if (!sameShape) {
            content.innerHTML = parts.map(([k, html]) => wrap(k, html)).join('');
            changed = parts.length;
        } else {
            for (const [k, html] of parts) {
                if (this.rendered.get(k) === html) continue;
                const el = content.querySelector?.(`[data-status-section="${k}"]`);
                if (!el) { content.innerHTML = parts.map(([kk, h]) => wrap(kk, h)).join(''); changed = parts.length; break; }
                el.innerHTML = html;
                changed++;
            }
        }
        this.rendered = new Map(parts);
        if (changed) {
            const now = content.querySelectorAll?.('details') || [];
            [...now].forEach((d, i) => { if (open[i]) d.open = true; });
            if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
        }
        return changed;
    }

    async refresh() {
        const content = document.getElementById('status-content');
        const updated = document.getElementById('status-updated');
        try {
            const status = await API.status.get();
            if (content) this.paint(content, status);
            if (updated) updated.textContent = `Updated ${new Date(status.generatedAt || Date.now()).toLocaleTimeString()} · every 5 s`;
        } catch (err) {
            if (updated) updated.textContent = `Could not refresh: ${err.message}`;
            if (content && !content.querySelector('.status-section')) {
                this.rendered = new Map();
                content.innerHTML = `<p class="hint">Could not load the server status: ${this.escape(err.message)}</p>`;
            }
        }
    }

    /**
     * 0147: the EPG categories the provider's guide tags programmes with, and how
     * many programmes carry each (GET /api/sports/categories). What sport can be
     * recognised by. Its own panel, loaded once per visit: it changes only when an
     * EPG sync lands, and the 5 s refresh would close it every time.
     */
    async loadEpgCategories() {
        const panel = document.getElementById('status-epg-categories');
        if (!panel) return;
        try {
            const rows = await API.sports.categories();
            panel.innerHTML = this.renderEpgCategories(Array.isArray(rows) ? rows : []);
        } catch (err) {
            panel.innerHTML = this.section('EPG categories', `<p class="setting-hint">Could not load the EPG categories: ${this.escape(err.message)}</p>`);
        }
    }

    renderEpgCategories(rows) {
        const e = (v) => this.escape(v);
        if (!rows.length) {
            return this.section('EPG categories', '<p class="setting-hint">The guide has no programme categories (or has not synced since the server was updated).</p>');
        }
        const table = this.table(['Category', 'Programmes'], rows.map(r => [e(r.category), e(r.programmes)]), '');
        return this.section('EPG categories',
            `<p class="setting-hint">The categories your provider's guide gives its programmes, most used first: one of the ways sport is recognised.</p>` +
            `<details class="status-epg-categories"><summary>${rows.length} categor${rows.length === 1 ? 'y' : 'ies'}</summary>${table}</details>`);
    }

    escape(text) {
        return String(text ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    }

    duration(sec) {
        if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–';
        const s = Math.max(0, Math.round(sec));
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ${s % 60}s`;
        return `${Math.floor(m / 60)}h ${m % 60}m`;
    }

    time(ms) {
        return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';
    }

    when(ms) {
        if (!ms) return 'never';
        const d = new Date(ms);
        const today = new Date();
        return d.toDateString() === today.toDateString()
            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    bytes(n) {
        if (!Number.isFinite(n)) return '–';
        const gb = n / (1024 ** 3);
        return gb >= 1 ? `${gb.toFixed(gb >= 100 ? 0 : 1)} GB` : `${Math.round(n / (1024 ** 2))} MB`;
    }

    /** R12: what in-stream recovery and the hot standby are doing, and each followed stream. */
    renderRelay(relay) {
        const e = (v) => this.escape(v);
        if (!relay) return '';
        const mode = `In-stream recovery is ${relay.enabled ? 'on' : 'off'}; hot standby is ${relay.enabled && relay.standby ? 'on' : 'off'}. `
            + '<span class="setting-hint">(Settings, Transcoding. A change applies to plays started afterwards.)</span>';
        const streams = relay.streams || [];
        if (!streams.length) return `<p class="setting-hint">${mode}${relay.enabled ? 'No stream is being followed.' : ''}</p>`;
        return `<p class="setting-hint">${mode}</p>` + this.table(
            ['Channel', 'Provider', 'State', 'Switches', 'Standby', 'Last reason'],
            streams.map(r => [
                e(r.channel || 'A channel'), e(r.provider || '–'),
                `<span class="status-event ${r.state === 'failed' ? 'status-failure' : ''}">${e(r.state)}</span>`,
                e(r.switches),
                r.standby ? `${e(r.standby)} (${r.standbyReady ? 'ready' : 'starting'})` : (r.standbyMode ? 'none' : 'off'),
                r.lastReason ? `${e(r.lastReason.code)} <span class="setting-hint">${this.when(r.lastReason.at)}</span>` : '–'
            ]), 'Nothing followed');
    }

    section(title, body) {
        return `<div class="settings-section status-section"><h3>${this.escape(title)}</h3>${body}</div>`;
    }

    table(headers, rows, empty) {
        if (!rows.length) return `<p class="setting-hint">${this.escape(empty)}</p>`;
        return `<div class="user-list-container"><table class="user-table status-table">
            <thead><tr>${headers.map(h => `<th>${this.escape(h)}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>`;
    }

    // 0157: a clear warning when the recordings folder itself is the problem -
    // missing, not writable, or (the case that actually happened live) an
    // unmounted network share reading back as a near-empty filesystem.
    renderRecordingsFolderWarning(folder) {
        if (!folder || folder.ok !== false) return '';
        const e = (v) => this.escape(v);
        const reasons = {
            missing: `does not exist: ${e(folder.root)}`,
            'not-writable': `is not writable: ${e(folder.root)}`,
            tiny: `isn't reachable: only ${this.bytes(folder.freeBytes)} free at ${e(folder.root)}. Is the network share connected?`,
            'low-space': `is low on space: only ${this.bytes(folder.freeBytes)} free at ${e(folder.root)}`
        };
        const reason = reasons[folder.problem] || `is not usable: ${e(folder.root)}`;
        return `<div class="settings-section status-section status-warning">
            <h3>Recordings folder</h3>
            <p class="setting-hint">The recordings folder ${reason}</p>
        </div>`;
    }

    /** Sport fixtures (0161): per league, last successful fetch, fixture count, last error. */
    renderSportFixtures(fx) {
        const e = (v) => this.escape(v);
        if (!fx || !fx.enabled) {
            return this.section('Sport fixtures', '<p class="setting-hint">Off (PIGTV_SPORT_FIXTURES=0): live/replay relies on the heuristics only.</p>');
        }
        return this.section('Sport fixtures', this.table(
            ['League', 'Last fetched', 'Fixtures', 'Last error'],
            (fx.leagues || []).map(l => [e(l.league), this.when(l.lastSuccessAt), e(l.fixtureCount ?? '–'), e(l.lastError || '')]),
            'Nothing fetched yet (no followed league ESPN covers, or the first refresh has not run)'));
    }

    /** R16: what each connection is for. The purpose is shown as the server sent it, so a new one (warm) just appears. */
    renderUses(uses) {
        if (!Array.isArray(uses) || !uses.length) return '<span class="setting-hint">idle</span>';
        const e = (v) => this.escape(v);
        const cls = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return `<span class="status-uses">${uses.map(u =>
            `<span class="status-use status-use-${e(cls(u.purpose))}" title="${e(u.channel || '')}">${e(u.purpose)}${u.channel ? ` · ${e(u.channel)}` : ''}</span>`).join('')}</span>`;
    }

    /** R16: preparation queue (0193), sport event builds (0195) and the server's event-loop lateness. */
    renderHealth(status) {
        const e = (v) => this.escape(v);
        const ms = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '–' : `${Math.round(Number(v) * 10) / 10} ms`);
        const metric = (label, value) => `<span class="status-metric">${e(label)} <b>${value}</b></span>`;
        const html = [];
        const ld = status.loopDelay;
        if (ld) {
            const row = (name, h) => h ? metric(name, `p50 ${ms(h.p50)} · p99 ${ms(h.p99)} · max ${ms(h.max)}`) : '';
            html.push(`<h4>Server event loop (lateness)</h4><div class="status-metrics">${row('Last minute', ld.lastMinute)}${row('Since start', ld.sinceStart)}</div>`);
        }
        const prep = status.preparation;
        if (prep && prep.counts) {
            const c = prep.counts;
            const cur = prep.current ? `Preparing now: ${e(prep.current.title || `recording ${prep.current.id}`)}.` : 'Nothing being prepared.';
            html.push(`<h4>Recording preparation</h4><div class="status-metrics">${metric('Waiting', e(c.pending))}${metric('Preparing', e(c.preparing))}${metric('Ready', e(c.ready))}${metric('Failed', e(c.failed))}</div>`
                + `<p class="setting-hint">${prep.enabled === false ? 'Preparation is switched off. ' : ''}${cur}</p>`
                + (prep.lastError ? `<p class="setting-hint"><span class="status-event status-failure">Last error</span> ${e(prep.lastError.title || '')}: ${e(prep.lastError.error)}</p>` : ''));
        }
        const se = status.sportEvents;
        if (se) {
            const stale = se.staleSinceMs ? this.duration(se.staleSinceMs / 1000) : 'fresh';
            html.push(`<h4>Sport event builds</h4><div class="status-metrics">${metric('Builds', e(se.builds ?? 0))}${metric('Last build', ms(se.lastBuildMs))}${metric('Worst loop delay in it', ms(se.lastMaxLoopDelayMs))}${metric('Served list', e(stale))}${se.building ? metric('Building', 'now') : ''}</div>`);
        }
        return html.length ? this.section('Server load and background work', html.join('')) : '';
    }

    renderProviders(providers) {
        const e = (v) => this.escape(v);
        if (!providers || !providers.length) {
            return this.section('Providers', '<p class="setting-hint">No providers configured.</p>');
        }
        const stateClass = (state) => {
            if (state === 'down') return 'status-failure';
            if (state === 'half-open') return 'status-warning';
            return 'status-success';
        };
        const expiryText = (prov) => {
            if (!prov.expiresAt) return 'unknown';
            if (prov.expired) return '<span class="status-event status-failure">Expired</span>';
            const d = new Date(prov.expiresAt);
            const days = prov.daysLeft !== undefined ? prov.daysLeft : Math.ceil((prov.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
            return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} (${days}d)`;
        };
        return this.section('Providers', this.table(
            ['Name', 'Role', 'State', 'Connections', 'In use for', 'Expires', 'Account'],
            providers.map(p => [
                e(p.name),
                e(p.role || 'primary'),
                `<span class="status-event ${stateClass(p.state)}">${e(p.state || 'up')}${p.downUntil ? ` until ${this.time(p.downUntil)}` : ''}</span>`,
                `${p.connections.used}/${p.connections.limit}`,
                this.renderUses(p.uses),
                expiryText(p),
                p.accountOk === null || p.accountOk === undefined ? 'not checked yet'
                    : p.accountOk ? '<span class="status-event status-success">OK</span>' : '<span class="status-event status-failure">Error</span>'
            ]),
            'No providers'));
    }

    render(status) {
        return this.parts(status).map(([k, html]) => `<div class="status-part" data-status-section="${k}">${html}</div>`).join('');
    }

    /** R16: the page as [key, html] pairs, one per section, so an unchanged one is not redrawn. */
    parts(status) {
        const e = (v) => this.escape(v);
        const out = [];
        const add = (key, html) => out.push([key, html]);

        add('folder', this.renderRecordingsFolderWarning(status.recordingsFolder));

        // Providers (P8, 0175)
        add('providers', this.renderProviders(status.providers));

        // Live sessions
        const sessions = status.sessions || [];
        add('sessions', this.section('Live sessions', this.table(
            ['Channel', 'Owner', 'Video / audio', 'Segments', 'Up', 'Idle', 'ffmpeg', ''],
            sessions.map(s => [
                `${e(s.channel)}${s.provider ? ` <span class="setting-hint">(${e(s.provider)})</span>` : ''}`, e(s.owner || '–'), `${e(s.video)} / ${e(s.audio)}`, e(s.segmentType || '–'),
                this.duration(s.uptimeSec), this.duration(s.idleSec),
                `${e(s.ffmpeg)}${s.error ? `<div class="setting-hint">${e(s.error)}</div>` : ''}`,
                `<button type="button" class="btn btn-sm btn-danger" data-kill-session="${e(s.id)}" title="Stop this stream and free its provider connection">Stop</button>`
            ]),
            'Nothing is playing')
            + this.renderRelay(status.relay)
            + (sessions.length > 1 ? '<p><button type="button" class="btn btn-sm btn-danger" data-kill-all>Stop all streams</button></p>' : '')));

        // Interruptions (0188): the measure any recovery change is judged against.
        const ix = status.interruptions;
        if (ix) {
            const secs = (v) => (v === null || v === undefined ? '–' : `${Math.round(v)} s`);
            const line = ix.count === 0
                ? `No stream was lost mid-play in the last ${ix.days} days (${e(ix.watchedHours)} h watched).`
                : `${e(ix.count)} lost mid-play in the last ${ix.days} days over ${e(ix.watchedHours)} h watched`
                    + `${ix.perHour === null ? '' : ` (${e(ix.perHour)} per hour)`}; ${e(ix.recovered)} came back, `
                    + `typically in ${secs(ix.medianRecoverSec)}, at worst ${secs(ix.worstRecoverSec)}.`;
            add('interruptions', this.section('Interruptions', `<p class="setting-hint">${line}</p>` + this.table(
                ['When', 'Channel', 'Provider', 'What happened', 'After playing', 'Back in'],
                (ix.recent || []).map(r => [
                    this.when(r.at), e(r.channel || '–'), e(r.provider || '–'),
                    (r.reason ? `<span class="setting-hint">${e(r.reason)}</span> ` : '') + e(r.how === 'stall' ? 'Stopped sending' : r.how === 'timestamps' ? 'Timestamps broke after a reconnect' : (r.providerReason ? 'Provider dropped it' : 'Stream ended')),
                    this.duration(r.playedSec),
                    r.recoverSec === null ? '<span class="status-event status-failure">Not recovered</span>'
                        : `${e(r.recoverSec)} s${r.recoveredProvider && r.recoveredProvider !== r.provider ? ` <span class="setting-hint">(on ${e(r.recoveredProvider)})</span>` : ''}`
                ]),
                'None')));
        }

        // Recordings
        const rec = status.recordings || { active: [], upcoming: [] };
        const recRow = (r) => [e(r.title), `${e(r.channel || '–')}${r.provider ? ` <span class="setting-hint">(${e(r.provider)})</span>` : ''}`, e(r.status), `${this.when(r.programStart)} – ${this.time(r.programEnd).slice(0, 5)}`];
        add('recordings', this.section('Recordings',
            `<h4>Recording now</h4>${this.table(['Programme', 'Channel', 'Status', 'Time'], (rec.active || []).map(recRow), 'Nothing is recording')}` +
            `<h4>Next scheduled</h4>${this.table(['Programme', 'Channel', 'Status', 'Time'], (rec.upcoming || []).map(recRow), 'Nothing scheduled')}`));

        // Recent problems (0156): missed/failed schedules from the last 7 days, so a
        // silent overnight failure shows up here instead of only in docker logs.
        add('problems', this.section('Recent problems', this.table(
            ['Programme', 'Channel', 'Status', 'Time', 'Reason'],
            (status.recentProblems || []).map(r => [
                e(r.title), e(r.channel || '–'),
                `<span class="status-event status-failure">${e(r.status === 'missed' ? 'Missed' : 'Failed')}</span>`,
                `${this.when(r.programStart)} – ${this.time(r.programEnd).slice(0, 5)}`,
                e(r.error || '')
            ]),
            'No missed or failed recordings in the last 7 days')));

        // Recent plays
        const label = { 'play-start': 'Started', 'play-end': 'Ended', failure: 'Failed', relay: 'Recovery' };
        add('plays', this.section('Recent plays', this.table(
            ['Time', 'Event', 'Channel', 'Owner', 'Start', 'First picture', 'Detail'],
            (status.events || []).map(ev => [
                this.time(ev.at),
                `<span class="status-event status-${e(ev.type)}">${e(label[ev.type] || ev.type)}</span>`,
                e(ev.channel || 'unknown'), e(ev.owner || '–'), e(ev.start || '–'),
                ev.firstPictureSec !== null && ev.firstPictureSec !== undefined ? `${ev.firstPictureSec.toFixed(1)}s` : '–',
                ev.type === 'failure' || ev.type === 'relay' ? e(ev.reason || '')
                    : ev.type === 'play-end' ? `watched ${this.duration(ev.watchedSec)}, ${ev.stalls ?? 0} stall${ev.stalls === 1 ? '' : 's'}`
                        : e([ev.strategy, ev.videoMode].filter(Boolean).join(', '))
            ]),
            'No plays since the server started')));

        // Sport fixtures (0161, C-I): ESPN's real kickoff/session times, per league.
        add('fixtures', this.renderSportFixtures(status.sportFixtures));

        // Least reliable channels (0133, C-G): failed starts and (0142) stalls over the last 7 days
        add('reliable', this.section('Least reliable channels', this.table(
            ['Channel', 'Attempts', 'Failures', 'Stalls', 'Watched', 'Median first picture', 'Health'],
            (status.leastReliable || []).map(ch => [
                e(ch.name), e(ch.attempts), e(ch.failures),
                ch.stallsPerHour !== null && ch.stallsPerHour !== undefined ? `${e(ch.stalls)} (${Number(ch.stallsPerHour).toFixed(1)}/h)` : e(ch.stalls ?? 0),
                ch.watchedMin !== null && ch.watchedMin !== undefined ? `${Math.round(ch.watchedMin)} min` : '–',
                ch.medianFirstPictureSec !== null && ch.medianFirstPictureSec !== undefined ? `${Number(ch.medianFirstPictureSec).toFixed(1)}s` : '–',
                (ch.health === 'flaky' ? '<span class="status-event status-failure">Flaky</span>' : e(ch.health || '–'))
                    + (ch.blank ? ' <span class="status-event status-failure">Blank picture</span>' : '')
            ]),
            'No failed starts or stalls in the last 7 days')));

        // Sync
        add('health', this.renderHealth(status));

        add('sync', this.section('Sync', this.table(
            ['Source', 'Type', 'Feed', 'Status', 'Last sync', 'Error'],
            (status.sync || []).flatMap(src => (src.feeds && src.feeds.length ? src.feeds : [{ type: '–', status: 'never synced' }]).map(f => [
                `${e(src.name)}${src.enabled ? '' : ' <span class="setting-hint">(disabled)</span>'}`, e(src.type), e(f.type), e(f.status || '–'),
                this.when(f.lastSync), e(f.error || '')
            ])),
            'No sources')));

        // Disk
        const disk = status.disk || {};
        const diskRow = (name, d) => [e(name), d && d.available ? this.bytes(d.freeBytes) : 'unavailable', d && d.available ? this.bytes(d.totalBytes) : '–'];
        add('disk', this.section('Disk', this.table(['Volume', 'Free', 'Size'],
            [diskRow('Transcode cache', disk.transcodeCache), diskRow('Recordings', disk.recordings)], '')));

        // Build
        const b = status.build || {};
        add('build', this.section('Build', `<p class="setting-hint">${e(b.display || '')}${b.builtAt ? ` · built ${e(new Date(b.builtAt).toLocaleString())}` : ''}</p>`));

        return out;
    }
}

window.StatusPage = StatusPage;
