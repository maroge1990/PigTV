/**
 * R4-D2 (0257), R5-D1 (0261): recordings being deleted. deleteRecording retires one before its
 * first await. Every job that publishes a file for a recording - segment delivery and its move
 * (recordingSegments), the native remux and preparation (recordingMedia), compression
 * (recordingPost) - asks owned() after its awaits and before it publishes or records anything; one
 * that finds its recording retired removes only what it made itself and publishes nothing.
 * Ids are never reused (AUTOINCREMENT), so the set only grows (one number per deletion).
 *
 * 0264 (Codex review of 0261): and every step that writes a file for a recording runs as one of
 * its writers (write()). The deletion stops them (an abort signal: ffmpeg is killed, a stream
 * destroyed) and waits until each has ended and removed what it made, before it removes the
 * recording's files and its row - so once a deletion has completed nothing of it is still being
 * written, and a restart cannot leave a late file. A writer started after the retirement is
 * aborted from the start.
 *
 * 0270 (Codex reviews of 0266, 0269): a stop cannot interrupt a filesystem call already stuck on a
 * share that stopped answering (a copy from appdata to the share, while the recording's own files
 * are local). So the deletion waits up to STOP_WAIT_MS, then goes on; a writer still running is
 * abandoned, and what it made is removed when it ends.
 *
 * 0273 (Codex review of 0271): every file a writer makes has a name of its own (partialFor: no other
 * file, of this recording or a later one, can ever have it), and is journalled in recording_cleanup
 * when the writer names it (made(path)), before it exists. A row goes only once that file is gone
 * (published under its final name, or removed); a removal that fails keeps it. sweepCleanup() at
 * start removes whatever is still listed - left by an abandoned writer or a crash, since no writer
 * outlives a restart.
 *
 * 0276 (Mark, 26 Oct; Codex review of 0274): a finished file published under its final name
 * (recordingSegments.publishNoReplace: a hard link from its partial) is journalled as 'published'
 * before its partial name goes, and released (committed) once the database points at it. At start,
 * a 'published' file no recording points at is removed; and a partial still there with another name
 * (a stop between the link and that journalling) has that other name checked the same way. The sweep
 * only ever removes a file this code made.
 *
 * 0277 (Codex review of 0276): a 'published' or withdrawn row also holds the file's identity (0281:
 * device, inode, size, mtime and birthtime - see identityOfStat); the sweep removes it only while that
 * name is still that very file - one put there since is kept, and unlisted. A partial whose second name cannot be removed stays listed, so the next start
 * finds that name again through it.
 *
 * 0279 (Codex review of the journal): the queues that finish, move, prepare and compress recordings
 * wait for the start-up sweep (whenSwept), so recovery never adopts a file the sweep is removing; and
 * a partial that cannot be inspected stays listed.
 *
 * #141: a deleted recording's file that the share stopped answering on is listed as 'deleted', with the identity read
 * just before; the deletion goes on without it. It is removed through shareFs (never the event loop) when the folder
 * check next finds the share answering, and at start - only while that name is still that very file. One whose
 * identity could not be read stays listed (and on the share) until it is gone.
 *
 * 0280 (Codex review of 0279): they wait at most SWEEP_WAIT_MS - a sweep stuck on a share that stopped
 * answering must not stall every queue - so recovery itself never adopts a file the sweep may still
 * remove (adoptable: not listed, and no second name). Inodes are compared exactly (bigint).
 *
 * #287: the finishing queue publishes through shareFs (bounded, off the event loop), and a link may miss its deadline
 * yet land later. So a name is journalled as 'published', with its file's identity, BEFORE the link (published()), and
 * each finish or move attempt first takes back what an earlier one journalled and never committed (takeBack(): the
 * sweep's rules, through bounded calls).
 *
 * Codex review of 0568: the jobs that publish by rename (remux, adoption, compression) do it inside their writer
 * (publishByRename), with the name journalled first and ownership asked again after; a rename that missed its deadline
 * keeps the writer (write's `until`) until it can no longer land. Each such job first takes back what an earlier pass left.
 */
