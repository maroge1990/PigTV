/**
 * Review of 0898/0899: mask what looks like a credential in free text that redact()/stripUrls() cannot see, because it
 * has no URL around it: a JSON or inspected-object key (`"password":"x"`, `token: 'x'`, `api_key=x`), a `Bearer`/`Basic`
 * value, and a Cookie/Authorization header written as text (the rest of its line). Best effort: a secret quoted with
 * none of these around it is not recognised. Used on the crash record's message (services/crashLog.js).
 */
const SECRET_KEY = '(?:password|passwd|pass|pwd|access_token|refresh_token|token|secret|authorization|set-cookie|cookie|api[_-]?key|apikey|x-api-key)';
// key, optional quote, : or =, then a quoted value or a run up to a separator.
const KEY_VALUE = new RegExp(`((?<![\\w-])["']?${SECRET_KEY}["']?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?|[^\\s,;&}\\]]+)`, 'gi');
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// A header written as text ("Cookie: a=1; b=2"): the whole rest of the line.
const HEADER_LINE = /((?<![\w-])(?:proxy-authorization|authorization|set-cookie|cookie)\s*:\s*)(?!["'])[^\r\n]*/gi;

function maskSecrets(text) {
    if (text == null) return text;
    return String(text).replace(HEADER_LINE, '$1***').replace(AUTH_SCHEME, '$1 ***').replace(KEY_VALUE, '$1***');
}

module.exports = { maskSecrets };
