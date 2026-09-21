/**
 * A channel identity that survives the provider reshuffling its playlist.
 *
 * `item_id` is `pos_N` - the channel's line number in the M3U. 0015 chose it
 * deliberately, and the reasoning still holds: tvg-id collides for regional
 * feeds sharing an EPG id, a URL hash collides for channels cross-listed in
 * several categories, and placeholder rows have no URL at all, so position is
 * the only value guaranteed unique per line. It has to stay the row key.
 *
 * What it is not is stable. On 21 September 2026 the provider inserted
 * channels mid-playlist and every id after the insertion shifted: Fox Sports
 * 505 moved from pos_1187 to pos_1185 within six hours, same channel, same
 * URL. Favourites, channel_history and scheduled recordings all key on that
 * id, so they quietly came to point at whatever now occupies the position -
 * a favourite was observed playing a different channel that evening, and a
 * recording scheduled on one channel would have recorded another.
 *
 * So identity and row key are separated. This derives the identity.
 *
 * What it is derived from, in order:
 *
 *   1. The provider's own stream id, taken from the URL path. Xtream-style
 *      URLs are `/live/<user>/<pass>/<streamId>.<ext>` - the id is assigned by
 *      the provider, does not move when the playlist is reordered (proven on
 *      the reorder above), and is not the credentials, which rotate. This is
 *      why the whole URL is not hashed: 0015 rejected a URL hash partly
 *      because of that.
 *   2. Failing that, a hash of the URL with anything credential-shaped
 *      removed - the best available for a playlist that is not Xtream-shaped.
 *   3. Nothing, for a row with no URL. Those are the `##### SECTION #####`
 *      placeholder lines: they cannot be played, so they cannot meaningfully
 *      be favourited or recorded, and giving them a synthetic identity would
 *      only invent collisions.
 *
 * Deliberately NOT unique: a channel cross-listed in two categories has one
 * identity and two rows. That is the correct answer for a favourite - it is
 * the same channel - and it is why this cannot replace `item_id`.
 */

const crypto = require('crypto');

// `/live/<user>/<pass>/<streamId>.<ext>`, and the movie/series equivalents.
// Anchored on the type segment so an ordinary path like /news/sports/12.ts
// is not mistaken for credentials.
const XTREAM_PATH = /\/(?:live|movie|series)\/[^/]+\/[^/]+\/([^/]+?)(?:\.[A-Za-z0-9]+)?$/i;

// Credential-shaped query parameters, dropped before hashing so a password
// rotation does not change every channel's identity.
const CRED_PARAMS = /([?&](?:username|password|pass|pwd|user|token|secret|api[_-]?key)=)[^&]*/gi;

/**
 * The provider's own stream id for this URL, or null when the URL is not
 * shaped that way.
 */
function providerStreamId(url) {
    if (!url) return null;
    const withoutQuery = String(url).split(/[?#]/)[0];
    const m = XTREAM_PATH.exec(withoutQuery);
    if (!m) return null;
    // Only a numeric id: a non-numeric last segment is a filename, not an id,
    // and would make two unrelated channels called `index.m3u8` the same thing.
    return /^\d+$/.test(m[1]) ? m[1] : null;
}

/**
 * What this channel is, as opposed to where it currently sits in the playlist.
 * Returns null when the row has no URL to derive anything from.
 */
function stableChannelId(url) {
    if (!url || typeof url !== 'string' || !url.trim()) return null;

    const streamId = providerStreamId(url);
    if (streamId) return `s${streamId}`;

    // No provider id to use. Hash what is left after removing the parts that
    // can change without the channel changing: userinfo and credential query
    // parameters.
    const canonical = url
        .replace(/(\/\/)[^/@\s]+@/, '$1')
        .replace(CRED_PARAMS, '$1');
    return `u${crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16)}`;
}

/**
 * How a whole playlist derives, for the log line after a sync. Evidence that
 * the derivation suits this provider before anything is keyed on it.
 */
function summarise(urls) {
    const counts = { total: 0, providerId: 0, urlHash: 0, none: 0 };
    const seen = new Map();
    for (const url of urls) {
        counts.total++;
        const id = stableChannelId(url);
        if (id === null) { counts.none++; continue; }
        if (id.startsWith('s')) counts.providerId++; else counts.urlHash++;
        seen.set(id, (seen.get(id) || 0) + 1);
    }
    // Rows sharing an identity are the cross-listed channels. Expected, and
    // worth counting: a large number would mean the derivation is too coarse.
    counts.distinct = seen.size;
    counts.shared = [...seen.values()].filter(n => n > 1).length;
    return counts;
}

module.exports = { stableChannelId, providerStreamId, summarise };