const fs = require('fs');
const crypto = require('crypto');
const shareFs = require('./shareFs');
const { identityOfStat } = require('./shareFsWorker');
const { recordings: recordingsDb, initSchema } = require('../db/recordingsDb');
const { getDb } = require('../db/sqlite');

const STOP_WAIT_MS = 30 * 1000;
let stopWaitMs = STOP_WAIT_MS;
function _setStopWaitMs(ms) { stopWaitMs = ms ?? STOP_WAIT_MS; } // test seam

const retired = new Set();
function retire(id) { retired.add(id); }
const owned = (id) => !retired.has(id) && Boolean(recordingsDb.getById(id));

/**
 * A file a job just made, for a recording that is no longer its: removed, through bounded calls (`io`: shareFs, or
 * shareFs.local for appdata), for the jobs that publish to the share. A copy the share does not let go of now stays
 * journalled as 'published' with its identity: the next attempt (takeBack) or the start-up sweep removes it while that
 * name is still that file.
 */
async function withdrawBounded(file, id, what, io = shareFs) {
    // #287: its own name (held by its publisher), so only another removal under way stops it.
    const mark = claimRemoval(file, { held: true });
    if (!mark) {
        console.warn(`[Recordings] #${id} was deleted while its ${what} was published; that copy is already being removed`);
        return;
    }
    let outstanding = null;
    let identity = null;
    try { identity = await io.identity(file); } catch (e) { /* unknown: kept until it can be told */ }
    try {
        await io.unlink(file);
        forget(file);
    } catch (e) {
        if (e.code === 'SHARE_UNRESPONSIVE') e.fromUnlink = true; // the unlink's own error (shareFs says whether it was sent)
        outstanding = e;
        try {
            cleanupDb().prepare(`INSERT INTO recording_cleanup (path, recording_id, created_at, kind, identity) VALUES (?, ?, ?, 'published', ?)
                ON CONFLICT (path) DO UPDATE SET kind = 'published', identity = COALESCE(excluded.identity, recording_cleanup.identity)`).run(file, id, Date.now(), identity);
        } catch (err) { /* database closed */ }
        console.warn(`[Recordings] #${id} was deleted while its ${what} was published; that copy could not be removed yet (${e.code || e.message}) and is removed later`);
        return;
    } finally {
        endRemoval(file, mark, outstanding);
    }
    console.log(`[Recordings] #${id} was deleted while its ${what} was published; that copy is removed too`);
}

const writers = new Map(); // recording id -> Set of { controller, ended, paths, abandoned }

const cleanupDb = () => { initSchema(); return getDb(); };
const path = require('path');
/** Does a recording point at `p` (its file, or its kept original)? Then it is the recording's, not debris. */
const recorded = (p) => Boolean(cleanupDb().prepare('SELECT 1 FROM recordings WHERE file_path = ? OR segment_original = ? LIMIT 1').get(p, p));
/**
 * Which file is at `p`: device, inode, size, modification and creation time (bigint, ns). A filesystem
 * may give a freed inode number straight to the next new file (Linux does: CI, 26 Oct), so the inode
 * alone does not tell a replacement from the file journalled; its times and size do. None of these
 * change when the file's partial name is linked or removed (only ctime does), so publication keeps it.
 */
async function identityNow(p) {
    try { return identityOfStat(await fs.promises.stat(p, { bigint: true })); } catch (e) { return e.code === 'ENOENT' ? 'gone' : null; }
}
/**
 * #287: `p` is about to become a name of the finished file whose identity is `identity` (journalled before the link, so
 * a link that lands late is still this code's to take back). Journalled as 'published' for recording `id` until
 * committed(). False when the journal lists `p` for anything else (the name is not free); throws if it cannot be journalled.
 */
