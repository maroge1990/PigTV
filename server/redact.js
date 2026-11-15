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
    // Xtream path-based stream URL: host/{live|movie|series}/{user}/{pass}/{id}[.{ext}]
    // (buildStreamUrl's format, and playlists that leave the extension off).
    // Anchored on a numeric stream id so a normal path like /live/news/sports/
    // is not caught.
    s = s.replace(
        /\/(live|movie|series)\/[^/\s]+\/[^/\s]+\/(\d+(?:\.\w+)?)(?=$|[^\w/])/gi,
        '/$1/***/***/$2'
    );
    // Xtream catch-up: host/timeshift/{user}/{pass}/{minutes}/{start}/{id}.{ext}
    s = s.replace(/\/timeshift\/[^/\s]+\/[^/\s]+\/(\d+)\//gi, '/timeshift/***/***/$1/');
    // The short form straight after the host: scheme://host[:port]/{user}/{pass}/{id}[.{ext}].
    // Only at the start of the path and only with a numeric last segment, so the
    // server's own /api/... paths are left alone. A login may contain quotes, so the
    // login segments do not stop at them (a quote that ends a logged URL comes after the id).
    s = s.replace(
        /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s?#'"]+)\/(?!api\/)[^/\s?#]+\/[^/\s?#]+\/(\d+(?:\.\w+)?)(?=$|[^\w/])/gi,
        '$1/***/***/$2'
    );
    // ?username=..&password=..&token=.. -> secret values replaced with ***. Quotes are part of
    // the value: over-redacting a closing quote in a log line is harmless, leaving a suffix is not.
    s = s.replace(
        /([?&](?:username|user|password|pass|pwd|token|secret|api[_-]?key)=)[^&\s#]+/gi,
        '$1***'
    );
    return s;
}

/** The host names of the given addresses (a bare host name is taken as it is). */
function hostsOf(known) {
    const hosts = new Set();
    for (const k of [].concat(known || [])) {
        if (!k) continue;
        let host = null;
        try { host = new URL(String(k)).hostname; } catch { host = /^[\w.-]+$/.test(String(k)) ? String(k) : null; }
        host = host && host.replace(/^\[|\]$/g, '');
        if (host && host.length >= 3) hosts.add(host);
    }
    return [...hosts];
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * #307: redact(), then every URL left in the text replaced outright (host and port included) for a log line.
 * #315: also every bare IPv4 address (with its port), and the host of each address in `known` (the stream or
 * provider address the text is about) wherever it appears without a scheme, as ffmpeg's "Failed to resolve
 * hostname ..." and a socket error's "connect ECONNREFUSED host:port" do.
 */
function stripUrls(value, known) {
    if (value == null) return value;
    let s = redact(value).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url removed]');
    for (const host of hostsOf(known)) {
        s = s.replace(new RegExp(`${escapeRe(host)}(?::\\d+)?`, 'gi'), '[host]');
    }
    return s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[host]');
}

module.exports = { redact, stripUrls };
