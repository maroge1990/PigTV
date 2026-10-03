/**
 * In-stream recovery and the hot standby (0189; docs/STANDBY-BRIEF.md). Experimental, off
 * unless the admin Settings switch `relayEnabled` is on (and `standbyEnabled` for the standby,
 * which only counts while recovery is on). R12: a switch applies to plays that START after
 * it is changed; a relay keeps the mode it began with, so turning recovery off never breaks
 * a stream that is already being followed.
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
const { parseFrameRate } = require('./streamProbe');
const { parseMediaPlaylist, renderMediaPlaylist } = require('./hlsPlaylist');

// `settings` is the settings object the resolve already holds (db.settings.get()).
const enabled = (settings) => !!settings && settings.relayEnabled === true;
const standbyEnabled = (settings) => enabled(settings) && settings.standbyEnabled === true;

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
const FLASH_MS = 60000;            // how long "promoted" / "reclaimed" / a failed standby stay the shown state
const ENDED_KEEP_MS = 10 * 60 * 1000; // a relay that failed stays on the Status page this long
const SEGMENT_NAME = /^(seg\d{4,}\.(ts|m4s)|init\.mp4)$/;

const relays = new Map();          // relay id -> Relay
const failedRelays = [];           // { snapshot, at }: relays that ended because nothing could take over
const aliases = new Map();         // relay id -> { legId, at }: the last playing leg, kept after the relay ends
const ALIAS_TTL_MS = 15 * 60 * 1000;

// Required lazily: these modules require each other in places, and none is needed at load.
const sessionsModule = () => require('./transcodeSession');
const coordinator = () => require('./streamCoordinator');
const routing = () => require('./providerRouting');
const strategy = () => require('./playbackStrategy');
const interruptions = () => require('./playbackInterruptions');
const playbackEvents = () => require('./playbackEvents');
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
        this.fingerprint = { videoCodec: front.options.videoCodec, width: front.options.width, height: front.options.height,
            fps: front.options.fps, audioCodec: front.options.audioCodec, audioChannels: front.options.audioChannels };
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
        // R12: decided when the play began and kept for its life (a Settings change is for the next play).
        this.standbyOn = standbyEnabled(ctx.settings);
        this.switches = 0;
        this.failed = false;
        this.lastReason = null;        // { code, detail, at }
        this.flash = null;             // { state, until }: a short-lived "promoted" / "reclaimed" / "failed"
        this.warnedUnknown = new Set();
        const now = Date.now();
        this.lastProgressAt = now;
        this.standbyAt = now + STANDBY_DELAY_MS;
        this.active = this.addLeg(front, ctx.candidate);
        this.timer = setInterval(() => {
            this.tick().catch(err => console.warn(`[Relay ${this.id}] tick failed: ${redact(err && err.message)}`));
        }, TICK_MS);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        this.log(`following "${ctx.channelName || 'channel'}" on ${this.providerOf(this.active)}${this.standbyOn ? ' (standby on)' : ''}`);
    }

    describe() {
        return {
            id: this.id,
            channel: this.ctx.channelName || null,
            provider: this.providerOf(this.active),
            state: this.state,
            switches: this.switches,
            standbyMode: this.standbyOn,
            standby: this.standby ? this.providerOf(this.standby) : null,
            standbyReady: this.standbyReady(),
            lastReason: this.lastReason
        };
    }

    log(text) { console.log(`[Relay ${this.id}] ${text}`); }
    providerOf(leg) { return (leg && leg.candidate && leg.candidate.providerName) || 'the provider'; }
    get status() { return this.active.session.status; }

    /** R12: the shown state, one word. A switch or a failure outranks the standby's own progress. */
    get state() {
        if (this.failed) return 'failed';
        if (this.switching) return 'switching';
        if (!this.active.joined && !this.switches) return 'starting';
        if (this.flash && Date.now() < this.flash.until) return this.flash.state;
        if (this.standbyOn && this.standby) return this.standbyReady() ? 'standby-ready' : 'standby-starting';
        if (this.standbyOn && this.startingStandby) return 'standby-starting';
        return 'playing';
    }

    /**
     * R12: remember why the relay did something (a short code the Status page shows) and add it
     * to the recent plays. Observation only: it never throws.
     */
    note(code, detail, { state = null, provider = null } = {}) {
        const now = Date.now();
        this.lastReason = { code, detail: detail || null, at: now };
        if (state) this.flash = { state, until: now + FLASH_MS };
        try {
            playbackEvents().record({ type: 'relay', owner: this.ctx.owner, channel: this.ctx.channelName,
                provider: provider || this.providerOf(this.active), reason: detail ? `${code}: ${detail}` : code });
        } catch (e) { /* observation only */ }
    }

    addLeg(session, candidate) {
        const leg = { n: this.legs.length, session, candidate: candidate || {}, dir: session.dir, lastSeq: -1,
            lost: null, joined: false, removed: false, startedAt: Date.now(), tail: [], lastSegAt: 0 };
        // Its segments stay listed after its ffmpeg has gone: the relay removes the folder.
        session.retainDir = true;
        session.once('lost', (info) => { leg.lost = info || { how: 'exit', providerReason: false }; });
        // A blank picture is the provider's problem the stall watchdog does not see: say so (it is
        // quarantined by providerRouting.watchSession), without acting on it here.
        session.once('blank', () => { if (leg === this.active) this.note('blank', 'the picture went blank', { provider: this.providerOf(leg) }); });
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
        if (leg.lost) {
            return leg.lost.how === 'stall' ? this.switchOver('stopped sending', 'stalled')
                : leg.lost.how === 'timestamps' ? this.switchOver('broke its timestamps after a reconnect', 'timestamps')
                    : this.switchOver('ended', 'lost');
        }
        if (this.standbyReady() && leg.joined && quietMs > switchAfterMs()) {
            return this.switchOver(`wrote nothing for ${Math.round(quietMs / 1000)} s`, 'stalled');
        }
    }

    // ---- switching -----------------------------------------------------------------------

    async switchOver(why, code = 'lost') {
        if (this.switching || this.closed) return;
        this.switching = true;
        const old = this.active;
        const { ctx } = this;
        const lostAt = Date.now();
        try {
            this.log(`${this.providerOf(old)} ${why}; switching`);
            this.note(code, `${this.providerOf(old)} ${why}`, { provider: this.providerOf(old) });
            // What it wrote last (a short final segment) belongs to the stream too.
            await this.ingest();
            // Leg 0's loss is recorded by the resolve route, which listens to its session; a
            // later leg's, and a switch the relay decided itself, are recorded here.
            if (!old.lost || old.n > 0) {
                interruptions().noteLost({ owner: ctx.owner, channel: ctx.channelName, provider: this.providerOf(old),
                    how: old.lost ? old.lost.how : 'stall', providerReason: old.lost ? old.lost.providerReason === true : true,
                    playedSec: (lostAt - old.startedAt) / 1000, reason: code });
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
                this.note('promoted', `standby on ${this.providerOf(next)} took over`, { state: 'promoted', provider: this.providerOf(next) });
                this.retire(old).catch(() => { /* logged in retire */ });
            } else {
                // Free the lost leg's connection first: the next start may need that very one.
                // Its folder stays for the segments still listed.
                await this.retire(old);
                if (this.closed) return;
                if (this.standby) await this.dropStandby('not ready when it was needed', 'stalled');
                next = await this.startCold();
            }
            if (this.closed) {
                if (next) await this.retire(next, true);
                return;
            }
            if (!next) {
                this.note('no-candidate', 'no provider could take over', { provider: this.providerOf(old) });
                return this.close('nothing could take over', true);
            }

            this.active = next;
            this.switches++;
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

    /**
     * Can this session's output join the stream the player already has? Returns '' when it can,
     * else what differs. Beyond the segment type and the video range (what the player was
     * told in the master playlist), a player carrying on after an EXT-X-DISCONTINUITY still
     * needs the same codec, frame size, frame rate and audio layout: a different one stalls
     * or garbles it. The values are the resolve probe's, kept in session.options; one that is
     * unknown on either side counts as the same (logged once per field).
     */
    incompatibility(session) {
        const o = session.options;
        const f = this.fingerprint;
        const differs = [];
        if (o.segmentType !== this.segmentType) differs.push(`segments ${o.segmentType}`);
        if ((o.videoRange || null) !== this.videoRange) differs.push(`range ${o.videoRange || 'SDR'}`);
        const known = (field, a, b) => {
            if (a === null || a === undefined || a === '' || b === null || b === undefined || b === '') {
                if (!this.warnedUnknown.has(field)) {
                    this.warnedUnknown.add(field);
                    this.log(`${field} unknown on one side; treated as compatible`);
                }
                return false;
            }
            return true;
        };
        const norm = (v) => String(v).toLowerCase();
        const alias = (v) => ({ avc: 'h264', hevc: 'h265' })[norm(v)] || norm(v);
        if (known('video codec', f.videoCodec, o.videoCodec) && alias(f.videoCodec) !== alias(o.videoCodec)) differs.push(`video ${o.videoCodec}`);
        // 0 is "not recorded" (an encode may scale): only a stream-copy states its size.
        const size = (w, h) => (w > 0 && h > 0 ? `${w}x${h}` : null);
        const mine = size(f.width, f.height);
        const theirs = size(o.width, o.height);
        if (known('resolution', mine, theirs) && mine !== theirs) differs.push(`size ${theirs}`);
        const rateA = parseFrameRate(f.fps);
        const rateB = parseFrameRate(o.fps);
        if (known('frame rate', rateA, rateB) && Math.abs(rateA - rateB) / Math.max(rateA, rateB) > 0.01) differs.push(`${rateB} fps`);
        if (known('audio codec', f.audioCodec, o.audioCodec) && norm(f.audioCodec) !== norm(o.audioCodec)) differs.push(`audio ${o.audioCodec}`);
        if (known('audio channels', f.audioChannels, o.audioChannels) && Number(f.audioChannels) !== Number(o.audioChannels)) differs.push(`${o.audioChannels} audio channels`);
        return differs.join(', ');
    }

    joinable(session) {
        return this.incompatibility(session) === '';
    }

    /** Start one candidate as a leg: probe, session, first segment. Null when it cannot be used. */
    async startLeg(candidate, { owner, standby = false, lease = null } = {}) {
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
                lease, // R11: bound to the leg's session when it exists
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
        const mismatch = this.incompatibility(session);
        if (mismatch) {
            this.unusable.add(candidate.providerId);
            this.log(`${candidate.providerName}'s feed cannot join this stream (${mismatch}); not used`);
            this.note(standby ? 'standby-incompatible' : 'incompatible', `${candidate.providerName}: ${mismatch}`,
                standby ? { state: 'failed', provider: candidate.providerName } : { provider: candidate.providerName });
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
            if (coordinator().activeStreams().some(s => s.owner && s.owner === ctx.owner && !s.warm)) {
                this.close('the viewer is watching something else');
                return null;
            }
            const ask = { force: false, activeRecordings: activeRecordings(), settings: ctx.settings, owner: ctx.owner, providerId: candidate.providerId };
            if (!coordinator().canAdmitWithoutDisturbing(ask)) continue;
            const verdict = await coordinator().admitViewer(ask);
            if (!verdict.allowed) continue;
            // R11: the lease taken with the admission is bound to the leg's session, or given back.
            let leg;
            try { leg = await this.startLeg(candidate, { owner: ctx.owner, lease: verdict.lease }); } finally { coordinator().releaseUnbound(verdict.lease); }
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
            if (s.lost) return this.dropStandby(s.lost.how === 'stall' ? 'it stopped sending' : 'it ended', s.lost.how === 'stall' ? 'stalled' : 'lost');
            if (s.session.stopRequested) return this.dropStandby('its connection was needed', 'standby-reclaimed');
            const parsed = await this.readPlaylist(s);
            if (parsed && parsed.segments.length) {
                const newest = parsed.segments[parsed.segments.length - 1].seq;
                if (!s.tail.length || s.tail[s.tail.length - 1].seq !== newest) s.lastSegAt = Date.now();
                s.tail = parsed.segments.slice(-STANDBY_TAIL);
                if (parsed.targetDuration) s.targetDuration = parsed.targetDuration;
            }
            return;
        }
        if (!this.standbyOn || this.startingStandby || Date.now() < this.standbyAt) return;
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
        // R11: the connection is leased in the same step it is found free, so a viewer or recording
        // arriving while the standby probes counts it (and, as it is only a standby, takes it).
        // A free connection anywhere first; failing that, one a warm channel holds (continuity of the
        // channel being watched comes before a guess at the next one: coordinator.reserveTakingWarm).
        let lease = null;
        const usable = candidates.filter(c => c.providerId !== null && c.providerId !== undefined
            && !this.unusable.has(c.providerId)
            && !coordinator().samePool(c.providerId, playingOn));
        const opts = { owner: `standby:${this.id}` };
        let candidate = usable.find(c => (lease = coordinator().tryReserveFree(c.providerId, 'standby', ctx.settings, activeRecordings(), opts)));
        for (const c of candidate ? [] : usable) {
            if (this.closed || this.standby) return;
            if ((lease = await coordinator().reserveTakingWarm(c.providerId, 'standby', ctx.settings, activeRecordings(), opts))) { candidate = c; break; }
        }
        if (!candidate) return;
        let leg;
        try { leg = await this.startLeg(candidate, { owner: `standby:${this.id}`, standby: true, lease }); } finally { coordinator().releaseUnbound(lease); }
        if (!leg) return;
        if (this.closed || this.standby) {
            await this.retire(leg, true);
            return;
        }
        this.standby = leg;
        this.log(`standby running on ${candidate.providerName}`);
    }

    async dropStandby(why, code = 'lost') {
        const s = this.standby;
        if (!s) return;
        this.standby = null;
        this.note(code, `standby on ${this.providerOf(s)} gone: ${why}`,
            { state: code === 'standby-reclaimed' ? 'reclaimed' : 'failed', provider: this.providerOf(s) });
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

    async close(why, failed = false) {
        if (this.closed) return;
        this.closed = true;
        if (failed) {
            this.failed = true;
            failedRelays.push({ snapshot: this.describe(), at: Date.now() });
            if (failedRelays.length > 10) failedRelays.shift();
        }
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

/** Follow a session the resolve just started. Null (and nothing changes) when the relay is off in ctx.settings. */
function adopt(session, ctx) {
    if (!ctx || !enabled(ctx.settings) || !session || !ctx || ctx.sourceId === undefined || ctx.channelId === undefined) return null;
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

/**
 * For the Status page and GET /api/status: one entry per followed stream, plus (for ten
 * minutes) the ones that ended because nothing could take over. `state` is one of starting |
 * playing | switching | standby-starting | standby-ready | promoted | reclaimed | failed;
 * `lastReason` is { code, detail, at } with code lost | stalled | timestamps | blank |
 * incompatible | standby-incompatible | standby-reclaimed | promoted | no-candidate. Names only.
 */
function list() {
    const now = Date.now();
    while (failedRelays.length && now - failedRelays[0].at > ENDED_KEEP_MS) failedRelays.shift();
    return [...relays.values()].map(r => r.describe()).concat(failedRelays.map(f => f.snapshot));
}

/** The switches as they stand: { enabled, standby } for a settings object. */
function modeOf(settings) {
    return { enabled: enabled(settings), standby: standbyEnabled(settings) };
}

module.exports = { enabled, standbyEnabled, modeOf, adopt, get, close, closeForOwner, closeAll, playingSessionId, list, Relay, STANDBY_TAIL };