function published(p, id, identity) {
    if (typeof identity !== 'string') throw new Error('a published name is journalled with the identity of its file');
    const db = cleanupDb();
    const row = db.prepare('SELECT kind, recording_id, identity FROM recording_cleanup WHERE path = ?').get(p);
    if (row) return row.kind === 'published' && row.recording_id === id && row.identity === identity;
    db.prepare(`INSERT INTO recording_cleanup (path, recording_id, created_at, kind, identity) VALUES (?, ?, ?, 'published', ?)`).run(p, id, Date.now(), identity);
    return true;
}
/**
 * Codex review of 0568: `from`, a file writer `id` made (made()), put in place as `to` by a rename that replaces a file
 * already there (the remux's .native.mp4, the adopted "<name>.mp4", the compressed MP4). Called inside that writer's work,
 * with its `until`, so a deletion waits for the publication. `to` is held (never taken back meanwhile) and journalled as
 * 'published' with the file's identity before the rename, so a rename that lands late is still this code's to take back;
 * ownership is asked again after it: a recording retired meanwhile has `to` withdrawn (false). Otherwise `commit()` runs
 * at once (nothing awaited since that check: the database says what `to` is) and `to` is committed (true).
 * A rename the share does not answer rejects as before; the writer and the hold then last until it can no longer land
 * (`settled`), when the same check withdraws `to` if the recording was retired meanwhile, and otherwise leaves it
 * journalled for the next attempt's takeBack (or the sweep). A name whose earlier removal may still land is not taken:
 * that rejects as SHARE_UNRESPONSIVE with nothing sent (the job is tried again later).
 */
async function publishByRename(id, from, to, io, until, what, commit = () => {}) {
    if (removalPending(to)) throw stillRemoving(to);
    hold(to);
    let releaseHere = true;
    try {
        const identity = await io.identity(from);
        if (!identity) throw new Error(`the finished file is missing (${path.basename(from)})`);
        if (!published(to, id, identity)) throw new Error(`${path.basename(to)} is listed for another removal`);
        try {
            await io.rename(from, to);
        } catch (err) {
            if (err.code === 'SHARE_UNRESPONSIVE') {
                if (err.sent === false) { forget(to); throw err; } // never sent: nothing can land
                releaseHere = false; // held until it can no longer land, then checked as below
                until((err.settled || new Promise(() => {})).then(async () => {
                    try { if (!owned(id)) await withdrawBounded(to, id, what, io); } finally { release(to); }
                }));
            }
            throw err; // an errno answer: `to` stays journalled, taken back (while it is that file) by the next attempt
        }
        if (!owned(id)) { await withdrawBounded(to, id, what, io); return false; }
        commit();
        committed(to);
        return true;
    } finally {
        if (releaseHere) release(to);
    }
}
const stillRemoving = (p) => Object.assign(new Error(`an earlier removal of ${path.basename(p)} may still land; tried again later`), { code: 'SHARE_UNRESPONSIVE', sent: false });

/** The database points at `p` now: it is no longer debris. */
function committed(p) { if (p) forget(p); }
function forget(p) {
    try { cleanupDb().prepare('DELETE FROM recording_cleanup WHERE path = ?').run(p); } catch (e) { /* database closed */ }
}
/** Remove `p` and its row; a removal that fails (not "already gone") keeps the row for the next start. */
async function removeListed(p) {
    try { await fs.promises.unlink(p); } catch (e) {
        if (e.code !== 'ENOENT') { console.warn(`[Recordings] Could not remove ${p} yet (${e.code || e.message}); it stays listed`); return false; }
    }
    forget(p);
    return true;
}

/** A name of its own beside `file`, for a file being written: "<file>.<pid>-<random>.partial". */
const partialFor = (file) => `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.partial`;

/**
 * Run `work(signal, made, until)` as a writer of recording `id`; resolves or rejects as it does. `made(path)`
 * journals a file it is about to create (a partialFor name). `until(promise)`: a call of the work's that missed its
 * deadline may still land (shareFs `settled`); the writer lasts until each such promise has settled, after the work
 * has returned, so a deletion waits for it (stopWriters) and its files stay busy meanwhile.
 */
