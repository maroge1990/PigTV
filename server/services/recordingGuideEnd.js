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
 *
 * #217: a sport recording also follows its event. A schedule is linked to a fixture game (the score collector's id) when
 * it was made from one (`sport_game_id`: a team rule's game, or a client naming `gameId`), else by the dashboard's own
 * game-to-airing join (both teams named in the title, play within 90 min of its start, the league it names if any; never a replay) when its stop is
 * decided. While it records, eventStop() applies sportOverrun.recordingEnd to the collector's stored answer for that
 * game (never a request to ESPN): `event_stop`, when set, is where it stops instead of the guide end + post-padding,
 * which stays the floor. Unlinked, or with no fresh answer: exactly as before.
 */
const { getDb } = require('../db/sqlite');
const epgMapping = require('./epgMapping');
const overrun = require('./sportOverrun');

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

/**
 * The tvg-id a schedule's channel reads its guide from (an admin's mapping first). DVR-2 (0228): a
 * schedule with a channel identity reads only that channel; when it has gone from the playlist
 * there is no guide to follow (its old position may be another channel's now). The position is
 * for schedules that never had an identity.
 */
function tvgIdFor(db, schedule) {
    const row = schedule.channel_stable_id
        ? db.prepare(`
            SELECT item_id, stable_id, tvg_id, data FROM playlist_items
            WHERE source_id = ? AND type = 'live' AND stable_id = ?
            ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC LIMIT 1
        `).get(schedule.source_id, schedule.channel_stable_id)
        : db.prepare(`
            SELECT item_id, stable_id, tvg_id, data FROM playlist_items
            WHERE source_id = ? AND type = 'live' AND item_id = ? LIMIT 1
        `).get(schedule.source_id, schedule.channel_item_id);
    if (!row) return null;
    let tvg = row.tvg_id || null;
    if (!tvg) { try { const d = JSON.parse(row.data || '{}'); tvg = d.tvgId || d.epg_channel_id || null; } catch { tvg = null; } }
    return epgMapping.effectiveTvgId(schedule.source_id, row.stable_id, row.item_id, tvg);
}

/** Apply guideEndFor to every pending/running schedule. Returns [{ id, from, to, guideEnd }]. */
function apply({ now = Date.now(), db = getDb() } = {}) {
    // The SQL below mirrors recordingWindow().stopsAt (and recordingsDb.js's copies): change one, change both.
    const schedules = db.prepare(`
        SELECT * FROM scheduled_recordings
        WHERE status IN ('scheduled', 'waiting', 'recording')
          AND MAX(program_end + post_buffer_min * 60000,
                  MIN(COALESCE(event_stop, 0), program_end + post_buffer_min * 60000 + ${overrun.OVERRUN_MAX})) > ?
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

// ---- #217: the event's end ------------------------------------------------------------------

const JOIN_WINDOW_MS = 90 * 60 * 1000;
const EARLY_MS = 60 * 1000; // decided from just before the floor, so the hard stop firing at it finds the answer made
const SESSION_LEAGUES = new Set(['F1', 'MotoGP', 'Supercars']); // sessions and weekends, not two sides

/** Where a schedule's window ends without its event: the guide end + post-padding. */
const floorOf = (s) => s.program_end + (s.post_buffer_min || 0) * 60000;

/**
 * Where a schedule stops, the one reading of it (the hard stop, the stop checks, `stopsAt`): its event stop, never
 * before the floor and (0442, 0440 Codex round 1, medium) never past the CURRENT floor + OVERRUN_MAX, so a guide
 * correction downwards cannot leave a stop decided against a later floor beyond the cap.
 */
function stopOf(s) {
    const floor = floorOf(s);
    return Number.isFinite(s.event_stop) && s.event_stop > floor ? Math.min(s.event_stop, floor + overrun.OVERRUN_MAX) : floor;
}

/**
 * A scheduled recording's time window, the one owner of it in JS: `startsAt` (guide start less the start-early),
 * `floor` (guide end + post-padding) and `stopsAt` (stopOf: the event stop, capped). The SQL copies (recordingsDb.js,
 * `apply` above) mirror it; change one, change both.
 */
function recordingWindow(s) {
    return { startsAt: s.program_start - (s.pre_buffer_min || 0) * 60000, floor: floorOf(s), stopsAt: stopOf(s) };
}

/**
 * The fixture game a schedule records, or null. Its stored link first; else the dashboard's join (matchBroadcasts), only
 * for a game of two sides whose play starts within JOIN_WINDOW_MS of the schedule, and only when exactly one game joins.
 */
function gameFor(schedule, catalog) {
    if (!schedule || !Array.isArray(catalog)) return null;
    if (schedule.sport_game_id) return catalog.find(g => g.id === schedule.sport_game_id) || null;
    const classify = require('./sportsClassify');
    const individual = require('./sportIndividual');
    const parsed = classify.parseTitle(schedule.title);
    if (!parsed.teams || parsed.replayWord || parsed.highlightsWord) return null;
    // 0443 (0440 Codex round 2, medium): only a game of the schedule's own league ("AFL: ..." never the AFLW game of the
    // same clubs): the league its title names, else its guide programme's categories; unknown, any league.
    const league = scheduleLeague(schedule, classify);
    const near = catalog.filter(g => Array.isArray(g.competitors) && g.competitors.length === 2 && !individual.has(g.league)
        && !SESSION_LEAGUES.has(g.league) && Number.isFinite(g.start) && Math.abs(g.start - schedule.program_start) <= JOIN_WINDOW_MS
        && (!league || g.league === league));
    if (!near.length) return null;
    const { matchBroadcasts } = require('./sportsDashboard');
    const hits = new Set();
    for (const league of new Set(near.map(g => g.league))) {
        const airing = { id: `schedule:${schedule.id}`, kind: 'event', league, title: schedule.title,
            start: schedule.program_start, end: schedule.program_end, channels: [] };
        for (const [id, on] of matchBroadcasts(near.filter(g => g.league === league), [airing])) if (on.length) hits.add(id);
    }
    return hits.size === 1 ? near.find(g => hits.has(g.id)) : null;
}

/** The league a schedule names: its title's, else its guide programme's categories' (one league only), else null. */
function scheduleLeague(schedule, classify) {
    const own = classify.detectLeague(schedule.title);
    if (own) return own;
    try {
        const db = getDb();
        const tvg = tvgIdFor(db, schedule);
        if (!tvg) return null;
        const row = db.prepare(`SELECT categories FROM epg_live WHERE channel_id = ? AND start_time BETWEEN ? AND ?
            ORDER BY ABS(start_time - ?) LIMIT 1`).get(tvg, schedule.program_start - SAME_START_MS, schedule.program_start + SAME_START_MS, schedule.program_start);
        let categories = [];
        try { categories = JSON.parse(row?.categories || '[]'); } catch (e) { categories = []; }
        const found = new Set((Array.isArray(categories) ? categories : []).map(c => classify.detectLeague(c)).filter(Boolean));
        return found.size === 1 ? [...found][0] : null;
    } catch (e) {
        return null;
    }
}

/**
 * The event stop a recording should have at `now` (the schedule's `event_stop` unchanged when there is nothing new):
 * a number, or null for none (it stops at the floor). Never throws; a failure is no change.
 * `store` is the score collector's store (sportsDashboard.store()); `catalog` its catalog, when already read.
 */
function eventStop(schedule, { now = Date.now(), store = null, catalog = null } = {}) {
    const current = Number.isFinite(schedule?.event_stop) ? schedule.event_stop : null;
    try {
        const floor = floorOf(schedule);
        if (current === null && now < floor - EARLY_MS) return null;
        const scores = store || require('./sportsDashboard').store();
        const game = gameFor(schedule, catalog || scores.catalog());
        if (!game) return current;
        const next = overrun.recordingEnd({ floor, postMs: (schedule.post_buffer_min || 0) * 60000, now,
            latest: scores.latest(game.id), gameStart: game.start, individual: require('./sportIndividual').has(game.league) });
        return next === undefined ? current : next;
    } catch (e) {
        return current;
    }
}

/**
 * C-M (#217, additive): how a listed schedule ends. `endsWith` "event" when it is linked to a fixture game, else
 * "guide"; `stopsAt` the effective stop (ms): max(floor, event_stop), at most floor + OVERRUN_MAX; `overrun: true`
 * while it records past the guide end + post-padding because its event has not ended.
 */
function endView(schedule, catalog, now = Date.now()) {
    let linked = Boolean(schedule.sport_game_id);
    if (!linked) { try { linked = Boolean(gameFor(schedule, catalog)); } catch (e) { linked = false; } }
    const stopsAt = stopOf(schedule);
    const extended = schedule.status === 'recording' && stopsAt > floorOf(schedule) && stopsAt > now;
    return { endsWith: linked ? 'event' : 'guide', stopsAt, ...(extended ? { overrun: true } : {}) };
}

module.exports = { apply, guideEndFor, normTitle, gameFor, eventStop, endView, floorOf, stopOf, recordingWindow,
    MATCH_WINDOW_MS, SAME_START_MS, MAX_EXTENSION_MS, JOIN_WINDOW_MS, EARLY_MS };
