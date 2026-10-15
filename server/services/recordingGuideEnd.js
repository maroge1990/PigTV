/**
 * R4 (Plan B1): a recording's end follows the guide. A schedule's `program_end` was fixed when
 * it was made; sport overruns (extra time, rain, a red flag) then cut the end off. After each EPG
 * sync (and at start-up) every schedule that is scheduled, waiting or recording is matched to the
 * programme the guide now has in its slot, and its end moves to that programme's end:
 *
 *   - The same programme: the schedule's channel (its tvg-id, honouring an admin's EPG mapping),
 *     a start within MATCH_WINDOW_MS of the schedule's start, and the same title once case,
 *     punctuation and "Live"/"(Live)" are ignored. With no title match, a programme that starts
 *     within SAME_START_MS is taken as the same slot renamed. Nothing else (an adjacent programme
 *     has a different start), and no match means no change.
 *   - Never before the end the schedule was made with (`program_end_original`, set the first time
 *     an end moves): a guide that shortens a programme does not cut a recording short. A later
 *     correction back down returns it towards that original end.
 *   - At most MAX_EXTENSION_MS past the original end.
 *   - Nothing for a schedule whose stop time has already passed.
 *
 * An unchanged guide cannot know about an overrun the provider never published: the post-buffer
 * (Settings -> Recording, or per schedule) stays the manual way to add time.
 */
const { getDb } = require('../db/sqlite');
const epgMapping = require('./epgMapping');

const MATCH_WINDOW_MS = 30 * 60 * 1000;
const SAME_START_MS = 2 * 60 * 1000;
const MAX_EXTENSION_MS = 3 * 60 * 60 * 1000;

function normTitle(t) {
    return String(t || '').toLowerCase()
        .replace(/\(\s*live\s*\)|\blive\s*[:\-|]\s*|\s*[:\-|]\s*live\b/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Pure: where `schedule` should end given the programmes on its channel around its start, or
 * null for no change. `schedule` has program_start, program_end, program_end_original, title.
 */
function guideEndFor(schedule, programmes) {
    const original = schedule.program_end_original ?? schedule.program_end;
    const near = programmes.filter(p => Math.abs(p.start_time - schedule.program_start) <= MATCH_WINDOW_MS && p.end_time > p.start_time);
    const title = normTitle(schedule.title);
    const byTitle = near.filter(p => normTitle(p.title) === title)
        .sort((a, b) => Math.abs(a.start_time - schedule.program_start) - Math.abs(b.start_time - schedule.program_start));
    const match = byTitle[0] || near.find(p => Math.abs(p.start_time - schedule.program_start) <= SAME_START_MS);
    if (!match) return null;
    const end = Math.min(Math.max(match.end_time, original), original + MAX_EXTENSION_MS);
    return end === schedule.program_end ? null : { end, original, guideEnd: match.end_time, title: match.title };
}

/** The tvg-id a schedule's channel reads its guide from (an admin's mapping first). */
function tvgIdFor(db, schedule) {
    const row = db.prepare(`
        SELECT item_id, stable_id, tvg_id, data FROM playlist_items
        WHERE source_id = ? AND (item_id = ? OR (? IS NOT NULL AND stable_id = ?))
        ORDER BY (stable_id = ?) DESC LIMIT 1
    `).get(schedule.source_id, schedule.channel_item_id, schedule.channel_stable_id, schedule.channel_stable_id, schedule.channel_stable_id);
    if (!row) return null;
    let tvg = row.tvg_id || null;
    if (!tvg) { try { const d = JSON.parse(row.data || '{}'); tvg = d.tvgId || d.epg_channel_id || null; } catch { tvg = null; } }
    return epgMapping.effectiveTvgId(schedule.source_id, row.stable_id, row.item_id, tvg);
}

/** Apply guideEndFor to every pending/running schedule. Returns [{ id, from, to, guideEnd }]. */
function apply({ now = Date.now(), db = getDb() } = {}) {
    const schedules = db.prepare(`
        SELECT * FROM scheduled_recordings
        WHERE status IN ('scheduled', 'waiting', 'recording')
          AND program_end + post_buffer_min * 60000 > ?
    `).all(now);
    const changes = [];
    const update = db.prepare(`UPDATE scheduled_recordings SET program_end = ?, program_end_original = COALESCE(program_end_original, ?) WHERE id = ?`);
    for (const s of schedules) {
        const tvg = tvgIdFor(db, s);
        if (!tvg) continue;
        const programmes = db.prepare(`
            SELECT title, start_time, end_time FROM epg_live
            WHERE channel_id = ? AND start_time BETWEEN ? AND ?
        `).all(tvg, s.program_start - MATCH_WINDOW_MS, s.program_start + MATCH_WINDOW_MS);
        const next = guideEndFor(s, programmes);
        if (!next) continue;
        update.run(next.end, next.original, s.id);
        changes.push({ id: s.id, from: s.program_end, to: next.end, guideEnd: next.guideEnd });
        console.log(`[Recordings] Schedule #${s.id} "${s.title}": the guide moved its end ${new Date(s.program_end).toISOString()} -> ${new Date(next.end).toISOString()}`);
    }
    return changes;
}

module.exports = { apply, guideEndFor, normTitle, MATCH_WINDOW_MS, SAME_START_MS, MAX_EXTENSION_MS };
