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
            const items = await API.recordings.getScheduled();
            this.renderScheduled(items);
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
                    <div class="recording-meta">${this.escape(item.channel_name || '')} &middot; ${this.formatRange(item.program_start, item.program_end)}</div>
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
                        ${item.started_at ? new Date(item.started_at).toLocaleString() : ''} &middot;
                        ${this.formatSize(item.file_size_bytes)}
                    </div>
                    <div class="recording-status status-${item.status}">${this.statusLabel(item.status)}</div>
                    ${item.status === 'failed' && item.error ? `<div class="recording-error">${this.escape(item.error)}</div>` : ''}
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
                <video controls autoplay src="${API.recordings.streamUrl(id)}"></video>
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

        this.attachAdSkipping(overlay, id);
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
        if (this._playerOverlay) {
            const video = this._playerOverlay.querySelector('video');
            if (video) { video.pause(); video.src = ''; }
            this._playerOverlay.remove();
            this._playerOverlay = null;
        }
    }

    proxiedLogo(url) {
        if (!url) return '/img/placeholder.png';
        if (window.location.protocol === 'https:' && url.startsWith('http://')) {
            return `/api/proxy/image?url=${encodeURIComponent(url)}`;
        }
        return url;
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