function write(id, work) {
    const controller = new AbortController();
    if (!owned(id)) controller.abort();
    const entry = { controller, paths: new Set(), abandoned: false };
    // Codex review of 0273: a file that cannot be journalled is not made - the INSERT's error stops the
    // writer before it creates anything (a full appdata disk must not leave an untracked file).
    const made = (p) => {
        cleanupDb().prepare('INSERT OR IGNORE INTO recording_cleanup (path, recording_id, created_at) VALUES (?, ?, ?)').run(p, id, Date.now());
        entry.paths.add(p);
    };
    const lasting = [];
    const until = (p) => { lasting.push(Promise.resolve(p).catch(() => {})); };
    const run = Promise.resolve().then(() => work(controller.signal, made, until));
    // #287: no longer busy (set before its caller resumes, when nothing outlasts the work)
    const end = () => { if (lasting.length === 0) { entry.done = true; return; } return Promise.all(lasting.splice(0)).then(end); };
    entry.ended = run.then(end, end);
    if (!writers.has(id)) writers.set(id, new Set());
    writers.get(id).add(entry);
    entry.ended.then(() => {
        const set = writers.get(id);
        if (set) { set.delete(entry); if (set.size === 0) writers.delete(id); }
        if (entry.abandoned) {
            // A deletion stopped waiting for it: what it made goes now.
            for (const p of entry.paths) removeListed(p);
            console.log(`[Recordings] #${id}: a stopped writer ended; what it made is removed`);
            return;
        }
        // Its files are published or removed by now, or soon after (the caller's next step): their rows
        // go once they are gone; one still there stays listed for the sweep.
        setImmediate(() => {
            // Only "not there" lets a row go; any other error (EIO, EACCES) keeps it for the sweep.
            for (const p of entry.paths) fs.promises.access(p).then(() => {}, (e) => { if (e.code === 'ENOENT') forget(p); });
        });
    });
    return run;
}

/**
 * Stop recording `id`'s writers and wait until every one has ended (deleteRecording, after retire()),
 * at most STOP_WAIT_MS: one still running then (a call stuck on the share) is abandoned, its files
 * recorded for removal. Returns the number abandoned.
 */
async function stopWriters(id) {
    const set = writers.get(id);
    if (!set) return 0;
    const running = [...set];
    for (const w of running) w.controller.abort();
    let timer;
    const late = new Promise(r => { timer = setTimeout(r, stopWaitMs); });
    await Promise.race([Promise.all(running.map(w => w.ended)), late]);
    clearTimeout(timer);
    const stuck = running.filter(w => set.has(w));
    if (stuck.length === 0) return 0;
    for (const w of stuck) w.abandoned = true; // its files are journalled already (made)
    console.warn(`[Recordings] #${id}: ${stuck.length} writer(s) did not stop within ${Math.round(stopWaitMs / 1000)} s (the share may not be answering); the deletion goes on and their files are removed when they end or at the next start`);
    return stuck.length;
}

/**
 * At start: every file still listed was left by an abandoned writer or a crash. A 'published' one a
 * recording points at was committed (kept, unlisted); a partial with a second name (its publication
 * stopped right after the link) has that name - the same file, so this code's - treated as published.
 * One that cannot be removed now stays listed.
 */
let swept = Promise.resolve(0);
const SWEEP_WAIT_MS = 60 * 1000;
let sweepWaitMs = SWEEP_WAIT_MS;
function _setSweepWaitMs(ms) { sweepWaitMs = ms ?? SWEEP_WAIT_MS; } // test seam
let sweepLate = false;
/**
 * Settles when the last start-up sweep has, or after SWEEP_WAIT_MS (never rejects): every queue that
 * changes recordings awaits it first. Past the wait the sweep may still be running; adoptable() keeps
 * recovery off what it may remove.
 */
function whenSwept() {
    let timer;
    const late = new Promise(r => { timer = setTimeout(() => {
        if (!sweepLate) console.warn(`[Recordings] The clean-up sweep has run ${Math.round(sweepWaitMs / 1000)} s (the share may not be answering); recordings are finished meanwhile`);
        sweepLate = true;
        r();
    }, sweepWaitMs); });
    return Promise.race([swept, late]).finally(() => clearTimeout(timer));
}
/**
 * May recovery take the file at `p` as a recording's (keepOriginal, recoverLegacyOriginals)? Only one
 * a recording already points at, or one the journal does not list and that has no second name (a
 * publication stopped after its link has two): the sweep never removes either.
 */
