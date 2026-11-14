/**
 * Recordings (DVR) Page Controller
 * #276 (option B, 11 Nov 2026): Recorded as picture cards (one rose Play: the newest recording not yet watched), Coming
 * up as a strip of compact items, then Recording rules and Recent problems side by side. Each list draws its own
 * loading, empty and load-error state; when all three fail, one page-level block replaces them.
 * Deleting and cancelling happen at once with a 10-second Undo (UI.undoable): the item leaves the page, and the request
 * is sent only when the notice ends without Undo (a second delete ends the first one's notice, which sends it), or at
 * once, with keepalive, if the browser page is left or hidden or the person signs out first. Stop on a recording in
 * progress still confirms, and a cancel whose recording has started meanwhile is not sent.
 */
const REC_PLAY_ICON = '<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

class RecordingsPage {
    constructor(app) {
        this.app = app;
        const $ = (id) => document.getElementById(id);
        this.pageState = $('recordings-page-state');
        this.recordedSection = $('recorded-section');
        this.recordedCount = $('recorded-count');
        this.recordingsList = $('recordings-list');
        this.recordedFoot = $('recorded-foot');
        this.scheduledSection = $('scheduled-section');
        this.scheduledCount = $('scheduled-count');
        this.scheduledList = $('scheduled-recordings-list');
        this.rulesSection = $('rules-section');
        this.rulesCount = $('rules-count');
        this.rulesSub = $('rules-sub');
        this.rulesList = $('recording-rules-list'); // R5
        this.recentProblemsSection = $('recent-problems-section');
        this.recentProblemsList = $('recent-problems-list');
        this._refreshTimer = null;
        // What each list last answered (null: not yet) and whether its last load failed.
        this.data = { recordings: null, upcoming: null, recent: null, rules: null };
        this.failed = { recordings: false, scheduled: false, rules: false };
        // Deletes waiting for their Undo notice to end, by key: 'recording:3', 'schedule:7' (a cancel or a recent
        // problem: the same request), 'rule:2'. A pending item is never drawn, whatever a refresh brings back.
        this.pending = new Map();
        this.init();
    }

    init() {
        const form = document.getElementById('rule-add-form');
        if (form) form.addEventListener('submit', (e) => { e.preventDefault(); this.addSportRule(); });
        this.draw();
    }

    async show() {
        await this.refresh();
        // Keep the list reasonably fresh while the page is open (status changes
        // as scheduled recordings start/finish)
        // #239 (0485): not while the tab is hidden (the compression watch below likewise)
        this._refreshTimer = setInterval(() => { if (!document.hidden) this.refresh(); }, 30000);
    }

