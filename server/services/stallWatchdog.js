/**
 * Output-inactivity watchdog for ffmpeg processes that read a live upstream.
 *
 * The failure this exists for: the provider drops the connection, ffmpeg's
 * -reconnect flags kick in, and it sits in a reconnect loop forever. The process
 * is alive, so nothing reaps it; it is silent, so nobody is being served; and it
 * still counts as the one provider connection, so the next channel change is
 * refused with no explanation.
 *
 * "Alive" is therefore the wrong test. This asks the only question that matters:
 * has the process produced any media recently? What "produced media" means
 * differs by delivery path (bytes on stdout for a remux, files landing in the
 * session directory for HLS), so the caller supplies that as getLastActivity()
 * and this module owns the timing and the decision.
 *
 * Two limits are used. Before the first output a process is probing the source
 * and legitimately quiet, so it gets a longer grace; once it has produced
 * output, silence for stallMs means it has stopped.
 */

function positiveInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Silence, after output has started, that counts as a stall. Both delivery
// paths only write at keyframe boundaries (an fMP4 fragment, an HLS segment),
// so a healthy copy-mode source with a 10 s GOP is quiet for 10 s between
// writes. 20 s clears that with margin: reaping a dead stream a few seconds
// late costs little, killing a live one costs a viewer. Overridable without a
// patch so it can be tuned against a real feed.
const STALL_TIMEOUT_MS = positiveInt(process.env.PIGTV_STALL_TIMEOUT_MS, 20000);

// Silence allowed before the first output: source probing plus connect time.
const STARTUP_GRACE_MS = Math.max(STALL_TIMEOUT_MS, 30000);

const CHECK_INTERVAL_MS = 2000;

/**
 * @param {object}   opts
 * @param {string}   opts.label            log prefix
 * @param {function} opts.getLastActivity  () => epoch ms of the most recent
 *        output, or null if there has been none. May be async. Activity older
 *        than the watchdog itself is ignored, so a stale file left behind by a
 *        previous attempt cannot look like output.
 * @param {function} opts.onStall          (quietMs, sawOutput) => void, called
 *        once; the watchdog has already stopped itself by then.
 * @param {number}   [opts.stallMs]
 * @param {number}   [opts.startupMs]
 * @param {number}   [opts.checkIntervalMs]
 * @param {function} [opts.now]            injectable clock, for tests
 * @returns {{ stop: function }}
 */
function createStallWatchdog({
    label,
    getLastActivity,
    onStall,
    stallMs = STALL_TIMEOUT_MS,
    startupMs = STARTUP_GRACE_MS,
    checkIntervalMs = CHECK_INTERVAL_MS,
    now = Date.now
}) {
    const startedAt = now();
    let stopped = false;
    let checking = false;

    const stop = () => {
        stopped = true;
        clearInterval(timer);
    };

    const check = async () => {
        // getLastActivity may be async (a directory scan); never let a slow
        // one pile up overlapping checks.
        if (stopped || checking) return;
        checking = true;
        try {
            let last = null;
            try {
                last = await getLastActivity();
            } catch (err) {
                // Can't tell. Never kill a process on the strength of a
                // failed measurement.
                return;
            }
            if (stopped) return;

            const sawOutput = last !== null && last !== undefined && last >= startedAt;
            const quietMs = now() - (sawOutput ? last : startedAt);
            const limit = sawOutput ? stallMs : startupMs;
            if (quietMs >= limit) {
                stop();
                console.warn(`[${label}] No output for ${Math.round(quietMs / 1000)}s ` +
                    `${sawOutput ? 'since the last data' : 'since starting'}; treating ffmpeg as stalled`);
                onStall(quietMs, sawOutput);
            }
        } finally {
            checking = false;
        }
    };

    const timer = setInterval(check, checkIntervalMs);
    timer.unref(); // never keep the process alive on our account

    return { stop };
}

module.exports = {
    createStallWatchdog,
    STALL_TIMEOUT_MS,
    STARTUP_GRACE_MS,
    CHECK_INTERVAL_MS
};