async function adoptable(p, io = shareFs) {
    try {
        if (recorded(p)) return true;
        if (cleanupDb().prepare('SELECT 1 FROM recording_cleanup WHERE path = ?').get(p)) return false;
        return (await io.nlink(p)) === 1; // #287: through bounded calls
    } catch (e) {
        if (e.code === 'SHARE_UNRESPONSIVE') throw e;
        return false;
    }
}
/** `alongside`: other start-up removals the queues must also wait for (#141). */
function sweepCleanup(alongside = null) {
    const sweep = sweepOnce().catch((err) => { console.warn('[Recordings] The clean-up sweep failed:', err.message); return 0; });
    swept = Promise.all([sweep, Promise.resolve(alongside).catch(() => null)]).then(([n]) => n);
    swept.then(() => retryDeleted()).catch(() => {});
    return swept;
}

/** #141: `files` ({path, identity}) of deleted recording `id` were not removed: the share stopped answering. */
function deferRemoval(files, id) {
    const stmt = cleanupDb().prepare(`INSERT INTO recording_cleanup (path, recording_id, created_at, kind, identity) VALUES (?, ?, ?, 'deleted', ?)
        ON CONFLICT (path) DO UPDATE SET kind = 'deleted', recording_id = excluded.recording_id, identity = excluded.identity`);
    for (const f of files) stmt.run(f.path, id, Date.now(), f.identity ?? null);
}

/**
 * #141: remove the listed files of deleted recordings, through shareFs: each only while its name is still that very
 * file. Stops at the first call the share does not answer (the next check tries again). Resolves with the number removed.
 */
let retrying = null;
function retryDeleted() {
    if (!retrying) retrying = retryOnce().finally(() => { retrying = null; });
    return retrying;
}
async function retryOnce() {
    let rows = [];
    try { rows = cleanupDb().prepare(`SELECT path, identity FROM recording_cleanup WHERE kind = 'deleted'`).all(); } catch (e) { return 0; }
    let removed = 0;
    for (const { path: p, identity } of rows) {
        if (recorded(p)) { forget(p); continue; } // a recording's file now: never ours to remove
        const mark = claimRemoval(p); // #287
        if (!mark) continue;
        let outstanding = null;
        let unlinking = false;
        try {
            const now = await shareFs.identity(p);
            if (now === null) { forget(p); continue; }
            if (identity === null) continue; // cannot tell which file it is: kept, still listed
            if (now !== identity) { forget(p); continue; } // another file at that name now
            unlinking = true;
            await shareFs.unlink(p);
            forget(p);
            removed++;
        } catch (err) {
            if (unlinking && err.code === 'SHARE_UNRESPONSIVE') err.fromUnlink = true; // the unlink's error (shareFs says if it was sent)
            outstanding = err;
            if (err.code === 'SHARE_UNRESPONSIVE') break;
            console.warn(`[Recordings] Could not remove ${p} yet (${err.code || err.message}); it stays listed`);
        } finally {
            endRemoval(p, mark, outstanding);
        }
    }
    if (removed) console.log(`[Recordings] Removed ${removed} file(s) of deleted recordings the share had not answered for`);
    return removed;
}
/**
 * One listed row: removed when it is still this code's (see sweepCleanup); true when its file was removed. `io` makes
 * the calls: the start-up sweep's own (in this process), or takeBack's bounded ones.
 *   identity(p)          'gone', null (cannot tell) or the identity of the file there
 *   otherNamesCleared(p) a partial's other names (a publication stopped after its link) dealt with: true to go on
 *   remove(p)            removeListed's meaning
 */
