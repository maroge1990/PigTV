/**
 * Recording rules (R5, Wave 4): "record my team", "record this series". One-off recordings are
 * unchanged; a rule only ever makes ordinary schedules (scheduled_recordings, with rule_id).
 *
 *   sport   a follow-list keyword (a team, "NFL: Arizona Cardinals"; a league, "AFL"; any word):
 *           every Sport EVENT that keyword follows (sportsEvents' own matching, never a replay)
 *           in the next 72 h, recorded on the event's best channel (channels[0]).
 *   series  a programme title on one channel: every airing of it there in the guide (7 days),
 *           or only the ones not flagged "previously shown" (new_only).
 *   team    #198 (D-41 point 11, "Record every game"): a followed team's games from the fixture (the score
 *           collector's cards, never guide titles) in the leagues of `sport` its maker follows (every league of
 *           the sport once they follow none), each recorded on the channel the guide airs it on (the dashboard's
 *           game-to-airing join: never a replay) in the next 72 h. Kept until deleted (D-42).
 *
 * De-duplicated three ways, because guides nudge times between syncs: by identity (the Sport
 * event; the series episode - its episode number or subtitle - else the airing's channel and
 * quarter hour), by an existing schedule of the same title on the same channel within 15 minutes
 * (which also stops two rules recording one event twice), and by hits: each identity a rule has
 * acted on is remembered, so a schedule the viewer cancels is not made again - unless this
 * evaluation finds the cancel unsure (pairInstances: the F4 policy records what it might be).
 *
 * Runs after every guide sync and every 15 minutes (recordingEngine's tick). Native: the idea is
 * Dispatcharr's series rules (AGPL, read, not copied).
 */
const { getDb } = require('../db/sqlite');
const { scheduled: scheduledDb, initSchema } = require('../db/recordingsDb');

const KINDS = ['sport', 'series', 'team'];
const SPORT_HOURS = 72;
const SERIES_DAYS = 7;
const NEAR_MS = 15 * 60 * 1000;
const SERIES_MOVE_MS = 3 * 3600 * 1000; // 0259: how far a series airing without episode data may move and stay itself
// F4 (0245) replaces 0237's six-hour window: see pairEvents().
const EVALUATE_EVERY_MS = 15 * 60 * 1000;
const MAX_MATCH = 120;
const MAX_RULES = 100;
const PREVIOUSLY_SHOWN = 1; // epgParser.PROGRAMME_FLAGS

const db = () => { initSchema(); return getDb(); };
const fold = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function makerName(id) {
    if (id === null || id === undefined) return null;
    try { return db().prepare('SELECT username FROM app_users WHERE id = ?').get(id)?.username || null; } catch (e) { return null; }
}

