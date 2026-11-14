// A minimal DOM for the vm tests of the notice (UI.toast) and the dialogs (UI.dialog and the pages that use it).
// It models: elements with children, attributes, classList, text, ids, simple selectors, events that bubble,
// focus and document.activeElement, and <dialog> with showModal / close / cancel / close events.
//
// What it does NOT prove: layout and painting (where the pill sits, whether the page behind is inert or scrolls),
// real focus trapping, the real Escape key reaching `cancel`, the backdrop's geometry (getBoundingClientRect is a
// fixed 10..110 box), live-region announcements, or fullscreen. Those need a browser (T3/T5).
class FakeEvent {
    constructor(type, init = {}) {
        Object.assign(this, { type, bubbles: true, cancelable: true, defaultPrevented: false, target: null }, init);
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}

function parseSimple(sel) {
    // tag, .class, [attr], [attr=value], :not([attr=value]) in any order, no combinators
    const out = { tag: null, id: null, classes: [], attrs: [], nots: [] };
    let rest = sel.trim();
    const tag = rest.match(/^[a-z][a-z0-9-]*/i);
    if (tag) { out.tag = tag[0].toLowerCase(); rest = rest.slice(tag[0].length); }
    while (rest) {
        let m;
        if ((m = rest.match(/^#([\w-]+)/))) out.id = m[1];
        else if ((m = rest.match(/^\.([\w-]+)/))) out.classes.push(m[1]);
        else if ((m = rest.match(/^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/))) out.attrs.push([m[1], m[2]]);
        else if ((m = rest.match(/^:not\(\[([\w-]+)=["']?([^\]"']*)["']?\]\)/))) out.nots.push([m[1], m[2]]);
        else throw new Error(`fakeDom: unsupported selector part ${rest}`);
        rest = rest.slice(m[0].length);
    }
    return out;
}

class FakeElement {
    constructor(tag, doc) {
        this.tagName = tag.toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.listeners = {};
        this._text = '';
        this.hidden = false;
        this.className = '';
        this.style = {};
        const el = this;
        this.classList = {
            add: (...c) => { const s = new Set(el.className.split(/\s+/).filter(Boolean)); c.forEach(x => s.add(x)); el.className = [...s].join(' '); },
            remove: (...c) => { const s = new Set(el.className.split(/\s+/).filter(Boolean)); c.forEach(x => s.delete(x)); el.className = [...s].join(' '); },
            contains: (c) => el.className.split(/\s+/).includes(c),
            toggle: (c, force) => { const has = el.classList.contains(c); const want = force === undefined ? !has : force; el.classList[want ? 'add' : 'remove'](c); return want; }
        };
        if (this.tagName === 'DIALOG') { this.open = false; }
    }
    get id() { return this.attributes.id || ''; }
    set id(v) { this.attributes.id = v; }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); }
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
    removeAttribute(k) { delete this.attributes[k]; }
    appendChild(child) {
        if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
        child.parentNode = this; this.children.push(child); return child;
    }
    append(...nodes) { nodes.forEach(n => this.appendChild(typeof n === 'string' ? Object.assign(new FakeElement('#text', this.ownerDocument), { _text: n }) : n)); }
    replaceChildren(...nodes) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = ''; nodes.forEach(n => this.appendChild(n)); }
    remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.body || n === this.ownerDocument.documentElement; }
    contains(other) { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(); this._text = String(v); }
    get innerHTML() { return this._html || ''; }
    // Not an HTML parser: it only makes the tags that carry an id appear as (flat) children, so lookups by id work.
    set innerHTML(v) {
        this.replaceChildren(); this._html = String(v);
        for (const m of this._html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
            const child = this.ownerDocument.createElement(m[1]);
            child.id = m[3];
            const cls = m[2].match(/\bclass="([^"]*)"/); if (cls) child.className = cls[1];
            for (const d of m[2].matchAll(/\b(data-[\w-]+)(?:="([^"]*)")?/g)) child.setAttribute(d[1], d[2] ?? '');
            this.appendChild(child);
        }
    }
    // Form controls keep their value as a string, as the browser does.
    get value() { return this._value ?? ''; }
    set value(v) { this._value = String(v); }
    matches(sel) {
        return sel.split(',').some((part) => {
            const bits = part.trim().split(/\s+/);
            const last = parseSimple(bits[bits.length - 1]);
            if (!this._matchesSimple(last)) return false;
            let anc = this.parentNode;
            for (let i = bits.length - 2; i >= 0; i--) {
                const want = parseSimple(bits[i]);
                while (anc && !(anc._matchesSimple && anc._matchesSimple(want))) anc = anc.parentNode;
                if (!anc) return false;
                anc = anc.parentNode;
            }
            return true;
        });
    }
    _matchesSimple(s) {
        if (s.tag && this.tagName.toLowerCase() !== s.tag) return false;
        if (s.id && this.id !== s.id) return false;
        if (!s.classes.every(c => this.classList.contains(c))) return false;
        const has = ([k, v]) => k in this.attributes && (v === undefined || this.attributes[k] === v);
        if (!s.attrs.every(has)) return false;
        return !s.nots.some(has);
    }
    closest(sel) { for (let n = this; n && n.matches; n = n.parentNode) if (n.matches(sel)) return n; return null; }
    querySelectorAll(sel) {
        const out = [];
        const walk = (n) => { n.children.forEach(c => { if (c.matches && c.matches(sel)) out.push(c); walk(c); }); };
        walk(this); return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
    dispatchEvent(ev) {
        if (!ev.target) ev.target = this;
        for (let n = this; n; n = n.parentNode) {
            ev.currentTarget = n;
            (n.listeners?.[ev.type] || []).slice().forEach(fn => fn.call(n, ev));
            if (ev.type === 'click' && typeof n.onclick === 'function' && n === ev.target) n.onclick(ev);
            if (!ev.bubbles) break;
        }
        if (!ev.target.parentNode && ev.target.ownerDocument.listeners?.[ev.type] && ev.target !== ev.target.ownerDocument) {
            // detached targets do not reach the document
        } else if (ev.bubbles && this.isConnected) {
            (this.ownerDocument.listeners[ev.type] || []).slice().forEach(fn => fn.call(this.ownerDocument, ev));
        }
        return !ev.defaultPrevented;
    }
    focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new FakeEvent('focusin', { bubbles: true })); }
    click() { this.dispatchEvent(new FakeEvent('click', { clientX: 50, clientY: 50, detail: 1 })); }
    getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 110 }; }
    // <dialog>
    showModal() { if (this.open) throw new Error('InvalidStateError: already open'); this.open = true; this.ownerDocument.modals.push(this); }
    close() {
        if (!this.open) return;
        this.open = false;
        this.ownerDocument.modals.splice(this.ownerDocument.modals.indexOf(this), 1);
        this.dispatchEvent(new FakeEvent('close', { bubbles: false, cancelable: false }));
    }
    /** What the browser does for Escape on a modal: fire `cancel`, and close unless it was prevented. */
    escape() {
        const ev = new FakeEvent('cancel', { bubbles: false });
        this.dispatchEvent(ev);
        if (!ev.defaultPrevented) this.close();
    }
    /** A click on the backdrop: the target is the dialog itself, outside its box. */
    backdropClick() {
        this.dispatchEvent(new FakeEvent('mousedown', { clientX: 0, clientY: 0 }));
        this.dispatchEvent(new FakeEvent('click', { clientX: 0, clientY: 0, detail: 1 }));
    }
}

function createDocument() {
    const doc = { listeners: {}, modals: [], activeElement: null, visibilityState: 'visible', hidden: false, readyState: 'complete' };
    doc.createElement = (tag) => new FakeElement(tag, doc);
    doc.documentElement = new FakeElement('html', doc);
    doc.body = new FakeElement('body', doc);
    doc.documentElement.appendChild(doc.body);
    doc.activeElement = doc.body;
    doc.addEventListener = (t, fn) => { (doc.listeners[t] ||= []).push(fn); };
    doc.removeEventListener = (t, fn) => { doc.listeners[t] = (doc.listeners[t] || []).filter(f => f !== fn); };
    doc.dispatchEvent = (ev) => { ev.target ||= doc; (doc.listeners[ev.type] || []).slice().forEach(fn => fn.call(doc, ev)); return !ev.defaultPrevented; };
    doc.getElementById = (id) => {
        const walk = (n) => { for (const c of n.children) { if (c.attributes.id === id) return c; const f = walk(c); if (f) return f; } return null; };
        return walk(doc.body);
    };
    doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
    doc.querySelector = (sel) => doc.body.querySelector(sel);
    return doc;
}

module.exports = { FakeEvent, FakeElement, createDocument };
