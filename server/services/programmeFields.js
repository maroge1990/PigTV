/**
 * #56: what a guide programme carries besides its title, description and times (the library guide and #57's search):
 *   live      true when the guide flags the airing live (XMLTV <live/>) or it is the airing of a live sport game
 *             (a C-I event of kind `event`, from the last built event list; never a replay)
 *   new       true when the guide flags it new or a premiere, false when it flags it previously shown (the flag C-M's
 *             newOnly skips); absent when the guide says neither
 *   subtitle  its <sub-title> (the episode's own title)
 *   episode   "S2 E5" (or "E5" with no season) read from its <episode-num> when that names an episode
 *   image     its <icon> through the logo cache (/api/logo/<key>), never the provider's address
 * Each field is absent when unknown. Reads epg_live's `flags` and `data` (syncService.programmeData: sub, ep, img).
 */
const { PROGRAMME_FLAGS } = require('./epgParser');
const { applyLogoCache } = require('./logoCache');

const LIVE = PROGRAMME_FLAGS.live;
const NEW = PROGRAMME_FLAGS.new | PROGRAMME_FLAGS.premiere;
const PREVIOUSLY_SHOWN = PROGRAMME_FLAGS['previously-shown'];

/** "S2 E5" / "E5" from an <episode-num> text (on-screen "S02E05", "S2 E5", xmltv_ns "1.4.0/1"), else null. */
function episodeText(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;
    let m = s.match(/^S(?:eason)?\s*(\d{1,4})\s*[,.:-]?\s*E(?:p(?:isode)?)?\.?\s*(\d{1,5})\b/i);
    if (m) return `S${+m[1]} E${+m[2]}`;
    // xmltv_ns: zero-based "season.episode.part", each optionally "n/total", any part may be blank.
    m = s.match(/^(\d{0,4})\s*(?:\/\s*\d+)?\s*\.\s*(\d{0,5})\s*(?:\/\s*\d+)?\s*\.\s*[\d/\s]*$/);
    if (m && m[2] !== '') {
        const ep = +m[2] + 1;
        return m[1] !== '' ? `S${+m[1] + 1} E${ep}` : `E${ep}`;
    }
    m = s.match(/^E(?:p(?:isode)?)?\.?\s*(\d{1,5})$/i);
    if (m) return `E${+m[1]}`;
    return null;
}

function parseData(data) {
    if (!data) return {};
    try { return JSON.parse(data) || {}; } catch (e) { return {}; }
}

/**
 * The #56 fields of one epg_live row ({ flags, data, start_time }) on a channel ({ sourceId, id, stableId }), as an
 * object to spread into the programme, plus `_img` (the raw image address) for applyImages to turn into `image`.
 * `liveIndex` is sportsEvents.liveAirings() (or null).
 */
function extras(row, channel, liveIndex) {
    const out = {};
    const flags = row.flags | 0;
    if ((flags & LIVE) || sportLive(row, channel, liveIndex)) out.live = true;
    if (flags & NEW) out.new = true;
    else if (flags & PREVIOUSLY_SHOWN) out.new = false;
    const data = parseData(row.data);
    if (typeof data.sub === 'string' && data.sub.trim()) out.subtitle = data.sub.trim();
    const ep = episodeText(data.ep);
    if (ep) out.episode = ep;
    if (typeof data.img === 'string' && /^https?:\/\//i.test(data.img)) out._img = data.img;
    return out;
}

function sportLive(row, channel, liveIndex) {
    if (!liveIndex || !channel) return false;
    const spans = liveIndex.get(`${channel.sourceId}:${channel.stableId || channel.id}`);
    if (!spans) return false;
    for (const [from, to] of spans) if (row.start_time >= from && row.start_time < to) return true;
    return false;
}

/** Each programme's `_img` becomes `image` (/api/logo/<key>), one transaction for the lot; `_img` is removed. */
function applyImages(programmes) {
    const holders = [];
    for (const p of programmes) {
        if (!p._img) { delete p._img; continue; }
        holders.push({ p, logo: p._img });
        delete p._img;
    }
    if (!holders.length) return;
    try { applyLogoCache(holders); } catch (e) { return; } // artwork never fails a listing
    for (const h of holders) if (typeof h.logo === 'string' && h.logo.startsWith('/api/logo/')) h.p.image = h.logo;
}

/** The sport index, or null when the event list has not been built (it never builds one). */
function liveIndex() {
    try { return require('./sportsEvents').liveAirings(); } catch (e) { return null; }
}

module.exports = { episodeText, extras, applyImages, liveIndex };
