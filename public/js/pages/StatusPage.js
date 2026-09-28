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
    }

    async init() { }

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

    render(status) {
        const e = (v) => this.escape(v);
        const out = [];

        out.push(this.renderRecordingsFolderWarning(status.recordingsFolder));

        // Live sessions
        out.push(this.section('Live sessions', this.table(
            ['Channel', 'Owner', 'Video / audio', 'Segments', 'Up', 'Idle', 'ffmpeg'],
            (status.sessions || []).map(s => [
                e(s.channel), e(s.owner || '–'), `${e(s.video)} / ${e(s.audio)}`, e(s.segmentType || '–'),
                this.duration(s.uptimeSec), this.duration(s.idleSec),
                `${e(s.ffmpeg)}${s.error ? `<div class="setting-hint">${e(s.error)}</div>` : ''}`
            ]),
            'Nothing is playing')));

        // Recordings
        const rec = status.recordings || { active: [], upcoming: [] };
        const recRow = (r) => [e(r.title), e(r.channel || '–'), e(r.status), `${this.when(r.programStart)} – ${this.time(r.programEnd).slice(0, 5)}`];
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

        // Least reliable channels (0133, C-G): failed starts and (0142) stalls over the last 7 days
        out.push(this.section('Least reliable channels', this.table(
            ['Channel', 'Attempts', 'Failures', 'Stalls', 'Watched', 'Median first picture', 'Health'],
            (status.leastReliable || []).map(ch => [
                e(ch.name), e(ch.attempts), e(ch.failures),
                ch.stallsPerHour !== null && ch.stallsPerHour !== undefined ? `${e(ch.stalls)} (${Number(ch.stallsPerHour).toFixed(1)}/h)` : e(ch.stalls ?? 0),
                ch.watchedMin !== null && ch.watchedMin !== undefined ? `${Math.round(ch.watchedMin)} min` : '–',
                ch.medianFirstPictureSec !== null && ch.medianFirstPictureSec !== undefined ? `${Number(ch.medianFirstPictureSec).toFixed(1)}s` : '–',
                ch.health === 'flaky' ? '<span class="status-event status-failure">Flaky</span>' : e(ch.health || '–')
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
