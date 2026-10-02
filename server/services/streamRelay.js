/**
 * In-stream recovery and the hot standby (0189; docs/STANDBY-BRIEF.md). Experimental, off
 * unless PIGTV_RELAY=1 (and PIGTV_STANDBY=1 for the standby).
 *
 * A relay keeps one HLS stream going across more than one ffmpeg. It is created for a channel
 * play that produced an HLS session, under that session's id - the id the client holds - and
 * has LEGS: one TranscodeSession each (its own ffmpeg, folder and provider connection), every
 * one an ordinary session in the registry, so the connection pools count it.
 *
 *   - Until the first switch the playlist is ffmpeg's own file, served as it always was; the
 *     relay only reads it, to keep its own list of segments.
 *   - When the playing leg is lost (ffmpeg exited, the stall watchdog), the relay frees its
 *     connection, plans the channel's providers again and starts the next one (cold switch) -
 *     or, with a standby ready, joins the standby on at once.
 *   - From then on the relay renders the playlist: leg 0's segments under their own names,
 *     later legs' as L<n>-seg0001.m4s, an EXT-X-DISCONTINUITY at each join.
 *   - If nothing can take over the relay ends, the playlist answers 404 and the client
 *     re-resolves: exactly what happens today without a relay.
 *
 * A standby is a second copy of the channel on another provider with a FREE connection,
 * owned by `standby:<relay id>`. The coordinator treats it as abandoned from the start, so a
 * viewer or a recording takes its connection without a prompt; the relay notices and goes on
 * without one.
 */
const fs = require('fs').promises;
const path = require('path');
const { redact } = require('../redact');
const { parseMediaPlaylist, renderMediaPlaylist } = require('./hlsPlaylist');

const on = (name) => /^(1|true|yes)$/i.test(process.env[name] || '');
const enabled = () => on('PIGTV_RELAY');
const standbyEnabled = () => enabled() && on('PIGTV_STANDBY');

