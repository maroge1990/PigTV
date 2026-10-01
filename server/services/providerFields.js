/**
 * The provider fields of a source (0168, multi-provider brief 2.1; 0182) and their
 * validation. A provider is one source; these are all optional:
 *
 *   role          'primary' | 'backup'   (an existing non-EPG source with none reads as 'primary')
 *   priority      integer >= 1           failover order among backups
 *   epgUrl        http(s) URL | null     this provider's guide (XMLTV); synced while it is the primary
 *   idOverlayUrl  http(s) URL | null     its EPGenius M3U; read while it is a backup
 *
 * 0182: every provider card is the same, so a guide or overlay address is kept whatever the
 * role. The connection limit and the subscription end are read from the provider's account
 * alone; the manual `maxConnections` and `subscription` are gone (a request that still
 * sends them is not refused, they are ignored).
 *
 * validate() returns { fields } (only what the request set, ready to store) or
 * { error } (a plain sentence for a 400). Nothing here reads the network.
 */

const ROLES = ['primary', 'backup'];
const KEYS = ['role', 'priority', 'epgUrl', 'idOverlayUrl'];

/** The source as stored, with the read-time defaults applied (a non-EPG source with no role is a primary). */
function withDefaults(source) {
    if (!source || source.type === 'epg' || source.role) return source;
    return { ...source, role: 'primary' };
}

const isInt = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** '' or null -> null; an http(s) address -> itself; anything else -> undefined. */
function address(value) {
    const v = value === '' ? null : value;
    if (v === null) return null;
    let u = null;
    try { u = typeof v === 'string' && v.length <= 2000 ? new URL(v) : null; } catch { u = null; }
    return u && /^https?:$/.test(u.protocol) ? v : undefined;
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
    if (type === 'epg') return { error: 'An EPG source has no provider settings (role, priority, guide, overlay)' };

    const fields = {};
    if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return { error: "role must be 'primary' or 'backup'" };
        fields.role = body.role;
    }
    if (body.priority !== undefined) {
        if (body.priority !== null && !isInt(body.priority, 1, 99)) return { error: 'priority must be a whole number from 1 to 99, or empty' };
        fields.priority = body.priority;
    }
    for (const key of ['epgUrl', 'idOverlayUrl']) {
        if (body[key] === undefined) continue;
        const v = address(body[key]);
        if (v === undefined) return { error: `${key} must be an http or https address (up to 2000 characters), or empty` };
        fields[key] = v;
    }

    // One enabled primary with streams. Only an explicit request for 'primary' is checked, so a
    // second plain source added the way it always was is not refused.
    if (fields.role === 'primary' && enabled) {
        const rival = others.find(o => o.type !== 'epg' && o.enabled && o.role === 'primary' && hasStreams(o.id));
        if (rival) return { error: `There is already a primary provider (${rival.name}). Make it a backup first, or disable it.` };
    }
    return { fields };
}

/** The provider fields an admin sees in a list (never an address, only whether one is set). */
function adminView(source) {
    const s = withDefaults(source);
    if (!s || s.type === 'epg') return {};
    return {
        role: s.role,
        priority: s.priority ?? null,
        hasEpg: Boolean(s.epgUrl),
        hasIdOverlay: Boolean(s.idOverlayUrl)
    };
}

module.exports = { ROLES, validate, withDefaults, adminView };
