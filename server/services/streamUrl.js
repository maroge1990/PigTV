/**
 * Only network sources are ever opened.
 *
 * ffmpeg and ffprobe accept far more than a network URL as an input - file:,
 * concat:, pipe:, data:, subfile:, a bare path - and several routes pass a URL
 * from the request straight through to them (resolve's bare `url`, the session
 * route, /api/probe, /api/subtitle). Without this a caller could have the server
 * read its own files back as a "stream". Access is VPN-only today, which bounds
 * it; this makes it not depend on that.
 *
 * The allowed schemes are the network protocols a playlist can legitimately name
 * (an M3U may carry rtmp/rtsp/udp/srt channels, which ffmpeg plays). A
 * -protocol_whitelist on the ffmpeg arguments would do the same job in one place,
 * but those arguments are also run against local sample files by stream-doctor
 * and the tests, so the check lives where URLs come in.
 */
const NETWORK_SCHEMES = new Set(['http:', 'https:', 'rtmp:', 'rtmps:', 'rtsp:', 'rtsps:', 'udp:', 'rtp:', 'srt:']);

function isStreamUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    try {
        return NETWORK_SCHEMES.has(new URL(url).protocol);
    } catch {
        return false;
    }
}

const NOT_A_STREAM_URL = 'Only network stream URLs (http, https, rtmp, rtsp, udp, rtp, srt) can be played';

module.exports = { isStreamUrl, NOT_A_STREAM_URL };
