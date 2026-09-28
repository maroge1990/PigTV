/**
 * Recordings folder health (0157).
 *
 * Background: a live test found a schedule marked failed with "Only 0.0 GB
 * free at /app/recordings, below the 10 GB minimum" - the true cause was a
 * stale Docker bind of an Unraid SMB share, which showed up as a 1 MB tmpfs
 * inside the container. The free-space check alone was technically correct
 * but useless for diagnosis: a genuinely full 10 TB volume and an unmounted
 * share both "have too little free space", and only one of them is a config
 * problem rather than "record less". This module tells them apart, and also
 * catches a folder that exists but cannot be written to (a read-only bind)
 * and one that does not exist at all (a typo'd path, or a share that is not
 * mounted yet).
 *
 * Kept pure-ish and dependency-free (fs only) so it can run from recordingEngine's
 * startup/periodic health check, from the settings route's validation of a new
 * recordingsPath, and from tests, without pulling in the rest of the engine.
 */
const fs = require('fs');
const path = require('path');

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// A filesystem this small is almost certainly not the real recordings volume:
// an unmounted network share's mount point, or a Docker tmpfs standing in for
// a bind that never took, both read back as a tiny (often 1 MB) filesystem
// rather than as "missing" - fs.existsSync is true, statfs just reports a
// filesystem too small to hold anything.
const TINY_FS_BYTES = 1 * GB;

/**
 * Is `dir` reachable and writable, and does it look like the real recordings
 * volume rather than an unmounted share's empty mount point?
 *
 * -> { ok, problem, freeBytes, totalBytes }, problem one of:
 *   'missing'       dir does not exist
 *   'not-writable'  dir exists but a probe file could not be written and removed
 *   'tiny'          the filesystem's total size is under 1 GB (almost certainly
 *                   an unmounted network share or a Docker tmpfs stand-in)
 *   'low-space'     free space is below `minFreeGB`
 *   null            ok is true
 *
 * Never throws: every failure becomes a problem in the result, because this is
 * read by both a periodic background check and a request-time validator, and
 * neither wants a try/catch of its own.
 */
function checkRecordingsFolder(dir, minFreeGB = 10) {
    if (!dir || !fs.existsSync(dir)) {
        return { ok: false, problem: 'missing', freeBytes: null, totalBytes: null };
    }

    let freeBytes = null;
    let totalBytes = null;
    try {
        if (typeof fs.statfsSync === 'function') {
            const st = fs.statfsSync(dir);
            freeBytes = st.bavail * st.bsize;
            totalBytes = st.blocks * st.bsize;
        }
    } catch (e) {
        // Left null; a platform or Node build that cannot report it skips the
        // checks that need it rather than treating that as failure.
    }

    try {
        const probe = path.join(dir, `.pigtv-write-test-${process.pid}-${Date.now()}`);
        fs.writeFileSync(probe, 'pigtv');
        fs.unlinkSync(probe);
    } catch (e) {
        return { ok: false, problem: 'not-writable', freeBytes, totalBytes };
    }

    if (totalBytes !== null && totalBytes < TINY_FS_BYTES) {
        return { ok: false, problem: 'tiny', freeBytes, totalBytes };
    }

    if (freeBytes !== null && minFreeGB > 0 && freeBytes < minFreeGB * GB) {
        return { ok: false, problem: 'low-space', freeBytes, totalBytes };
    }

    return { ok: true, problem: null, freeBytes, totalBytes };
}

/**
 * True when `dir`'s filesystem is under 1 GB in total: an unmounted share's mount
 * point (Unraid keeps /mnt/remotes on a 1 MB tmpfs), not a real recordings volume.
 * False when it can't be told (no statfs), so an unknown never blocks recording.
 */
function onTinyFilesystem(dir) {
    try {
        if (typeof fs.statfsSync !== 'function') return false;
        const st = fs.statfsSync(dir);
        return st.blocks * st.bsize < TINY_FS_BYTES;
    } catch (e) {
        return false;
    }
}

/** "1.0 MB" / "9.5 GB" / "an unknown amount", for a plain-language reason. */
function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'an unknown amount';
    const gb = bytes / GB;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * The plain-language reason a recording was refused, or that the Status page's
 * banner should show, for a checkRecordingsFolder() result that is not ok.
 * `tiny` gets its own wording (B.4): it is the case that actually happened live
 * (a 1 MB tmpfs behind a stale Docker bind) and the one most worth spelling out,
 * since "10 GB minimum" alone reads like "record less", not "check your mount".
 */
function refusalMessage(check, dir, minFreeGB) {
    if (check.problem === 'missing') {
        return `The recordings folder does not exist: ${dir}`;
    }
    if (check.problem === 'not-writable') {
        return `The recordings folder is not writable: ${dir}`;
    }
    if (check.problem === 'tiny') {
        return `The recordings folder isn't reachable: only ${formatBytes(check.freeBytes)} free at ${dir}. Is the network share connected?`;
    }
    if (check.problem === 'low-space') {
        return `Only ${formatBytes(check.freeBytes)} free at ${dir}, below the ${minFreeGB} GB minimum`;
    }
    return `The recordings folder is not usable: ${dir}`;
}

/**
 * Validates a `recordingsPath` an admin is about to save (settings route, B.5).
 * Deliberately more lenient than checkRecordingsFolder(): a path that does not
 * exist YET is fine as long as its parent does, because getRecordingsRoot()
 * below creates exactly that folder on first use - refusing here would reject
 * the normal case (choosing a not-yet-created subfolder), not just typos and
 * unmounted shares.
 * -> { ok } or { ok: false, reason }.
 */
function validateRecordingsPathSetting(dir) {
    if (!dir) return { ok: true };
    // 0167: a relative path ("fake") resolves against the server's own working
    // folder, whose parent always exists, so it passed every check below.
    if (!path.isAbsolute(dir)) {
        return { ok: false, reason: `The recordings folder must be a full path starting with /, for example /app/recordings/SERVER01_Video/Recordings (got "${dir}")` };
    }
    if (fs.existsSync(dir)) {
        try {
            const probe = path.join(dir, `.pigtv-write-test-${process.pid}-${Date.now()}`);
            fs.writeFileSync(probe, 'pigtv');
            fs.unlinkSync(probe);
        } catch (e) {
            return { ok: false, reason: `The recordings folder is not writable: ${dir}` };
        }
        if (onTinyFilesystem(dir)) {
            return { ok: false, reason: `The recordings folder isn't on a real volume (under 1 GB in total): ${dir}. Is the network share connected?` };
        }
        return { ok: true };
    }
    const parent = path.dirname(dir);
    if (!fs.existsSync(parent)) {
        return { ok: false, reason: `The recordings folder does not exist, and neither does its parent (${parent}). Is the share mounted?` };
    }
    // The folder would be created inside a disconnected share's empty mount point.
    if (onTinyFilesystem(parent)) {
        return { ok: false, reason: `The recordings folder does not exist, and its parent isn't on a real volume (under 1 GB in total): ${parent}. Is the network share connected?` };
    }
    return { ok: true };
}

module.exports = { checkRecordingsFolder, refusalMessage, formatBytes, validateRecordingsPathSetting, onTinyFilesystem, TINY_FS_BYTES, GB, MB };
