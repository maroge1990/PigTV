/**
 * #239 (0485): the one poller of the recordings in progress (GET /api/recordings/active). The recording banner and the
 * Sport page used to poll it on timers of their own (30 s; every 20-60 s), several at once. Here one request serves every
 * subscriber: every `interval` while someone is subscribed and the tab is visible, at once when the tab comes back or a
 * page asks (`refresh()`; a request already on its way is shared), and nothing while the tab is hidden.
 *
 * subscribe(fn) calls fn(rows, error) with the latest answer (rows: an array, [] after a failure) and after every
 * fetch; it returns the unsubscribe.
 */
class RecordingsFeed {
    constructor({ fetch = () => API.recordings.getActive(), interval = 30000, doc = document,
                  timers = { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) } } = {}) {
        this.fetch = fetch; this.interval = interval; this.doc = doc; this.timers = timers;
        this.subscribers = new Set(); this.timer = null; this.inFlight = null;
        this.latest = undefined; this.error = null;
        this.onVisibility = () => { if (this.doc.hidden) this.stop(); else this.ensure(); };
        this.doc.addEventListener?.('visibilitychange', this.onVisibility);
    }

    subscribe(fn) {
        this.subscribers.add(fn);
        if (this.latest !== undefined) fn(this.latest, this.error);
        this.ensure();
        return () => {
            this.subscribers.delete(fn);
            if (this.subscribers.size === 0) this.stop();
        };
    }

    /** Polling while someone listens and the tab is visible; the first poll at once. */
    ensure() {
        if (this.timer || this.doc.hidden || this.subscribers.size === 0) return;
        this.timer = this.timers.setInterval(() => this.refresh(), this.interval);
        this.refresh();
    }

    stop() {
        if (this.timer) this.timers.clearInterval(this.timer);
        this.timer = null;
    }

    refresh() {
        if (this.inFlight) return this.inFlight;
        this.inFlight = (async () => {
            try {
                const rows = await this.fetch();
                this.latest = Array.isArray(rows) ? rows : [];
                this.error = null;
            } catch (err) {
                this.latest = [];
                this.error = err;
            } finally {
                this.inFlight = null;
            }
            for (const fn of [...this.subscribers]) {
                try { fn(this.latest, this.error); } catch { /* one subscriber never stops the others */ }
            }
        })();
        return this.inFlight;
    }
}

if (typeof window !== 'undefined') window.RecordingsFeed = RecordingsFeed;
