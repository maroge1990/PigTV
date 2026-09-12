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

    initialized = true;
    console.log('[Recordings] Schema initialized');
}

function row(x) { return x || null; }

const scheduled = {
    create(data) {
        const db = getDb();
        initSchema();
        const stmt = db.prepare(`
            INSERT INTO scheduled_recordings
                (title, description, source_id, channel_item_id, channel_name, channel_logo,
                 program_start, program_end, pre_buffer_min, post_buffer_min, status, created_by, created_at)
            VALUES (@title, @description, @source_id, @channel_item_id, @channel_name, @channel_logo,
                    @program_start, @program_end, @pre_buffer_min, @post_buffer_min, 'scheduled', @created_by, @created_at)
        `);
        const info = stmt.run(data);
        return this.getById(info.lastInsertRowid);
    },

    getById(id) {
        const db = getDb();
        return row(db.prepare('SELECT * FROM scheduled_recordings WHERE id = ?').get(id));
    },

    listUpcoming() {
        const db = getDb();
        return db.prepare(`
            SELECT * FROM scheduled_recordings
            WHERE status IN ('scheduled', 'recording')
            ORDER BY program_start ASC
        `).all();
    },

    listAll() {
        const db = getDb();
        return db.prepare(`SELECT * FROM scheduled_recordings ORDER BY program_start DESC LIMIT 500`).all();
    },

    // Find schedules due to start (accounting for pre-buffer) that haven't started yet
    findDueToStart(nowMs) {
        const db = getDb();
        return db.prepare(`
            SELECT * FROM scheduled_recordings
            WHERE status = 'scheduled'
              AND (program_start - (pre_buffer_min * 60000)) <= ?
        `).all(nowMs);
    },

    // Find schedules whose window fully passed without ever starting (e.g. server was off)
    findMissed(nowMs) {
        const db = getDb();
        return db.prepare(`
            SELECT * FROM scheduled_recordings
            WHERE status = 'scheduled'
              AND (program_end + (post_buffer_min * 60000)) < ?
        `).all(nowMs);
    },

    findByProgram(sourceId, channelItemId, programStart) {
        const db = getDb();
        return row(db.prepare(`
            SELECT * FROM scheduled_recordings
            WHERE source_id = ? AND channel_item_id = ? AND program_start = ?
              AND status IN ('scheduled', 'recording')
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
    create(data) {
        const db = getDb();
        initSchema();
        const stmt = db.prepare(`
            INSERT INTO recordings
                (scheduled_id, title, channel_name, channel_logo, source_id, channel_item_id,
                 file_path, started_at, status)
            VALUES (@scheduled_id, @title, @channel_name, @channel_logo, @source_id, @channel_item_id,
                    @file_path, @started_at, 'recording')
        `);
        const info = stmt.run(data);
        return this.getById(info.lastInsertRowid);
    },

    getById(id) {
        const db = getDb();
        return row(db.prepare('SELECT * FROM recordings WHERE id = ?').get(id));
    },

    listAll() {
        const db = getDb();
        return db.prepare(`SELECT * FROM recordings ORDER BY started_at DESC LIMIT 500`).all();
    },

    finish(id, { status, ended_at, file_size_bytes, duration_sec, error }) {
        const db = getDb();
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
        return db.prepare(`SELECT * FROM recordings WHERE status = 'recording'`).all();
    },

    delete(id) {
        const db = getDb();
        db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
    }
};

module.exports = { initSchema, scheduled, recordings };