function shape(r) {
    if (!r) return null;
    const pending = db().prepare(`SELECT COUNT(*) AS n FROM scheduled_recordings WHERE rule_id = ? AND status IN ('scheduled', 'waiting', 'recording')`).get(r.id).n;
    return {
        id: r.id, kind: r.kind, match: r.match,
        sourceId: r.source_id ?? null, channelId: r.channel_item_id ?? null, stableId: r.channel_stable_id ?? null,
        channelName: r.channel_name ?? null,
        preBufferMin: r.pre_buffer_min ?? null, postBufferMin: r.post_buffer_min ?? null,
        newOnly: r.new_only === 1, enabled: r.enabled === 1, createdAt: r.created_at, upcoming: pending,
        // #198 (additive): a team rule's sport, and who set the rule (shown in Recordings)
        sport: r.sport ?? null, createdBy: r.created_by ?? null, createdByName: makerName(r.created_by)
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
    if (!KINDS.includes(kind)) return { error: 'kind must be "sport", "series" or "team"' };
    const match = typeof body.match === 'string' ? body.match.replace(/\s+/g, ' ').trim() : '';
    if (!match || match.length > MAX_MATCH) return { error: `match must be 1 to ${MAX_MATCH} characters` };
    const pre = minutes(body.preBufferMin, 60);
    const post = minutes(body.postBufferMin, 180);
    if (pre === undefined || post === undefined) return { error: 'preBufferMin (0-60) and postBufferMin (0-180) must be whole minutes' };
    const rule = { kind, match, pre_buffer_min: pre, post_buffer_min: post, new_only: body.newOnly === true ? 1 : 0,
        source_id: null, channel_item_id: null, channel_stable_id: null, channel_name: null, sport: null };
    if (kind === 'team') {
        const sport = require('./sportCatalog').sport(body.sport);
        if (!sport) return { error: 'a team rule needs sport, a catalogue sport' };
        rule.sport = sport.sport;
    }
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
        COALESCE(source_id, 0) = COALESCE(?, 0) AND COALESCE(channel_stable_id, channel_item_id, '') = COALESCE(?, ?, '')
        AND COALESCE(sport, '') = COALESCE(?, '')`)
        .get(rule.kind, rule.match, rule.source_id, rule.channel_stable_id, rule.channel_item_id, rule.sport);
    if (same) return { rule: get(same.id), existing: true };
    const info = db().prepare(`INSERT INTO recording_rules (kind, match, source_id, channel_item_id, channel_stable_id, channel_name,
            pre_buffer_min, post_buffer_min, new_only, enabled, created_by, created_at, sport)
        VALUES (@kind, @match, @source_id, @channel_item_id, @channel_stable_id, @channel_name, @pre_buffer_min, @post_buffer_min,
            @new_only, 1, @created_by, @created_at, @sport)`).run({ ...rule, created_by: userId, created_at: Date.now() });
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
        const leagues = ev.league ? [ev.league] : [];
        if (!sportsEvents.followedKeyword(follow, ev.title, ev.aliases || [], leagues)) continue;
        // #207 (as teamCandidates since 0417): C-I merges overlapping broadcasts into one event whose bounds are the
        // widest, so each channel goes by its own airing: the best channel whose own airing is still to start, on
        // that airing's times.
        const pick = (ev.channels || []).map(ch => ({ ch, start: Number.isFinite(ch.start) ? ch.start : ev.start,
            end: Number.isFinite(ch.end) ? ch.end : ev.end })).find(a => a.start > now && a.end > a.start);
        if (!pick) continue; // only what is still to start
        const { ch } = pick;
        out.push({ identity: `event:${ev.id}`, title: ev.title, titles: [ev.title, ...(ev.aliases || [])], anyChannel: true, start: pick.start, end: pick.end,
            sourceId: ch.sourceId, channelId: String(ch.id), channelName: ch.name, channelLogo: ch.logo || null, description: null });
    }
    return out;
}

/**
 * #198 Team: the team's games in the fixture, each on the channel the guide airs it on. Leagues: those of the rule's
 * sport its maker follows, else all of the sport's. A game without a matched airing yet is left for a later evaluation.
 */
async function teamCandidates(rule, now, { games = null, events = null } = {}) {
    const offered = require('./sportCatalog').sport(rule.sport)?.leagues || [];
    let leagues = offered;
    try {
        const mine = rule.created_by === null || rule.created_by === undefined ? null
            : require('./sportPagePrefs').follows(rule.created_by).sports.find(s => s.sport === rule.sport)?.leagues;
        if (mine && mine.length) leagues = mine.filter(l => offered.includes(l));
    } catch (e) { /* every league of the sport */ }
    const dashboard = require('./sportsDashboard');
    const person = (v) => String(v || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const wanted = person(rule.match);
    const mine = (games || dashboard.store().catalog()).filter(g => leagues.includes(g.league) && g.start > now - 12 * 3600 * 1000 &&
        (g.competitors || []).some(c => [c.name, ...(c.aliases || [])].some(a => person(a) === wanted)));
    if (!mine.length) return [];
    const airings = events || (await require('./sportsEvents').eventsFor({ hours: SPORT_HOURS, now })).events;
    const joined = dashboard.matchBroadcasts(mine, airings);
    const out = [];
    for (const g of mine) {
        // 0417 (0416 Codex round 2, high): each channel by its own airing (C-I merges overlapping broadcasts into one
        // event, its bounds the widest): the best channel whose own airing is still to start, on that airing's times.
        const airingsOf = (e) => (e.channels || []).map(ch => ({ e, ch, start: Number.isFinite(ch.start) ? ch.start : e.start,
            end: Number.isFinite(ch.end) ? ch.end : e.end }));
        const pick = (joined.get(g.id) || []).flatMap(airingsOf).filter(a => a.start > now)
            .sort((a, b) => Math.abs(a.start - g.start) - Math.abs(b.start - g.start))[0];
        if (!pick) continue;
        const { e: on, ch } = pick;
        out.push({ identity: `game:${g.id}`, gameId: g.id, title: on.title, titles: [on.title, g.title], anyChannel: false, start: pick.start, end: pick.end,
            sourceId: ch.sourceId, channelId: String(ch.id).replace(/^(?:m3u|xtream)_\d+_/, ''), stableId: ch.stableId || null,
            channelName: ch.name, channelLogo: ch.logo || null, description: null });
    }
    return out;
}

/**
 * 0416 (0415 Codex round 1, high): a team rule's game is its schedule by the game's identity alone (the hit), never by
 * title (two leagues' "Collingwood v Carlton" are two games): the schedule its hit names is the game's, cancelled by the
 * viewer or not; moved with the game when it is pending on the same channel, else (a different channel) cancelled and
 * made again. -> { pairs: Map(candidate -> schedule), declined: Map(candidate -> Set(schedule id)) } as pairInstances.
 */
async function pairGames(rule, candidates, priorHit) {
    const pairs = new Map(), declined = new Map();
    for (const c of candidates) {
        const prior = priorHit.get(rule.id, c.identity);
        const s = prior && scheduledDb.getById(prior.schedule_id);
        if (!s) continue;
        if (['scheduled', 'waiting'].includes(s.status) && s.rule_id === rule.id && !sameChannel(c, s)) {
            await require('./recordingEngine').cancelScheduled(s.id).catch(() => {});
            db().prepare('UPDATE scheduled_recordings SET rule_id = NULL WHERE id = ?').run(s.id);
            declined.set(c, new Set([s.id]));
            continue;
        }
        pairs.set(c, s);
    }
    return { pairs, declined };
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
        out.push({ identity, episode: Boolean(episode), title: r.title, start: r.start_time, end: r.end_time, sourceId: channel.sourceId,
            channelId: String(channel.id), stableId: channel.stableId || null, channelName: channel.name, channelLogo: channel.logo || null, description: r.description || null });
    }
    return out;
}

// Schedules a candidate may already be: not cancelled, or cancelled but made by a rule (what the
// viewer cancelled must not come back - from any rule).
const SCHEDULE_COLUMNS = 'id, source_id, channel_item_id, channel_stable_id, title, program_start, program_end, status, rule_id, sport_game_id';
const LIVE_OR_RULE = `(status <> 'cancelled' OR rule_id IS NOT NULL)`;

/**
 * R5-F3: a schedule is on a candidate's channel by the channel's stable identity when it has one
 * (a playlist reorder changes the position, not the channel); only a schedule without one falls
 * back to its stored position.
 */
const sameChannel = (c, s) => s.source_id === c.sourceId &&
    (s.channel_stable_id ? s.channel_stable_id === c.stableId : String(s.channel_item_id) === c.channelId);

/**
 * A schedule (not cancelled, unless a rule made it) of the same programme within 15 minutes on the
 * same channel. Series airings with an episode key; Sport events and other airings go through pairInstances().
 */
function alreadyScheduled(c, taken = new Set()) {
    const near = db().prepare(`SELECT ${SCHEDULE_COLUMNS} FROM scheduled_recordings
        WHERE ${LIVE_OR_RULE} AND program_start BETWEEN ? AND ?`).all(c.start - NEAR_MS, c.start + NEAR_MS);
    const titles = new Set((c.titles || [c.title]).map(fold));
    return near.find(s => !taken.has(s.id) && titles.has(fold(s.title)) &&
        (c.anyChannel || sameChannel(c, s))) || null;
}

/**
 * F4 (0245; DVR-3), F4 policy (0259, Mark 25 Oct): which existing schedule, if any, each candidate of
 * this evaluation is. The guide gives no lasting id (a Sport event's id changes with its time; a
 * series airing without episode data is known only by its time), so it is decided by the instances:
 *
 *   1. Present: a schedule of the same title (and, for series, the same channel) within 15 minutes
 *      of a candidate is that candidate - it is still in the guide where it was.
 *   2. Moved: a schedule that has not begun (pending, or cancelled by the viewer), starts within
 *      `horizonMs` (what the guide shows: absence beyond it proves nothing) and is not present, is
 *      the same programme as a same-title candidate that has no schedule, at most `maxMoveMs`
 *      away, nearest first, one to one. A pending one follows it.
 *      Ambiguity: a CANCELLED schedule holds only when its pairing is unambiguous - one vanished
 *      schedule and one candidate between them. With several, the candidates it might be are
 *      recorded instead (a recording too many costs a cancel; one missed cannot be undone).
 *   3. Anything else is new: another match of the same teams beside a scheduled one is recorded.
 *
 * A schedule whose time has come or that is already recording (D4) never takes a successor, and a
 * `reserved` one (R5-F2: an episode's, while that episode is in the guide) is never anyone else's.
 * Returns { pairs: Map(candidate -> schedule), declined: Map(candidate -> Set(schedule id)) }, where
 * declined holds the cancelled schedules a candidate might have been but was not paired with as
 * unsure (R5-F1: a hit left by an earlier, clear pairing with one of them does not hold it back).
 */
const MOVABLE = ['scheduled', 'waiting', 'cancelled'];

function pairInstances(candidates, now, { horizonMs, maxMoveMs = Infinity, sameGroup = () => true, reserved = new Set() }) {
    const pairs = new Map(), declined = new Map();
    if (candidates.length === 0) return { pairs, declined };
    const olds = db().prepare(`SELECT ${SCHEDULE_COLUMNS} FROM scheduled_recordings
        WHERE ${LIVE_OR_RULE} AND program_end > ?`).all(now - NEAR_MS).filter(o => !reserved.has(o.id));
    const titlesOf = (c) => new Set((c.titles || [c.title]).map(fold));
    const used = new Set();
    // 1. Present.
    for (const c of candidates) {
        const titles = titlesOf(c);
        const s = olds.find(o => !used.has(o.id) && sameGroup(c, o) && titles.has(fold(o.title)) && Math.abs(o.program_start - c.start) <= NEAR_MS);
        if (s) { pairs.set(c, s); used.add(s.id); }
    }
    // 2. Moved. D4 (0254): only a schedule that has not begun can be a moved one.
    const vanished = olds.filter(o => !used.has(o.id) && MOVABLE.includes(o.status)
        && o.program_start > now && o.program_start < now + horizonMs);
    const options = [];
    for (const c of candidates) {
        if (pairs.has(c)) continue;
        const titles = titlesOf(c);
        for (const o of vanished) {
            const gap = Math.abs(o.program_start - c.start);
            if (gap <= maxMoveMs && sameGroup(c, o) && titles.has(fold(o.title))) options.push({ c, o, gap });
        }
    }
    // Unambiguous: the only option of its candidate and of its schedule.
    const perC = new Map(), perO = new Map();
    for (const x of options) {
        perC.set(x.c, (perC.get(x.c) || 0) + 1);
        perO.set(x.o.id, (perO.get(x.o.id) || 0) + 1);
    }
    const sole = (x) => perC.get(x.c) === 1 && perO.get(x.o.id) === 1;
    options.sort((a, b) => a.gap - b.gap);
    for (const x of options) {
        if (pairs.has(x.c) || used.has(x.o.id)) continue;
        if (x.o.status === 'cancelled' && !sole(x)) { // 0259: unsure, so it is recorded
            if (!declined.has(x.c)) declined.set(x.c, new Set());
            declined.get(x.c).add(x.o.id);
            continue;
        }
        pairs.set(x.c, x.o);
        used.add(x.o.id);
    }
    return { pairs, declined };
}

/** Sport: any channel, within the 72 hours the guide shows, a move of any size inside them. */
const pairEvents = (candidates, now) => pairInstances(candidates, now, { horizonMs: SPORT_HOURS * 3600 * 1000 });

/**
 * Which schedule each series airing WITH episode data already is, decided before anything is
 * matched by time (Codex reviews of 0260, 0263, 0265). An episode is that episode wherever the
 * guide moves it, and a schedule belongs to one episode only:
 *   1. the schedule its hit names (this rule's, not yet begun) is the episode's - taken by the airing
 *      of it at that schedule's time if there is one (a repeat elsewhere never takes it), else by its
 *      first airing, which a pending schedule then follows. Should two episodes' hits name one
 *      schedule, an episode with an airing at its time has it first;
 *   2. an episode with no such schedule: its first airing is the one present within 15 minutes of
 *      it, if any - never a schedule another episode's hit names, whether that episode is in the
 *      guide or not. Repeats are never matched by time.
 * Returns { resolved: Map(candidate -> schedule), taken: Set(schedule id), ownerOf: Map(schedule id
 * -> identity), namedBy: Map(schedule id -> Set(identity)) }. ownerOf: whose each resolved schedule
 * is; namedBy: which episodes' hits name each schedule. A hit naming a schedule that another episode
 * holds now, or whose hit names it too (an older build), does not hold its episode back, and a new
 * schedule for an episode is never one of another's (0269); once an episode holds a schedule, the
 * other hits on it are removed (0272). What is taken is never an unidentified airing's (R5-F2).
 */
function resolveEpisodes(ruleId, candidates, now) {
    const resolved = new Map(), taken = new Set(), ownerOf = new Map();
    const scheduleOf = db().prepare(`SELECT ${SCHEDULE_COLUMNS} FROM scheduled_recordings
        WHERE id = ? AND rule_id = ? AND status IN ('scheduled', 'waiting', 'cancelled') AND program_start > ?`);
    // Every schedule an episode's hit names, in the guide or not: never another episode's by time.
    const named = db().prepare(`SELECT identity, schedule_id FROM recording_rule_hits
        WHERE rule_id = ? AND identity LIKE 'ep:%' AND schedule_id IS NOT NULL`).all(ruleId);
    const hitOf = new Map(named.map(h => [h.identity, h.schedule_id]));
    const namedBy = new Map();
    for (const h of named) {
        if (!namedBy.has(h.schedule_id)) namedBy.set(h.schedule_id, new Set());
        namedBy.get(h.schedule_id).add(h.identity);
    }
    const episodes = candidates.filter(c => c.episode);
    const claims = [];
    for (const identity of new Set(episodes.map(c => c.identity))) {
        const id = hitOf.get(identity);
        const s = id !== undefined ? scheduleOf.get(id, ruleId, now) : null;
        if (!s) continue;
        const airings = episodes.filter(c => c.identity === identity);
        const at = airings.find(c => Math.abs(s.program_start - c.start) <= NEAR_MS);
        claims.push({ identity, s, owner: at || airings[0], present: Boolean(at) });
    }
    claims.sort((x, y) => Number(y.present) - Number(x.present));
    for (const { identity, s, owner } of claims) {
        if (taken.has(s.id)) continue;
        resolved.set(owner, s);
        taken.add(s.id);
        ownerOf.set(s.id, identity);
    }
    const settled = new Set([...resolved.keys()].map(c => c.identity));
    for (const c of episodes) {
        if (settled.has(c.identity)) continue;
        settled.add(c.identity); // its first airing only
        const others = new Set(named.filter(h => h.identity !== c.identity).map(h => h.schedule_id));
        const s = alreadyScheduled(c, new Set([...taken, ...others]));
        if (s) { resolved.set(c, s); taken.add(s.id); ownerOf.set(s.id, c.identity); }
    }
    // Codex review of 0271: a schedule an episode holds is that episode's from now on - another
    // episode's hit on it (left by an older build) goes, so the owner's repeats stay skipped after
    // the schedule has run or its time has passed, and the other episode is recorded when it airs.
    const drop = db().prepare(`DELETE FROM recording_rule_hits WHERE rule_id = ? AND schedule_id = ? AND identity LIKE 'ep:%' AND identity <> ?`);
    for (const [id, identity] of ownerOf) {
        if (drop.run(ruleId, id, identity).changes) namedBy.set(id, new Set([identity]));
    }
    return { resolved, taken, ownerOf, namedBy };
}

/** 0259: series airings without episode data: on the rule's (stable) channel, a move of at most SERIES_MOVE_MS. */
const pairAirings = (candidates, now, reserved) => pairInstances(candidates.filter(c => !c.episode), now, {
    horizonMs: SERIES_DAYS * 24 * 3600 * 1000, maxMoveMs: SERIES_MOVE_MS, sameGroup: sameChannel, reserved
});

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
        // A hit names the schedule that last acted for its identity (R5-F1: a new one replaces a declined one).
        const hitStmt = db().prepare(`INSERT INTO recording_rule_hits (rule_id, identity, schedule_id, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (rule_id, identity) DO UPDATE SET schedule_id = excluded.schedule_id`);
        const hit = (ruleId, identity, scheduleId) => hitStmt.run(ruleId, identity, scheduleId, Date.now());
        const priorHit = db().prepare('SELECT schedule_id FROM recording_rule_hits WHERE rule_id = ? AND identity = ?');
        for (const rule of rules) {
            let candidates = [];
            try {
                candidates = rule.kind === 'sport' ? await sportCandidates(rule, now) : rule.kind === 'team' ? await teamCandidates(rule, now)
                    : seriesCandidates(rule, now);
            } catch (err) {
                console.warn(`[Rules] Rule #${rule.id} could not be evaluated: ${err.message}`);
                continue;
            }
            // Episodes first (their identity), then everything else by instance (pairInstances).
            const episodes = rule.kind === 'series' ? resolveEpisodes(rule.id, candidates, now) : { resolved: new Map(), taken: new Set(), ownerOf: new Map(), namedBy: new Map() };
            const byEvent = rule.kind === 'sport' || rule.kind === 'team';
            const { pairs: events, declined } = rule.kind === 'team' ? await pairGames(rule, candidates, priorHit)
                : byEvent ? pairEvents(candidates, now) : pairAirings(candidates, now, episodes.taken);
            const paired = (c) => (byEvent || !c.episode);
            for (const c of candidates) {
                // D3 (0253): an existing schedule is reconciled first, so a correction back to a time
                // seen before (A -> B -> A, its identity already a hit) still moves it; the hit only
                // stops a second schedule being made.
                const existing = paired(c) ? events.get(c) || null : episodes.resolved.get(c) || null;
                if (existing) {
                    // F4: a moved programme's pending schedule follows it (the viewer's cancel just holds).
                    if (existing.rule_id !== null && ['scheduled', 'waiting'].includes(existing.status)
                        && Math.abs(existing.program_start - c.start) > NEAR_MS) {
                        db().prepare(`UPDATE scheduled_recordings SET program_start = ?, program_end = ? WHERE id = ? AND status IN ('scheduled', 'waiting')`)
                            .run(c.start, c.end, existing.id);
                        console.log(`[Rules] Rule #${rule.id}: "${c.title}" moved in the guide; schedule #${existing.id} follows it`);
                    }
                    // #217: a team rule's schedule records until its game ends (an older one is linked now)
                    if (c.gameId && !existing.sport_game_id && ['scheduled', 'waiting', 'recording'].includes(existing.status)) {
                        db().prepare('UPDATE scheduled_recordings SET sport_game_id = ? WHERE id = ? AND sport_game_id IS NULL').run(c.gameId, existing.id);
                    }
                    hit(rule.id, c.identity, existing.id);
                    continue;
                }
                // R5-F1: a hit holds unless it names a cancelled schedule this pairing found unsure for c,
                // or (Codex review of 0265) a schedule another episode holds now - then c is recorded
                // and its hit names its own schedule.
                const prior = priorHit.get(rule.id, c.identity);
                // Whose a schedule is: its owner in this evaluation if it has one (Codex review of 0269:
                // that outranks an older shared hit, for the owner's repeats too); else any episode
                // other than c whose hit names it.
                const another = (id) => (episodes.ownerOf.has(id) ? episodes.ownerOf.get(id) !== c.identity
                    : [...(episodes.namedBy.get(id) || [])].some(i => i !== c.identity));
                const othersNow = c.episode && prior && another(prior.schedule_id);
                if (prior && !(declined.get(c)?.has(prior.schedule_id)) && !othersNow) continue;
                // 0269: an episode's new schedule is never the one another episode has in that slot.
                const exclude = c.episode ? new Set([...episodes.ownerOf.keys(), ...episodes.namedBy.keys()].filter(another)) : null;
                try {
                    const schedule = await engine.scheduleFromProgram({
                        sourceId: c.sourceId, channelItemId: c.channelId, channelName: c.channelName, channelLogo: c.channelLogo,
                        title: c.title, description: c.description, programStart: c.start, programEnd: c.end,
                        preBufferMin: rule.pre_buffer_min ?? undefined, postBufferMin: rule.post_buffer_min ?? undefined,
                        createdBy: rule.created_by, exclude, gameId: c.gameId || null
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

module.exports = { list, get, create, update, remove, validate, evaluate, evaluateIfDue, teamCandidates, KINDS, NEAR_MS };
