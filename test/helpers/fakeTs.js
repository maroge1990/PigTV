// Synthetic MPEG-TS for the join-point tests (#3): PAT, PMT, video and audio packets, 188 bytes each,
// with the frame number written into every video PES so a test can tell where a reader started.
'use strict';

const PMT_PID = 0x1000;
const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;
const STREAM_TYPE = { h264: 0x1b, hevc: 0x24, mpeg2: 0x02 };

const counters = new Map();
function packet(pid, { pusi = false, rai = null, payload = Buffer.alloc(0) } = {}) {
    const p = Buffer.alloc(188, 0xff);
    const cc = counters.get(pid) || 0;
    counters.set(pid, (cc + 1) & 0x0f);
    p[0] = 0x47;
    p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
    p[2] = pid & 0xff;
    let at = 4;
    if (rai !== null) {
        p[3] = 0x30 | cc; // adaptation field and payload
        p[4] = 1;
        p[5] = rai ? 0x40 : 0x00;
        at = 6;
    } else p[3] = 0x10 | cc;
    payload.copy(p, at, 0, Math.min(payload.length, 188 - at));
    return p;
}

function pat() {
    const body = [0x00, 0, 0, 0x00, 0x01, 0xc1, 0, 0, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff];
    const length = body.length - 3 + 4;
    body[1] = 0xb0 | ((length >> 8) & 0x0f);
    body[2] = length & 0xff;
    return packet(0, { pusi: true, payload: Buffer.concat([Buffer.from([0]), Buffer.from(body), Buffer.from([0xde, 0xad, 0xbe, 0xef])]) });
}

function pmt({ codec = 'h264', video = true } = {}) {
    const streams = [];
    if (video) streams.push(STREAM_TYPE[codec], 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00);
    streams.push(0x0f, 0xe0 | (AUDIO_PID >> 8), AUDIO_PID & 0xff, 0xf0, 0x00);
    const body = [0x02, 0, 0, 0x00, 0x01, 0xc1, 0, 0, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00, ...streams];
    const length = body.length - 3 + 4;
    body[1] = 0xb0 | ((length >> 8) & 0x0f);
    body[2] = length & 0xff;
    return packet(PMT_PID, { pusi: true, payload: Buffer.concat([Buffer.from([0]), Buffer.from(body), Buffer.from([0xde, 0xad, 0xbe, 0xef])]) });
}

// The first NAL units of an access unit, per codec and kind.
const NALS = {
    h264: { key: [0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x64], idr: [0x09, 0xf0, 0, 0, 0, 1, 0x65, 0x88], plain: [0x09, 0xf0, 0, 0, 0, 1, 0x41, 0x9a] },
    hevc: { key: [0x46, 0x01, 0x50, 0, 0, 0, 1, 0x26, 0x01], idr: [0x46, 0x01, 0x50, 0, 0, 0, 1, 0x26, 0x01], plain: [0x46, 0x01, 0x50, 0, 0, 0, 1, 0x02, 0x01] },
    mpeg2: { key: [0xb3, 0x14, 0x00], idr: [0xb3, 0x14, 0x00], plain: [0x00, 0x00, 0x10] }
};

/** A video access unit's first packet (PES start) and `more` continuation packets; `kind` picks a key frame's NAL units. */
function videoFrame(frame, { key = false, codec = 'h264', rai = null, kind = null, more = 2 } = {}) {
    const es = Buffer.from([0, 0, 0, 1, ...NALS[codec][key ? (kind || 'key') : 'plain']]);
    const tag = Buffer.alloc(8, 0);
    tag.write('FR', 0, 'latin1');
    tag.writeUInt32BE(frame, 2);
    const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 0x05, 0x21, 0, 1, 0, 1]), es, Buffer.from([0, 0, 0x03]), tag]);
    const out = [packet(VIDEO_PID, { pusi: true, rai: rai === null ? null : rai && key, payload: pes })];
    for (let i = 0; i < more; i++) out.push(packet(VIDEO_PID, { payload: tag }));
    return Buffer.concat(out);
}

const audio = () => packet(AUDIO_PID, { pusi: true, payload: Buffer.from([0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 0x05, 0x21, 0, 1, 0, 1, 0xff, 0xf1]) });

/** Every packet of `buf` (aligned at 0): { pid, pusi, frame (video PES starts), key }. */
function readPackets(buf) {
    const out = [];
    for (let i = 0; i + 188 <= buf.length; i += 188) {
        const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
        const pusi = (buf[i + 1] & 0x40) !== 0;
        const tag = buf.indexOf('FR', i, 'latin1');
        const frame = pid === VIDEO_PID && pusi && tag >= 0 && tag < i + 188 ? buf.readUInt32BE(tag + 2) : null;
        out.push({ offset: i, pid, pusi, frame });
    }
    return out;
}

module.exports = { PMT_PID, VIDEO_PID, AUDIO_PID, packet, pat, pmt, videoFrame, audio, readPackets };
