/**
 * Measured channel quality (#265 step 2, D-65): what a channel's stream was actually seen to be, not what its name says
 * (the channel audit found 18 of 62 names stating a quality measured something else).
 *
 * One row per channel identity (source + COALESCE(stable_id, item_id), the favourites' key) in `channel_measurements`:
 * the newest measurement wins, whether it came from the channel audit's results (`scripts/import-channel-audit.js`,
 * source 'audit') or from a play's probe (playbackStrategy, source 'play'). No URL is stored.
 *
 * One rule turns a measurement into what the clients see, `measured: { label, fps }`:
 *   height >= 2000 -> "4K", >= 1000 -> "1080", >= 700 -> "720", else "SD"; fps rounded to a whole number (or null).
 * A channel never measured carries no `measured` at all.
 *
 * Nothing in here may fail a play or a list: a database error is logged and treated as "no measurement".
 */

const { getDb } = require('../db/sqlite');

/** The label for a picture height, or null when there is none. */
function labelFor(height) {
    const h = Number(height);
    if (!Number.isFinite(h) || h <= 0) return null;
    if (h >= 2000) return '4K';
    if (h >= 1000) return '1080';
    if (h >= 700) return '720';
    return 'SD';
}

/** A frame rate (a number, or ffprobe's "50/1" / "30000/1001") rounded to a whole number, or null. */
function roundFps(value) {
    if (value === null || value === undefined || value === '') return null;
    const [num, den] = String(value).split('/').map(Number);
    const rate = den === undefined ? num : (den ? num / den : NaN);
    return Number.isFinite(rate) && rate > 0 && rate <= 240 ? Math.round(rate) : null;
}

/** What the clients see for a stored measurement: { label, fps }, or null. */
function measuredOf(row) {
    const label = row ? labelFor(row.height) : null;
    return label ? { label, fps: roundFps(row.fps) } : null;
}

/**
 * Keep a measurement unless a newer one is already stored. Returns true when it was written.
 * @param {{sourceId:number, key:string, height:number, fps?:number|string, kbps?:number, measuredAt:number, source:'audit'|'play'}} m
 */
function record(m, db = getDb()) {
    const height = Math.round(Number(m.height));
    if (!Number.isFinite(height) || height <= 0 || m.sourceId === null || m.sourceId === undefined || !m.key) return false;
    const fps = (() => {
        const [num, den] = String(m.fps ?? '').split('/').map(Number);
        const rate = den === undefined ? num : (den ? num / den : NaN);
        return Number.isFinite(rate) && rate > 0 ? rate : null;
    })();
    const kbps = Number.isFinite(Number(m.kbps)) && m.kbps !== null ? Math.round(Number(m.kbps)) : null;
    const info = db.prepare(`
        INSERT INTO channel_measurements (source_id, channel_key, height, fps, kbps, measured_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, channel_key) DO UPDATE SET
            height = excluded.height, fps = excluded.fps, kbps = excluded.kbps,
            measured_at = excluded.measured_at, source = excluded.source
        WHERE excluded.measured_at >= channel_measurements.measured_at
    `).run(Number(m.sourceId), String(m.key), height, fps, kbps, Number(m.measuredAt) || Date.now(), m.source === 'audit' ? 'audit' : 'play');
    if (info.changes > 0) changed();
    return info.changes > 0;
}

/**
 * A play's probe of a channel (playbackStrategy, once the session produced its playlist from it and it was not the
 * provider's placeholder). `channel` is { sourceId, key }. Never throws.
 */
function recordPlay(channel, info, measuredAt = Date.now()) {
    try {
        if (!channel || !info) return false;
        return record({ sourceId: channel.sourceId, key: channel.key, height: info.height, fps: info.fps, kbps: null, measuredAt, source: 'play' });
    } catch (err) {
        console.warn('[Measurements] Could not record a play:', err.message);
        return false;
    }
}

/** #332: the play's probe turned out to be the provider's placeholder: drop that measurement (only that one). */
function forgetPlay(channel, measuredAt) {
    try {
        if (!channel) return;
        const info = getDb().prepare("DELETE FROM channel_measurements WHERE source_id = ? AND channel_key = ? AND source = 'play' AND measured_at = ?")
            .run(Number(channel.sourceId), String(channel.key), Number(measuredAt));
        if (info.changes > 0) changed();
    } catch (err) {
        console.warn('[Measurements] Could not drop a play measurement:', err.message);
    }
}

/**
 * Whether one channel-audit result line is a usable measurement: a picture with a height, and not blank, not failed
 * (an error, no video). Returns the measurement, or null.
 */
function auditMeasurement(r) {
    if (!r || typeof r !== 'object') return null;
    if (r.error) return null;
    if (r.blank === true) return null;
    const problems = Array.isArray(r.problems) ? r.problems : [];
    if (problems.includes('blank') || problems.includes('no-video') || problems.includes('no-connect')) return null;
    const v = r.video;
    if (!v || !(Number(v.height) > 0)) return null;
    const sourceId = Number(r.source_id);
    const key = r.stable_id || r.item_id;
    if (!Number.isInteger(sourceId) || !key) return null;
    const at = Date.parse(r.ended || r.started || '');
    return { sourceId, key: String(key), height: Number(v.height), fps: v.fpsAvg ?? v.fpsR ?? null,
        kbps: r.kbps ?? null, measuredAt: Number.isFinite(at) ? at : Date.now(), source: 'audit' };
}

