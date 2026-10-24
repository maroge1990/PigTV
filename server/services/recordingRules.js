/**
 * Recording rules (R5, Wave 4): "record my team", "record this series". One-off recordings are
 * unchanged; a rule only ever makes ordinary schedules (scheduled_recordings, with rule_id).
 *
 *   sport   a follow-list keyword (a team, "NFL: Arizona Cardinals"; a league, "AFL"; any word):
 *           every Sport EVENT that keyword follows (sportsEvents' own matching, never a replay)
 *           in the next 72 h, recorded on the event's best channel (channels[0]).
 *   series  a programme title on one channel: every airing of it there in the guide (7 days),
 *           or only the ones not flagged "previously shown" (new_only).
 *
 * De-duplicated three ways, because guides nudge times between syncs: by identity (the Sport
 * event; the series episode - its episode number or subtitle - else the airing's channel and
 * quarter hour), by an existing schedule of the same title on the same channel within 15 minutes
 * (which also stops two rules recording one event twice), and by hits: each identity a rule has
 * acted on is remembered, so a schedule the viewer cancels is never made again.
 *
 * Runs after every guide sync and every 15 minutes (recordingEngine's tick). Native: the idea is
 * Dispatcharr's series rules (AGPL, read, not copied).
 */
const { getDb } = require('../db/sqlite');
const { scheduled: scheduledDb, initSchema } = require('../db/recordingsDb');

const KINDS = ['sport', 'series'];
const SPORT_HOURS = 72;
const SERIES_DAYS = 7;
const NEAR_MS = 15 * 60 * 1000;
// F4 (0245) replaces 0237's six-hour window: see pairEvents().
const EVALUATE_EVERY_MS = 15 * 60 * 1000;
const MAX_MATCH = 120;
const MAX_RULES = 100;
const PREVIOUSLY_SHOWN = 1; // epgParser.PROGRAMME_FLAGS

const db = () => { initSchema(); return getDb(); };
const fold = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function shape(r) {
    if (!r) return null;
    const pending = db().prepare(`SELECT COUNT(*) AS n FROM scheduled_recordings WHERE rule_id = ? AND status IN ('scheduled', 'waiting', 'recording')`).get(r.id).n;
    return {
        id: r.id, kind: r.kind, match: r.match,
        sourceId: r.source_id ?? null, channelId: r.channel_item_id ?? null, stableId: r.channel_stable_id ?? null,
        channelName: r.channel_name ?? null,
        preBufferMin: r.pre_buffer_min ?? null, postBufferMin: r.post_buffer_min ?? null,
        newOnly: r.new_only === 1, enabled: r.enabled === 1, createdAt: r.created_at, upcoming: pending
    };
}

function list() {
    return db().prepare('SELECT * FROM recording_rules ORDER BY created_at ASC, id ASC').all().map(shape);
}

function get(id) {
    return shape(db().prepare('SELECT * FROM recording_rules WHERE id = ?').get(Number(id)));
}

const minutes = (v, max) => (v === undefined || v === null ? null
    : Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);

/** A rule from a request body, or { error } (a 400). */
function validate(body = {}) {
    const kind = body.kind;
    if (!KINDS.includes(kind)) return { error: 'kind must be "sport" or "series"' };
    const match = typeof body.match === 'string' ? body.match.replace(/\s+/g, ' ').trim() : '';
    if (!match || match.length > MAX_MATCH) return { error: `match must be 1 to ${MAX_MATCH} characters` };
    const pre = minutes(body.preBufferMin, 60);
    const post = minutes(body.postBufferMin, 180);
    if (pre === undefined || post === undefined) return { error: 'preBufferMin (0-60) and postBufferMin (0-180) must be whole minutes' };
    const rule = { kind, match, pre_buffer_min: pre, post_buffer_min: post, new_only: body.newOnly === true ? 1 : 0,
        source_id: null, channel_item_id: null, channel_stable_id: null, channel_name: null };
    if (kind === 'series') {
        const sourceId = Number(body.sourceId);
        const channelId = body.channelId === undefined || body.channelId === null ? '' : String(body.channelId).replace(/^(?:m3u|xtream)_\d+_/, '');
        if (!Number.isInteger(sourceId) || sourceId <= 0 || !channelId) return { error: 'a series rule needs sourceId and channelId' };
        const row = db().prepare(`SELECT item_id, stable_id, name FROM playlist_items WHERE source_id = ? AND type = 'live' AND (item_id = ? OR stable_id = ?) LIMIT 1`)
            .get(sourceId, channelId, channelId);
        if (!row) return { error: 'that channel is not in the playlist' };
        Object.assign(rule, { source_id: sourceId, channel_item_id: row.item_id, channel_stable_id: row.stable_id || null,
            channel_name: typeof body.channelName === 'string' && body.channelName.trim() ? body.channelName.trim().slice(0, 200) : row.name });
    }
    return { rule };
}

