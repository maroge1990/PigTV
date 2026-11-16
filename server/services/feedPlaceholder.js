'use strict';

/**
 * #332: the provider's placeholder. When a provider has nothing on a stream it serves one still picture (1920x1080 at
 * 30 fps, about 193 kbps with its sound), usually closing within about a second and served again on every reconnect
 * (#331's channel audit, 15-16 Nov 2026: 249 of 254 blank captures share one first frame; blanks reach at most
 * 435 kbps, the lowest real channel 448 kbps; median held 1 s). Every reconnect delivers MPEG-TS, so the ingest's
 * 10 s reconnect failure never fires; this is the rule that tells such a feed from a channel.
 *
 * The rule, pure (ingest.js keeps the count per feed):
 *   - a connection is *short and low-rate* when it ended within SHORT_CONNECTION_MS of its first MPEG-TS, having
 *     delivered data at an average rate below connectionLimitKbps(height) - the 20 s blank-picture check's threshold
 *     (transcodeSession.checkPicture, 0191: 500 kbps, 250 below 720p, PIGTV_BLANK_KBPS overrides), and the lower one
 *     (250) when the height is not known (Codex #332 high: a recording-only feed has none, and a real 448 kbps 400p
 *     channel with two short drops must not be taken for the slate, ~193 kbps). The rate is the
 *     bytes over the longer of the connection's wall time and the media time its PCR covered, so a slate sent in one
 *     burst is measured by the seconds it holds, not the milliseconds it took to arrive.
 *   - PLACEHOLDER_RUN such connections in a row make the feed a placeholder. Any other connection (long, or at a
 *     channel's rate) starts the count again.
 *   - The 20 s blank verdict counts as a placeholder too when the feed has had at least one short low-rate connection,
 *     or the session's picture has the placeholder's shape (PLACEHOLDER_SHAPE).
 * A real low-bitrate channel (448 kbps at 400p, one long connection) is never one: its connections do not end early.
 */

/** A connection that ends this soon after its first MPEG-TS can be the placeholder's (median 1 s in the audit). */
const SHORT_CONNECTION_MS = 15000;
/** How many short low-rate connections in a row make the feed a placeholder. */
const PLACEHOLDER_RUN = 2;
/** The placeholder's picture: 1920x1080 at 30 fps (every one the audit kept). */
const PLACEHOLDER_SHAPE = Object.freeze({ width: 1920, height: 1080, fps: 30 });
/** The threshold when the feed's height is not known: the HD threshold. */
const UNKNOWN_HEIGHT_KBPS = 500;

/** 0191: under this rate (kbps, audio included) a picture is blank. PIGTV_BLANK_KBPS overrides; 250 below 720p. */
function blankKbps(height) {
    const n = Number.parseInt(process.env.PIGTV_BLANK_KBPS, 10);
    if (Number.isFinite(n) && n >= 0) return n;
    return height && height < 720 ? 250 : UNKNOWN_HEIGHT_KBPS;
}

/** The short-connection rule's threshold: blankKbps for a known height, else the lower (below-720p) one. */
function connectionLimitKbps(height) {
    const h = Number(height) || 0;
    return blankKbps(h > 0 ? h : 1);
}

/**
 * #333 (Codex sign-off high): the one threshold that lets a recording delete what it recorded (#332's slate part,
 * #333's file tail and its file verdict). Never above DESTRUCTIVE_MAX_KBPS, whatever PIGTV_BLANK_KBPS says: a real
 * 448 kbps channel must never be deleted as the slate (~71-193 kbps). An override may only lower it.
 */
const DESTRUCTIVE_MAX_KBPS = 250;
function destructiveKbps() {
    return Math.min(DESTRUCTIVE_MAX_KBPS, connectionLimitKbps(null));
}

/** A connection's average rate in kbps: { bytes, wallMs, mediaSec } -> bytes over the longer of the two times. */
function connectionKbps({ bytes = 0, wallMs = 0, mediaSec = 0 } = {}) {
    const sec = Math.max((Number(wallMs) || 0) / 1000, Number(mediaSec) || 0);
    if (!(sec > 0)) return Infinity; // nothing to measure by: never low
    return (Number(bytes) || 0) * 8 / sec / 1000;
}

/** Did this connection end soon after it started, at a rate a channel never has? */
function isShortLowRate(conn, { height = null, shortMs = SHORT_CONNECTION_MS } = {}) {
    if (!conn || !(Number(conn.wallMs) <= shortMs)) return false;
    return connectionKbps(conn) < connectionLimitKbps(height);
}

/** The run of short low-rate connections after `conn` ended: one more, or back to 0. */
function nextRun(run, conn, opts = {}) {
    return isShortLowRate(conn, opts) ? (Number(run) || 0) + 1 : 0;
}

/** Is a run this long the placeholder? */
function isPlaceholderRun(run) {
    return Number(run) >= PLACEHOLDER_RUN;
}

const frameRate = (fps) => {
    if (typeof fps === 'number') return fps;
    const m = /^\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(String(fps || ''));
    if (!m) return null;
    const v = Number(m[1]) / (m[2] ? Number(m[2]) : 1);
    return Number.isFinite(v) ? v : null;
};

/** Is this picture the placeholder's shape (1920x1080 at 30 fps; 29.97 is a real US channel's, not the slate's)? */
function hasPlaceholderShape({ width, height, fps } = {}) {
    const rate = frameRate(fps);
    return Number(width) === PLACEHOLDER_SHAPE.width && Number(height) === PLACEHOLDER_SHAPE.height
        && rate !== null && Math.abs(rate - PLACEHOLDER_SHAPE.fps) < 0.01;
}

/** Does a 20 s blank verdict mean the placeholder (rather than a dark or still channel)? */
function blankIsPlaceholder({ shortLowSeen = false, width = null, height = null, fps = null } = {}) {
    return shortLowSeen === true || hasPlaceholderShape({ width, height, fps });
}

module.exports = {
    SHORT_CONNECTION_MS, PLACEHOLDER_RUN, PLACEHOLDER_SHAPE, UNKNOWN_HEIGHT_KBPS,
    DESTRUCTIVE_MAX_KBPS, destructiveKbps, blankKbps, connectionLimitKbps, connectionKbps, isShortLowRate, nextRun, isPlaceholderRun, hasPlaceholderShape, blankIsPlaceholder
};
