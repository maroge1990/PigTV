/**
 * Shared UI helpers: the one HTML escape, the one clock-time format and the one trailing debounce.
 * A plain global (window.UI), loaded right after api.js; also exported for tests that run in Node.
 */
const UI = {
    /** Safe in text and in a quoted attribute. null and undefined give ''; 0 and false print as "0" and "false". */
    escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    },

    /** A clock time in the viewer's locale, hours and minutes ("07:30 pm"). */
    time(date) {
        return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    /** A function that runs `fn` once, `ms` after the last call, with that last call's arguments. */
    debounce(fn, ms) {
        let timeout;
        return function debounced(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => { timeout = undefined; fn(...args); }, ms);
        };
    }
};

if (typeof window !== 'undefined') window.UI = UI;
if (typeof module !== 'undefined' && module.exports) module.exports = UI;
