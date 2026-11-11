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

    /**
     * #276: the one date format. "Sat 7 Nov, 3:50 am": weekday, day and month, the year only when it is not this year,
     * hours and minutes (12- or 24-hour from the locale, as UI.time), never seconds. '' for a missing or bad date.
     * `options` { locale, timeZone, now } are for tests; the page passes none (the browser's locale and zone).
     */
    dateTime(date, options) { return DateFormat.dateTime(date, options); },

    /** "Sat 7 Nov, 3:50 – 5:30 am" on one day (am/pm once when both share it); over midnight both days are named. */
    dateRange(start, end, options) { return DateFormat.dateRange(start, end, options); },

    /** Hours and minutes as dateTime writes them ("10:15 pm"). */
    clock(date, options) { return DateFormat.clock(date, options); },

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
     * `onEnd(why)` is called once when it goes: 'timeout', 'action' (before the action runs), 'replaced' (by the next
     * notice) or 'closed' (its close button, Escape, or close()).
     * The text is set as text, never as markup. Returns { close() }, or null where there is no page.
     */
    toast(message, options = {}) { return Toast.show(message, options); },

    /**
     * #276: the one way an area says it is loading, has nothing to show yet, or could not be loaded.
     *   UI.stateBlock('loading')                                         spinner and "Loading…"
     *   UI.stateBlock('empty', { title: 'No devices yet', detail: 'Pair one above.' })
     *   UI.stateBlock('error', 'The channel list could not be loaded.', { run: () => this.load() })   "Try again"
     *   UI.stateBlock('empty', 'Nothing yet', { label: 'Start', run, primary: true }, { className: 'my-empty' })   rose button, extra class
     * `text` is a string (the title) or { title, detail }; `action` is { label, run } or { label, href }, drawn as the
     * secondary button unless it says `primary: true`; `options.className` adds a modifier class to the block. All text is
     * escaped. Returns HTML, for pages that build markup; a `run` is bound by UI.setState, the usual way in.
     * A load error is a fixed plain sentence: the raw error goes to the console, never into the block.
     */
    stateBlock(kind, text, action, options) { return StateBlock.html(kind, text, action, options); },

    /**
     * Empty `container`, put the block in and bind its action's `run`. `{ colspan }` wraps the block in one table row,
     * for a <tbody>; `{ className }` as for stateBlock. Returns the action's button, or null.
     */
    setState(container, kind, text, action, options = {}) { return StateBlock.set(container, kind, text, action, options); },

    /** Native <dialog> modals: Escape, a backdrop click and the close button close; focus returns to the opener. */
    dialog: null,

    /**
     * #276: a small menu under a "⋯" button. UI.menu.attach(button, () => items, { label, onClose }), items being
     * { label, run } or { label, href, download }, `danger: true` for the destructive one. The button gets
     * aria-haspopup="menu" and aria-expanded; the menu opens on click (Enter, Space) or the arrow keys, arrows move,
     * Escape, Tab and a click outside close it and focus returns to the button. One is open at a time; it sits on
     * the page (fixed), kept inside the window and following its button on scroll, so no card clips it.
     * UI.menu.isOpen(), UI.menu.close().
     */
    menu: null
};

