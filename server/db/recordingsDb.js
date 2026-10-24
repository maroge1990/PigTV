/**
 * DVR / Recordings database layer
 *
 * Uses the same SQLite connection as content.db (server/db/sqlite.js) but owns
 * its own tables. Kept in a separate module so the recording feature stays
 * self-contained and easy to lift out or disable.
 */
const path = require('path');
const { getDb } = require('./sqlite');

let initialized = false;

/**
 * D1 (0251): which kept original a recording owns is recorded, never inferred at delete. 0227-0241
 * published it at "<name>.ts" beside the MP4 and only then set segment_state 'done', recording no
 * path; such a row (kept, done, no segment_original) is claimed here once. Since 0242 a done row with
 * a kept original always has its path, so a pending or failed one ('moving', NULL) owns nothing.
 */
function claimLegacyOriginals(db) {
    const rows = db.prepare(`SELECT id, file_path FROM recordings WHERE segment_keep IS NOT NULL AND segment_state = 'done'
        AND segment_original IS NULL AND file_path IS NOT NULL AND file_path <> ''`).all();
    const claim = db.prepare('UPDATE recordings SET segment_original = ? WHERE id = ?');
    for (const r of rows) {
        claim.run(path.join(path.dirname(r.file_path), `${path.basename(r.file_path, path.extname(r.file_path))}.ts`), r.id);
    }
}

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

    // 0207: where each login stopped watching a recording. One row per (recording, user):
    // the Apple TV and the phone of one login share it (a paired device's token names the
    // login's user id), two logins never see each other's. user_id is TEXT, as devices.user_id
    // is; always written through String(req.user.id).
    db.exec(`
        CREATE TABLE IF NOT EXISTS recording_positions (
            recording_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            position_sec REAL NOT NULL,
            watched INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (recording_id, user_id)
        );
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
        // mid-recording. NULL on recordings made before.
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
        // R3 (Wave 4): a segmented recording - HLS segments in appdata, one MP4 on the share at
        // the end (services/recordingSegments.js). work_dir is its folder in appdata;
        // segment_state capturing | finishing | moving | done | failed; segment_name and
        // segment_folder are the file and channel-folder names the MP4 gets on the share.
        // All NULL for a recording made the usual way.
        'work_dir TEXT',
        'segment_state TEXT',
        'segment_name TEXT',
        'segment_folder TEXT',
        'segment_attempts INTEGER DEFAULT 0',
        // DVR-1 (0227): why the segments must outlive the MP4 (its check could not compare it with
        // them); NULL when the MP4 was fully checked. While set, the work folder is only deleted once
        // the segments are on the share as "<name>.ts" beside the MP4.
        'segment_keep TEXT',
        // F1 (0242): where that kept original was published (its own file, never one found there).
        'segment_original TEXT',
        // R6: the programme's image from the guide (a URL; listed only as /api/logo/<key>).
        'image_url TEXT',
    ]) {
        try {
            db.exec(`ALTER TABLE recordings ADD COLUMN ${col}`);
        } catch (e) { /* already present */ }
    }
    claimLegacyOriginals(db);

    // Which channel this schedule is FOR. channel_item_id is a playlist position,
    // and the provider moves them - a schedule made before a reorder would resolve
    // to whatever now sits at that line and record the wrong programme. Backfilled
    // and preferred at resolve time; see services/stableIds.js.
    try {
        db.exec('ALTER TABLE scheduled_recordings ADD COLUMN channel_stable_id TEXT');
    } catch (e) { /* already present */ }

    // R4 (0214): the end a schedule was made with, set the first time the guide moves its
    // program_end (services/recordingGuideEnd.js); NULL means it never moved.
    try {
        db.exec('ALTER TABLE scheduled_recordings ADD COLUMN program_end_original INTEGER');
    } catch (e) { /* already present */ }

    // R5: recording rules. A rule makes schedules (scheduled_recordings.rule_id says which); each
    // airing or event it has acted on is a hit, kept even when its schedule is cancelled, so a
    // cancelled one is never made again. services/recordingRules.js.
    db.exec(`
        CREATE TABLE IF NOT EXISTS recording_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,            -- 'sport' (a team, league or word, as the follow list) | 'series' (a title on one channel)
            match TEXT NOT NULL,
            source_id INTEGER,             -- series: the channel
            channel_item_id TEXT,
            channel_stable_id TEXT,
            channel_name TEXT,
            pre_buffer_min INTEGER,        -- NULL: the Settings default
            post_buffer_min INTEGER,
            new_only INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_by INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recording_rule_hits (
            rule_id INTEGER NOT NULL,
            identity TEXT NOT NULL,
            schedule_id INTEGER,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (rule_id, identity)
        );
    `);
    try {
        db.exec('ALTER TABLE scheduled_recordings ADD COLUMN rule_id INTEGER');
    } catch (e) { /* already present */ }
    // R6: the programme's image from the guide, found when the schedule is made.
    try {
        db.exec('ALTER TABLE scheduled_recordings ADD COLUMN image_url TEXT');
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

    /** 0207: a failed or missed schedule removed from "Recent problems". */
    delete(id) {
        const db = getDb();
        initSchema();
        db.prepare('DELETE FROM scheduled_recordings WHERE id = ?').run(id);
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
        return db.prepare(`
            SELECT * FROM recordings
            WHERE status = 'completed' AND ad_detect_status = 'pending'
            ORDER BY ended_at ASC
        `).all();
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
        const info = stmt.run({ provider_id: null, part: null, ...data });
        return this.getById(info.lastInsertRowid);
    },

    getById(id) {
        const db = getDb();
        initSchema(); // a fresh database has no table until this has run once
        return row(db.prepare('SELECT * FROM recordings WHERE id = ?').get(id));
    },

    /** R3: set any of a segmented recording's columns (names from a fixed list, never the caller's). */
    setSegmentFields(id, fields) {
        const allowed = ['image_url', 'file_path', 'work_dir', 'segment_state', 'segment_name', 'segment_folder', 'segment_attempts',
            'segment_keep', 'segment_original', 'status', 'ended_at', 'file_size_bytes', 'duration_sec', 'error'];
        const keys = Object.keys(fields).filter(k => allowed.includes(k));
        if (keys.length === 0) return;
        getDb().prepare(`UPDATE recordings SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`)
            .run({ ...Object.fromEntries(keys.map(k => [k, fields[k] === undefined ? null : fields[k]])), id });
    },

    /** R3: segmented recordings that still have work in appdata to finish or move, oldest first. */
    findSegmentWork() {
        initSchema();
        return getDb().prepare(`SELECT * FROM recordings WHERE work_dir IS NOT NULL AND segment_state IN ('finishing', 'moving')
            ORDER BY ended_at ASC, id ASC`).all();
    },

    /** R3: every recording that still has a folder in appdata (for Status and the startup check). */
    findWithWorkDir() {
        initSchema();
        return getDb().prepare('SELECT * FROM recordings WHERE work_dir IS NOT NULL ORDER BY id ASC').all();
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
        db.transaction(() => {
            db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
            // 0207: nobody can resume a recording that is gone.
            db.prepare('DELETE FROM recording_positions WHERE recording_id = ?').run(id);
        })();
    },

    // --- 0207: per-login resume position --------------------------------

    /** The stored position as the API shape, or null when this login has none. */
    getPosition(recordingId, userId) {
        const db = getDb();
        initSchema();
        const r = db.prepare('SELECT position_sec, watched, updated_at FROM recording_positions WHERE recording_id = ? AND user_id = ?')
            .get(recordingId, String(userId));
        return r ? { position_sec: r.position_sec, watched: !!r.watched, updated_at: r.updated_at } : null;
    },

    /** Last write wins. Returns the stored row in the API shape. */
    setPosition(recordingId, userId, positionSec, watched) {
        const db = getDb();
        initSchema();
        const now = Date.now();
        db.prepare(`
            INSERT INTO recording_positions (recording_id, user_id, position_sec, watched, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(recording_id, user_id) DO UPDATE SET
                position_sec = excluded.position_sec, watched = excluded.watched, updated_at = excluded.updated_at
        `).run(recordingId, String(userId), positionSec, watched ? 1 : 0, now);
        return { position_sec: positionSec, watched: !!watched, updated_at: now };
    },

    /** Every position this login has, by recording id, for the library list. */
    positionsFor(userId) {
        const db = getDb();
        initSchema();
        const map = new Map();
        for (const r of db.prepare('SELECT recording_id, position_sec, watched FROM recording_positions WHERE user_id = ?').all(String(userId))) {
            map.set(r.recording_id, { position_sec: r.position_sec, watched: !!r.watched });
        }
        return map;
    }
};

module.exports = {
    __resetInitForTests, claimLegacyOriginals,
    initSchema, initSchema, scheduled, recordings };
