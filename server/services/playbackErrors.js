/**
 * What a failed resolve tells the viewer (0118, roadmap A1.3, contract C-B).
 *
 * The Apple client shows a resolve `error` verbatim only when it starts with
 * one of ALLOWED_PREFIXES and contains no "://"; anything else becomes its
 * generic message. So every provider/channel failure the server can return from
 * POST /api/playback/resolve is one of the fixed sentences below, and
 * clientSafe() removes any URL from whatever else reaches the route's catch.
 *
 * The sentences never contain a URL or ffmpeg/ffprobe's own words. What ffmpeg
 * actually said stays in the server log (redacted), for diagnosis.
 */

const ALLOWED_PREFIXES = [
    'The provider refused this channel',
    'The provider did not respond',
    'This channel is not available'
];

const MESSAGES = {
    // ffmpeg/ffprobe: "Server returned 4xx" other than 404 (0113 wording, unchanged).
    refused: status => `The provider refused this channel (HTTP ${status}). It may be offline, or still releasing the previous stream; try again in a few seconds.`,
    // ... 5xx
    serverError: status => `The provider refused this channel (HTTP ${status}): its server had a problem. Try again in a few seconds.`,
    // ... 404
    notFound: () => 'This channel is not available from the provider (HTTP 404). It may be offline or have moved; a playlist sync may help.',
    // TCP "Connection refused".
    connectionRefused: () => 'The provider did not respond (connection refused). Its server may be down; try again shortly.',
    // No first segment within the deadline, and ffmpeg said nothing more specific.
    timeout: () => 'The provider did not respond in time. The channel may be offline; try again in a few seconds.',
    // ffmpeg ended before a first segment, and said nothing more specific.
    couldNotOpen: () => 'This channel is not available right now: its stream could not be opened. Try again in a few seconds.',
    // ffprobe failed without a recognisable reason.
    couldNotRead: () => 'This channel is not available right now: its stream could not be read. Try again in a few seconds.',
    // The channel (or its source) is not in the playlist (streamUrlForChannel's 404).
    notInPlaylist: () => 'This channel is not available. It may have been removed from the playlist; a playlist sync may help.',
    // The playlist row has no stream address (streamUrlForChannel's 422).
    noStreamUrl: () => 'This channel is not available: the playlist has no stream address for it.'
};

// Any scheme://... run, however it was redacted.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*/gi;

/** A message with every URL replaced; the last line of defence for the resolve route. */
function clientSafe(message) {
    return String(message == null ? '' : message).replace(URL_RE, '(address hidden)');
}

module.exports = { ALLOWED_PREFIXES, MESSAGES, clientSafe };