async function clearListed(row, io) {
    if (row.kind === 'deleted') return false; // #141: retryDeleted's, through shareFs
    // #287: one removal of a name at a time, never of a name being published or written, and the mark holds from before
    // its identity is read until its unlink has settled (see endRemoval).
    const mark = claimRemoval(row.path);
    if (!mark) return false;
    let outstanding = null;
    try {
        return await clearClaimed(row, io);
    } catch (e) {
        outstanding = e;
        throw e;
    } finally {
        endRemoval(row.path, mark, outstanding);
    }
}
async function clearClaimed({ path: p, kind, identity }, io) {
    if (kind === 'published') {
        if (recorded(p)) { forget(p); return false; }
        const now = await io.identity(p);
        if (now === 'gone') { forget(p); return false; }
        if (now === null || identity === null) return false; // cannot tell which file it is: kept, still listed
        if (now !== identity) { forget(p); return false; } // another file at that name now: never ours to remove
    } else if (!(await io.otherNamesCleared(p))) {
        return false; // the partial stays listed: the way back to that name next time
    }
    return io.remove(p);
}

async function sweepOnce() {
    let rows = [];
    try { rows = cleanupDb().prepare('SELECT path, kind, identity FROM recording_cleanup').all(); } catch (e) { return 0; }
    let removed = 0;
    const io = {
        identity: identityNow,
        async otherNamesCleared(p) {
            let st = null;
            try { st = await fs.promises.stat(p, { bigint: true }); } catch (e) {
                return e.code === 'ENOENT'; // cannot see whether it has another name: it stays listed
            }
            if (!(st.nlink > 1n)) return true;
            // A publication stopped right after its link: its other name is this very file.
            let cleared = true;
            const names = await fs.promises.readdir(path.dirname(p)).catch(() => null);
            if (names === null) cleared = false;
            for (const name of names || []) {
                const other = path.join(path.dirname(p), name);
                if (other === p) continue;
                // Only "not there" is not this file; a name that cannot be inspected keeps the partial listed.
                const o = await fs.promises.stat(other, { bigint: true }).catch((e) => { if (e.code !== 'ENOENT') cleared = false; return null; });
                if (!o || o.ino !== st.ino || o.dev !== st.dev || recorded(other)) continue;
                const mark = claimRemoval(other); // #287
                if (!mark) { cleared = false; continue; }
                try {
                    // Looked at again under the mark: still this very file, and still nobody's.
                    const again = await fs.promises.stat(other, { bigint: true }).catch(() => null);
                    if (!again || again.ino !== st.ino || again.dev !== st.dev || recorded(other)) continue;
                    await fs.promises.unlink(other);
                    removed++;
                } catch (e) { cleared = false; } finally { endRemoval(other, mark, null); }
            }
            return cleared;
        },
        remove: removeListed
    };
    for (const row of rows) {
        if (await clearListed(row, io)) removed++;
    }
    if (removed) console.log(`[Recordings] Cleared ${removed} file(s) left by writers that did not finish`);
    return removed;
}

/**
 * #287: names a publication in this process is putting in place (its partial and the name it links), from before the
 * name is journalled until the database points at it (or it is withdrawn): takeBack never touches them.
 */
const publishing = new Map(); // path -> count
function hold(p) { publishing.set(p, (publishing.get(p) || 0) + 1); }
function release(p) {
    if (!p || !publishing.has(p)) return;
    const n = publishing.get(p) - 1;
    if (n > 0) publishing.set(p, n); else publishing.delete(p);
}
/**
 * Is `p` a file a writer (of any recording) has named, or a name being published, right now? Not an abandoned writer's
 * (stopWriters gave up on it): its files are debris already, removed when it ends or by the sweep.
 */
const busy = (p) => publishing.has(p) || [...writers.values()].some(set => [...set].some(w => !w.abandoned && !w.done && w.paths.has(p)));

/**
 * #287: names being removed (the start-up sweep, takeBack, withdrawBounded, retryDeleted): marked from before the file's
 * identity is read until its unlink has settled. Whoever marks a name first owns its removal (others skip it), and no
 * publication takes a marked name (removalPending). An unlink that missed its deadline may still land: its mark stays
 * until the helper it was sent to has exited (shareFs `settled`), and for the life of the process if that cannot be known.
 */
