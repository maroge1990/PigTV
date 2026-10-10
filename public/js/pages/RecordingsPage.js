/**
 * Recordings (DVR) Page Controller
 * Shows scheduled recordings and the recorded library, with basic playback,
 * download, and delete actions.
 */
class RecordingsPage {
    constructor(app) {
        this.app = app;
        this.scheduledList = document.getElementById('scheduled-recordings-list');
        this.recordingsList = document.getElementById('recordings-list');
        this.recentProblemsSection = document.getElementById('recent-problems-section');
        this.recentProblemsList = document.getElementById('recent-problems-list');
        this._refreshTimer = null;
        this.init();
    }

    init() {
    }

    async show() {
        await this.refresh();
        // Keep the list reasonably fresh while the page is open (status changes
        // as scheduled recordings start/finish)
        this._refreshTimer = setInterval(() => this.refresh(), 30000);
    }

    hide() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }

    async refresh() {
        await Promise.all([this.loadScheduled(), this.loadRecordings()]);
    }

    async loadScheduled() {
        try {
            // 0156: include=recent also returns missed/failed schedules from the last
            // 7 days, so a silent overnight failure (like schedule #3's "0.0 GB free")
            // stays visible here instead of simply vanishing.
            const items = await API.recordings.getScheduledWithRecent();
            const upcoming = items.filter(x => x.status !== 'missed' && x.status !== 'failed');
            const recent = items.filter(x => x.status === 'missed' || x.status === 'failed');
            this.renderScheduled(upcoming);
            this.renderRecentProblems(recent);
        } catch (err) {
            console.error('Failed to load scheduled recordings:', err);
            this.scheduledList.innerHTML = `<div class="empty-state"><p>Failed to load scheduled recordings</p></div>`;
        }
    }

    async loadRecordings() {
        try {
            const items = await API.recordings.getAll();
            const wasActive = (this.recordings || []).some(
                r => ['running', 'pending'].includes(r.compress_status)
                  || ['running', 'pending'].includes(r.ad_detect_status)
            );
            this.recordings = items;
            this.renderRecordings(items);
            if (!wasActive && !this._compressTimer) this.resumeCompressionWatchIfNeeded();
        } catch (err) {
            console.error('Failed to load recordings:', err);
            this.recordingsList.innerHTML = `<div class="empty-state"><p>Failed to load recordings</p></div>`;
        }
    }

    renderScheduled(items) {
        if (!items || items.length === 0) {
            this.scheduledList.innerHTML = `<div class="empty-state"><p>No upcoming recordings</p><p class="hint">Click a program in the TV Guide and choose Record</p></div>`;
            return;
        }

        this.scheduledList.innerHTML = items.map(item => `
            <div class="recording-item" data-id="${item.id}">
                <img class="recording-thumb" src="${this.proxiedLogo(item.channel_logo)}" alt=""
                     onerror="this.onerror=null;this.src='/img/placeholder.png'">
                <div class="recording-info">
                    <div class="recording-title">${this.escape(item.title)}</div>
                    <div class="recording-meta">${this.escape(item.channel_name || '')} &middot; <span class="pig-amount">${this.formatRange(item.program_start, item.program_end)}</span></div>
                    <div class="recording-status status-${item.status}">${this.statusLabel(item.status)}</div>
                </div>
                <div class="recording-actions">
                    <button class="btn btn-sm btn-secondary" data-action="cancel" data-id="${item.id}">
                        ${item.status === 'recording' ? 'Stop' : 'Cancel'}
                    </button>
                </div>
            </div>
        `).join('');

        this.scheduledList.querySelectorAll('[data-action="cancel"]').forEach(btn => {
            btn.addEventListener('click', () => this.cancelScheduled(btn.dataset.id));
        });
    }

    // 0156: schedules that ended up missed or failed in the last 7 days. Only shown
    // at all when there is something to show - most of the time there is nothing.
    renderRecentProblems(items) {
        if (!this.recentProblemsSection || !this.recentProblemsList) return;
        if (!items || items.length === 0) {
            this.recentProblemsSection.hidden = true;
            this.recentProblemsList.innerHTML = '';
            return;
        }
        this.recentProblemsSection.hidden = false;
        this.recentProblemsList.innerHTML = items.map(item => `
            <div class="recording-item" data-id="${item.id}">
                <img class="recording-thumb" src="${this.proxiedLogo(item.channel_logo)}" alt=""
                     onerror="this.onerror=null;this.src='/img/placeholder.png'">
                <div class="recording-info">
                    <div class="recording-title">${this.escape(item.title)}</div>
                    <div class="recording-meta">${this.escape(item.channel_name || '')} &middot; <span class="pig-amount">${this.formatRange(item.program_start, item.program_end)}</span></div>
                    <div class="recording-status status-${item.status}">${this.statusLabel(item.status)}</div>
                    ${item.error ? `<div class="recording-error">${this.escape(item.error)}</div>` : ''}
                </div>
                <div class="recording-actions">
                    <button class="btn btn-sm btn-danger" data-action="delete-scheduled" data-id="${item.id}">Delete</button>
                </div>
            </div>
        `).join('');

        this.recentProblemsList.querySelectorAll('[data-action="delete-scheduled"]').forEach(btn => {
            btn.addEventListener('click', () => this.deleteProblem(btn.dataset.id));
        });
    }

    renderRecordings(items) {
        if (!items || items.length === 0) {
            this.recordingsList.innerHTML = `<div class="empty-state"><p>No recordings yet</p></div>`;
            return;
        }

        this.recordingsList.innerHTML = items.map(item => `
            <div class="recording-item" data-id="${item.id}">
                <img class="recording-thumb" src="${this.proxiedLogo(item.channel_logo)}" alt=""
                     onerror="this.onerror=null;this.src='/img/placeholder.png'">
                <div class="recording-info">
                    <div class="recording-title">${this.escape(item.title)}</div>
                    <div class="recording-meta">
                        ${this.escape(item.channel_name || '')} &middot;
                        ${item.part > 1 ? `Part ${Number(item.part)}${item.provider_name ? ` (${this.escape(item.provider_name)})` : ''} &middot;` : ''}
                        ${item.started_at ? `<span class="pig-amount">${new Date(item.started_at).toLocaleString()}</span>` : ''} &middot;
                        <span class="pig-amount">${this.formatSize(item.file_size_bytes)}</span>
                    </div>
                    <div class="recording-status status-${item.status}">${this.statusLabel(item.status)}</div>
                    ${item.status === 'failed' && item.error ? `<div class="recording-error">${this.escape(item.error)}</div>` : ''}
                    ${this.progressHtml(item)}
                </div>
                <div class="recording-actions">
                    ${item.is_partial ? `<span class="small muted" style="margin-right:8px;" title="${
                        item.missed_start_ms > 30000
                            ? `Missing the first ${Math.round(item.missed_start_ms / 60000)} minutes`
                            : 'Stopped before the programme ended'
                    }">Partial</span>` : ''}
                    ${item.ad_detect_status === 'running' ? '<span class="small muted" style="margin-right:8px;">Finding breaks…</span>' : ''}
                    ${item.ad_detect_status === 'done' ? '<span class="small muted" style="margin-right:8px;">Breaks marked</span>' : ''}
                    ${item.ad_detect_status === 'failed' ? `<span class="small muted" style="margin-right:8px;" title="${(item.ad_detect_error || '').replace(/"/g, '&quot;')}">Break detection failed</span>` : ''}
                    ${item.compress_status === 'running' ? '<span class="small muted" style="margin-right:8px;">Compressing…</span>' : ''}
                    ${item.compress_status === 'pending' ? '<span class="small muted" style="margin-right:8px;">Queued to compress</span>' : ''}
                    ${item.compress_status === 'done' ? '<span class="small muted" style="margin-right:8px;">Compressed</span>' : ''}
                    ${item.compress_status === 'failed' ? `<span class="small muted" style="margin-right:8px;" title="${(item.compress_error || '').replace(/"/g, '&quot;')}">Compression failed</span>` : ''}
                    ${item.status === 'completed' && !['running', 'pending', 'done'].includes(item.compress_status)
                        ? `<button class="btn btn-sm btn-secondary" data-action="compress" data-id="${item.id}">Compress</button>` : ''}
                    ${item.status === 'completed' ? `<button class="btn btn-sm btn-primary" data-action="play" data-id="${item.id}">Play</button>` : ''}
                    ${item.status === 'completed' ? `<a class="btn btn-sm btn-secondary" href="${API.recordings.downloadUrl(item.id)}">Download</a>` : ''}
                    <button class="btn btn-sm btn-danger" data-action="delete" data-id="${item.id}">Delete</button>
                </div>
            </div>
        `).join('');

        this.recordingsList.querySelectorAll('[data-action="play"]').forEach(btn => {
            btn.addEventListener('click', () => this.play(btn.dataset.id));
        });
        this.recordingsList.querySelectorAll('[data-action="delete"]').forEach(btn => {
            btn.addEventListener('click', () => this.deleteRecording(btn.dataset.id));
        });
        this.recordingsList.querySelectorAll('[data-action="compress"]').forEach(btn => {
            btn.addEventListener('click', () => this.compress(btn.dataset.id, btn));
        });
    }

    async compress(id, btn) {
        try {
            if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
            await API.recordings.compress(id);
            // The server starts work immediately, so refresh straight away to
            // pick up 'running' rather than leaving the row reading 'queued'
            // for the length of a poll interval.
            await this.refresh();
            this.startCompressionWatch();
        } catch (err) {
            alert('Could not start compression: ' + err.message);
            if (btn) { btn.disabled = false; btn.textContent = 'Compress'; }
        }
    }

    startCompressionWatch() {
        if (this._compressTimer) clearInterval(this._compressTimer);
        this._compressTimer = setInterval(async () => {
            // Only refresh while this page is actually on screen.
            if (this.recordingsList && this.recordingsList.offsetParent === null) return;
            await this.refresh();
            const stillGoing = (this.recordings || []).some(
                r => ['running', 'pending'].includes(r.compress_status)
                  || ['running', 'pending'].includes(r.ad_detect_status)
            );
            if (!stillGoing) {
                clearInterval(this._compressTimer);
                this._compressTimer = null;
            }
        }, 4000);
    }

    /**
     * Resume watching after a page load if the server is mid-compression, so
     * the status is live whether or not this browser started the job.
     */
    resumeCompressionWatchIfNeeded() {
        const active = (this.recordings || []).some(
            r => ['running', 'pending'].includes(r.compress_status)
              || ['running', 'pending'].includes(r.ad_detect_status)
        );
        if (active) this.startCompressionWatch();
    }

    async cancelScheduled(id) {
        if (!confirm('Cancel this recording?')) return;
        try {
            await API.recordings.cancelScheduled(id);
            await this.refresh();
        } catch (err) {
            alert(`Failed to cancel: ${err.message}`);
        }
    }

    // 0207: a failed or missed schedule from "Recent problems": the server deletes it along
    // with its failed recordings and their files, so the library is refreshed as well.
    async deleteProblem(id) {
        if (!confirm('Delete this failed recording? Any partial file is removed too. This cannot be undone.')) return;
        try {
            await API.recordings.cancelScheduled(id);
            await this.refresh();
        } catch (err) {
            alert(`Failed to delete: ${err.message}`);
        }
    }

    // 0207: this login's progress through a recording: a thin bar part-way through, a label
    // once watched. Nothing for one not started.
    progressHtml(item) {
        if (item.status !== 'completed') return '';
        if (item.watched) return '<div class="recording-watched">Watched</div>';
        const position = Number(item.position_sec) || 0;
        const duration = Number(item.duration_sec) || 0;
        if (position <= 0 || duration <= 0) return '';
        const percent = Math.min(100, Math.max(1, Math.round((position / duration) * 100)));
        return `<div class="recording-progress" title="${this.formatClock(position)} watched"><span style="width:${percent}%"></span></div>`;
    }

    // H:MM:SS
    formatClock(sec) {
        const total = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    async deleteRecording(id) {
        if (!confirm('Delete this recording? This cannot be undone.')) return;
        try {
            await API.recordings.delete(id);
            await this.loadRecordings();
        } catch (err) {
            alert(`Failed to delete: ${err.message}`);
        }
    }

    async play(id) {
        this.closePlayer();

        const overlay = document.createElement('div');
        overlay.className = 'recording-player-overlay';
        overlay.innerHTML = `
            <div class="recording-player-box">
                <button class="recording-player-close">&times;</button>
                <video controls></video>
                <div class="ad-markers" aria-hidden="true"></div>
                <button class="skip-ad-btn" hidden>Skip ad</button>
            </div>
        `;
        overlay.querySelector('.recording-player-close').addEventListener('click', () => this.closePlayer());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.closePlayer();
        });

        document.body.appendChild(overlay);
        this._playerOverlay = overlay;

        // 0207: where this login stopped last time. Asked before anything plays; a failure
        // to read it just means playing from the start.
        let resumeAt = 0;
        try {
            const pos = await API.recordings.getPosition(id);
            if (pos && pos.position_sec > 10 && !pos.watched) resumeAt = await this.askResume(overlay, pos.position_sec);
        } catch (err) { /* play from the start */ }
        if (resumeAt === null || this._playerOverlay !== overlay) return; // closed while asking

        const video = overlay.querySelector('video');
        if (resumeAt > 0) {
            video.addEventListener('loadedmetadata', () => { video.currentTime = resumeAt; }, { once: true });
        }
        video.autoplay = true;
        video.src = API.recordings.streamUrl(id);

        this.trackPosition(overlay, video, id);
        this.attachAdSkipping(overlay, id);
    }

    /**
     * Resume or start over. Resolves with the seconds to start at (0 = start over), or null
     * if the player was closed without choosing.
     */
    askResume(overlay, positionSec) {
        return new Promise((resolve) => {
            const box = overlay.querySelector('.recording-player-box');
            const panel = document.createElement('div');
            panel.className = 'resume-choice';
            panel.innerHTML = `
                <p>Continue where you left off?</p>
                <div class="resume-choice-actions">
                    <button class="btn btn-primary" data-choice="resume">Resume from ${this.formatClock(positionSec)}</button>
                    <button class="btn btn-secondary" data-choice="restart">Start over</button>
                </div>
            `;
            box.insertBefore(panel, box.firstChild);
            const settle = (value) => { panel.remove(); resolve(value); };
            panel.querySelector('[data-choice="resume"]').addEventListener('click', () => settle(positionSec));
            panel.querySelector('[data-choice="restart"]').addEventListener('click', () => settle(0));
            this._resumePrompt = () => settle(null);
        });
    }

    /** Save the position every ~10 s while playing, on pause, and on close (failures ignored). */
    trackPosition(overlay, video, id) {
        // Closing pauses the video and clears its source; the pause event lands after that,
        // when currentTime reads 0, so once closed nothing more is saved.
        let closed = false;
        const save = () => {
            if (closed || !Number.isFinite(video.currentTime)) return;
            API.recordings.setPosition(id, Math.floor(video.currentTime)).catch(() => {});
        };
        const timer = setInterval(() => { if (!video.paused && !video.ended) save(); }, 10000);
        video.addEventListener('pause', save);
        this._positionTracker = { timer, save, close: () => { closed = true; } };
    }

    /**
     * Show detected commercial breaks and let them be skipped.
     *
     * The button only exists while playback is inside a break, so it is absent
     * the rest of the time rather than being another permanent control. The
     * markers on the scrub bar matter during tuning: they are how you judge
     * whether detection got it right, which is hard to tell from a button that
     * may simply never appear.
     */
    async attachAdSkipping(overlay, id) {
        const video = overlay.querySelector('video');
        const button = overlay.querySelector('.skip-ad-btn');
        const strip = overlay.querySelector('.ad-markers');
        if (!video || !button) return;

        let markers = [];
        let autoSkip = false;

        try {
            const [data, settings] = await Promise.all([
                API.recordings.getMarkers(id),
                API.settings.get().catch(() => ({}))
            ]);
            markers = (data.markers || []).map(m => ({ start: m.startMs / 1000, end: m.endMs / 1000 }));
            autoSkip = settings.adAutoSkip === true;
        } catch (err) {
            return; // no markers is simply a player without the feature
        }

        if (markers.length === 0) return;

        const paint = () => {
            const total = video.duration;
            if (!Number.isFinite(total) || total <= 0) return;
            strip.innerHTML = markers.map(m => {
                const left = (m.start / total) * 100;
                const width = Math.max(0.3, ((m.end - m.start) / total) * 100);
                return `<span style="left:${left}%;width:${width}%"></span>`;
            }).join('');
        };
        video.addEventListener('loadedmetadata', paint);
        if (video.readyState >= 1) paint();

        const currentBreak = (t) => markers.find(m => t >= m.start && t < m.end - 0.4);

        video.addEventListener('timeupdate', () => {
            const active = currentBreak(video.currentTime);
            if (!active) {
                button.hidden = true;
                return;
            }
            if (autoSkip) {
                video.currentTime = active.end;
                return;
            }
            const left = Math.max(1, Math.round(active.end - video.currentTime));
            button.textContent = `Skip ad · ${left}s`;
            button.hidden = false;
        });

        button.addEventListener('click', () => {
            const active = currentBreak(video.currentTime);
            if (active) video.currentTime = active.end;
            button.hidden = true;
        });
    }

    closePlayer() {
        if (this._resumePrompt) { const settle = this._resumePrompt; this._resumePrompt = null; settle(); }
        if (this._positionTracker) {
            clearInterval(this._positionTracker.timer);
            this._positionTracker.save(); // before the video is torn down
            this._positionTracker.close();
            this._positionTracker = null;
        }
        if (this._playerOverlay) {
            const video = this._playerOverlay.querySelector('video');
            if (video) { video.pause(); video.src = ''; }
            this._playerOverlay.remove();
            this._playerOverlay = null;
        }
    }

    // A recording scheduled since 0121 (or by the Apple client) stores the library's
    // /api/logo/ path; an older one may hold the provider's own logo URL, used as is
    // (the server's image passthrough went in 0122).
    proxiedLogo(url) {
        return url || '/img/placeholder.png';
    }

    formatRange(startMs, endMs) {
        const start = new Date(startMs);
        const end = new Date(endMs);
        const dateStr = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
        const startStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const endStr = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `${dateStr}, ${startStr} - ${endStr}`;
    }

    formatSize(bytes) {
        if (!bytes) return '';
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1) return `${gb.toFixed(2)} GB`;
        const mb = bytes / (1024 * 1024);
        return `${mb.toFixed(0)} MB`;
    }

    statusLabel(status) {
        const labels = {
            scheduled: 'Scheduled',
            waiting: 'Waiting for viewer',
            recording: 'Recording',
            completed: 'Completed',
            failed: 'Failed',
            cancelled: 'Cancelled',
            missed: 'Missed'
        };
        return labels[status] || status;
    }

    escape(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }
}

window.RecordingsPage = RecordingsPage;
