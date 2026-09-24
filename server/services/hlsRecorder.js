/**
 * A recording taken from a tuner's segments (the tuner model, 0127).
 *
 * With PIGTV_TUNER=1 a recording owns no ffmpeg. It holds the tuner for its
 * channel (a live viewer's, when there is one, so watching and recording one
 * channel costs one provider connection) and keeps every segment whose span
 * overlaps [start - pre-buffer, end + post-buffer): hard-linked into the
 * recording's folder when the tuner's directory is on the same volume (the
 * timeshift directory, 0128), copied otherwise. Its own playlist, index.m3u8, is
 * rewritten (atomically) after every segment: an EVENT playlist while it records,
 * VOD with #EXT-X-ENDLIST once it is finished.
 *
 * Segments are renumbered for the recording (seg00000...) so a re-tune (the
 * tuner stalled and a new one was started) cannot collide; the first segment
 * after a re-tune carries #EXT-X-DISCONTINUITY and, for fMP4, the new tuner's init
 * segment (init-2.mp4, ...).
 */

const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const hls = require('./hlsPlaylist');

/** Hard link, else copy (a different volume, or a filesystem without links). */
async function linkOrCopy(from, to) {
    try {
        await fs.link(from, to);
        return 'link';
    } catch (err) {
        if (err.code === 'EEXIST') return 'exists';
        await fs.copyFile(from, to);
        return 'copy';
    }
}

class HlsRecorder extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.dir      the recording's folder (exists)
     * @param {number} o.from     epoch ms: keep segments that end after this
     * @param {number} o.to       epoch ms: and start before this
     * @param {string} [o.label]  log prefix
     */
    constructor({ dir, from, to, label = 'Recording' }) {
        super();
        this.dir = dir;
        this.from = from;
        this.to = to;
        this.label = label;
        this.segments = [];      // [{ name, duration, pdt, map, discontinuity, bytes }]
        this.bytes = 0;
        this.generation = 0;
        this.seen = new Set();   // `${tunerId}:${seq}`
        this.finished = false;
        this.queue = Promise.resolve();
        this.version = 3;
        this.targetDuration = 0;
        this.tuner = null;
        this.links = { link: 0, copy: 0 };
    }

    /** Take segments from this tuner, starting with what its window already holds. */
    attach(tuner) {
        this.detach();
        this.generation++;
        this.tuner = tuner;
        const generation = this.generation;
        const state = { initName: null, first: true };
        const take = (segs) => this.enqueue(tuner, generation, state, segs);
        const onSegments = (segs) => take(segs.map(s => ({ ...s, map: tuner.mapName })));
        const onEnded = () => {
            if (this.tuner === tuner) this.detach();
        };
        tuner.on('segments', onSegments);
        tuner.once('ended', onEnded);
        this._off = () => {
            tuner.off('segments', onSegments);
            tuner.off('ended', onEnded);
        };
        take(tuner.segmentsSnapshot());
    }

    detach() {
        if (this._off) this._off();
        this._off = null;
        this.tuner = null;
    }

    enqueue(tuner, generation, state, segs) {
        this.queue = this.queue
            .then(() => this.take(tuner, generation, state, segs))
            .catch(err => console.error(`[${this.label}] Could not keep a segment: ${err.message}`));
        return this.queue;
    }

    async take(tuner, generation, state, segs) {
        let added = 0;
        for (const s of segs) {
            if (this.finished) break;
            const seenKey = `${tuner.id}:${s.seq}`;
            if (this.seen.has(seenKey)) continue;
            if (s.pdt + s.duration * 1000 <= this.from || s.pdt >= this.to) continue;
            this.seen.add(seenKey);

            let map = null;
            if (s.map) {
                if (!state.initName) {
                    const name = generation === 1 ? 'init.mp4' : `init-${generation}.mp4`;
                    await linkOrCopy(path.join(tuner.dir, s.map), path.join(this.dir, name));
                    state.initName = name;
                }
                map = state.initName;
            }
            const ext = path.extname(s.name);
            const name = `seg${String(this.segments.length).padStart(5, '0')}${ext}`;
            try {
                this.links[await linkOrCopy(path.join(tuner.dir, s.name), path.join(this.dir, name))]++;
            } catch (err) {
                // Trimmed out of the tuner's window before we got to it: nothing to keep.
                console.warn(`[${this.label}] Segment ${s.name} was gone before it could be kept (${err.code || err.message})`);
                continue;
            }
            let bytes = 0;
            try { bytes = (await fs.stat(path.join(this.dir, name))).size; } catch { /* counted as 0 */ }
            this.segments.push({
                name, duration: s.duration, pdt: s.pdt, map,
                discontinuity: state.first && this.segments.length > 0,
                bytes
            });
            this.bytes += bytes;
            this.version = Math.max(this.version, tuner.version || 3);
            state.first = false;
            added++;
        }
        if (added) {
            await this.writePlaylist();
            this.emit('segments', added);
        }
    }

    durationSec() {
        return this.segments.reduce((t, s) => t + s.duration, 0);
    }

    render() {
        const { text, targetDuration } = hls.renderMediaPlaylist({
            segments: this.segments,
            mediaSequence: 0,
            version: this.version,
            // Sticky: an EVENT playlist's target duration must not change.
            targetDuration: this.targetDuration || 1,
            playlistType: this.finished ? 'VOD' : 'EVENT',
            endList: this.finished,
            // 0129: played from its start, also while it is still recording (an
            // EVENT playlist otherwise starts at its live end).
            startOffset: 0
        });
        this.targetDuration = targetDuration;
        return text;
    }

    async writePlaylist() {
        const file = path.join(this.dir, 'index.m3u8');
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, this.render());
        await fs.rename(tmp, file);
    }

    /** No more segments: drain what is queued and write the VOD playlist. */
    async finish() {
        this.detach();
        await this.queue;
        this.finished = true;
        await this.writePlaylist();
    }
}

/**
 * An EVENT playlist left behind by a server that stopped mid-recording, turned
 * into VOD. Returns { segments, durationSec } or null when it has no segments.
 */
async function closeOrphanPlaylist(dir) {
    const file = path.join(dir, 'index.m3u8');
    let text;
    try {
        text = await fs.readFile(file, 'utf8');
    } catch {
        return null;
    }
    const parsed = hls.parseMediaPlaylist(text);
    if (!parsed.segments.length) return null;
    if (!parsed.ended) {
        text = text.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD').replace(/\n*$/, '\n') + '#EXT-X-ENDLIST\n';
        await fs.writeFile(`${file}.tmp`, text);
        await fs.rename(`${file}.tmp`, file);
    }
    return { segments: parsed.segments.length, durationSec: parsed.segments.reduce((t, s) => t + s.duration, 0) };
}

module.exports = { HlsRecorder, linkOrCopy, closeOrphanPlaylist };
