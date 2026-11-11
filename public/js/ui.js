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

    /**
     * #276: the one way an area says it is loading, has nothing to show yet, or could not be loaded.
     *   UI.stateBlock('loading')                                         spinner and "Loading…"
     *   UI.stateBlock('empty', { title: 'No devices yet', detail: 'Pair one above.' })
     *   UI.stateBlock('error', 'The channel list could not be loaded.', { run: () => this.load() })   "Try again"
     * `text` is a string (the title) or { title, detail }; `action` is { label, run } or { label, href }. All text is
     * escaped. Returns HTML, for pages that build markup; a `run` is bound by UI.setState, the usual way in.
     * A load error is a fixed plain sentence: the raw error goes to the console, never into the block.
     */
    stateBlock(kind, text, action) { return StateBlock.html(kind, text, action); },

    /**
     * Empty `container`, put the block in and bind its action's `run`. `{ colspan }` wraps the block in one table row,
     * for a <tbody>. Returns the action's button, or null.
     */
    setState(container, kind, text, action, options = {}) { return StateBlock.set(container, kind, text, action, options); },

    /** Native <dialog> modals: Escape, a backdrop click and the close button close; focus returns to the opener. */
    dialog: null
};

const StateBlock = (() => {
    const KINDS = { loading: 'status', empty: null, error: 'alert' };
    const DEFAULT_TITLE = { loading: 'Loading…', empty: 'Nothing here yet.', error: 'This could not be loaded.' };

    function parts(kind, text) {
        if (!(kind in KINDS)) throw new TypeError(`UI.stateBlock: unknown kind ${kind}`);
        const t = text && typeof text === 'object' ? text : { title: text };
        return { title: t.title == null || t.title === '' ? DEFAULT_TITLE[kind] : String(t.title), detail: t.detail == null ? '' : String(t.detail) };
    }

    function actionOf(kind, action) {
        if (!action || (!action.run && !action.href)) return null;
        const label = action.label || (kind === 'error' ? 'Try again' : '');
        return label ? { label: String(label), run: action.run, href: action.href } : null;
    }

    function html(kind, text, action) {
        const e = UI.escape;
        const { title, detail } = parts(kind, text);
        const act = actionOf(kind, action);
        const role = KINDS[kind] ? ` role="${KINDS[kind]}"` : '';
        const button = !act ? ''
            : act.href ? `<a class="btn btn-secondary state-block-action" href="${e(act.href)}">${e(act.label)}</a>`
                : `<button type="button" class="btn btn-secondary state-block-action" data-state-action>${e(act.label)}</button>`;
        return `<div class="state-block state-${kind}"${role}>`
            + (kind === 'loading' ? '<span class="state-block-spinner" aria-hidden="true"></span>' : '')
            + `<p class="state-block-title">${e(title)}</p>`
            + (detail ? `<p class="state-block-detail">${e(detail)}</p>` : '')
            + button + '</div>';
    }

    function set(container, kind, text, action, { colspan } = {}) {
        if (!container) return null;
        const block = html(kind, text, action);
        container.innerHTML = colspan ? `<tr class="state-row"><td colspan="${Number(colspan) || 1}">${block}</td></tr>` : block;
        const act = actionOf(kind, action);
        if (!act || !act.run) return null;
        const button = container.querySelector ? container.querySelector('[data-state-action]') : null;
        if (!button) return null;
        button.addEventListener('click', () => { button.disabled = true; act.run(); });
        return button;
    }

    return { html, set };
})();

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
        place(Dialogs.top());
        part.pill.classList.add('is-open');
        if (kind === 'info') arm(act ? ACTION_MS : INFO_MS);
        const mine = current;
        return { close: () => { if (current === mine) closeCurrent(); } };
    }

    if (hasPage()) ensure();
    else if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('DOMContentLoaded', ensure);

    return { show, place, ensure };
})();

const Dialogs = (() => {
    const open = [];
    let seq = 0;

    const top = () => open.length ? open[open.length - 1] : null;

    function lock(on) {
        if (typeof document === 'undefined' || !document.body || !document.body.classList) return;
        document.body.classList.toggle('ui-dialog-open', on);
    }

    /** Make an existing <dialog> behave: Escape (the native cancel) and the backdrop and any close button close it. */
    function attach(el, options = {}) {
        if (el._uiDialog) { Object.assign(el._uiDialog.options, options); return el._uiDialog; }
        const ctl = { el, options: { ...options }, opener: null, isOpen: () => !!el.open,
            open(opener) {
                if (el.open) return ctl;
                if (options.parent !== false && !el.isConnected && typeof document !== 'undefined') document.body.appendChild(el);
                ctl.opener = opener !== undefined ? opener : (ctl.opener || (typeof document !== 'undefined' ? document.activeElement : null));
                el.showModal();
                open.push(el);
                lock(true);
                Toast.place(el);
                const first = el.querySelector('[autofocus]')
                    || el.querySelector('input:not([type=hidden]), select, textarea, .ui-dialog-body button, .ui-dialog-footer button')
                    || el.querySelector('.ui-dialog-close') || el;
                if (first.focus) first.focus();
                return ctl;
            },
            close() { if (el.open) el.close(); }
        };
        let downOn = null;
        el.addEventListener('mousedown', (e) => { downOn = e.target; });
        el.addEventListener('click', (e) => {
            const hit = e.target;
            if (hit && hit.closest && hit.closest('.ui-dialog-close, [data-dialog-close]')) { ctl.close(); return; }
            if (hit !== el || downOn !== el) return;
            downOn = null;
            const r = el.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) ctl.close();
        });
        el.addEventListener('close', () => {
            const i = open.lastIndexOf(el);
            if (i >= 0) open.splice(i, 1);
            if (!open.length) lock(false);
            Toast.place(top());
            const opener = ctl.opener;
            ctl.opener = null;
            if (opener && opener.focus && opener.isConnected !== false) opener.focus();
            if (ctl.options.onClose) ctl.options.onClose(ctl);
            if (ctl.options.removeOnClose) el.remove();
        });
        el._uiDialog = ctl;
        return ctl;
    }

    /** A new dialog with a title, a close button, a body and a footer. Its element goes when it closes. */
    function create({ title = '', label = '', className = '', onClose } = {}) {
        const el = document.createElement('dialog');
        el.className = `ui-dialog ${className}`.trim();
        const header = document.createElement('div');
        header.className = 'ui-dialog-header';
        const titleEl = document.createElement('h2');
        titleEl.className = 'ui-dialog-title';
        titleEl.id = `ui-dialog-title-${++seq}`;
        titleEl.textContent = title;
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'ui-dialog-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '\u00d7';
        header.appendChild(titleEl);
        header.appendChild(closeBtn);
        const body = document.createElement('div');
        body.className = 'ui-dialog-body';
        const footer = document.createElement('div');
        footer.className = 'ui-dialog-footer';
        el.appendChild(header);
        el.appendChild(body);
        el.appendChild(footer);
        if (label) el.setAttribute('aria-label', label);
        else el.setAttribute('aria-labelledby', titleEl.id);
        const ctl = attach(el, { onClose, removeOnClose: true });
        Object.assign(ctl, { titleEl, body, footer, setTitle: (t) => { titleEl.textContent = t; } });
        return ctl;
    }

    return { attach, create, top };
})();

UI.dialog = { attach: Dialogs.attach, create: Dialogs.create };

if (typeof window !== 'undefined') window.UI = UI;
if (typeof module !== 'undefined' && module.exports) module.exports = UI;
