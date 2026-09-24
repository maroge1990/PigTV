/**
 * HLS media playlists the server writes itself (the tuner model, 0126-0129).
 *
 * With PIGTV_TUNER=1 a tuner's ffmpeg still writes an HLS playlist, but only the
 * server reads it (parseMediaPlaylist): the segment list it learns from it is kept
 * in memory, and every playlist a client or a recording sees is rendered here
 * (renderMediaPlaylist). That is what lets the server add
 * #EXT-X-PROGRAM-DATE-TIME, keep a window of hours rather than ffmpeg's rolling
 * 90 segments, answer delta updates (_HLS_skip=YES), and write a recording's own
 * EVENT/VOD playlist - none of which ffmpeg's playlist can do for us.
 *
 * Pure functions, no I/O: test/hls-playlist.test.js drives them directly.
 */

const path = require('path');

/**
 * What ffmpeg's hls muxer wrote. Segment names are reduced to their base name
 * (the file sits next to the playlist), and `seq` is the number in the name
 * (seg0042.m4s -> 42), which is the muxer's media sequence number for it.
 *
 * @returns {{version:number|null, targetDuration:number|null, mediaSequence:number|null,
 *            map:string|null, ended:boolean, segments:Array<{name:string, duration:number, seq:number}>}}
 */
function parseMediaPlaylist(text) {
    const out = { version: null, targetDuration: null, mediaSequence: null, map: null, ended: false, segments: [] };
    if (typeof text !== 'string' || !text.startsWith('#EXTM3U')) return out;
    let pendingDuration = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            let m;
            if ((m = /^#EXT-X-VERSION:(\d+)/.exec(line))) out.version = Number(m[1]);
            else if ((m = /^#EXT-X-TARGETDURATION:(\d+)/.exec(line))) out.targetDuration = Number(m[1]);
            else if ((m = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(line))) out.mediaSequence = Number(m[1]);
            else if ((m = /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(line))) out.map = path.basename(m[1]);
            else if ((m = /^#EXTINF:([0-9.]+)/.exec(line))) pendingDuration = Number(m[1]);
            else if (line.startsWith('#EXT-X-ENDLIST')) out.ended = true;
            continue;
        }
        if (pendingDuration === null) continue; // a URI without #EXTINF is not a segment
        const name = path.basename(line.split('?')[0]);
        const seqMatch = /(\d+)\.[a-z0-9]+$/i.exec(name);
        if (seqMatch && Number.isFinite(pendingDuration)) {
            out.segments.push({ name, duration: pendingDuration, seq: Number(seqMatch[1]) });
        }
        pendingDuration = null;
    }
    return out;
}

/** The HLS spec's rule: every EXTINF, rounded, must fit in the target duration. */
function targetDurationFor(segments, atLeast = 1) {
    let td = atLeast;
    for (const s of segments) td = Math.max(td, Math.round(s.duration));
    return td;
}

/**
 * How many of the oldest segments a delta update may leave out: those that end at
 * or before the Skip Boundary, which is `canSkipUntil` seconds before the end of
 * the playlist (RFC 8216bis 4.4.3.8 / 6.2.5.1). Never all of them.
 */
function skippableCount(segments, canSkipUntil) {
    if (!(canSkipUntil > 0) || segments.length === 0) return 0;
    const total = segments.reduce((t, s) => t + s.duration, 0);
    const boundary = total - canSkipUntil;
    let end = 0;
    let n = 0;
    for (const s of segments) {
        end += s.duration;
        if (end <= boundary + 1e-6) n++;
        else break;
    }
    return Math.min(n, segments.length - 1);
}

function formatPdt(ms) {
    return new Date(ms).toISOString();
}

/**
 * A media playlist.
 *
 * @param {object} p
 * @param {Array<{name, duration, pdt?, discontinuity?, map?}>} p.segments  oldest first;
 *        `map` is the init segment in force for it (null for MPEG-TS)
 * @param {number}  p.mediaSequence       sequence number of segments[0]
 * @param {number}  [p.discontinuitySequence]
 * @param {number}  [p.version]           at least this EXT-X-VERSION
 * @param {number}  [p.targetDuration]    at least this (sticky: it must not shrink)
 * @param {string}  [p.playlistType]      'EVENT' | 'VOD'
 * @param {boolean} [p.endList]
 * @param {boolean} [p.independentSegments]
 * @param {number}  [p.canSkipUntil]      seconds; adds EXT-X-SERVER-CONTROL
 * @param {boolean} [p.skip]              render a Playlist Delta Update (_HLS_skip=YES)
 * @param {number}  [p.startOffset]       adds EXT-X-START:TIME-OFFSET (seconds from the start)
 * @returns {{text:string, skipped:number, targetDuration:number}}
 */
function renderMediaPlaylist(p) {
    const segments = p.segments || [];
    const targetDuration = targetDurationFor(segments, p.targetDuration || 1);
    const skipped = p.skip ? skippableCount(segments, p.canSkipUntil) : 0;
    // EXT-X-SKIP needs version 9 (RFC 8216bis 4.4.3.8); everything else keeps
    // what ffmpeg itself would have declared.
    const version = Math.max(p.version || 3, skipped > 0 ? 9 : 0);

    const lines = ['#EXTM3U', `#EXT-X-VERSION:${version}`, `#EXT-X-TARGETDURATION:${targetDuration}`];
    if (p.canSkipUntil > 0) lines.push(`#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=${Number(p.canSkipUntil).toFixed(1)}`);
    lines.push(`#EXT-X-MEDIA-SEQUENCE:${p.mediaSequence || 0}`);
    if (p.discontinuitySequence > 0) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${p.discontinuitySequence}`);
    if (p.playlistType) lines.push(`#EXT-X-PLAYLIST-TYPE:${p.playlistType}`);
    if (p.independentSegments !== false) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
    // Where a player starts: without it an EVENT playlist (a recording still being
    // made) starts near its live end, like live TV (0129).
    if (Number.isFinite(p.startOffset)) lines.push(`#EXT-X-START:TIME-OFFSET=${Number(p.startOffset).toFixed(1)}`);
    if (skipped > 0) lines.push(`#EXT-X-SKIP:SKIPPED-SEGMENTS=${skipped}`);

    let mapInForce = null;
    segments.forEach((s, i) => {
        if (i < skipped) return;
        if (s.discontinuity && i > 0) lines.push('#EXT-X-DISCONTINUITY');
        if (s.map && s.map !== mapInForce) {
            lines.push(`#EXT-X-MAP:URI="${s.map}"`);
            mapInForce = s.map;
        }
        if (Number.isFinite(s.pdt)) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${formatPdt(s.pdt)}`);
        lines.push(`#EXTINF:${s.duration.toFixed(6)},`);
        lines.push(s.name);
    });
    if (p.endList) lines.push('#EXT-X-ENDLIST');
    lines.push('');
    return { text: lines.join('\n'), skipped, targetDuration };
}

module.exports = { parseMediaPlaylist, renderMediaPlaylist, skippableCount, targetDurationFor, formatPdt };
