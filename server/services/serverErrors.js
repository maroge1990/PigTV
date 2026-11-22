/**
 * The Express error handler (server/index.js, last middleware).
 *
 * Review of 0898 (high): it logged the whole error. A JSON body that does not parse reaches it with the raw body on
 * `err.body` and quoted in `err.message`, so a sign-in's password went to stdout (and the log ring). Now one fixed line
 * with allow-listed fields only: the error's name, `type` (body-parser's kind, e.g. entity.parse.failed), status, a short
 * `code`, and the route pattern. Never the body, the message, headers, the URL or the query. The answer is unchanged.
 */
const { routePattern } = require('./slowRequestLog');

const short = (v, max) => String(v).replace(/[^\w.:@/-]/g, '?').slice(0, max);

function describe(err, req) {
    const parts = [`name=${short(err && err.name ? err.name : typeof err, 40)}`];
    if (err && typeof err.type === 'string') parts.push(`type=${short(err.type, 40)}`);
    const status = err && (err.status || err.statusCode);
    if (Number.isInteger(status)) parts.push(`status=${status}`);
    if (err && (typeof err.code === 'string' || Number.isInteger(err.code))) parts.push(`code=${short(err.code, 32)}`);
    parts.push(`route=${req ? `${short(req.method || '?', 8)} ${routePattern(req)}` : '?'}`);
    return parts.join(' ');
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    console.error(`Server error: ${describe(err, req)}`);
    res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler, describe };
