/**
 * #307: what a log line says about a provider: its name (and never any part of its address).
 * A source with no name, or an id that matches none, reads as "a provider".
 */
function providerLabel(providerId) {
    try {
        if (providerId === null || providerId === undefined) return 'a provider';
        const id = Number(providerId);
        const src = require('./db').sources.listParsed().find(s => Number(s.id) === id);
        return src && src.name ? `provider "${src.name}"` : 'a provider';
    } catch (e) {
        return 'a provider';
    }
}

module.exports = { providerLabel };
