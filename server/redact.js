/**
 * Strip provider credentials out of a string before it is logged or returned
 * to a client.
 *
 * Upstream stream URLs carry the Xtream username/password as query parameters
 * (and occasionally as URL userinfo), and ffmpeg/ffprobe echo the input URL in
 * their command lines and error output. So without this the provider password
 * lands in the container log on every play, in GET /api/transcode/sessions,
 * and in the error body returned by a failed resolve. This changes only what
 * the server prints or returns, never what it actually fetches.
 *
 * Operates on any string, not just a bare URL, so it can be handed a whole
 * ffmpeg command line or a block of ffprobe stderr.
 */
function redact(value) {
    if (value == null) return value;
    let s = String(value);
    // scheme://user:pass@host  ->  scheme://***:***@host
    s = s.replace(/(\/\/)[^/:@\s]+:[^/@\s]+@/g, '$1***:***@');
    // Xtream path-based stream URL: host/{live|movie|series}/{user}/{pass}/{id}.{ext}
    // (the primary format buildStreamUrl produces). Anchored on a numeric
    // stream id so a normal path like /live/news/sports/ is not caught.
    s = s.replace(
        /\/(live|movie|series)\/[^/\s]+\/[^/\s]+\/(\d+\.\w+)/gi,
        '/$1/***/***/$2'
    );
    // ?username=..&password=..&token=.. -> secret values replaced with ***
    s = s.replace(
        /([?&](?:username|password|pass|pwd|token|secret|api[_-]?key)=)[^&\s'"#]+/gi,
        '$1***'
    );
    return s;
}

module.exports = { redact };
