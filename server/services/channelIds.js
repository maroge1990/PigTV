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

/** The bare item id, whichever spelling was supplied. */
function bareChannelId(id) {
    const s = String(id);
    const m = COMPOSITE.exec(s);
    return m ? m[1] : s;
}

/** The composite spelling the web app uses, for a bare id. */
function compositeChannelId(sourceType, sourceId, id) {
    return `${sourceType === 'xtream' ? 'xtream' : 'm3u'}_${sourceId}_${bareChannelId(id)}`;
}

module.exports = { bareChannelId, compositeChannelId, COMPOSITE };
