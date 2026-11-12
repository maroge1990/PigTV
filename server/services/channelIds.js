/**
 * Channel id forms.
 *
 * A channel has two spellings in circulation. The library API (and so the Apple
 * client) uses the bare item id the sync wrote - `pos_412` for an M3U channel,
 * the stream id for Xtream. The web app builds a composite from it,
 * `<sourceType>_<sourceId>_<itemId>`, and sends that. Playback and recordings
 * already accept both; favourites did not, which is why a channel favourited on
 * the phone never appeared on the TV and vice versa.
 *
 * The bare form is canonical: it is what /api/library joins on and what the
 * frozen native contract writes.
 */

const COMPOSITE = /^(?:m3u|xtream)_\d+_(.+)$/;
// The prefix alone. D-6 (#274): the one place it is written; every server site strips through bareChannelId
// (scripts/verify-build.sh fails on an inline copy).
const PREFIX = /^(?:m3u|xtream)_\d+_/;

/**
 * The bare item id, whichever spelling was supplied: String(id) with one composite prefix removed. A null or
 * undefined id is the string 'null'/'undefined', as String() makes it; callers that want '' guard first.
 * A prefix with nothing after it (`m3u_1_`) is returned as it came, as the helper before 0573 did: stripped, it
 * would be '', which a favourite would store and a quarantine key would share with every other such id.
 */
function bareChannelId(id) {
    const s = String(id);
    const bare = s.replace(PREFIX, '');
    return bare === '' ? s : bare;
}

/** The composite spelling the web app uses, for a bare id. */
function compositeChannelId(sourceType, sourceId, id) {
    return `${sourceType === 'xtream' ? 'xtream' : 'm3u'}_${sourceId}_${bareChannelId(id)}`;
}

module.exports = { bareChannelId, compositeChannelId, COMPOSITE };