function create(body, userId = null) {
    const { rule, error } = validate(body);
    if (error) return { error };
    if (db().prepare('SELECT COUNT(*) AS n FROM recording_rules').get().n >= MAX_RULES) return { error: `at most ${MAX_RULES} rules` };
    const same = db().prepare(`SELECT id FROM recording_rules WHERE kind = ? AND lower(match) = lower(?) AND
        COALESCE(source_id, 0) = COALESCE(?, 0) AND COALESCE(channel_stable_id, channel_item_id, '') = COALESCE(?, ?, '')`)
        .get(rule.kind, rule.match, rule.source_id, rule.channel_stable_id, rule.channel_item_id);
    if (same) return { rule: get(same.id), existing: true };
    const info = db().prepare(`INSERT INTO recording_rules (kind, match, source_id, channel_item_id, channel_stable_id, channel_name,
            pre_buffer_min, post_buffer_min, new_only, enabled, created_by, created_at)
        VALUES (@kind, @match, @source_id, @channel_item_id, @channel_stable_id, @channel_name, @pre_buffer_min, @post_buffer_min,
            @new_only, 1, @created_by, @created_at)`).run({ ...rule, created_by: userId, created_at: Date.now() });
    console.log(`[Rules] Rule #${info.lastInsertRowid} added: ${rule.kind} "${rule.match}"${rule.channel_name ? ` on ${rule.channel_name}` : ''}`);
    return { rule: get(info.lastInsertRowid) };
}

/** enabled / newOnly / buffers. */
function update(id, body = {}) {
    const current = db().prepare('SELECT * FROM recording_rules WHERE id = ?').get(Number(id));
    if (!current) return null;
    const pre = 'preBufferMin' in body ? minutes(body.preBufferMin, 60) : current.pre_buffer_min;
    const post = 'postBufferMin' in body ? minutes(body.postBufferMin, 180) : current.post_buffer_min;
    if (pre === undefined || post === undefined) return { error: 'preBufferMin (0-60) and postBufferMin (0-180) must be whole minutes' };
    if ('enabled' in body && typeof body.enabled !== 'boolean') return { error: 'enabled must be true or false' };
    if ('newOnly' in body && typeof body.newOnly !== 'boolean') return { error: 'newOnly must be true or false' };
    db().prepare('UPDATE recording_rules SET enabled = ?, new_only = ?, pre_buffer_min = ?, post_buffer_min = ? WHERE id = ?').run(
        'enabled' in body ? (body.enabled ? 1 : 0) : current.enabled,
        'newOnly' in body ? (body.newOnly ? 1 : 0) : current.new_only, pre, post, current.id);
    return { rule: get(current.id) };
}

/**
 * Delete a rule. Its schedules that have not started are cancelled (they were the rule's doing);
 * one recording now, and everything recorded, stay. Returns the number cancelled, or null.
 */
function remove(id) {
    const rule = db().prepare('SELECT * FROM recording_rules WHERE id = ?').get(Number(id));
    if (!rule) return null;
    const pending = db().prepare(`SELECT * FROM scheduled_recordings WHERE rule_id = ? AND status IN ('scheduled', 'waiting')`).all(rule.id);
    const engine = require('./recordingEngine');
    for (const s of pending) engine.cancelScheduled(s.id).catch(() => {});
    // Cancelled by deleting the rule, not by the viewer: no longer the rule's, so a later rule may record them.
    db().prepare(`UPDATE scheduled_recordings SET rule_id = NULL WHERE rule_id = ? AND status IN ('scheduled', 'waiting', 'cancelled')`).run(rule.id);
    db().prepare('DELETE FROM recording_rule_hits WHERE rule_id = ?').run(rule.id);
    db().prepare('DELETE FROM recording_rules WHERE id = ?').run(rule.id);
    console.log(`[Rules] Rule #${rule.id} deleted; ${pending.length} upcoming schedule(s) cancelled`);
    return { cancelled: pending.length };
}

// ---- what a rule would record ------------------------------------------------------------

/** Sport: each followed event (never a replay), on its best channel. */
async function sportCandidates(rule, now) {
    const sportsEvents = require('./sportsEvents');
    const follow = sportsEvents.compileFollow([rule.match]);
    const { events } = await sportsEvents.eventsFor({ hours: SPORT_HOURS, now });
    const out = [];
    for (const ev of events) {
        if (ev.kind && ev.kind !== 'event') continue;
        if (ev.start <= now || !ev.channels.length) continue; // only what is still to start
        const leagues = ev.league ? [ev.league] : [];
        if (!sportsEvents.followedKeyword(follow, ev.title, ev.aliases || [], leagues)) continue;
        const ch = ev.channels[0];
        out.push({ identity: `event:${ev.id}`, title: ev.title, titles: [ev.title, ...(ev.aliases || [])], anyChannel: true, start: ev.start, end: ev.end,
            sourceId: ch.sourceId, channelId: String(ch.id), channelName: ch.name, channelLogo: ch.logo || null, description: null });
    }
    return out;
}

