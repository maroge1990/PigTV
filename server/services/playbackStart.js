/**
 * Starting a viewer on the first provider that has room (D-7, #274).
 *
 * The one owner of the walk a viewer's start takes through a channel's provider candidates:
 * in order, for each one, check it can be admitted without disturbing anybody, admit the
 * viewer (which takes a connection lease in the same tick), start the stream on that lease,
 * and give the lease back if the start did not bind it to a session - on every way out. The
 * play route's first pass (routes/playback.js) and the relay's cold start
 * (streamRelay.js, Relay.startCold) both walk through here. Past fixes to this shape (0231,
 * 0232, 0244, 0320) were races fixed in one copy at a time; there is one copy now.
 *
 * What differs between the two callers stays in their hooks, in their own files: the route's
 * supersession and deadline checks and its failover bookkeeping; the relay's closed /
 * unusable / "the viewer is watching something else" checks, its renewal-pin bookkeeping and
 * its answer to a recordings source that cannot be read.
 *
 * NOT this walk, by design (do not fold them in):
 *   - The route's forced pass (routes/playback.js, after the walk): the first candidate only,
 *     no "without disturbing" check, a 409 to the caller, recordings it displaces stopped and
 *     their ingests closed: it is the deliberate disturbance this walk avoids.
 *   - The route's warm adopt (routes/playback.js, before the walk): adopts a warm session's
 *     existing lease; nothing is started and no candidate is walked.
 *   - The relay's standby start (streamRelay.js, startStandby): tryReserveFree /
 *     reserveTakingWarm, never admitViewer: a standby may only take a free (or warm)
 *     connection and is never a viewer.
 *   - Warming (channelWarming.js, warm): tryReserveFree only, no failover: a guess must never
 *     disturb anybody nor walk the providers.
 *   - Recording (recordingEngine.js, chooseProvider / startPart): requestForRecording /
 *     canRecordFreely and releaseLease: a recording has its own admission rules (it may
 *     prompt a viewer) and its lease outlives the start.
 */

// Required lazily, as streamRelay.js does: the coordinator is not needed at load.
const defaultCoordinator = () => require('./streamCoordinator');

/** What a `before` hook returns to pass over this candidate, or to end the walk. */
const SKIP = 'skip';
const STOP = 'stop';

/**
 * Walk `candidates` in order and start the first that can be admitted without disturbing anyone.
 *
 * Per candidate, in this order:
 *   1. before(candidate, i)          SKIP: next candidate; STOP: the walk ends (null); may throw.
 *   2. ask(candidate, i)             the admission request (force:false is the caller's to set).
 *   3. coordinator.canAdmitWithoutDisturbing(ask)   false: next candidate.
 *   4. await coordinator.admitViewer(ask)           not allowed: next candidate.
 *      A throw from 3 or 4 (the running recordings could not be read) goes to
 *      admissionFailed(err) when given, which ends the walk (null); otherwise it propagates.
 *      No lease exists yet at this point.
 *   5. admitted(verdict, candidate, i)              bookkeeping on the admission.
 *   6. await start(candidate, i, verdict.lease, verdict)
 *      a truthy result ends the walk with it; a falsy one goes on to the next candidate.
 *      A throw goes to failed(err, candidate, i), which rethrows to end the walk or returns to
 *      go on; without `failed`, it propagates.
 *   7. finally coordinator.releaseUnbound(verdict.lease), after 6 on every path (a bound lease
 *      is left alone).
 *
 * @returns {Promise<*>} the first truthy start result, or null.
 */
async function startOnFirstFree(candidates, { ask, start, before = null, admitted = null, failed = null,
    admissionFailed = null, coordinator = null } = {}) {
    const coord = coordinator || defaultCoordinator();
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (before) {
            const go = before(candidate, i);
            if (go === STOP) return null;
            if (go === SKIP) continue;
        }
        const request = ask(candidate, i);
        let verdict;
        try {
            if (!coord.canAdmitWithoutDisturbing(request)) continue;
            verdict = await coord.admitViewer(request);
        } catch (err) {
            if (!admissionFailed) throw err;
            admissionFailed(err, candidate, i);
            return null;
        }
        if (!verdict.allowed) continue;
        if (admitted) admitted(verdict, candidate, i);
        // R11: the lease is released on every way out that leaves no session to count; once
        // the session exists the lease is bound to it and releaseUnbound leaves it alone.
        const lease = verdict.lease;
        let result;
        try {
            result = await start(candidate, i, lease, verdict);
        } catch (err) {
            if (!failed) throw err;
            failed(err, candidate, i);
        } finally {
            coord.releaseUnbound(lease);
        }
        if (result) return result;
    }
    return null;
}

module.exports = { startOnFirstFree, SKIP, STOP };
