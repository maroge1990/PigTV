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
        this.refresh();
        this.loadEpgCategories();
        clearInterval(this.timer);
        this.timer = setInterval(() => this.refresh(), this.refreshMs);
    }

    hide() {
        clearInterval(this.timer);
        this.timer = null;
    }

    async refresh() {
        const content = document.getElementById('status-content');
        const updated = document.getElementById('status-updated');
        try {
            const status = await API.status.get();
            if (content) content.innerHTML = this.render(status);
            if (updated) updated.textContent = `Updated ${new Date(status.generatedAt || Date.now()).toLocaleTimeString()} · every 5 s`;
        } catch (err) {
            if (updated) updated.textContent = `Could not refresh: ${err.message}`;
            if (content && !content.querySelector('.status-section')) {
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
            ['Name', 'Role', 'State', 'Connections', 'Expires', 'Account'],
            providers.map(p => [
                e(p.name),
                e(p.role || 'primary'),
                `<span class="status-event ${stateClass(p.state)}">${e(p.state || 'up')}${p.downUntil ? ` until ${this.time(p.downUntil)}` : ''}</span>`,
                `${p.connections.used}/${p.connections.limit}`,
                expiryText(p),
                p.accountOk === null || p.accountOk === undefined ? 'not checked yet'
                    : p.accountOk ? '<span class="status-event status-success">OK</span>' : '<span class="status-event status-failure">Error</span>'
            ]),
            'No providers'));
    }

    render(status) {
        const e = (v) => this.escape(v);
        const out = [];

        out.push(this.renderRecordingsFolderWarning(status.recordingsFolder));

        // Providers (P8, 0175)
        out.push(this.renderProviders(status.providers));

        // Live sessions
        const sessions = status.sessions || [];
        out.push(this.section('Live sessions', this.table(
            ['Channel', 'Owner', 'Video / audio', 'Segments', 'Up', 'Idle', 'ffmpeg', ''],
            sessions.map(s => [
                `${e(s.channel)}${s.provider ? ` <span class="setting-hint">(${e(s.provider)})</span>` : ''}`, e(s.owner || '–'), `${e(s.video)} / ${e(s.audio)}`, e(s.segmentType || '–'),
                this.duration(s.uptimeSec), this.duration(s.idleSec),
                `${e(s.ffmpeg)}${s.error ? `<div class="setting-hint">${e(s.error)}</div>` : ''}`,
                `<button type="button" class="btn btn-sm btn-danger" data-kill-session="${e(s.id)}" title="Stop this stream and free its provider connection">Stop</button>`
            ]),
            'Nothing is playing')
            // 0189: what in-stream recovery is doing (PIGTV_RELAY=1), one line per stream.
            + ((status.relay && status.relay.enabled) ? `<p class="setting-hint">In-stream recovery is on${status.relay.standby ? ', with a hot standby' : ''}. `
                + ((status.relay.streams || []).map(r => `${e(r.channel || 'A channel')}: on ${e(r.provider)}${r.switches ? ` after ${e(r.switches)} switch${r.switches === 1 ? '' : 'es'}` : ''}`
                    + `${r.standby ? `, standby on ${e(r.standby)} (${r.standbyReady ? 'ready' : 'starting'})` : (status.relay.standby ? ', no standby' : '')}`).join('; ') || 'Nothing followed.') + '</p>' : '')
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
            out.push(this.section('Interruptions', `<p class="setting-hint">${line}</p>` + this.table(
                ['When', 'Channel', 'Provider', 'What happened', 'After playing', 'Back in'],
                (ix.recent || []).map(r => [
                    this.when(r.at), e(r.channel || '–'), e(r.provider || '–'),
                    e(r.how === 'stall' ? 'Stopped sending' : r.how === 'timestamps' ? 'Timestamps broke after a reconnect' : (r.providerReason ? 'Provider dropped it' : 'Stream ended')),
                    this.duration(r.playedSec),
                    r.recoverSec === null ? '<span class="status-event status-failure">Not recovered</span>'
                        : `${e(r.recoverSec)} s${r.recoveredProvider && r.recoveredProvider !== r.provider ? ` <span class="setting-hint">(on ${e(r.recoveredProvider)})</span>` : ''}`
                ]),
                'None')));
        }

        // Recordings
        const rec = status.recordings || { active: [], upcoming: [] };
        const recRow = (r) => [e(r.title), `${e(r.channel || '–')}${r.provider ? ` <span class="setting-hint">(${e(r.provider)})</span>` : ''}`, e(r.status), `${this.when(r.programStart)} – ${this.time(r.programEnd).slice(0, 5)}`];
        out.push(this.section('Recordings',
            `<h4>Recording now</h4>${this.table(['Programme', 'Channel', 'Status', 'Time'], (rec.active || []).map(recRow), 'Nothing is recording')}` +
            `<h4>Next scheduled</h4>${this.table(['Programme', 'Channel', 'Status', 'Time'], (rec.upcoming || []).map(recRow), 'Nothing scheduled')}`));

        // Recent problems (0156): missed/failed schedules from the last 7 days, so a
        // silent overnight failure shows up here instead of only in docker logs.
        out.push(this.section('Recent problems', this.table(
            ['Programme', 'Channel', 'Status', 'Time', 'Reason'],
            (status.recentProblems || []).map(r => [
                e(r.title), e(r.channel || '–'),
                `<span class="status-event status-failure">${e(r.status === 'missed' ? 'Missed' : 'Failed')}</span>`,
                `${this.when(r.programStart)} – ${this.time(r.programEnd).slice(0, 5)}`,
                e(r.error || '')
            ]),
            'No missed or failed recordings in the last 7 days')));

        // Recent plays
        const label = { 'play-start': 'Started', 'play-end': 'Ended', failure: 'Failed' };
        out.push(this.section('Recent plays', this.table(
            ['Time', 'Event', 'Channel', 'Owner', 'Start', 'First picture', 'Detail'],
            (status.events || []).map(ev => [
                this.time(ev.at),
                `<span class="status-event status-${e(ev.type)}">${e(label[ev.type] || ev.type)}</span>`,
                e(ev.channel || 'unknown'), e(ev.owner || '–'), e(ev.start || '–'),
                ev.firstPictureSec !== null && ev.firstPictureSec !== undefined ? `${ev.firstPictureSec.toFixed(1)}s` : '–',
                ev.type === 'failure' ? e(ev.reason || '')
                    : ev.type === 'play-end' ? `watched ${this.duration(ev.watchedSec)}, ${ev.stalls ?? 0} stall${ev.stalls === 1 ? '' : 's'}`
                        : e([ev.strategy, ev.videoMode].filter(Boolean).join(', '))
            ]),
            'No plays since the server started')));

        // Sport fixtures (0161, C-I): ESPN's real kickoff/session times, per league.
        out.push(this.renderSportFixtures(status.sportFixtures));

        // Least reliable channels (0133, C-G): failed starts and (0142) stalls over the last 7 days
        out.push(this.section('Least reliable channels', this.table(
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
        out.push(this.section('Sync', this.table(
            ['Source', 'Type', 'Feed', 'Status', 'Last sync', 'Error'],
            (status.sync || []).flatMap(src => (src.feeds && src.feeds.length ? src.feeds : [{ type: '–', status: 'never synced' }]).map(f => [
                `${e(src.name)}${src.enabled ? '' : ' <span class="setting-hint">(disabled)</span>'}`, e(src.type), e(f.type), e(f.status || '–'),
                this.when(f.lastSync), e(f.error || '')
            ])),
            'No sources')));

        // Disk
        const disk = status.disk || {};
        const diskRow = (name, d) => [e(name), d && d.available ? this.bytes(d.freeBytes) : 'unavailable', d && d.available ? this.bytes(d.totalBytes) : '–'];
        out.push(this.section('Disk', this.table(['Volume', 'Free', 'Size'],
            [diskRow('Transcode cache', disk.transcodeCache), diskRow('Recordings', disk.recordings)], '')));

        // Build
        const b = status.build || {};
        out.push(this.section('Build', `<p class="setting-hint">${e(b.display || '')}${b.builtAt ? ` · built ${e(new Date(b.builtAt).toLocaleString())}` : ''}</p>`));

        return out.join('');
    }
}

window.StatusPage = StatusPage;
