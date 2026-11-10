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
    },

    /**
     * A short notice at the bottom centre, one at a time (a new one replaces the current one).
     *   UI.toast('Saved')                                   an info notice, gone after 5 s
     *   UI.toast('Channel hidden', { action: { label: 'Undo', run } })   10 s; running the action closes it
     *   UI.toast('Could not save: ...', { kind: 'error' })  stays until closed
     * The text is set as text, never as markup. Returns { close() }, or null where there is no page.
     */
    toast(message, options = {}) { return Toast.show(message, options); },

};

const Toast = (() => {
    const INFO_MS = 5000, ACTION_MS = 10000;
    let parts = null, current = null, hovering = false, focusInside = false;

    const hasPage = () => typeof document !== 'undefined' && !!document.createElement && !!document.body;

    function build(kind) {
        const pill = document.createElement('div');
        pill.className = `ui-toast ui-toast-${kind}`;
        pill.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        const text = document.createElement('span');
        text.className = 'ui-toast-text';
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'ui-toast-action';
        action.hidden = true;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'ui-toast-close';
        close.setAttribute('aria-label', 'Close notice');
        close.textContent = '\u00d7';
        close.hidden = kind !== 'error';
        pill.appendChild(text);
        pill.appendChild(action);
        pill.appendChild(close);
        close.addEventListener('click', () => closeCurrent());
        pill.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCurrent(); });
        pill.addEventListener('mouseenter', () => { hovering = true; pause(); });
        pill.addEventListener('mouseleave', () => { hovering = false; resume(); });
        pill.addEventListener('focusin', () => { focusInside = true; pause(); });
        pill.addEventListener('focusout', (e) => {
            if (e.relatedTarget && pill.contains && pill.contains(e.relatedTarget)) return;
            focusInside = false; resume();
        });
        return { pill, text, action, close };
    }

    /** The two live regions (status and alert), in the page from load: only their text and visibility change. */
    function ensure() {
        if (parts) return parts;
        if (!hasPage()) return null;
        const host = document.createElement('div');
        host.className = 'ui-toast-host';
        parts = { host, info: build('info'), error: build('error') };
        host.appendChild(parts.info.pill);
        host.appendChild(parts.error.pill);
        document.body.appendChild(host);
        return parts;
    }

    /** A modal dialog makes everything outside it inert, so the notices move into the top dialog while one is open. */
    function place(parent) {
        const p = ensure();
        if (!p) return;
        const home = parent || document.body;
        if (p.host.parentNode !== home) home.appendChild(p.host);
    }

    function arm(ms) {
        clearTimeout(current.timer);
        current.remaining = ms;
        current.startedAt = Date.now();
        current.timer = setTimeout(() => closeCurrent(), ms);
    }
    function pause() {
        if (!current || current.kind !== 'info' || !current.timer) return;
        clearTimeout(current.timer);
        current.timer = null;
        current.remaining = Math.max(current.remaining - (Date.now() - current.startedAt), 1000);
    }
    function resume() {
        if (!current || current.kind !== 'info' || current.timer || hovering || focusInside) return;
        arm(current.remaining);
    }

    function closeCurrent() {
        if (!current) return;
        const { pill, text, action } = current.part;
        clearTimeout(current.timer);
        pill.classList.remove('is-open');
        text.textContent = '';
        action.hidden = true;
        action.onclick = null;
        current = null;
        hovering = false; focusInside = false;
    }

    function show(message, options) {
        const p = ensure();
        if (!p) return null;
        const kind = options.kind === 'error' ? 'error' : 'info';
        closeCurrent();
        const part = p[kind];
        const act = options.action && options.action.label ? options.action : null;
        part.text.textContent = String(message ?? '');
        if (act) {
            part.action.textContent = String(act.label);
            part.action.hidden = false;
            part.action.onclick = () => {
                closeCurrent();
                let result;
                try { result = act.run && act.run(); } catch (err) { result = Promise.reject(err); }
                if (result && typeof result.then === 'function') {
                    result.then(undefined, (err) => show(`Could not ${String(act.label).toLowerCase()}: ${err && err.message ? err.message : 'something went wrong'}`, { kind: 'error' }));
                }
            };
        } else {
            part.action.hidden = true;
            part.action.onclick = null;
        }
        current = { kind, part, timer: null, remaining: 0, startedAt: 0 };
        place(null);
        part.pill.classList.add('is-open');
        if (kind === 'info') arm(act ? ACTION_MS : INFO_MS);
        const mine = current;
        return { close: () => { if (current === mine) closeCurrent(); } };
    }

    if (hasPage()) ensure();
    else if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('DOMContentLoaded', ensure);

    return { show, place, ensure };
})();


if (typeof window !== 'undefined') window.UI = UI;
if (typeof module !== 'undefined' && module.exports) module.exports = UI;
