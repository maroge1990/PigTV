'use strict';
/**
 * #238 / #272 (C-5, I-5): "is anyone looking at sport?", one rule for the three background sport loops.
 *
 *   - the score collector (sportsDashboard) keeps its busy pace while a client has asked for a score page in the last
 *     5 minutes, or a recording is running: `demand()`, unchanged since #238.
 *   - the event-list rebuild (sportsEvents, every 5 min) and the fixture refresh (sportsFixtures, every 30 min) run
 *     while ANY of: someone asked for sport in the last 5 minutes (a score page or the events list), a recording is
 *     running, or an enabled sport recording rule exists. A rule schedules future games from exactly these two
 *     outputs, with nobody looking, so it keeps them alive (`loopDemand()`).
 *   - otherwise a pass is skipped (no ESPN request, no rebuild): one log line when a loop goes idle, one when it
 *     resumes. The first ask after an idle spell (or a rule being created) runs the skipped pass at once (`wake`).
 */
const LOOK_WINDOW_MS = 5 * 60000;
let lookedAt = -Infinity; // a score page was asked for (drives the collector's busy pace)
let askedAt = -Infinity; // any sport read: a score page or the events list (drives the two other loops)

function exists(sql) {
    try { return !!require('../db/sqlite').getDb().prepare(sql).get(); }
    catch { return false; }
}
/** A recording is being made now (its end can follow the game's, #217). */
const recordingNow = () => exists(`SELECT 1 FROM scheduled_recordings WHERE status = 'recording' LIMIT 1`);
/** A recording rule that schedules sport from the event list and fixtures is switched on. */
const ruleEnabled = () => exists(`SELECT 1 FROM recording_rules WHERE enabled = 1 AND kind IN ('sport', 'team', 'game') LIMIT 1`);

/** Why the score collector is at its busy pace now ('looking' | 'recording'), or null when nobody needs it. */
function demand(now = Date.now()) {
    if (now - lookedAt < LOOK_WINDOW_MS) return 'looking';
    return recordingNow() ? 'recording' : null;
}
/** Why the event-list rebuild and the fixture refresh must run now ('looking' | 'recording' | 'rule'), or null. */
function loopDemand(now = Date.now()) {
    if (now - askedAt < LOOK_WINDOW_MS) return 'looking';
    if (recordingNow()) return 'recording';
    return ruleEnabled() ? 'rule' : null;
}

// ---- the idle-able loops ---------------------------------------------------------------------

const loops = new Map(); // name -> { label, idle, since, why, wake }
const log = (msg) => console.log(`[Sport] ${msg}`);

/**
 * Register a loop. -> { gate(now), onWake(fn) }. `gate` is called once per scheduled pass: true when the
 * pass should run, false when it is skipped (logging only on the transition into idle, and out of it).
 */
function createLoop(name, label) {
    const state = { label, idle: false, since: 0, why: null, wake: null };
    loops.set(name, state);
    const resume = (why) => {
        if (!state.idle) return false;
        state.idle = false; state.since = 0; state.why = why;
        log(`${label} resumed (${why})`);
        return true;
    };
    return {
        gate(now = Date.now()) {
            const why = loopDemand(now);
            if (why) { resume(why); state.why = why; return true; }
            if (!state.idle) { state.idle = true; state.since = now; state.why = null; log(`${label} paused: nobody is looking and no recording rule needs it`); }
            return false;
        },
        onWake(fn) { state.wake = fn; }
    };
}

/** A client asked for sport: any loop that skipped a pass runs it now. `why` names the reason for the log. */
function wake(why = 'looking') {
    for (const state of loops.values()) {
        if (!state.idle) continue;
        state.idle = false; state.since = 0; state.why = why;
        log(`${state.label} resumed (${why})`);
        try { state.wake?.(); } catch (err) { console.warn(`[Sport] ${state.label}: ${err.message}`); }
    }
}

/** A client asked for a score page: the collector's busy pace for 5 minutes. -> true when it was quiet before. */
function noteLook(now = Date.now()) {
    const quiet = now - lookedAt >= LOOK_WINDOW_MS && !recordingNow();
    lookedAt = now;
    noteAsk(now);
    return quiet;
}
/** A client asked for any sport read (score page or events list): the two slower loops run for 5 minutes. */
function noteAsk(now = Date.now()) {
    askedAt = now;
    wake('looking');
}

/** For /api/status: whether each idle-able loop is running, and why. */
function status() {
    const out = {};
    for (const [name, state] of loops) {
        out[name] = { running: !state.idle, why: state.idle ? null : state.why, idleSince: state.idle ? state.since : null };
    }
    return out;
}

function reset() { lookedAt = -Infinity; askedAt = -Infinity; for (const s of loops.values()) { s.idle = false; s.since = 0; s.why = null; } }

module.exports = { LOOK_WINDOW_MS, demand, loopDemand, recordingNow, ruleEnabled, createLoop, wake, noteLook, noteAsk, status, reset };