/** Import the channel audit's results.jsonl text: { read, imported, skipped }. Newest wins, in the file and the table. */
function importAudit(text, db = getDb()) {
    const out = { read: 0, imported: 0, skipped: 0 };
    const lines = String(text).split(/\r?\n/).filter(l => l.trim());
    db.transaction(() => {
        for (const line of lines) {
            out.read++;
            let r;
            try { r = JSON.parse(line); } catch { out.skipped++; continue; }
            const m = auditMeasurement(r);
            if (!m) { out.skipped++; continue; }
            if (record(m, db)) out.imported++;
            else out.skipped++;
        }
    })();
    return out;
}

// Quality words in a channel's name (UHD, FHD, HD, SD, HDR, 4K, 1080p50, 720p, 50fps, superscript ᵁᴴᴰ …): the copies
// of one channel ("Sky Sports F1 UHD", "Sky Sports F1 HD", "Sky Sports F1") share one name key (D-65's picker rows).
// The web's SportView.baseName is the same rule.
const QUALITY_WORDS = /[\s\-_|]*[([]?\b(?:u?hd|fhd|sd|hdr(?:10)?|[48]k|\d{3,4}[pi](?:\s?\d{2})?|\d{2}\s?fps)\b[)\]]?/gi;
const SUPERSCRIPT_TAGS = /ᵁᴴᴰ|ᶠᴴᴰ|ᴴᴰ|ˢᴰ/g;
/** A channel's name with its quality words removed (region prefix kept), lower case: the picker groups copies by it. */
function nameKey(name) {
    const raw = String(name || '');
    const folded = raw.replace(SUPERSCRIPT_TAGS, ' ').replace(QUALITY_WORDS, ' ').replace(/\s+/g, ' ').trim();
    return (folded || raw.trim()).toLowerCase();
}

const MEASURED_RANK = { '4K': 0, '1080': 1, '720': 2, SD: 3 };
/**
 * D-65: within each name (nameKey), copies best first by measured label then fps, unmeasured after measured (each kept
 * in its existing relative order). The positions a name holds do not change, so names keep their order and channels[0]
 * is the preferred name's best measured copy. Returns a new array; `keyOf(ch)` gives a channel's name key.
 */
function bestWithinName(channels, keyOf = (ch) => ch.nameKey ?? nameKey(ch.name)) {
    const slots = new Map();
    channels.forEach((ch, i) => { const k = keyOf(ch); if (!slots.has(k)) slots.set(k, []); slots.get(k).push(i); });
    const rank = (ch) => (ch.measured && ch.measured.label in MEASURED_RANK ? MEASURED_RANK[ch.measured.label] * 1000 - (ch.measured.fps || 0) : Infinity);
    const out = channels.slice();
    for (const at of slots.values()) {
        if (at.length < 2) continue;
        const sorted = at.map(i => channels[i]).map((ch, n) => ({ ch, n })).sort((a, b) => (rank(a.ch) - rank(b.ch)) || (a.n - b.n));
        at.forEach((i, n) => { out[i] = sorted[n].ch; });
    }
    return out;
}

/**
 * 0888+1 (#361): the table is read into a Map once and kept, not once per guide page. It is read again when this module
 * wrote (record, forgetPlay: `writes`), when this connection wrote anything (`total_changes()`: a write by hand or by a
 * test) or another connection did (`data_version`: scripts/import-channel-audit.js runs as its own process), and for
 * another database handle. The stamp is one tiny statement; the Map's values are frozen, since every page shares them.
 */
let writes = 0;
let kept = null; // { db, stamp, map }
let stampStmt = null, stampDb = null;
function stampOf(db) {
    if (stampDb !== db) {
        stampDb = db;
        stampStmt = db.prepare('SELECT total_changes() AS t, (SELECT data_version FROM pragma_data_version) AS v');
    }
    const r = stampStmt.get();
    return `${writes}:${r.t}:${r.v}`;
}
function changed() { writes++; kept = null; }

/** Every stored measurement: Map "sourceId:key" -> { label, fps } (shared: do not change it). Empty on any error (a read-only worker, no table). */
function all(db) {
    const handle = db || getDb();
    let stamp = null;
    try { stamp = stampOf(handle); } catch { /* no stamp: read the table, keep nothing */ }
    if (stamp !== null && kept && kept.db === handle && kept.stamp === stamp) return kept.map;
    const map = new Map();
    try {
        for (const r of handle.prepare('SELECT source_id, channel_key, height, fps FROM channel_measurements').all()) {
            const m = measuredOf(r);
            if (m) map.set(`${r.source_id}:${r.channel_key}`, Object.freeze(m));
        }
    } catch (err) { return map; /* no measurements; nothing kept */ }
    // Read inside an open transaction, the rows may still be rolled back: use them, keep nothing.
    kept = stamp === null || handle.inTransaction ? null : { db: handle, stamp, map };
    return map;
}

/** Set `measured` on channel objects ({ sourceId, stableId, id }) that have one, and every one's `nameKey`. */
function applyMeasured(rows, db) {
    for (const r of rows) r.nameKey = nameKey(r.name);
    const map = all(db);
    if (!map.size) return rows;
    for (const r of rows) {
        const m = map.get(`${r.sourceId}:${r.stableId || r.id}`);
        if (m) r.measured = m;
    }
    return rows;
}

/** The kept Map's stamp right now (it changes whenever a measurement may have): for answers kept on top of it. */
function revision(db) {
    const handle = db || getDb();
    try { return stampOf(handle); } catch { return null; }
}

module.exports = { revision, labelFor, roundFps, measuredOf, record, recordPlay, forgetPlay, auditMeasurement, importAudit, all, applyMeasured, nameKey, bestWithinName };
