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
        this.initSettingsPanel();
    }

    initSettingsPanel() {
        const toggle = document.getElementById('dvr-settings-toggle');
        const panel = document.getElementById('dvr-settings-panel');
        const saveBtn = document.getElementById('dvr-settings-save');
        if (!toggle || !panel || !saveBtn) return;

        toggle.addEventListener('click', async () => {
            const showing = panel.style.display !== 'none';
            if (!showing) {
                await this.loadDvrSettings();
                await this.loadContentVisibility();
            }
            panel.style.display = showing ? 'none' : 'block';
        });

        saveBtn.addEventListener('click', () => this.saveDvrSettings());

        const cvSave = document.getElementById('content-visibility-save');
        if (cvSave) cvSave.addEventListener('click', () => this.saveContentVisibility());
    }

    async loadContentVisibility() {
        try {
            const settings = await API.settings.get();
            document.getElementById('setting-show-movies').checked = settings.showMovies !== false;
            document.getElementById('setting-show-series').checked = settings.showSeries !== false;
        } catch (err) {
            console.error('Failed to load content visibility:', err);
        }
    }

    async saveContentVisibility() {
        try {
            await API.settings.update({
                showMovies: document.getElementById('setting-show-movies').checked,
                showSeries: document.getElementById('setting-show-series').checked
            });
            if (window.app) await window.app.applyContentVisibility();
        } catch (err) {
            alert('Failed to save: ' + err.message);
        }
    }

    async loadDvrSettings() {
        try {
            const settings = await API.settings.get();
            document.getElementById('dvr-setting-path').value = settings.recordingsPath || '/app/recordings';
            document.getElementById('dvr-setting-pre').value = settings.defaultPreBufferMin ?? 1;
            document.getElementById('dvr-setting-post').value = settings.defaultPostBufferMin ?? 5;
            document.getElementById('dvr-setting-max').value = settings.maxConcurrentRecordings ?? 1;
            document.getElementById('dvr-setting-minfree').value = settings.minFreeSpaceGB ?? 10;
        } catch (err) {
            console.error('Failed to load DVR settings:', err);
        }
    }

    async saveDvrSettings() {
        try {
            await API.settings.update({
                recordingsPath: document.getElementById('dvr-setting-path').value.trim() || '/app/recordings',
                defaultPreBufferMin: parseInt(document.getElementById('dvr-setting-pre').value, 10) || 0,
                defaultPostBufferMin: parseInt(document.getElementById('dvr-setting-post').value, 10) || 0,
                maxConcurrentRecordings: parseInt(document.getElementById('dvr-setting-max').value, 10) || 1,
                minFreeSpaceGB: Math.max(0, parseInt(document.getElementById('dvr-setting-minfree').value, 10) || 0)
            });
            document.getElementById('dvr-settings-panel').style.display = 'none';
        } catch (err) {
            alert(`Failed to save DVR settings: ${err.message}`);
        }
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
            this.renderRecordings(items);
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

    play(id) {
        this.closePlayer();

        const overlay = document.createElement('div');
        overlay.className = 'recording-player-overlay';
        overlay.innerHTML = `
            <div class="recording-player-box">
                <button class="recording-player-close">&times;</button>
                <video controls autoplay src="${API.recordings.streamUrl(id)}"></video>
            </div>
        `;
        overlay.querySelector('.recording-player-close').addEventListener('click', () => this.closePlayer());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.closePlayer();
        });

        document.body.appendChild(overlay);
        this._playerOverlay = overlay;
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