const DateFormat = (() => {
    const formats = new Map();
    function format(o, opts) {
        const key = JSON.stringify([o.locale || null, o.timeZone || null, opts]);
        let f = formats.get(key);
        if (!f) {
            f = new Intl.DateTimeFormat(o.locale || undefined, o.timeZone ? { ...opts, timeZone: o.timeZone } : opts);
            formats.set(key, f);
        }
        return f;
    }
    const valid = (date) => date !== null && date !== undefined && date !== '' && !Number.isNaN(new Date(date).getTime());
    const named = (f, d) => Object.fromEntries(f.formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));

    function day(d, o) {
        const p = named(format(o, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), d);
        const thisYear = named(format(o, { year: 'numeric' }), new Date(o.now ?? Date.now())).year;
        return `${p.weekday} ${p.day} ${p.month}${p.year !== thisYear ? ` ${p.year}` : ''}`;
    }
    /** The clock's parts; spaces inside it are non-breaking, so "3:50 am" never splits. */
    function clockParts(d, o) {
        // "3:50 am" on a 12-hour clock, "03:50" on a 24-hour one.
        let f = format(o, { hour: 'numeric', minute: '2-digit' });
        if (!f.resolvedOptions().hour12) f = format(o, { hour: '2-digit', minute: '2-digit' });
        return f.formatToParts(d)
            .map(p => ({ type: p.type, value: p.value.replace(/\s/g, '\u00a0') }));
    }
    const join = (parts) => parts.map(p => p.value).join('').trim();
    function withoutPeriod(parts) {
        const out = parts.filter(p => p.type !== 'dayPeriod');
        return join(out).replace(/^\u00a0+|\u00a0+$/g, '');
    }
    const period = (parts) => (parts.find(p => p.type === 'dayPeriod') || {}).value;

    function clock(date, o = {}) { return valid(date) ? join(clockParts(new Date(date), o)) : ''; }
    function dateTime(date, o = {}) {
        if (!valid(date)) return '';
        const d = new Date(date);
        return `${day(d, o)}, ${clock(d, o)}`;
    }
    function dateRange(start, end, o = {}) {
        if (!valid(start)) return '';
        if (!valid(end)) return dateTime(start, o);
        const a = new Date(start), b = new Date(end);
        if (day(a, o) !== day(b, o)) return `${dateTime(a, o)} \u2013 ${dateTime(b, o)}`;
        const pa = clockParts(a, o), pb = clockParts(b, o);
        const from = period(pa) && period(pa) === period(pb) ? withoutPeriod(pa) : join(pa);
        return `${day(a, o)}, ${from} \u2013 ${join(pb)}`;
    }
    return { dateTime, dateRange, clock };
})();

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
        return label ? { label: String(label), run: action.run, href: action.href, primary: action.primary === true } : null;
    }

    function html(kind, text, action, { className } = {}) {
        const e = UI.escape;
        const { title, detail } = parts(kind, text);
        const act = actionOf(kind, action);
        const role = KINDS[kind] ? ` role="${KINDS[kind]}"` : '';
        const btn = act && act.primary ? 'btn-primary' : 'btn-secondary';
        const button = !act ? ''
            : act.href ? `<a class="btn ${btn} state-block-action" href="${e(act.href)}">${e(act.label)}</a>`
                : `<button type="button" class="btn ${btn} state-block-action" data-state-action>${e(act.label)}</button>`;
        const extra = className ? ` ${e(className)}` : '';
        return `<div class="state-block state-${kind}${extra}"${role}>`
            + (kind === 'loading' ? '<span class="state-block-spinner" aria-hidden="true"></span>' : '')
            + `<p class="state-block-title">${e(title)}</p>`
            + (detail ? `<p class="state-block-detail">${e(detail)}</p>` : '')
            + button + '</div>';
    }

    function set(container, kind, text, action, { colspan, className } = {}) {
        if (!container) return null;
        const block = html(kind, text, action, { className });
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
        current.timer = setTimeout(() => closeCurrent('timeout'), ms);
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

    function closeCurrent(why = 'closed') {
        if (!current) return;
        const { pill, text, action } = current.part;
        const onEnd = current.onEnd;
        clearTimeout(current.timer);
        pill.classList.remove('is-open');
        text.textContent = '';
        action.hidden = true;
        action.onclick = null;
        current = null;
        hovering = false; focusInside = false;
        if (typeof onEnd === 'function') {
            try { onEnd(why); } catch (err) { console.error('Notice onEnd failed:', err); }
        }
    }

    function show(message, options) {
        const p = ensure();
        if (!p) return null;
        const kind = options.kind === 'error' ? 'error' : 'info';
        closeCurrent('replaced');
        const part = p[kind];
        const act = options.action && options.action.label ? options.action : null;
        part.text.textContent = String(message ?? '');
        if (act) {
            part.action.textContent = String(act.label);
            part.action.hidden = false;
            part.action.onclick = () => {
                closeCurrent('action');
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
        current = { kind, part, timer: null, remaining: 0, startedAt: 0, onEnd: options.onEnd };
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

const Menu = (() => {
    let current = null, seq = 0;
    const win = () => (typeof window !== 'undefined' ? window : null);

    function focusItem(i) {
        const rows = current.rows;
        if (!rows.length) return;
        const at = (i + rows.length) % rows.length;
        current.index = at;
        rows[at].focus();
    }

    function place() {
        const { button, menu } = current;
        if (!menu.style || !button.getBoundingClientRect) return;
        const w = win() || {};
        const vw = (typeof document !== 'undefined' && document.documentElement && document.documentElement.clientWidth) || w.innerWidth || 1024;
        const vh = w.innerHeight || 768;
        const b = button.getBoundingClientRect();
        const m = menu.getBoundingClientRect ? menu.getBoundingClientRect() : { width: 0, height: 0 };
        const width = m.width || (m.right - m.left) || 0, height = m.height || (m.bottom - m.top) || 0;
        const gap = 4, edge = 8;
        const left = Math.max(edge, Math.min(b.right - width, vw - width - edge));
        let top = b.bottom + gap;
        if (top + height > vh - edge && b.top - height - gap >= edge) top = b.top - height - gap;
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(Math.max(edge, top))}px`;
    }

    function onKey(e) {
        if (!current) return;
        const k = e.key;
        if (k === 'ArrowDown') { e.preventDefault(); focusItem(current.index + 1); }
        else if (k === 'ArrowUp') { e.preventDefault(); focusItem(current.index - 1); }
        else if (k === 'Home') { e.preventDefault(); focusItem(0); }
        else if (k === 'End') { e.preventDefault(); focusItem(current.rows.length - 1); }
        else if (k === 'Escape') { e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); close(); }
        else if (k === 'Tab') close();
    }
    function onOutside(e) {
        if (!current) return;
        const t = e.target;
        if (current.menu.contains(t) || current.button.contains(t)) return;
        close();
    }
    /** A scroll or resize: the menu follows its button, and closes once the button has left the window. */
    function onMove(e) {
        if (!current || (e && e.target && current.menu.contains && current.menu.contains(e.target))) return;
        const b = current.button.getBoundingClientRect ? current.button.getBoundingClientRect() : null;
        const w = win() || {};
        if (b && (b.bottom < 0 || b.top > (w.innerHeight || Infinity))) { close(false); return; }
        place();
    }

    function close(returnFocus = true) {
        if (!current) return;
        const { button, menu, onClose } = current;
        current = null;
        menu.remove();
        button.setAttribute('aria-expanded', 'false');
        button.removeAttribute('aria-controls');
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('scroll', onMove, true);
        const w = win();
        if (w && w.removeEventListener) w.removeEventListener('resize', onMove);
        if (returnFocus && button.focus && button.isConnected !== false) button.focus({ preventScroll: true });
        if (typeof onClose === 'function') onClose();
    }

    function open(button, items, options = {}) {
        close(false);
        const menu = document.createElement('div');
        menu.className = 'ui-menu';
        menu.id = `ui-menu-${++seq}`;
        menu.setAttribute('role', 'menu');
        if (options.label) menu.setAttribute('aria-label', options.label);
        const rows = (items || []).filter(Boolean).map((item) => {
            const row = document.createElement(item.href ? 'a' : 'button');
            if (item.href) {
                row.href = item.href;
                if (item.download) row.setAttribute('download', '');
            } else {
                row.type = 'button';
            }
            row.className = `ui-menu-item${item.danger ? ' is-danger' : ''}`;
            row.setAttribute('role', 'menuitem');
            row.setAttribute('tabindex', '-1');
            row.textContent = String(item.label);
            row.addEventListener('click', () => {
                // A link follows itself (the browser still follows an <a> taken out of the page); a button runs.
                close();
                if (item.run) item.run();
            });
            menu.appendChild(row);
            return row;
        });
        menu.addEventListener('keydown', onKey);
        document.body.appendChild(menu);
        button.setAttribute('aria-expanded', 'true');
        button.setAttribute('aria-controls', menu.id);
        current = { button, menu, rows, index: 0, onClose: options.onClose };
        place();
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('scroll', onMove, true);
        const w = win();
        if (w && w.addEventListener) w.addEventListener('resize', onMove);
        focusItem(options.last ? rows.length - 1 : 0);
    }

    function attach(button, items, options = {}) {
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => {
            if (current && current.button === button) { close(); return; }
            open(button, items(), options);
        });
        button.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            open(button, items(), { ...options, last: e.key === 'ArrowUp' });
        });
        return button;
    }

    return { attach, close: () => close(), isOpen: () => !!current };
})();

UI.menu = Menu;

if (typeof window !== 'undefined') window.UI = UI;
if (typeof module !== 'undefined' && module.exports) module.exports = UI;