    hide() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }

    async refresh() {
        await Promise.all([this.fetchScheduled(), this.fetchRecordings(), this.fetchRules()]);
        this.draw();
    }

    async loadRules() { await this.fetchRules(); this.draw(); }
    async loadScheduled() { await this.fetchScheduled(); this.draw(); }
    async loadRecordings() { await this.fetchRecordings(); this.draw(); }

    async fetchRules() {
        try {
            this.data.rules = await API.recordings.getRules();
            this.failed.rules = false;
        } catch (err) {
            console.error('Failed to load recording rules:', err);
            this.failed.rules = true;
        }
    }

    async fetchScheduled() {
        try {
            // 0156: include=recent also returns missed/failed schedules from the last
            // 7 days, so a silent overnight failure (like schedule #3's "0.0 GB free")
            // stays visible here instead of simply vanishing.
            const items = await API.recordings.getScheduledWithRecent();
            this.data.upcoming = items.filter(x => x.status !== 'missed' && x.status !== 'failed');
            this.data.recent = items.filter(x => x.status === 'missed' || x.status === 'failed');
            this.failed.scheduled = false;
        } catch (err) {
            console.error('Failed to load scheduled recordings:', err);
            this.failed.scheduled = true;
        }
    }

    async fetchRecordings() {
        try {
            const items = await API.recordings.getAll();
            const wasActive = (this.recordings || []).some(
                r => ['running', 'pending'].includes(r.compress_status)
                  || ['running', 'pending'].includes(r.ad_detect_status)
            );
            this.recordings = items;
            this.data.recordings = items;
            this.failed.recordings = false;
            if (!wasActive && !this._compressTimer) this.resumeCompressionWatchIfNeeded();
        } catch (err) {
            console.error('Failed to load recordings:', err);
            this.failed.recordings = true;
        }
    }

    // Draw one list from given rows (also how the tests feed the page).
    renderRecordings(items) { this.data.recordings = items || []; this.failed.recordings = false; this.draw(); }
    renderScheduled(items) { this.data.upcoming = items || []; this.failed.scheduled = false; this.draw(); }
    renderRecentProblems(items) { this.data.recent = items || []; this.draw(); }
    renderRules(rules) { this.data.rules = rules || []; this.failed.rules = false; this.draw(); }

    // ---- drawing -------------------------------------------------------------

    /** Items of a list that are not waiting to be deleted. */
    visible(list, kind) {
        return (list || []).filter(x => !this.pending.has(`${kind}:${x.id}`));
    }

    draw() {
        // A refresh while a "⋯" menu is open would take its button away: draw when it closes instead.
        if (UI.menu && UI.menu.isOpen()) { this._drawWanted = true; return; }
        this._drawWanted = false;
        // #276 review: a redraw (the 30 s refresh, a delete sent) replaces the buttons; focus on one goes back to the
        // same button drawn again, never to the page.
        const had = typeof document !== 'undefined' ? document.activeElement : null;
        const keep = had && had.dataset && had.dataset.action && had.closest && had.closest('#page-recordings')
            ? { action: had.dataset.action, id: had.dataset.id } : null;
        this.drawLists();
        if (!keep || (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected !== false)) return;
        const page = document.getElementById('page-recordings');
        const again = page && page.querySelector && page.querySelector(`[data-action="${keep.action}"][data-id="${keep.id}"]`);
        if (again && again.focus) again.focus({ preventScroll: true });
    }

    drawLists() {
        const allFailed = this.failed.recordings && this.failed.scheduled && this.failed.rules;
        const sections = [this.recordedSection, this.scheduledSection, this.rulesSection, this.recentProblemsSection];
        if (this.pageState) this.pageState.hidden = !allFailed;
        if (allFailed) {
            sections.forEach(s => { if (s) s.hidden = true; });
            UI.setState(this.pageState, 'error', { title: 'Recordings could not be loaded', detail: 'The server did not answer. Nothing is lost: programmes already recorded are safe, and anything scheduled will still record. Live TV and the TV Guide still work.' },
                { run: () => this.refresh(), primary: true }, { className: 'rec-empty' });
            return;
        }
        if (this.pageState) this.pageState.innerHTML = '';
        if (this.recordedSection) this.recordedSection.hidden = false;
        if (this.rulesSection) this.rulesSection.hidden = false;
        this.drawRecorded();
        this.drawComingUp();
        this.drawRules();
        this.drawProblems();
    }

    drawRecorded() {
        const el = this.recordingsList;
        if (!el) return;
        const put = (node, html) => { if (node) node.innerHTML = html; };
        if (this.recordedFoot) this.recordedFoot.hidden = true;
        this.recordedSection?.classList?.toggle('is-empty', false);
        if (this.failed.recordings) {
            put(this.recordedCount, '');
            UI.setState(el, 'error', { title: 'The recorded programmes could not be loaded.', detail: 'Anything scheduled still records.' },
                { run: () => this.loadRecordings() });
            return;
        }
        if (this.data.recordings === null) {
            put(this.recordedCount, '<span class="rec-loading-text" role="status">Loading recordings…</span>');
            el.innerHTML = this.skeleton('tiles');
            return;
        }
        const items = this.visible(this.data.recordings, 'recording');
        if (!items.length) {
            put(this.recordedCount, '');
            this.recordedSection?.classList?.toggle('is-empty', true);
            UI.setState(el, 'empty', { title: 'No recordings yet', detail: 'Programmes you record appear here, ready to play. Find one in the TV Guide and choose Record.' },
                { label: 'Open the TV Guide', run: () => this.openGuide(), primary: true }, { className: 'rec-empty' });
            return;
        }
        put(this.recordedCount, `<span class="pig-amount">${items.length}</span> ${items.length === 1 ? 'programme' : 'programmes'}`);
        const primary = this.primaryId(items);
        el.innerHTML = `<div class="rec-grid">${items.map(item => this.tileHtml(item, primary)).join('')}</div>`;
        el.querySelectorAll('[data-action="play"]').forEach(btn => {
            btn.addEventListener('click', () => this.play(btn.dataset.id));
        });
        el.querySelectorAll('[data-action="watch"]').forEach(btn => {
            btn.addEventListener('click', () => this.play(btn.dataset.id, { watch: true }));
        });
        el.querySelectorAll('[data-action="delete"]').forEach(btn => {
            btn.addEventListener('click', () => this.deleteRecording(btn.dataset.id));
        });
        el.querySelectorAll('[data-action="more"]').forEach(btn => {
            UI.menu.attach(btn, () => this.menuItems(btn.dataset.id), {
                label: btn.getAttribute('aria-label'),
                onClose: () => { if (this._drawWanted) this.draw(); }
            });
        });
        // Nothing coming up: no empty Coming up box, one quiet line here instead.
        const upcoming = this.failed.scheduled || this.data.upcoming === null ? null : this.visible(this.data.upcoming, 'schedule');
        if (upcoming && !upcoming.length && this.recordedFoot) {
            this.recordedFoot.hidden = false;
            this.recordedFoot.innerHTML = 'Nothing is scheduled to record. Choose Record on a programme in the TV Guide.';
        }
    }

    /** The one rose Play: the newest completed recording not yet watched. */
    primaryId(items) {
        let best = null;
        for (const item of items) {
            if (item.status !== 'completed' || item.watched) continue;
            if (!best || (Number(item.started_at) || 0) > (Number(best.started_at) || 0)) best = item;
        }
        return best ? String(best.id) : null;
    }

    tileHtml(item, primaryId) {
        const e = UI.escape;
        const id = e(item.id);
        const tag = (text, tone) => `<span class="rec-tag${tone ? ` is-${tone}` : ''}">${e(text)}</span>`;
        const sep = '\u00a0<span class="rec-sep" aria-hidden="true">·</span> '; // a line may break after the dot

        // A programme image fills the picture; a channel logo (or the placeholder) sits whole on a plain surface.
        const logo = !item.image;
        const art = `<div class="rec-art${logo ? ' is-logo' : ''}"><img src="${e(this.proxiedLogo(item.image || item.channel_logo))}" alt="" loading="lazy"
            onerror="this.onerror=null;this.src='/img/placeholder.png';this.parentNode.classList.add('is-logo')"></div>`;

        const progress = this.progressOf(item);
        const bar = progress ? `<div class="rec-tile-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}" aria-label="Watched"><span style="width:${progress.percent}%"></span></div>` : '';

        const size = this.formatSize(item.file_size_bytes);
        const meta = [
            item.channel_name ? `<span class="rec-nw">${e(item.channel_name)}</span>` : '',
            item.part > 1 ? `Part <span class="pig-amount">${Number(item.part)}</span>${item.provider_name ? ` (${e(item.provider_name)})` : ''}` : '',
            item.started_at ? `<span class="pig-amount">${e(UI.dateTime(item.started_at))}</span>` : '',
            size ? `<span class="pig-amount">${size}</span>` : ''
        ].filter(Boolean).join(sep);

        const tags = [];
        if (item.status === 'completed') tags.push(tag('Completed', 'ok'));
        else if (item.status === 'failed') tags.push(tag('Failed', 'bad'));
        else if (item.status === 'recording') tags.push(tag('Recording', 'live'));
        else tags.push(tag(this.statusLabel(item.status)));
        if (item.is_partial) tags.push(tag('Partial', 'warn'));
        if (item.status === 'completed' && item.watched) tags.push(tag('Watched'));
        if (item.ad_detect_status === 'running') tags.push(tag('Finding breaks…'));
        if (item.ad_detect_status === 'done') tags.push(tag('Breaks marked'));
        if (item.ad_detect_status === 'failed') tags.push(tag('Break detection failed', 'bad'));
        if (item.compress_status === 'running') tags.push(tag('Compressing…'));
        if (item.compress_status === 'pending') tags.push(tag('Queued to compress'));
        if (item.compress_status === 'done') tags.push(tag('Compressed'));
        if (item.compress_status === 'failed') tags.push(tag('Compression failed', 'bad'));

        // The reasons are written in the card, never only in a hover title.
        const notes = [];
        if (item.is_partial) {
            const minutes = Math.round((Number(item.missed_start_ms) || 0) / 60000);
            const why = item.missed_start_ms > 30000
                ? `missing the first ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
                : 'stopped before the programme ended';
            notes.push(`<p class="rec-note"><b>Partial:</b> ${why}</p>`);
        }
        if (item.status === 'failed' && item.error) notes.push(`<p class="rec-err">${e(item.error)}</p>`);
        if (item.compress_status === 'failed' && item.compress_error) notes.push(`<p class="rec-err"><b>Compression failed:</b> ${e(item.compress_error)}</p>`);
        if (item.ad_detect_status === 'failed' && item.ad_detect_error) notes.push(`<p class="rec-err"><b>Break detection failed:</b> ${e(item.ad_detect_error)}</p>`);
        if (progress) notes.push(`<p class="rec-progress"><span class="pig-amount">${e(progress.left)}</span></p>`);

        const actions = item.status === 'failed'
            ? `<button type="button" class="btn btn-secondary" data-action="delete" data-id="${id}">Delete</button>`
            : (item.status === 'completed'
                ? `<button type="button" class="btn ${String(item.id) === primaryId ? 'btn-primary' : 'btn-secondary'} btn-play" data-action="play" data-id="${id}">${REC_PLAY_ICON}Play</button>`
                : (item.status === 'recording' && item.watch_live === true
                    ? `<button type="button" class="btn btn-secondary btn-play" data-action="watch" data-id="${id}">${REC_PLAY_ICON}Watch from start</button>`
                    : ''))
              + `<button type="button" class="btn btn-secondary btn-more" data-action="more" data-id="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${e(item.title)}">⋯</button>`;

        return `<article class="rec-tile" data-id="${id}">${art}${bar}<div class="rec-tile-body">
            <h4 class="rec-title" title="${e(item.title)}">${e(item.title)}</h4>
            <div class="rec-meta">${meta}</div>
            <div class="rec-tags">${tags.join('')}</div>
            ${notes.join('')}
            <div class="rec-actions">${actions}</div>
        </div></article>`;
    }

    /** What the "⋯" menu of a recording offers. */
    menuItems(id) {
        const item = (this.data.recordings || []).find(r => String(r.id) === String(id));
        if (!item) return [];
        const items = [];
        if (item.status === 'completed') {
            items.push({ label: 'Download', href: API.recordings.downloadUrl(item.id), download: true });
            if (!['running', 'pending', 'done'].includes(item.compress_status)) items.push({ label: 'Compress', run: () => this.compress(item.id) });
        }
        items.push({ label: 'Delete', run: () => this.deleteRecording(item.id), danger: true });
        return items;
    }

    drawComingUp() {
        const el = this.scheduledList;
        if (!el) return;
        const section = this.scheduledSection;
        const count = this.scheduledCount;
        const show = (on) => { if (section) section.hidden = !on; };
        if (count) count.innerHTML = '';
        if (this.failed.scheduled) {
            show(true);
            UI.setState(el, 'error', { title: 'What is coming up could not be loaded.', detail: 'Scheduled recordings still record.' },
                { run: () => this.loadScheduled() });
            return;
        }
        if (this.data.upcoming === null) { show(true); el.innerHTML = this.skeleton('chips'); return; }
        const items = this.visible(this.data.upcoming, 'schedule');
        if (!items.length) { show(false); el.innerHTML = ''; return; }
        show(true);
        if (count) count.innerHTML = `<span class="pig-amount">${items.length}</span> scheduled`;

        const e = UI.escape;
        // #12: a clash is shown on each schedule involved, never silent (D-28). D-42: the one scheduled first records
        // (`beatenBy` names who wins); the other waits until someone chooses it instead or cancels the winner.
        const titles = new Map((this.data.upcoming || []).map(i => [i.id, `${i.title} (${i.channel_name || 'unknown channel'})`]));
        const names = (ids) => e(ids.map(id => titles.get(id) || `schedule #${id}`).join(', '));
        const beaten = (item) => Array.isArray(item.beatenBy) && item.beatenBy.length > 0;
        const clash = (item) => {
            if (!Array.isArray(item.conflictsWith) || !item.conflictsWith.length) return '';
            if (beaten(item)) {
                return `<div class="rec-clash" data-clash>Clashes with ${names(item.beatenBy)}, which records instead: this one waits and is not recorded unless you choose it.</div>`;
            }
            return `<div class="rec-clash" data-clash>Clashes with ${names(item.conflictsWith)}: this one records${item.status === 'recording' ? '' : ' (scheduled first)'}; the other waits.</div>`;
        };
        const tag = (item) => {
            const t = (text, tone) => `<span class="rec-tag is-${tone}">${e(text)}</span>`;
            if (item.status === 'recording') return t('Recording', 'live');
            if (item.status === 'waiting') return t(item.error ? 'Waiting' : this.statusLabel('waiting'), 'warn');
            if (beaten(item)) return t('Clash: will not record', 'warn');
            return t(this.statusLabel(item.status), 'accent');
        };
        const when = (item) => item.status === 'recording'
            ? `Now, until ${UI.clock(item.program_end)}`
            : UI.dateTime(item.program_start);
        const sep = '\u00a0<span class="rec-sep" aria-hidden="true">·</span> '; // a line may break after the dot

        el.innerHTML = `<div class="rec-strip">${items.map(item => `
            <div class="rec-chip" data-id="${e(item.id)}">
                <div class="rec-when"><span class="pig-amount">${e(when(item))}</span>${item.channel_name ? `${sep}<span class="rec-nw">${e(item.channel_name)}</span>` : ''}</div>
                <div class="rec-title" title="${e(item.title)}">${e(item.title)}</div>
                ${item.status === 'waiting' && item.error ? `<p class="rec-note"><b>Waiting:</b> ${e(item.error)}</p>` : ''}
                ${clash(item)}
                <div class="rec-chip-foot">${tag(item)}<div class="rec-actions">${beaten(item) && item.status !== 'recording'
                    ? `<button type="button" class="btn btn-secondary" data-action="choose" data-id="${e(item.id)}">Record this one instead</button>` : ''}<button type="button" class="btn btn-secondary" data-action="cancel" data-id="${e(item.id)}">${item.status === 'recording' ? 'Stop' : 'Cancel'}</button></div></div>
            </div>`).join('')}</div>`;

        el.querySelectorAll('[data-action="cancel"]').forEach(btn => {
            btn.addEventListener('click', () => this.cancelScheduled(btn.dataset.id));
        });
        el.querySelectorAll('[data-action="choose"]').forEach(btn => {
            btn.addEventListener('click', () => this.chooseScheduled(btn.dataset.id));
        });
    }

    // ---- R5: recording rules -------------------------------------------------

    drawRules() {
        const el = this.rulesList;
        if (!el) return;
        if (this.rulesCount) this.rulesCount.innerHTML = '';
        if (this.rulesSub) this.rulesSub.hidden = true;
        if (this.failed.rules) {
            UI.setState(el, 'error', { title: 'The recording rules could not be loaded.', detail: 'Rules already made still record.' },
                { run: () => this.loadRules() });
            return;
        }
        if (this.data.rules === null) { el.innerHTML = this.skeleton('rows'); return; }
        const rules = this.visible(this.data.rules, 'rule');
        if (!rules.length) {
            if (this.rulesSub) this.rulesSub.hidden = false;
            el.innerHTML = '';
            return;
        }
        if (this.rulesCount) this.rulesCount.innerHTML = `<span class="pig-amount">${rules.length}</span> ${rules.length === 1 ? 'rule' : 'rules'}`;
        const e = UI.escape;
        el.innerHTML = `<ul class="rec-list">${rules.map(rule => {
            const what = rule.kind === 'series'
                ? `Series: ${e(rule.match)} on ${e(rule.channelName || 'its channel')}${rule.newOnly ? ' (new episodes only)' : ''}`
                : `Every game: ${e(rule.match)}`;
            const n = Number(rule.upcoming) || 0;
            const upcoming = n === 0 ? 'Nothing scheduled yet'
                : `<span class="pig-amount">${n}</span> ${n === 1 ? 'recording' : 'recordings'} scheduled`;
            return `
            <li class="rec-row" data-rule-id="${e(rule.id)}">
                <div class="rec-info">
                    <div class="rec-title">${what}</div>
                    <div class="rec-tags">${rule.enabled ? `<span class="rec-tag is-accent">On</span><span class="rec-meta">${upcoming}</span>` : '<span class="rec-tag">Off</span>'}</div>
                </div>
                <div class="rec-actions">
                    <button type="button" class="btn btn-secondary" data-action="toggle-rule" data-id="${e(rule.id)}" data-enabled="${rule.enabled}"
                        aria-pressed="${rule.enabled}">${rule.enabled ? 'Turn off' : 'Turn on'}</button>
                    <button type="button" class="btn btn-secondary" data-action="delete-rule" data-id="${e(rule.id)}">Delete</button>
                </div>
            </li>`;
        }).join('')}</ul>`;
        el.querySelectorAll('[data-action="toggle-rule"]').forEach(btn => {
            btn.addEventListener('click', () => this.toggleRule(btn.dataset.id, btn.dataset.enabled !== 'true'));
        });
        el.querySelectorAll('[data-action="delete-rule"]').forEach(btn => {
            btn.addEventListener('click', () => this.deleteRule(btn.dataset.id));
        });
    }

    async addSportRule() {
        const input = document.getElementById('rule-add-match');
        const status = document.getElementById('rule-add-status');
        const match = (input?.value || '').trim();
        if (!match) return;
        if (status) status.textContent = 'Adding…';
        try {
            const rule = await API.recordings.addRule({ kind: 'sport', match });
            if (input) input.value = '';
            if (status) status.textContent = rule.scheduled === 1 ? 'Added: 1 game scheduled' : `Added: ${rule.scheduled || 0} games scheduled`;
            await this.refresh();
        } catch (err) {
            if (status) status.textContent = UI.errorText(err, 'The rule was not added.');
        }
    }

    async toggleRule(id, enabled) {
        try {
            await API.recordings.updateRule(id, { enabled });
            await this.refresh();
        } catch (err) {
            UI.toast(UI.errorText(err, 'Could not change the rule.'), { kind: 'error' });
        }
    }

    // 0156: schedules that ended up missed or failed in the last 7 days. Only shown
    // at all when there is something to show - most of the time there is nothing.
    drawProblems() {
        const section = this.recentProblemsSection, list = this.recentProblemsList;
        if (!section || !list) return;
        const items = this.failed.scheduled ? [] : this.visible(this.data.recent, 'schedule');
        if (!items.length) {
            section.hidden = true;
            list.innerHTML = '';
            return;
        }
        section.hidden = false;
        const e = UI.escape;
        const sep = '\u00a0<span class="rec-sep" aria-hidden="true">·</span> '; // a line may break after the dot
        list.innerHTML = `<ul class="rec-list">${items.map(item => `
            <li class="rec-row" data-id="${e(item.id)}">
                <div class="rec-info">
                    <div class="rec-title">${e(item.title)}</div>
                    <div class="rec-meta">${item.channel_name ? `<span class="rec-nw">${e(item.channel_name)}</span>${sep}` : ''}<span class="pig-amount">${e(UI.dateRange(item.program_start, item.program_end))}</span></div>
                    <div class="rec-tags"><span class="rec-tag is-bad">${e(this.statusLabel(item.status))}</span></div>
                    ${item.error ? `<p class="rec-err">${e(item.error)}</p>` : ''}
                </div>
                <div class="rec-actions">
                    <button type="button" class="btn btn-secondary" data-action="delete-scheduled" data-id="${e(item.id)}">Delete</button>
                </div>
            </li>`).join('')}</ul>`;

        list.querySelectorAll('[data-action="delete-scheduled"]').forEach(btn => {
            btn.addEventListener('click', () => this.deleteProblem(btn.dataset.id));
        });
    }

    /** Placeholder shapes while a list loads: no text, hidden from screen readers (the one status line speaks). */
    skeleton(kind) {
        const sk = (cls) => `<span class="rec-sk ${cls}"></span>`;
        if (kind === 'tiles') {
            const tile = `<div class="rec-sk-tile">${sk('rec-sk-art')}<div class="rec-sk-body">${sk('rec-sk-line')}${sk('rec-sk-line is-short')}${sk('rec-sk-button')}</div></div>`;
            return `<div class="rec-grid" aria-hidden="true">${tile.repeat(3)}</div>`;
        }
        if (kind === 'chips') {
            const chip = `<div class="rec-sk-chip">${sk('rec-sk-line is-short')}${sk('rec-sk-line')}</div>`;
            return `<div class="rec-strip" aria-hidden="true">${chip.repeat(2)}</div>`;
        }
        const row = `<li class="rec-row"><div class="rec-sk-body">${sk('rec-sk-line')}${sk('rec-sk-line is-short')}</div></li>`;
        return `<ul class="rec-list" aria-hidden="true">${row.repeat(2)}</ul>`;
    }

    openGuide() {
        if (this.app && typeof this.app.navigateTo === 'function') this.app.navigateTo('guide');
    }

    // ---- delete and cancel, with Undo ----------------------------------------

    /**
     * The item leaves the page now; the request goes when the notice ends without Undo, or with keepalive when the
     * page is left, hidden or signed out of first (UI.undoable sends it exactly once, never after Undo).
     */
    defer({ key, message, failText, path, cancel = null }) {
        const near = this.neighbour(key);
        this.pending.set(key, { key, failText, path, committing: false, cancel: !!cancel, id: cancel && cancel.id, title: cancel && cancel.title });
        this.draw();
        UI.undoable(message, {
            undo: () => this.undo(key),
            commit: (ctl) => this.commitPending(key, ctl),
            focus: { undo: () => this.controlOf(key), end: () => (near && this.controlOf(near)) || this.landingOf(key) }
        });
    }

    /** The list a key's item is drawn in. */
    listOf(key) {
        const [kind, id] = key.split(':');
        if (kind === 'recording') return { el: this.recordingsList, section: 'recorded', items: this.visible(this.data.recordings, 'recording') };
        if (kind === 'rule') return { el: this.rulesList, section: 'rules', items: this.visible(this.data.rules, 'rule'), attr: 'data-rule-id' };
        const recent = (this.data.recent || []).some(x => String(x.id) === id);
        return recent ? { el: this.recentProblemsList, section: 'problems', items: this.visible(this.data.recent, 'schedule') }
            : { el: this.scheduledList, section: 'scheduled', items: this.visible(this.data.upcoming, 'schedule') };
    }

    /** The key of the item after this one in its list (else the one before), for focus once it has gone. */
    neighbour(key) {
        const [kind, id] = key.split(':');
        const { items } = this.listOf(key);
        const i = items.findIndex(x => String(x.id) === id);
        if (i < 0) return null;
        const other = items[i + 1] || items[i - 1];
        return other ? `${kind}:${other.id}` : null;
    }

    /** An item's main control (its first button), when it is drawn. */
    controlOf(key) {
        const id = key.split(':')[1];
        const { el, attr = 'data-id' } = this.listOf(key);
        return el && el.querySelector ? el.querySelector(`[${attr}="${id}"] button`) : null;
    }

    /** Where focus goes when a list has nothing left to focus: the action of its empty block, else its heading. */
    landingOf(key) {
        const { el, section } = this.listOf(key);
        const action = el && el.querySelector ? el.querySelector('.state-block-action') : null;
        if (action) return action;
        const heading = typeof document !== 'undefined' && document.getElementById ? document.getElementById(`${section}-heading`) : null;
        const shown = heading && heading.closest ? heading.closest('section') : null;
        if (!heading || (shown && shown.hidden)) return null;
        if (heading.getAttribute && heading.getAttribute('tabindex') === null) heading.setAttribute('tabindex', '-1');
        return heading;
    }

    undo(key) {
        const entry = this.pending.get(key);
        if (!entry || entry.committing) return;
        this.pending.delete(key);
        this.draw();
    }

    /**
     * Sent once by UI.undoable (`ctl`: its control object; a plain `{ keepalive }` from a test). The DELETE always goes
     * with keepalive, so a page left while it is on its way does not drop it. A cancel first checks the recording has
     * not started; it holds its request meanwhile and stops waiting for a fresh read once the page is going.
     */
    async commitPending(key, ctl = {}) {
        const leaving = () => !!(ctl.leaving ?? ctl.keepalive);
        const entry = this.pending.get(key);
        if (!entry || entry.committing) { ctl.dispatched?.(); return; }
        entry.committing = true;
        // A cancel whose recording has started in the 10 s is not sent: Stop, which asks first, is the way to end it.
        if (entry.cancel) {
            ctl.hold?.();
            let started;
            try { started = await this.hasStarted(entry.id, { fresh: !leaving(), left: ctl.left }); } catch { started = true; }
            if (started) {
                ctl.dispatched?.();
                this.pending.delete(key);
                this.draw();
                UI.toast(`${entry.title ? `${entry.title} has` : 'It has'} started recording, so it was not cancelled. Use Stop to end it.`);
                return;
            }
        }
        const request = API.request('DELETE', entry.path, null, { keepalive: true });
        ctl.dispatched?.();
        try {
            await request;
        } catch (err) {
            this.pending.delete(key);
            this.draw();
            UI.toast(UI.errorText(err, entry.failText), { kind: 'error' });
            return;
        }
        this.forget(key);
        this.pending.delete(key);
        this.draw();
        if (!leaving()) await this.refresh();
    }

    /**
     * Whether schedule `id` is recording now, from the freshest the page has: the scheduled list asked again (`fresh`,
     * when there is time to wait for an answer, and only until `left` resolves), else the list it holds, the shared feed
     * of recordings in progress, and its start (less its lead-in) having passed.
     */
    async hasStarted(id, { fresh = false, left = null } = {}) {
        const find = () => (this.data.upcoming || []).find(x => String(x.id) === String(id));
        if (fresh) {
            // The page going (or sign-out) while the list is read: decide at once from what is held (below).
            const read = this.fetchScheduled().then(() => 'read');
            const how = left ? await Promise.race([read, left.then(() => 'left')]) : await read;
            if (how === 'read' && !this.failed.scheduled) return !!find() && find().status === 'recording';
        }
        const item = find();
        if (item && item.status === 'recording') return true;
        const feed = this.app && this.app.recordingsFeed && this.app.recordingsFeed.latest;
        if (Array.isArray(feed) && feed.some(r => String(r.id) === String(id))) return true;
        if (!item) return false;
        const start = Number(item.program_start) - (Number(item.pre_buffer_min) || 0) * 60000;
        return Number.isFinite(start) && Date.now() >= start;
    }

    /** Take a deleted item out of what the page holds, so it stays gone until the next answer. */
    forget(key) {
        const [kind, id] = key.split(':');
        const keep = (x) => String(x.id) !== id;
        if (kind === 'recording' && this.data.recordings) this.recordings = this.data.recordings = this.data.recordings.filter(keep);
        if (kind === 'schedule') {
            if (this.data.upcoming) this.data.upcoming = this.data.upcoming.filter(keep);
            if (this.data.recent) this.data.recent = this.data.recent.filter(keep);
        }
        if (kind === 'rule' && this.data.rules) this.data.rules = this.data.rules.filter(keep);
    }

    deleteRecording(id) {
        this.defer({ key: `recording:${id}`, message: 'Recording deleted', failText: 'Could not delete it',
            path: `/recordings/${id}` });
    }

    // Its recordings that have not started are cancelled by the server; anything recorded is kept.
    deleteRule(id) {
        // #276 (C12): say what else goes with it, from the count the row shows.
        const rule = (this.data.rules || []).find(x => String(x.id) === String(id));
        const n = Number(rule && rule.upcoming) || 0;
        const message = n > 0 ? `Rule deleted. Its ${n} scheduled ${n === 1 ? 'recording is' : 'recordings are'} cancelled.` : 'Rule deleted';
        this.defer({ key: `rule:${id}`, message, failText: 'Could not delete the rule',
            path: `/recordings/rules/${id}` });
    }

    // 0207: a failed or missed schedule from "Recent problems": the server deletes it along
    // with its failed recordings and their files, so the library is refreshed as well.
    deleteProblem(id) {
        this.defer({ key: `schedule:${id}`, message: 'Failed recording deleted', failText: 'Could not delete it',
            path: `/recordings/scheduled/${id}` });
    }

    // Cancel has Undo; Stop on a recording in progress cannot be undone, so it still asks first.
    async cancelScheduled(id) {
        const item = (this.data.upcoming || []).find(x => String(x.id) === String(id));
        if (item && item.status === 'recording') {
            if (!confirm('Stop this recording now? It cannot be resumed.')) return;
            try {
                await API.recordings.cancelScheduled(id);
                await this.refresh();
            } catch (err) {
                UI.toast(UI.errorText(err, 'Could not stop the recording.'), { kind: 'error' });
            }
            return;
        }
        this.defer({ key: `schedule:${id}`, message: 'Recording cancelled', failText: 'Could not cancel it',
            path: `/recordings/scheduled/${id}`, cancel: { id, title: item && item.title } });
    }

    // #12 (D-42): this schedule wins its clashes; the one it beats waits instead.
    async chooseScheduled(id) {
        try {
            await API.recordings.chooseScheduled(id);
            await this.refresh();
        } catch (err) {
            UI.toast(UI.errorText(err, 'Could not record this one instead.'), { kind: 'error' });
        }
    }

    // 0207: this login's progress through a completed recording: a bar part-way through (with the time left); the
    // "Watched" tag once watched; nothing for one not started.
    progressOf(item) {
        if (item.status !== 'completed' || item.watched) return null;
        const position = Number(item.position_sec) || 0;
        const duration = Number(item.duration_sec) || 0;
        if (position <= 0 || duration <= 0) return null;
        const percent = Math.min(100, Math.max(1, Math.round((position / duration) * 100)));
        const minutes = Math.max(1, Math.round((duration - position) / 60));
        const left = minutes < 60 ? `${minutes} min left`
            : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''} left`;
        return { percent, left };
    }

    // H:MM:SS
    formatClock(sec) {
        const total = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
            UI.toast(UI.errorText(err, 'Could not start compression.'), { kind: 'error' });
            if (btn) { btn.disabled = false; btn.textContent = 'Compress'; }
        }
    }

    startCompressionWatch() {
        if (this._compressTimer) clearInterval(this._compressTimer);
        this._compressTimer = setInterval(async () => {
            // Only refresh while this page is actually on screen, in a visible tab (#239).
            if (document.hidden || (this.recordingsList && this.recordingsList.offsetParent === null)) return;
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

    /**
     * Open the player. #62: the page asks the server for the address (`/playback?async=1`, or `/watch` for a recording
     * still in progress), shows "Preparing…" while the server gets it ready, then plays it; every failure is written in
     * the player with Try again, never a silent black box. `watch` plays a recording in progress from its start.
     */
    async play(id, { watch = false } = {}) {
        this.closePlayer();

        const overlay = document.createElement('div');
        overlay.className = 'recording-player-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Recording player');
        overlay.innerHTML = `
            <div class="recording-player-box">
                <button class="recording-player-close" aria-label="Close player">&times;</button>
                <video controls></video>
                <div class="recording-player-status" hidden></div>
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
        // Escape closes it, and focus returns to what opened it when it closes.
        this._playerOpener = document.activeElement;
        this._onPlayerKey = (e) => { if (e.key === 'Escape') this.closePlayer(); };
        document.addEventListener('keydown', this._onPlayerKey);
        overlay.querySelector('.recording-player-close').focus?.();

        // 0207: where this login stopped last time. Asked before anything plays; a failure
        // to read it just means playing from the start. A recording in progress always plays from its start.
        let resumeAt = 0;
        if (!watch) {
            try {
                const pos = await API.recordings.getPosition(id);
                if (pos && pos.position_sec > 10 && !pos.watched) resumeAt = await this.askResume(overlay, pos.position_sec);
            } catch (err) { /* play from the start */ }
        }
        if (resumeAt === null || this._playerOverlay !== overlay) return; // closed while asking

        await this.startPlayback(overlay, id, { watch, resumeAt });
    }

    /** Show a state in the player's status area (hidden when `kind` is null). */
    playerStatus(overlay, kind, text, action) {
        const area = overlay.querySelector('.recording-player-status');
        if (!area) return;
        area.hidden = !kind;
        if (kind) UI.setState(area, kind, text, action);
        else area.innerHTML = '';
    }

    /** Resolve, then play; any failure is shown with Try again, which starts this again. */
    async startPlayback(overlay, id, { watch, resumeAt }) {
        const retry = () => this.startPlayback(overlay, id, { watch, resumeAt });
        const fail = (title) => this.playerStatus(overlay, 'error', { title, detail: 'Your place in it is kept.' }, { label: 'Try again', run: retry });
        this.teardownMedia(overlay);
        this.playerStatus(overlay, 'loading', { title: 'Preparing…', detail: watch ? 'Getting this recording ready to watch while it records.' : 'Getting this recording ready to play. A long one can take a minute.' });

        let target;
        try {
            target = await this.resolvePlayback(overlay, id, watch);
        } catch (err) {
            if (this._playerOverlay !== overlay) return;
            fail(UI.errorText(err, watch ? 'This recording could not be opened to watch.' : 'This recording could not be prepared for playback.'));
            return;
        }
        if (!target || this._playerOverlay !== overlay) return; // closed meanwhile

        const video = overlay.querySelector('video');
        const url = API.withStreamToken(target.url);
        const hlsUrl = target.container === 'hls';
        const onFatal = () => { if (this._playerOverlay === overlay) { this.teardownMedia(overlay); fail('This recording stopped playing.'); } };

        if (hlsUrl && window.Hls && window.Hls.isSupported()) {
            // Follows a growing recording: hls.js reloads the EVENT playlist, and playback starts at its beginning.
            const hls = new window.Hls({ enableWorker: true, startPosition: 0, maxBufferHole: 1.0, manifestLoadingMaxRetry: 4, fragLoadingMaxRetry: 6 });
            overlay._hls = hls;
            overlay._hlsUsed = true;
            let recovered = false;
            hls.on(window.Hls.Events.ERROR, (event, data) => {
                if (!data || !data.fatal) return;
                if (!recovered && window.Hls.ErrorTypes && data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { recovered = true; hls.recoverMediaError(); return; }
                console.error('Recording HLS error:', data.details);
                onFatal();
            });
            hls.loadSource(url);
            hls.attachMedia(video);
        } else if (hlsUrl && !(video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl'))) {
            fail('This browser cannot play a recording that is still being made.');
            return;
        } else {
            video.src = url; // an MP4, or HLS in Safari, natively
        }

        this.playerStatus(overlay, null);
        if (resumeAt > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = resumeAt; }, { once: true });
        video.addEventListener('error', onFatal, { once: true });
        video.autoplay = true;
        if (video.play) { const started = video.play(); if (started && started.catch) started.catch(() => {}); }

        if (!watch) {
            this.trackPosition(overlay, video, id);
            this.attachAdSkipping(overlay, id);
        }
    }

    /** Let go of what the player is playing (hls.js, the element's source) and its position saving. */
    teardownMedia(overlay) {
        if (this._positionTracker) {
            clearInterval(this._positionTracker.timer);
            this._positionTracker.save(); // before the video is torn down
            this._positionTracker.close();
            this._positionTracker = null;
        }
        if (overlay._hls) { try { overlay._hls.destroy(); } catch (err) { /* already gone */ } overlay._hls = null; }
        const video = overlay.querySelector('video');
        if (video && (video.getAttribute?.('src') || video.src || overlay._hlsUsed)) {
            video.pause?.();
            video.removeAttribute?.('src');
            if (video.src) video.src = '';
            video.load?.();
        }
    }

    /**
     * Ask the server for the playable address, asking again while it says "preparing" (the Apple client's way).
     * Resolves { url, container }, or null if the player was closed; throws on a failure.
     */
    async resolvePlayback(overlay, id, watch) {
        const maxWaitMs = 15 * 60 * 1000;
        let waited = 0;
        let useWatch = watch;
        for (;;) {
            let answer;
            try {
                answer = useWatch ? await API.recordings.watch(id) : await API.recordings.playback(id);
            } catch (err) {
                // It finished since the page was drawn: play the finished recording instead.
                if (useWatch && err && err.status === 409) { useWatch = false; continue; }
                throw err;
            }
            if (this._playerOverlay !== overlay) return null;
            if (answer && answer.url) return { url: answer.url, container: answer.container };
            if (!answer || answer.status !== 'preparing') throw new Error('The server did not say how to play this recording');
            const delay = Math.min(10, Math.max(1, Number(answer.retryAfterSec) || 3)) * 1000;
            waited += delay;
            if (waited > maxWaitMs) throw new Error('Preparing this recording is taking too long');
            await new Promise(resolve => setTimeout(resolve, delay));
            if (this._playerOverlay !== overlay) return null;
        }
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
        if (this._playerOverlay) this.teardownMedia(this._playerOverlay); // saves the position before the video goes
        if (this._onPlayerKey) { document.removeEventListener('keydown', this._onPlayerKey); this._onPlayerKey = null; }
        if (this._playerOverlay) {
            this._playerOverlay.remove();
            this._playerOverlay = null;
            const opener = this._playerOpener;
            this._playerOpener = null;
            if (opener && opener.focus && opener.isConnected !== false) opener.focus();
        }
    }

    // A recording scheduled since 0121 (or by the Apple client) stores the library's
    // /api/logo/ path; an older one may hold the provider's own logo URL, used as is
    // (the server's image passthrough went in 0122).
    proxiedLogo(url) {
        return url || '/img/placeholder.png';
    }

    formatSize(bytes) {
        if (!bytes) return '';
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1) return `${gb.toFixed(1)} GB`;
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

}

window.RecordingsPage = RecordingsPage;
