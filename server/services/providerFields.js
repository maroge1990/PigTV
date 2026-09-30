/**
 * The provider fields of a source (0168, multi-provider brief 2.1) and their
 * validation. A provider is one source; these are all optional:
 *
 *   role            'primary' | 'backup'   (an existing non-EPG source with none reads as 'primary')
 *   priority        integer >= 1           failover order among backups
 *   maxConnections  integer | null         manual override of the connection limit
 *   subscription    { purchasedAt, termMonths, endsAt }   dates as 'YYYY-MM-DD'
 *   idOverlayUrl    http(s) URL | null     a backup's EPGenius M3U (a capability URL: admin only)
 *
 * validate() returns { fields } (only what the request set, ready to store) or
 * { error } (a plain sentence for a 400). Nothing here reads the network.
 */

const ROLES = ['primary', 'backup'];
const KEYS = ['role', 'priority', 'maxConnections', 'subscription', 'idOverlayUrl'];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The source as stored, with the read-time defaults applied (a non-EPG source with no role is a primary). */
function withDefaults(source) {
    if (!source || source.type === 'epg' || source.role) return source;
    return { ...source, role: 'primary' };
}

/** A real calendar date 'YYYY-MM-DD' -> [y, m, d], else null. */
function parseDate(value) {
    const m = typeof value === 'string' ? DATE.exec(value) : null;
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}

const isInt = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function validateSubscription(input, current) {
    if (input === null) return { value: { purchasedAt: null, termMonths: null, endsAt: null } };
    if (typeof input !== 'object' || Array.isArray(input)) return { error: 'subscription must be an object with purchasedAt, termMonths and endsAt' };
    const out = { purchasedAt: null, termMonths: null, endsAt: null, ...(current || {}) };
    for (const key of ['purchasedAt', 'endsAt']) {
        if (!(key in input)) continue;
        const v = input[key] === '' ? null : input[key];
        if (v !== null && !parseDate(v)) return { error: `${key} must be a real date written YYYY-MM-DD, or empty` };
        out[key] = v;
    }
    if ('termMonths' in input) {
        const v = input.termMonths === '' ? null : input.termMonths;
        if (v !== null && !isInt(v, 1, 120)) return { error: 'termMonths must be a whole number of months from 1 to 120, or empty' };
        out.termMonths = v;
    }
    return { value: { purchasedAt: out.purchasedAt, termMonths: out.termMonths, endsAt: out.endsAt } };
}

/**
 * @param body      the request body
 * @param existing  the stored source (with defaults) on an update, else null
 * @param type      the source's type
 * @param others    the other stored sources (with defaults), for the one-primary rule
 * @param hasStreams (sourceId) => boolean, whether that source has live channels
 * @param enabled   whether the source is (or will be) enabled
 */
function validate(body, { existing = null, type, others = [], hasStreams = () => false, enabled = true } = {}) {
    const given = KEYS.filter(k => body && body[k] !== undefined);
    if (given.length === 0) return { fields: {} };
    if (type === 'epg') return { error: 'An EPG source has no provider settings (role, priority, connections, subscription)' };

    const fields = {};
    if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return { error: "role must be 'primary' or 'backup'" };
        fields.role = body.role;
    }
    if (body.priority !== undefined) {
        if (body.priority !== null && !isInt(body.priority, 1, 99)) return { error: 'priority must be a whole number from 1 to 99, or empty' };
        fields.priority = body.priority;
    }
    if (body.maxConnections !== undefined) {
        const v = body.maxConnections === '' ? null : body.maxConnections;
        if (v !== null && !isInt(v, 1, 50)) return { error: 'maxConnections must be a whole number from 1 to 50, or empty to read it from the provider' };
        fields.maxConnections = v;
    }
    if (body.subscription !== undefined) {
        const r = validateSubscription(body.subscription, existing?.subscription);
        if (r.error) return { error: r.error };
        fields.subscription = r.value;
    }
    if (body.idOverlayUrl !== undefined) {
        const v = body.idOverlayUrl === '' ? null : body.idOverlayUrl;
        if (v !== null) {
            let u = null;
            try { u = typeof v === 'string' && v.length <= 2000 ? new URL(v) : null; } catch { u = null; }
            if (!u || !/^https?:$/.test(u.protocol)) return { error: 'idOverlayUrl must be an http or https address (up to 2000 characters), or empty' };
        }
        fields.idOverlayUrl = v;
    }

    const role = fields.role || existing?.role || 'primary';
    if (fields.idOverlayUrl && role !== 'backup') return { error: 'An ID overlay address only applies to a backup provider' };

    // One enabled primary with streams. Only an explicit request for 'primary' is checked, so a
    // second plain source added the way it always was is not refused.
    if (fields.role === 'primary' && enabled) {
        const rival = others.find(o => o.type !== 'epg' && o.enabled && o.role === 'primary' && hasStreams(o.id));
        if (rival) return { error: `There is already a primary provider (${rival.name}). Make it a backup first, or disable it.` };
    }
    return { fields };
}

/** The provider fields an admin sees (never the overlay address itself, only whether one is set). */
function adminView(source) {
    const s = withDefaults(source);
    if (!s || s.type === 'epg') return {};
    return {
        role: s.role,
        priority: s.priority ?? null,
        maxConnections: s.maxConnections ?? null,
        subscription: s.subscription || { purchasedAt: null, termMonths: null, endsAt: null },
        hasIdOverlay: Boolean(s.idOverlayUrl)
    };
}

module.exports = { ROLES, validate, withDefaults, adminView, parseDate };
