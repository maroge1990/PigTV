/**
 * DVR / Recordings database layer
 *
 * Uses the same SQLite connection as content.db (server/db/sqlite.js) but owns
 * its own tables. Kept in a separate module so the recording feature stays
 * self-contained and easy to lift out or disable.
 */
const { getDb } = require('./sqlite');

let initialized = false;

function initSchema() {
    if (initialized) return;
    const db = getDb();

    db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_recordings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            source_id INTEGER NOT NULL,
            channel_item_id TEXT NOT NULL,
            channel_name TEXT,
            channel_logo TEXT,
            program_start INTEGER NOT NULL, -- ms epoch, from EPG
            program_end INTEGER NOT NULL,   -- ms epoch, from EPG
            pre_buffer_min INTEGER NOT NULL DEFAULT 0,
            post_buffer_min INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|recording|completed|failed|cancelled|missed
            recording_id INTEGER,
            created_by INTEGER,
            created_at INTEGER NOT NULL,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sched_status_start ON scheduled_recordings(status, program_start);

        CREATE TABLE IF NOT EXISTS recordings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scheduled_id INTEGER,
            title TEXT NOT NULL,
            channel_name TEXT,
            channel_logo TEXT,
            source_id INTEGER,
            channel_item_id TEXT,
            file_path TEXT NOT NULL,
            started_at INTEGER,
            ended_at INTEGER,
            status TEXT NOT NULL DEFAULT 'recording', -- recording|completed|failed
            file_size_bytes INTEGER,
            duration_sec INTEGER,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
    `);

    // Commercial breaks found in a recording.
    //
    // Separate rows rather than a JSON blob on the recording: a client asks
    // "what should I skip", and breaks are edited and re-detected
    // independently of the recording itself.
    db.exec(`
        CREATE TABLE IF NOT EXISTS recording_markers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recording_id INTEGER NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            type TEXT NOT NULL DEFAULT 'ad',
            source TEXT NOT NULL DEFAULT 'comskip',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_markers_recording ON recording_markers(recording_id, start_ms);
    `);

    // Migrations for databases created before compression existed.
    for (const col of [
        'compress_status TEXT',      // null|pending|running|done|failed|skipped
        'original_size_bytes INTEGER',
        'compress_error TEXT',
        'is_partial INTEGER DEFAULT 0',
        'missed_start_ms INTEGER',   // how much of the programme was already gone
        'ad_detect_status TEXT',     // null|pending|running|done|failed|unavailable
        'ad_detect_error TEXT',
        // 0177 (multi-provider P7): the provider (a source id) this recording's
        // connection was on, and which part of its schedule it is - 1 for the first
        // (or only) one, 2 and 3 for the continuations made when a provider died
        // mid-recording. NULL on recordings made before, and on the tuner's.
        'provider_id INTEGER',
        'part INTEGER',
        // 0192 (audit R06): preparing a finished recording for the Apple client
        // ahead of the first Play. null (never queued) | pending | preparing |
        // ready | failed; the error and the number of attempts made so far.
        'native_status TEXT',
        'native_error TEXT',
        'native_attempts INTEGER DEFAULT 0',
        // 0203: how it was prepared (2: audio re-encoded and decode-checked); NULL before.
        'native_version INTEGER',
        // 0127, the tuner model: 'hls' for a recording taken from a tuner's segments
        // (its folder, hls_dir, holds index.m3u8 and the segments; file_path is that
        // playlist until the joined MP4 exists). NULL for the .mkv recordings. Added
        // only once PIGTV_TUNER=1 has been used, so with the tuner never on, the
        // recordings API's rows are exactly as before.
        ...(require('../services/tuner').enabled() ? ['format TEXT', 'hls_dir TEXT'] : [])
    ]) {
        try {
            db.exec(`ALTER TABLE recordings ADD COLUMN ${col}`);
        } catch (e) { /* already present */ }
    }

    // Which channel this schedule is FOR. channel_item_id is a playlist position,
    // and the provider moves them - a schedule made before a reorder would resolve
    // to whatever now sits at that line and record the wrong programme. Backfilled
    // and preferred at resolve time; see services/stableIds.js.
    try {
        db.exec('ALTER TABLE scheduled_recordings ADD COLUMN channel_stable_id TEXT');
    } catch (e) { /* already present */ }

    // Pending schedules only: a completed or cancelled one never resolves again,
    // and rewriting history would be dishonest about what was recorded.
    try {
        const filled = db.prepare(`
            UPDATE scheduled_recordings SET channel_stable_id = (
                SELECT p.stable_id FROM playlist_items p
                WHERE p.source_id = scheduled_recordings.source_id
                  AND p.item_id = scheduled_recordings.channel_item_id
                  AND p.type = 'live' LIMIT 1
            )
            WHERE channel_stable_id IS NULL AND status IN ('scheduled', 'waiting')
        `).run().changes;
        if (filled) console.log(`[Recordings] Pointed ${filled} pending schedule(s) at a channel identity`);
    } catch (e) {
        // playlist_items may not exist yet on a first run; the next start fills them.
    }

    initialized = true;
    console.log('[Recordings] Schema initialized');
}

// Lets a test re-run the schema step, which is what a restart does.
function __resetInitForTests() { initialized = false; }

function row(x) { return x || null; }

const scheduled = {
    create(data) {
        const db = getDb();
        initSchema();
        const stmt = db.prepare(`
            INSERT INTO scheduled_recordings
                (title, description, source_id, channel_item_id, channel_name, channel_logo,
                 program_start, program_end, pre_buffer_min, post_buffer_min, status, created_by, created_at,
                 channel_stable_id)
            VALUES (@title, @description, @source_id, @channel_item_id, @channel_name, @channel_logo,
                    @program_start, @program_end, @pre_buffer_min, @post_buffer_min, 'scheduled', @created_by, @created_at,
                    @channel_stable_id)
        `);
        // Resolved by the caller, which knows how to read the composite id the web
        // app sends; defaulted here so better-sqlite3 never sees a missing parameter.
        const info = stmt.run({ channel_stable_id: null, ...data });
        return this.getById(info.lastInsertRowid);
    },

    getById(id) {
        const db = getDb();
        initSchema(); // a fresh database has no table until this has run once
        return row(db.prepare('SELECT * FROM scheduled_recordings WHERE id = ?').get(id));
    },

    // Everything a person would call "coming up or in progress". 'waiting' belongs here: it is
    // a recording that is due but held back because someone is watching on the provider's only
    // stream. Leaving it out made it vanish from the list at exactly the moment it mattered, and
    // left nothing to cancel.
    listUpcoming() {
        const db = getDb();
        return db.prepare(`
            SELECT * FROM scheduled_recordings
            WHERE status IN ('scheduled', 'recording', 'waiting')
            ORDER BY program_start ASC
        `).all();
    },

    listAll() {
        const db = getDb();
        initSchema(); // a fresh database has no table until this has run once
        return db.prepare(`SELECT * FROM scheduled_recordings ORDER BY program_start DESC LIMIT 500`).all();
    },

    // Find schedules due to start (accounting for pre-buffer) that haven't started yet.
    // 'waiting' is included deliberately: a recording held back because a viewer
    // is using the provider's only stream must be retried on every tick, which
    // is what makes it start the moment playback stops.
    findDueToStart(nowMs) {
        const db = getDb();
        return db.prepare(`
            SELECT * FROM scheduled_recordings
            WHERE status IN ('scheduled', 'waiting')
              AND (program_start - (pre_buffer_min * 60000)) <= ?
        `).all(nowMs);
    },

    // Find schedules whose window fully passed without ever starting (e.g. server
    // was off, or a viewer never released the stream)
    findMissed(nowMs) {
        const db = getDb();
        return db.prepare(`
            SELECT * FROM scheduled_recordings
            WHERE status IN ('scheduled', 'waiting')
              AND (program_end + (post_buffer_min * 60000)) < ?
        `).all(nowMs);
    },

    // 0156: missed/failed schedules stay visible for a while after the fact
    // (GET /api/recordings/scheduled?include=recent) instead of simply vanishing
    // the moment their window passes - which is what made schedule #3's failure
    // invisible in both UIs until Mark went looking in docker logs.
    findRecentProblems(sinceMs) {
        const db = getDb();
        return db.prepare(`
            SELECT * FROM scheduled_recordings
            WHERE status IN ('missed', 'failed')
              AND program_end >= ?
            ORDER BY program_end DESC
        `).all(sinceMs);
    },

    findByProgram(sourceId, channelItemId, programStart) {
        const db = getDb();
        return row(db.prepare(`
            SELECT * FROM scheduled_recordings
            WHERE source_id = ? AND channel_item_id = ? AND program_start = ?
              AND status IN ('scheduled', 'recording', 'waiting')
        `).get(sourceId, channelItemId, programStart));
    },

    setStatus(id, status, extra = {}) {
        const db = getDb();
        const fields = ['status = @status'];
        const params = { id, status, ...extra };
        if ('recording_id' in extra) fields.push('recording_id = @recording_id');
        if ('error' in extra) fields.push('error = @error');
        db.prepare(`UPDATE scheduled_recordings SET ${fields.join(', ')} WHERE id = @id`).run(params);
        return this.getById(id);
    },

    cancel(id) {
        return this.setStatus(id, 'cancelled');
    },

    // Recordings still marked in-flight from a previous process lifetime
    findActive() {
        const db = getDb();
        initSchema();
        return db.prepare(`
            SELECT * FROM scheduled_recordings
            WHERE status = 'recording'
            ORDER BY program_start ASC
        `).all();
    },

    findOrphanedRecording() {
        const db = getDb();
        return db.prepare(`SELECT * FROM scheduled_recordings WHERE status = 'recording'`).all();
    }
};

const recordings = {
    setAdDetectStatus(id, status, error = null) {
        const db = getDb();
        initSchema();
        db.prepare('UPDATE recordings SET ad_detect_status = ?, ad_detect_error = ? WHERE id = ?')
            .run(status, error, id);
    },

    findPendingAdDetection() {
        const db = getDb();
        initSchema();
        // An HLS recording (0127) is analysed once it has been joined into an MP4.
        return db.prepare(`
            SELECT * FROM recordings
            WHERE status = 'completed' AND ad_detect_status = 'pending'
              AND file_path NOT LIKE '%.m3u8'
            ORDER BY ended_at ASC
        `).all();
    },

    /** 0127: this recording is taken from a tuner, into this folder. */
    setHls(id, dir) {
        const db = getDb();
        initSchema();
        db.prepare("UPDATE recordings SET format = 'hls', hls_dir = ? WHERE id = ?").run(dir, id);
    },

    setFilePath(id, filePath) {
        const db = getDb();
        initSchema();
        db.prepare('UPDATE recordings SET file_path = ? WHERE id = ?').run(filePath, id);
    },

    replaceMarkers(recordingId, markers, source = 'comskip') {
        const db = getDb();
        initSchema();
        const now = Date.now();
        const wipe = db.prepare('DELETE FROM recording_markers WHERE recording_id = ? AND source = ?');
        const add = db.prepare(`
            INSERT INTO recording_markers (recording_id, start_ms, end_ms, type, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        // One transaction: a half-replaced marker set would have the player
        // skipping into the middle of the programme.
        db.transaction(() => {
            wipe.run(recordingId, source);
            for (const m of markers) {
                add.run(recordingId, m.startMs, m.endMs, m.type || 'ad', source, now);
            }
        })();
    },

    getMarkers(recordingId) {
        const db = getDb();
        initSchema();
        return db.prepare(`
            SELECT id, start_ms, end_ms, type, source
            FROM recording_markers WHERE recording_id = ? ORDER BY start_ms ASC
        `).all(recordingId);
    },

    deleteMarkers(recordingId) {
        const db = getDb();
        initSchema();
        db.prepare('DELETE FROM recording_markers WHERE recording_id = ?').run(recordingId);
    },

    /**
     * 0177: this part stopped before the programme did (its provider died and the
     * recording continued in the next part). Partial, with a note saying so; the
     * missing span at its start, if any, is kept.
     */
    markEndedEarly(id, note) {
        const db = getDb();
        initSchema();
        db.prepare('UPDATE recordings SET is_partial = 1, missed_start_ms = COALESCE(missed_start_ms, 0), error = ? WHERE id = ?')
            .run(note || null, id);
    },

    /** 0177: the recording moved to another provider before it had recorded anything. */
    setProvider(id, providerId) {
        const db = getDb();
        initSchema();
        db.prepare('UPDATE recordings SET provider_id = ? WHERE id = ?').run(providerId ?? null, id);
    },

    /** 0177: every recording (part) made for a schedule, first part first. */
    listBySchedule(scheduledId) {
        const db = getDb();
        initSchema();
        return db.prepare('SELECT * FROM recordings WHERE scheduled_id = ? ORDER BY id ASC').all(scheduledId);
    },

    markPartial(id, missedStartMs) {
        const db = getDb();
        initSchema();
        db.prepare('UPDATE recordings SET is_partial = 1, missed_start_ms = ? WHERE id = ?')
            .run(Math.max(0, Math.round(missedStartMs)), id);
    },

    setCompressStatus(id, status, extra = {}) {
        const db = getDb();
        initSchema();
        db.prepare(`
            UPDATE recordings
            SET compress_status = ?,
                compress_error = COALESCE(?, compress_error),
                original_size_bytes = COALESCE(?, original_size_bytes),
                file_size_bytes = COALESCE(?, file_size_bytes),
                file_path = COALESCE(?, file_path)
            WHERE id = ?
        `).run(
            status,
            extra.error ?? null,
            extra.originalSize ?? null,
            extra.fileSize ?? null,
            extra.filePath ?? null,
            id
        );
    },

    /**
     * 0192 (audit R06). `attempt` counts a fresh try; `error` is replaced, not kept,
     * so a recording that succeeds on its second attempt stops showing the first's.
     */
    setNativeStatus(id, status, { error = null, attempt = false } = {}) {
        const db = getDb();
        initSchema();
        db.prepare(`
            UPDATE recordings
            SET native_status = ?, native_error = ?,
                native_attempts = COALESCE(native_attempts, 0) + ?
            WHERE id = ?
        `).run(status, error, attempt ? 1 : 0, id);
    },

    /**
     * R16: the preparation queue at a glance - rows per native_status, and the most recent
     * error among the failed ones. Read-only; never a path (the error text is trimmed).
     */
    nativeQueueSummary() {
        const db = getDb();
        initSchema();
        const counts = { pending: 0, preparing: 0, ready: 0, failed: 0 };
        for (const r of db.prepare(`SELECT native_status AS s, COUNT(*) AS n FROM recordings WHERE native_status IS NOT NULL GROUP BY native_status`).all()) {
            if (r.s in counts) counts[r.s] = r.n;
        }
        const failed = db.prepare(`
            SELECT id, title, native_error AS error FROM recordings
            WHERE native_status = 'failed' AND native_error IS NOT NULL
            ORDER BY COALESCE(ended_at, 0) DESC LIMIT 1
        `).get();
        return { counts, lastError: failed ? { id: failed.id, title: failed.title, error: String(failed.error).slice(0, 300) } : null };
    },

    /** Waiting to be prepared, the most recently finished first: the likeliest to be watched next. */
    findPendingNative() {
        const db = getDb();
        initSchema();
        return db.prepare(`
            SELECT * FROM recordings
            WHERE status = 'completed' AND native_status = 'pending'
              AND file_path NOT LIKE '%.m3u8'
            ORDER BY ended_at DESC
        `).all();
    },

    /**
     * Queue every finished recording that has never been through preparation -
     * the library recorded before 0192. Returns how many were queued.
     */
    /** 0203: this recording was prepared the current way. */
    setNativeVersion(id, version) {
        const db = getDb();
        initSchema();
        db.prepare('UPDATE recordings SET native_version = ? WHERE id = ?').run(version, id);
    },

    /** 0203: prepared before 0203 and still in its original .mkv: the MP4 beside it has copied audio. */
    findOldPreparedWithOriginal() {
        const db = getDb();
        initSchema();
        return db.prepare(`
            SELECT * FROM recordings
            WHERE status = 'completed' AND native_status = 'ready' AND native_version IS NULL
              AND lower(file_path) LIKE '%.mkv'
        `).all();
    },

    queueNativeBackfill() {
        const db = getDb();
        initSchema();
        return db.prepare(`
            UPDATE recordings SET native_status = 'pending'
            WHERE status = 'completed' AND native_status IS NULL
              AND file_path NOT LIKE '%.m3u8'
        `).run().changes;
    },

    /**
     * After a restart nothing is preparing or compressing any more: put what was
     * mid-way back in the queue. Returns the rows whose compression was cut short,
     * so the caller can clear away what that encode left behind.
     */
    requeueInterrupted() {
        const db = getDb();
        initSchema();
        const compressing = db.prepare(`SELECT * FROM recordings WHERE compress_status = 'running'`).all();
        db.prepare(`UPDATE recordings SET compress_status = 'pending' WHERE compress_status = 'running'`).run();
        db.prepare(`UPDATE recordings SET native_status = 'pending' WHERE native_status = 'preparing'`).run();
        return compressing;
    },

    findPendingCompression() {
        const db = getDb();
        initSchema();
        return db.prepare(`
            SELECT * FROM recordings
            WHERE status = 'completed' AND compress_status = 'pending'
              AND file_path NOT LIKE '%.m3u8'
            ORDER BY ended_at ASC
        `).all();
    },

    create(data) {
        const db = getDb();
        initSchema();
        const stmt = db.prepare(`
            INSERT INTO recordings
                (scheduled_id, title, channel_name, channel_logo, source_id, channel_item_id,
                 file_path, started_at, status, provider_id, part)
            VALUES (@scheduled_id, @title, @channel_name, @channel_logo, @source_id, @channel_item_id,
                    @file_path, @started_at, 'recording', @provider_id, @part)
        `);
        // provider_id/part (0177) are the default path's; the tuner's recordings leave them NULL.
        const info = stmt.run({ provider_id: null, part: null, ...data });
        return this.getById(info.lastInsertRowid);
    },

    getById(id) {
        const db = getDb();
        initSchema(); // a fresh database has no table until this has run once
        return row(db.prepare('SELECT * FROM recordings WHERE id = ?').get(id));
    },

    listAll() {
        const db = getDb();
        initSchema(); // a fresh database has no table until this has run once
        return db.prepare(`SELECT * FROM recordings ORDER BY started_at DESC LIMIT 500`).all();
    },

    finish(id, { status, ended_at, file_size_bytes, duration_sec, error }) {
        const db = getDb();
        initSchema(); // a fresh database has no table until this has run once
        db.prepare(`
            UPDATE recordings
            SET status = @status, ended_at = @ended_at, file_size_bytes = @file_size_bytes,
                duration_sec = @duration_sec, error = @error
            WHERE id = @id
        `).run({ id, status, ended_at, file_size_bytes: file_size_bytes ?? null, duration_sec: duration_sec ?? null, error: error ?? null });
        return this.getById(id);
    },

    findInProgress() {
        const db = getDb();
        initSchema(); // a fresh database has no table until this has run once
        return db.prepare(`SELECT * FROM recordings WHERE status = 'recording'`).all();
    },

    delete(id) {
        const db = getDb();
        initSchema(); // a fresh database has no table until this has run once
        db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
    }
};

module.exports = {
    __resetInitForTests,
    initSchema, initSchema, scheduled, recordings };