const msFromEnv = (name, fallback, min) => {
    const n = Number.parseInt(process.env[name], 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
};

const TICK_MS = 1000;
// With a standby ready: how long the playing leg may write nothing before the standby takes
// over. Segments are written at keyframes, so a 10 s GOP is quiet for 10 s when healthy.
const switchAfterMs = () => msFromEnv('PIGTV_RELAY_SWITCH_MS', 10000, 3000);
const STANDBY_DELAY_MS = 20000;    // into a play, before a standby is started
const STANDBY_RETRY_MS = 60000;    // between attempts while there is none
const STANDBY_TAIL = 2;            // segments of the standby joined on at a switch
const START_DEADLINE_MS = 20000;   // a leg's probe and first segment
const SEGMENT_NAME = /^(seg\d{4,}\.(ts|m4s)|init\.mp4)$/;

const relays = new Map();          // relay id -> Relay
const aliases = new Map();         // relay id -> { legId, at }: the last playing leg, kept after the relay ends
const ALIAS_TTL_MS = 15 * 60 * 1000;

// Required lazily: these modules require each other in places, and none is needed at load.
const sessionsModule = () => require('./transcodeSession');
const coordinator = () => require('./streamCoordinator');
const routing = () => require('./providerRouting');
const strategy = () => require('./playbackStrategy');
const interruptions = () => require('./playbackInterruptions');
const activeRecordings = () => { try { return require('./recordingEngine').listActive(); } catch (e) { return []; } };

class Relay {
    /**
     * @param {object} front  the session the resolve started (leg 0)
     * @param {object} ctx    { sourceId, channelId, capabilities, settings, ffprobePath, upscale,
     *                          audioEncode, owner, channelName, primaryKey, candidate }
     */
    constructor(front, ctx) {
        this.kind = 'relay';
        this.id = front.id;
        this.ctx = ctx;
        this.segmentType = front.options.segmentType;
        this.videoRange = front.options.videoRange || null;
        this.master = this.videoRange ? sessionsModule().buildMasterPlaylist(front.options) : null;
        this.legs = [];
        this.entries = [];             // { leg, name, duration, abs, discontinuity }
        this.nextAbs = null;           // absolute media sequence number of the next entry
        this.discontinuitySequence = 0;
        this.version = null;
        this.targetDuration = 1;
        this.switched = false;         // true once the relay renders the playlist itself
        this.switching = false;
        this.closed = false;
        this.standby = null;
        this.startingStandby = false;
        this.unusable = new Set();     // providers whose feed cannot join this stream
        const now = Date.now();
        this.lastProgressAt = now;
        this.standbyAt = now + STANDBY_DELAY_MS;
        this.active = this.addLeg(front, ctx.candidate);
        this.timer = setInterval(() => {
            this.tick().catch(err => console.warn(`[Relay ${this.id}] tick failed: ${redact(err && err.message)}`));
        }, TICK_MS);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        this.log(`following "${ctx.channelName || 'channel'}" on ${this.providerOf(this.active)}${standbyEnabled() ? ' (standby on)' : ''}`);
    }

    log(text) { console.log(`[Relay ${this.id}] ${text}`); }
    providerOf(leg) { return (leg && leg.candidate && leg.candidate.providerName) || 'the provider'; }
    get status() { return this.active.session.status; }

    addLeg(session, candidate) {
        const leg = { n: this.legs.length, session, candidate: candidate || {}, dir: session.dir, lastSeq: -1,
            lost: null, joined: false, removed: false, startedAt: Date.now(), tail: [], lastSegAt: 0 };
        // Its segments stay listed after its ffmpeg has gone: the relay removes the folder.
        session.retainDir = true;
        session.once('lost', (info) => { leg.lost = info || { how: 'exit', providerReason: false }; });
        this.legs.push(leg);
        return leg;
    }

    touch() { this.active.session.touch(); }

    async readPlaylist(leg) {
        try {
            return parseMediaPlaylist(await fs.readFile(leg.session.playlistPath, 'utf8'));
        } catch (err) {
            return null;
        }
    }

    /** Take the playing leg's new segments into the relay's list. Returns how many were new. */
    async ingest() {
        const leg = this.active;
        const parsed = await this.readPlaylist(leg);
        if (!parsed || !parsed.segments.length) return 0;
        if (parsed.version) this.version = Math.max(this.version || 0, parsed.version);
        if (parsed.targetDuration) this.targetDuration = Math.max(this.targetDuration, parsed.targetDuration);
        let added = 0;
        for (const seg of parsed.segments) {
            if (seg.seq <= leg.lastSeq) continue;
            // Leg 0 keeps ffmpeg's own numbering, so the file ffmpeg wrote and the playlist
            // the relay renders later number the same segments the same way.
            if (this.nextAbs === null) this.nextAbs = seg.seq;
            this.entries.push({ leg: leg.n, name: seg.name, duration: seg.duration, abs: this.nextAbs++,
                discontinuity: leg.n > 0 && !leg.joined });
            leg.joined = true;
            leg.lastSeq = seg.seq;
            added++;
        }
        if (added) {
            this.lastProgressAt = Date.now();
            this.trim();
        }
        return added;
    }

    /** Keep ffmpeg's own window; count a join that slides out; delete a leg's folder once unlisted. */
    trim() {
        const window = sessionsModule().HLS_LIST_SIZE;
        while (this.entries.length > window) {
            this.entries.shift();
            if (this.entries[0].discontinuity) {
                this.discontinuitySequence++;
                this.entries[0].discontinuity = false;
            }
        }
        const listed = new Set(this.entries.map(e => e.leg));
        for (const leg of this.legs) {
            if (leg === this.active || leg === this.standby || leg.removed || listed.has(leg.n)) continue;
            this.removeLegFiles(leg);
        }
    }

    removeLegFiles(leg) {
        if (leg.removed) return;
        leg.removed = true;
        fs.rm(leg.dir, { recursive: true, force: true }).catch(() => { /* swept at the next start */ });
    }

    nameFor(entry) { return entry.leg === 0 ? entry.name : `L${entry.leg}-${entry.name}`; }

    render() {
        if (!this.entries.length) return null;
        const fmp4 = this.segmentType === 'fmp4';
        return renderMediaPlaylist({
            segments: this.entries.map(e => ({
                name: this.nameFor(e),
                duration: e.duration,
                discontinuity: e.discontinuity,
                map: fmp4 ? (e.leg === 0 ? 'init.mp4' : `L${e.leg}-init.mp4`) : null
            })),
            mediaSequence: this.entries[0].abs,
            discontinuitySequence: this.discontinuitySequence,
            version: this.version || (fmp4 ? 7 : 3),
            targetDuration: this.targetDuration
        }).text;
    }

    // ---- what the routes ask for (the same shape as a session) ------------------------

    async getPlaylist() {
        this.touch();
        // Before anything has gone wrong: leg 0's own file, as it always was - less an
        // #EXT-X-ENDLIST. ffmpeg writes one when the provider closes the connection cleanly,
        // and a player that reads it stops for good; for a relay the stream is not over.
        if (!this.switched && !this.switching && !this.active.lost) {
            const text = await this.legs[0].session.getPlaylist();
            return text ? text.replace(/^#EXT-X-ENDLIST\r?\n?/m, '') : text;
        }
        // From the moment a leg is lost: the relay's own list, which never ends.
        if (!this.switching) await this.ingest();
        return this.render();
    }

    getMasterPlaylist() {
        if (!this.master) return null;
        this.touch();
        return this.master;
    }

    async getSegment(name) {
        this.touch();
        const m = /^L(\d+)-(.+)$/.exec(name);
        const leg = this.legs[m ? Number(m[1]) : 0];
        const file = m ? m[2] : name;
        if (!leg || leg.removed || !SEGMENT_NAME.test(file)) return null;
        const full = path.join(leg.dir, file);
        try {
            await fs.access(full);
            return full;
        } catch (err) {
            return null;
        }
    }

    // ---- the clock -----------------------------------------------------------------------

    async tick() {
        if (this.closed || this.switching) return;
        const leg = this.active;
        // Stopped on request (the viewer changed channel, a DELETE, a takeover, the idle
        // sweep): the play is over. A lost leg is checked first: the stall watchdog also
        // stops its session, after saying it was lost.
        if (!leg.lost && leg.session.stopRequested) return this.close('its stream was stopped');

        if (!leg.lost) await this.ingest();
        if (this.closed || this.switching) return;

        await this.tendStandby();
        if (this.closed || this.switching) return;

        const quietMs = Date.now() - this.lastProgressAt;
        if (leg.lost) return this.switchOver(leg.lost.how === 'stall' ? 'stopped sending' : 'ended');
        if (this.standbyReady() && leg.joined && quietMs > switchAfterMs()) {
            return this.switchOver(`wrote nothing for ${Math.round(quietMs / 1000)} s`);
        }
    }

    // ---- switching -----------------------------------------------------------------------

    async switchOver(why) {
        if (this.switching || this.closed) return;
        this.switching = true;
        const old = this.active;
        const { ctx } = this;
        const lostAt = Date.now();
        try {
            this.log(`${this.providerOf(old)} ${why}; switching`);
            // What it wrote last (a short final segment) belongs to the stream too.
            await this.ingest();
            // Leg 0's loss is recorded by the resolve route, which listens to its session; a
            // later leg's, and a switch the relay decided itself, are recorded here.
            if (!old.lost || old.n > 0) {
                interruptions().noteLost({ owner: ctx.owner, channel: ctx.channelName, provider: this.providerOf(old),
                    how: old.lost ? old.lost.how : 'stall', providerReason: old.lost ? old.lost.providerReason === true : true,
                    playedSec: (lostAt - old.startedAt) / 1000 });
            }
            // A lost session is quarantined by providerRouting.watchSession; a leg the relay
            // gave up on itself is quarantined here, the same way.
            if (!old.lost) {
                try { routing().noteFailure(old.candidate, ctx.primaryKey); } catch (e) { /* observation only */ }
            }
            let next = null;
            if (this.standbyReady()) {
                // The standby is already running: join it on first, then let the old leg go.
                next = this.promoteStandby();
                this.retire(old).catch(() => { /* logged in retire */ });
            } else {
                // Free the lost leg's connection first: the next start may need that very one.
                // Its folder stays for the segments still listed.
                await this.retire(old);
                if (this.closed) return;
                if (this.standby) await this.dropStandby('not ready when it was needed');
                next = await this.startCold();
            }
            if (this.closed) {
                if (next) await this.retire(next, true);
                return;
            }
            if (!next) return this.close('nothing could take over');

            this.active = next;
            this.switched = true;
            this.lastProgressAt = Date.now();
            this.standbyAt = Date.now() + STANDBY_DELAY_MS;
            aliases.set(this.id, { legId: next.session.id, at: Date.now() });
            interruptions().noteResolved({ owner: ctx.owner, channel: ctx.channelName, provider: this.providerOf(next) });
            this.log(`now on ${this.providerOf(next)} after ${((Date.now() - lostAt) / 1000).toFixed(1)} s`);
        } finally {
            this.switching = false;
        }
    }

    /** Stop a leg's ffmpeg and take it out of the registry. Its folder is kept unless `files`. */
    async retire(leg, files = false) {
        try {
            await sessionsModule().removeSession(leg.session.id);
            await leg.session.cleanup(); // when the registry no longer had it (a stall): idempotent
        } catch (err) {
            console.warn(`[Relay ${this.id}] could not stop a leg: ${redact(err && err.message)}`);
        }
        if (files) this.removeLegFiles(leg);
    }

    /** Can this session's output join the stream the player already has? */
    joinable(session) {
        return session.options.segmentType === this.segmentType && (session.options.videoRange || null) === this.videoRange;
    }

    /** Start one candidate as a leg: probe, session, first segment. Null when it cannot be used. */
    async startLeg(candidate, { owner, standby = false } = {}) {
        const { ctx } = this;
        let decision;
        try {
            decision = await strategy().resolve({
                url: candidate.url,
                capabilities: ctx.capabilities || {},
                settings: ctx.settings,
                ffprobePath: ctx.ffprobePath,
                upscale: ctx.upscale === true,
                audioEncode: ctx.audioEncode === true,
                owner,
                live: true,
                providerId: candidate.providerId,
                refusedRetryDelaysMs: [1000],
                deadlineAt: Date.now() + START_DEADLINE_MS,
                timingNote: `, relay ${this.id} ${standby ? 'standby' : 'takeover'} on ${candidate.providerName}`,
                sessionOptions: { channelName: ctx.channelName || null, ...(standby ? { standby: true } : {}) }
            });
        } catch (err) {
            if (routing().isProviderFailure(err)) {
                try { routing().noteFailure(candidate, ctx.primaryKey); } catch (e) { /* observation only */ }
            }
            this.log(`${candidate.providerName} could not start: ${redact(err && err.message).split('. ')[0]}`);
            return null;
        }
        const session = decision && decision.sessionId ? sessionsModule().getSession(decision.sessionId) : null;
        if (!session) return null; // a direct play has no segments to join
        if (!this.joinable(session)) {
            this.unusable.add(candidate.providerId);
            this.log(`${candidate.providerName}'s feed cannot join this stream (${session.options.segmentType}${session.options.videoRange ? `, ${session.options.videoRange}` : ''}); not used`);
            await sessionsModule().removeSession(session.id);
            return null;
        }
        try { routing().watchSession(session, candidate, ctx.primaryKey, ctx.channelName); } catch (e) { /* observation only */ }
        return this.addLeg(session, candidate);
    }

    /** No standby: plan the channel's providers again and start the first that can be. */
    async startCold() {
        const { ctx } = this;
        let candidates;
        try {
            candidates = (await routing().plan(ctx.sourceId, ctx.channelId)).candidates;
        } catch (err) {
            return null;
        }
        for (const candidate of candidates) {
            if (this.closed) return null;
            if (this.unusable.has(candidate.providerId)) continue;
            // The viewer has started something else since: this play is over, and admitting
            // it again would stop what they are watching now.
            if (coordinator().activeStreams().some(s => s.owner && s.owner === ctx.owner)) {
                this.close('the viewer is watching something else');
                return null;
            }
            const ask = { force: false, activeRecordings: activeRecordings(), settings: ctx.settings, owner: ctx.owner, providerId: candidate.providerId };
            if (!coordinator().canAdmitWithoutDisturbing(ask)) continue;
            const verdict = await coordinator().admitViewer(ask);
            if (!verdict.allowed) continue;
            const leg = await this.startLeg(candidate, { owner: ctx.owner });
            if (leg) return leg;
        }
        return null;
    }

    // ---- the standby -----------------------------------------------------------------------

    standbyReady() {
        const s = this.standby;
        return !!s && !s.lost && !s.session.stopRequested && s.tail.length >= STANDBY_TAIL
            && Date.now() - s.lastSegAt < switchAfterMs();
    }

    /** Keep the standby's newest segments known; drop it when it is lost or taken; start one when due. */
    async tendStandby() {
        const s = this.standby;
        if (s) {
            if (s.lost) return this.dropStandby(s.lost.how === 'stall' ? 'it stopped sending' : 'it ended');
            if (s.session.stopRequested) return this.dropStandby('its connection was needed');
            const parsed = await this.readPlaylist(s);
            if (parsed && parsed.segments.length) {
                const newest = parsed.segments[parsed.segments.length - 1].seq;
                if (!s.tail.length || s.tail[s.tail.length - 1].seq !== newest) s.lastSegAt = Date.now();
                s.tail = parsed.segments.slice(-STANDBY_TAIL);
                if (parsed.targetDuration) s.targetDuration = parsed.targetDuration;
            }
            return;
        }
        if (!standbyEnabled() || this.startingStandby || Date.now() < this.standbyAt) return;
        this.startingStandby = true;
        // In the background: the playing leg is still followed while this probes and starts.
        this.startStandby()
            .catch(err => console.warn(`[Relay ${this.id}] standby failed: ${redact(err && err.message)}`))
            .finally(() => { this.startingStandby = false; this.standbyAt = Date.now() + STANDBY_RETRY_MS; });
    }

    async startStandby() {
        const { ctx } = this;
        let candidates;
        try {
            candidates = (await routing().plan(ctx.sourceId, ctx.channelId)).candidates;
        } catch (err) {
            return;
        }
        const playingOn = this.active.candidate.providerId;
        const candidate = candidates.find(c => c.providerId !== null && c.providerId !== undefined
            && !this.unusable.has(c.providerId)
            && !coordinator().samePool(c.providerId, playingOn)
            && coordinator().hasFreeConnection(c.providerId, ctx.settings, activeRecordings()));
        if (!candidate) return;
        const leg = await this.startLeg(candidate, { owner: `standby:${this.id}`, standby: true });
        if (!leg) return;
        if (this.closed || this.standby) {
            await this.retire(leg, true);
            return;
        }
        this.standby = leg;
        this.log(`standby running on ${candidate.providerName}`);
    }

    async dropStandby(why) {
        const s = this.standby;
        if (!s) return;
        this.standby = null;
        this.standbyAt = Date.now() + STANDBY_RETRY_MS;
        this.log(`standby on ${this.providerOf(s)} gone: ${why}`);
        await this.retire(s, true);
    }

    /** The standby becomes the playing leg: the viewer's stream now, joined on at its newest segments. */
    promoteStandby() {
        const s = this.standby;
        this.standby = null;
        s.session.options.standby = false;
        s.session.options.owner = this.ctx.owner;
        s.session.touch();
        s.lastSeq = s.tail[0].seq - 1;
        if (s.targetDuration) this.targetDuration = Math.max(this.targetDuration, s.targetDuration);
        return s;
    }

    // ---- ending ----------------------------------------------------------------------------

    async close(why) {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.timer);
        relays.delete(this.id);
        aliases.set(this.id, { legId: this.active.session.id, at: Date.now() });
        this.log(`ended: ${why}`);
        for (const leg of this.legs) await this.retire(leg, true);
    }
}

// ---- the module -------------------------------------------------------------------------

function pruneAliases(now = Date.now()) {
    for (const [id, a] of aliases) if (now - a.at > ALIAS_TTL_MS) aliases.delete(id);
}

/** Follow a session the resolve just started. Null (and nothing changes) when the relay is off. */
function adopt(session, ctx) {
    if (!enabled() || !session || !ctx || ctx.sourceId === undefined || ctx.channelId === undefined) return null;
    if (relays.has(session.id)) return relays.get(session.id);
    const relay = new Relay(session, ctx);
    relays.set(relay.id, relay);
    return relay;
}

function get(id) {
    return relays.get(String(id)) || null;
}

/** End the relay with this id (a DELETE). True when there was one. */
async function close(id, why = 'stopped by the client') {
    const relay = relays.get(String(id));
    if (!relay) return false;
    await relay.close(why);
    return true;
}

/** The same viewer is resolving something else: their relays end (their legs with them). */
async function closeForOwner(owner, why = 'the viewer started another play') {
    if (!owner) return;
    for (const relay of [...relays.values()]) {
        if (relay.ctx.owner === owner) await relay.close(why);
    }
}

async function closeAll(why = 'stopped by an admin') {
    for (const relay of [...relays.values()]) await relay.close(why);
}

/** The session id the coordinator knows a relay's stream by now (its playing leg), else the id given. */
function playingSessionId(id) {
    const relay = relays.get(String(id));
    if (relay) return relay.active.session.id;
    pruneAliases();
    const alias = aliases.get(String(id));
    return alias ? alias.legId : String(id);
}

/** For the Status page: [{ id, channel, provider, legs, standby }]. */
function list() {
    return [...relays.values()].map(r => ({
        id: r.id,
        channel: r.ctx.channelName || null,
        provider: r.providerOf(r.active),
        switches: r.active.n,
        standby: r.standby ? r.providerOf(r.standby) : null,
        standbyReady: r.standbyReady()
    }));
}

module.exports = { enabled, standbyEnabled, adopt, get, close, closeForOwner, closeAll, playingSessionId, list, Relay, STANDBY_TAIL };