/** Series: the title's airings on its channel, through the channel's guide id. */
function seriesCandidates(rule, now) {
    const sportsEvents = require('./sportsEvents');
    const channel = sportsEvents.visibleChannels(db()).find(c => c.sourceId === rule.source_id &&
        (rule.channel_stable_id ? c.stableId === rule.channel_stable_id : c.id === rule.channel_item_id));
    if (!channel || !channel.tvgId) return [];
    const rows = db().prepare(`SELECT title, description, start_time, end_time, flags, data FROM epg_live
        WHERE channel_id = ? AND start_time > ? AND start_time < ? AND lower(trim(title)) = ? ORDER BY start_time ASC`)
        .all(channel.tvgId, now, now + SERIES_DAYS * 24 * 3600 * 1000, fold(rule.match));
    const out = [];
    for (const r of rows) {
        if (rule.new_only === 1 && (r.flags & PREVIOUSLY_SHOWN)) continue;
        let data = {};
        try { data = JSON.parse(r.data || '{}') || {}; } catch (e) { data = {}; }
        const episode = fold(data.ep) || fold(data.sub);
        const identity = episode
            ? `ep:${fold(rule.match)}|${episode}`
            : `air:${channel.sourceId}:${channel.stableId || channel.id}|${Math.round(r.start_time / NEAR_MS)}`;
        out.push({ identity, title: r.title, start: r.start_time, end: r.end_time, sourceId: channel.sourceId,
            channelId: String(channel.id), channelName: channel.name, channelLogo: channel.logo || null, description: r.description || null });
    }
    return out;
}

// Schedules a candidate may already be: not cancelled, or cancelled but made by a rule (what the
// viewer cancelled must not come back - from any rule).
const SCHEDULE_COLUMNS = 'id, source_id, channel_item_id, title, program_start, program_end, status, rule_id';
const LIVE_OR_RULE = `(status <> 'cancelled' OR rule_id IS NOT NULL)`;

/**
 * A schedule (not cancelled, unless a rule made it) of the same programme within 15 minutes on the
 * same channel. Series candidates; Sport events go through pairEvents().
 */
function alreadyScheduled(c) {
    const near = db().prepare(`SELECT ${SCHEDULE_COLUMNS} FROM scheduled_recordings
        WHERE ${LIVE_OR_RULE} AND program_start BETWEEN ? AND ?`).all(c.start - NEAR_MS, c.start + NEAR_MS);
    const titles = new Set((c.titles || [c.title]).map(fold));
    return near.find(s => titles.has(fold(s.title)) &&
        (c.anyChannel || (s.source_id === c.sourceId && String(s.channel_item_id) === c.channelId))) || null;
}

/**
 * F4 (0245; DVR-3): which existing schedule, if any, each Sport event of this evaluation is. A
 * Sport event's id changes with its time, so identity is decided by the instances themselves:
 *
 *   1. Present: a schedule of the same title (the event's or a merged guide title, any channel)
 *      within 15 minutes of an event is that event - it is still in the guide where it was.
 *   2. Moved: a schedule still to start, inside the window the guide shows (SPORT_HOURS), whose
 *      event is NOT in the guide any more (nothing of its title within 15 minutes), is the same
 *      event as a same-title event that has no schedule - the nearest in time, one to one. That
 *      is a guide correction of any size: the cancel holds, a pending schedule follows it.
 *   3. Anything else is a new event: another match of the same teams that sits beside the
 *      scheduled one (a doubleheader, the next round) is recorded too.
 *
 * A schedule whose time has come (started, live, past) never takes a successor: that match
 * happened. Returns Map(candidate -> schedule).
 */