const removing = new Map(); // path -> mark
/** The mark for removing `p`, or null when it is being removed already, or (unless `held`: its publisher's own withdraw) is in use. */
function claimRemoval(p, { held = false } = {}) {
    if (removing.has(p) || (!held && busy(p))) return null;
    const mark = {};
    removing.set(p, mark);
    return mark;
}
/** `outstanding`: the error the removal ended with, if any. Released now, once its late call can no longer land, or never. */
function endRemoval(p, mark, outstanding) {
    const free = () => { if (removing.get(p) === mark) removing.delete(p); };
    if (!outstanding || outstanding.code !== 'SHARE_UNRESPONSIVE') return free();
    // Only an unlink that shareFs says was sent can still land: until its helper has exited (`settled`).
    if (!outstanding.fromUnlink || outstanding.sent === false) return free();
    if (outstanding.sent && outstanding.settled) outstanding.settled.then(free); // else: kept while this process runs
}
const removalPending = (p) => removing.has(p);

/**
 * #287: before a new attempt to finish or move recording `id`, what an earlier one journalled and never committed is
 * taken back - its partials, and the names it published (a link that missed its deadline may have landed late) while
 * each is still that very file - through bounded calls (`ioFor(path)`: shareFs, or shareFs.local for appdata), so the
 * attempt never publishes a second copy beside it. The sweep's own rules (clearListed). Only rows listed when it starts
 * (a writer's file is listed by made() before it exists, so one started since is never among them), and never a file a
 * writer has named or a name being published (busy), checked again just before each removal. Rejects with
 * SHARE_UNRESPONSIVE when the share does not answer: the attempt ends there.
 */
async function takeBack(id, ioFor = () => shareFs) {
    const rows = cleanupDb().prepare(`SELECT path, kind, identity FROM recording_cleanup WHERE recording_id = ? AND kind IN ('partial', 'published')`).all(id);
    const stillListed = (p) => Boolean(cleanupDb().prepare('SELECT 1 FROM recording_cleanup WHERE path = ?').get(p));
    const bounded = (io) => {
        const answer = (e, fallback) => { if (e.code === 'SHARE_UNRESPONSIVE') throw e; return fallback; };
        return {
            async identity(p) { try { return (await io.identity(p)) ?? 'gone'; } catch (e) { return answer(e, null); } },
            async otherNamesCleared(p) { try { const n = await io.nlink(p); return n === null || n === 1; } catch (e) { return answer(e, false); } },
            async remove(p) {
                if (busy(p)) return false; // in use since this began: left alone
                try { await io.unlink(p); } catch (e) {
                    if (e.code === 'SHARE_UNRESPONSIVE') e.fromUnlink = true; // the unlink's own error (shareFs says whether it was sent)
                    answer(e);
                    console.warn(`[Recordings] Could not remove ${p} yet (${e.code || e.message}); it stays listed`);
                    return false;
                }
                forget(p);
                return true;
            }
        };
    };
    // Partials first (once gone, a link of one that lands late finds nothing), then the published names, then the
    // partials kept because a late link had given them a second name, which is gone by then.
    const partials = rows.filter(r => r.kind === 'partial');
    let removed = 0;
    for (const row of [...partials, ...rows.filter(r => r.kind === 'published'), ...partials]) {
        if (busy(row.path) || !stillListed(row.path)) continue;
        if (await clearListed(row, bounded(ioFor(row.path)))) removed++;
    }
    if (removed) console.log(`[Recordings] #${id}: took back ${removed} file(s) an earlier attempt left on the way to the recordings folder`);
    return removed;
}

const DELETED = 'Recording was deleted';

module.exports = { retire, owned, withdrawBounded, takeBack, publishByRename, stillRemoving, hold, release, forget, removalPending, write, stopWriters, sweepCleanup, whenSwept, deferRemoval, retryDeleted, adoptable, partialFor, published, committed, DELETED, STOP_WAIT_MS, _setStopWaitMs, _setSweepWaitMs };