function pairEvents(candidates, now) {
    const pairs = new Map();
    if (candidates.length === 0) return pairs;
    const olds = db().prepare(`SELECT ${SCHEDULE_COLUMNS} FROM scheduled_recordings
        WHERE ${LIVE_OR_RULE} AND program_end > ?`).all(now - NEAR_MS);
    const titlesOf = (c) => new Set((c.titles || [c.title]).map(fold));
    const used = new Set();
    // 1. Present.
    for (const c of candidates) {
        const titles = titlesOf(c);
        const s = olds.find(o => !used.has(o.id) && titles.has(fold(o.title)) && Math.abs(o.program_start - c.start) <= NEAR_MS);
        if (s) { pairs.set(c, s); used.add(s.id); }
    }
    // 2. Moved: the vanished ones, nearest first.
    const vanished = olds.filter(o => !used.has(o.id) && o.program_start > now && o.program_start < now + SPORT_HOURS * 3600 * 1000);
    const options = [];
    for (const c of candidates) {
        if (pairs.has(c)) continue;
        const titles = titlesOf(c);
        for (const o of vanished) if (titles.has(fold(o.title))) options.push({ c, o, gap: Math.abs(o.program_start - c.start) });
    }
    options.sort((a, b) => a.gap - b.gap);
    for (const { c, o } of options) {
        if (pairs.has(c) || used.has(o.id)) continue;
        pairs.set(c, o);
        used.add(o.id);
    }
    return pairs;
}

let running = null;
let lastRun = 0;

/**
 * Turn every enabled rule's candidates into schedules. Never throws; one rule's failure does not
 * stop the others. Returns [{ ruleId, scheduleId, title, start }] for what it scheduled.
 */
function evaluate({ now = Date.now() } = {}) {
    if (running) return running;
    running = (async () => {
        const made = [];
        let rules = [];
        try { rules = db().prepare('SELECT * FROM recording_rules WHERE enabled = 1 ORDER BY id').all(); } catch (e) { return made; }
        const engine = require('./recordingEngine');
        const hitStmt = db().prepare(`INSERT OR IGNORE INTO recording_rule_hits (rule_id, identity, schedule_id, created_at) VALUES (?, ?, ?, ?)`);
        const hit = (ruleId, identity, scheduleId) => hitStmt.run(ruleId, identity, scheduleId, Date.now());
        for (const rule of rules) {
            let candidates = [];
            try {
                candidates = rule.kind === 'sport' ? await sportCandidates(rule, now) : seriesCandidates(rule, now);
            } catch (err) {
                console.warn(`[Rules] Rule #${rule.id} could not be evaluated: ${err.message}`);
                continue;
            }
            const events = rule.kind === 'sport' ? pairEvents(candidates, now) : null;
            for (const c of candidates) {
                // D3 (0253): an existing schedule is reconciled first, so a correction back to a time
                // seen before (A -> B -> A, its identity already a hit) still moves it; the hit only
                // stops a second schedule being made.
                const existing = events ? events.get(c) || null : alreadyScheduled(c);
                if (existing) {
                    // F4: a moved event's pending schedule follows it (the viewer's cancel just holds).
                    if (events && existing.rule_id !== null && ['scheduled', 'waiting'].includes(existing.status)
                        && Math.abs(existing.program_start - c.start) > NEAR_MS) {
                        db().prepare(`UPDATE scheduled_recordings SET program_start = ?, program_end = ? WHERE id = ? AND status IN ('scheduled', 'waiting')`)
                            .run(c.start, c.end, existing.id);
                        console.log(`[Rules] Rule #${rule.id}: "${c.title}" moved in the guide; schedule #${existing.id} follows it`);
                    }
                    hit(rule.id, c.identity, existing.id);
                    continue;
                }
                if (db().prepare('SELECT 1 FROM recording_rule_hits WHERE rule_id = ? AND identity = ?').get(rule.id, c.identity)) continue;
                try {
                    const schedule = await engine.scheduleFromProgram({
                        sourceId: c.sourceId, channelItemId: c.channelId, channelName: c.channelName, channelLogo: c.channelLogo,
                        title: c.title, description: c.description, programStart: c.start, programEnd: c.end,
                        preBufferMin: rule.pre_buffer_min ?? undefined, postBufferMin: rule.post_buffer_min ?? undefined,
                        createdBy: rule.created_by
                    });
                    db().prepare('UPDATE scheduled_recordings SET rule_id = ? WHERE id = ? AND rule_id IS NULL').run(rule.id, schedule.id);
                    hit(rule.id, c.identity, schedule.id);
                    made.push({ ruleId: rule.id, scheduleId: schedule.id, title: c.title, start: c.start });
                    console.log(`[Rules] Rule #${rule.id} scheduled "${c.title}" (${c.channelName}) #${schedule.id}`);
                } catch (err) {
                    console.warn(`[Rules] Rule #${rule.id} could not schedule "${c.title}": ${err.message}`);
                }
            }
        }
        lastRun = Date.now();
        return made;
    })().finally(() => { running = null; });
    return running;
}

/** recordingEngine's tick: at most every 15 minutes (a guide sync calls evaluate() itself). */
function evaluateIfDue(now = Date.now()) {
    if (now - lastRun < EVALUATE_EVERY_MS) return null;
    lastRun = now;
    return evaluate({ now });
}

module.exports = { list, get, create, update, remove, validate, evaluate, evaluateIfDue, KINDS, NEAR_MS };
