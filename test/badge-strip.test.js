const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stripBadgeSuffix } = require('../server/services/textCleanup');
const epgParser = require('../server/services/epgParser');
const m3uParser = require('../server/services/m3uParser');

// The badge as it arrives in the provider's data: small-caps / modifier-letter
// glyphs, not ASCII "LIVE". U+1D38 U+026A U+1D20 U+1D07.
const BADGE = 'ᴸɪᴠᴇ'; // "ᴸɪᴠᴇ"
const NEW_BADGE = 'ɴᴇᴡ'; // "ɴᴇᴡ"

test('stripBadgeSuffix removes a trailing small-caps badge', () => {
    assert.equal(stripBadgeSuffix(`NFL Football - Giants at Rams ${BADGE}`), 'NFL Football - Giants at Rams');
    assert.equal(stripBadgeSuffix(`NFL 16 ${BADGE}`), 'NFL 16');
    assert.equal(stripBadgeSuffix(`Some Show ${NEW_BADGE}`), 'Some Show');
    // No separating space is required either.
    assert.equal(stripBadgeSuffix(`Match${BADGE}`), 'Match');
});

test('stripBadgeSuffix leaves ordinary titles and edge inputs untouched', () => {
    assert.equal(stripBadgeSuffix('NFL Football - Giants at Rams'), 'NFL Football - Giants at Rams');
    // A badge-looking run only in the MIDDLE is not a trailing badge.
    assert.equal(stripBadgeSuffix(`The ${BADGE} Show`), `The ${BADGE} Show`);
    assert.equal(stripBadgeSuffix(''), '');
    assert.equal(stripBadgeSuffix(null), null);
    assert.equal(stripBadgeSuffix(undefined), undefined);
});

test('EPG parser strips the badge from title, sub-title and channel name', async () => {
    const xml = `<?xml version="1.0"?><tv>` +
        `<channel id="c1"><display-name>NFL 16 ${BADGE}</display-name></channel>` +
        `<programme channel="c1" start="20260101120000 +0000" stop="20260101130000 +0000">` +
        `<title>NFL Football - Giants at Rams ${BADGE}</title>` +
        `<sub-title>Week 3 ${BADGE}</sub-title>` +
        `</programme>` +
        `</tv>`;

    const { channels, programmes } = await epgParser.parse(xml);
    assert.equal(channels[0].name, 'NFL 16');
    assert.equal(programmes[0].title, 'NFL Football - Giants at Rams');
    assert.equal(programmes[0].subtitle, 'Week 3');
});

test('EPG streaming parser strips the badge too', async () => {
    const { Readable } = require('stream');
    const xml = `<?xml version="1.0"?><tv>` +
        `<channel id="c1"><display-name>NFL 16 ${BADGE}</display-name></channel>` +
        `<programme channel="c1" start="20260101120000 +0000" stop="20260101130000 +0000">` +
        `<title>Ordinary Title</title><sub-title>Week 3 ${BADGE}</sub-title></programme>` +
        `</tv>`;

    let channels = null;
    const titles = [];
    const subtitles = [];
    for await (const batch of epgParser.parseStreaming(Readable.from([xml]), 10)) {
        if (batch.channels) channels = batch.channels;
        for (const p of batch.programmes) { titles.push(p.title); subtitles.push(p.subtitle); }
    }
    assert.equal(channels[0].name, 'NFL 16');
    assert.equal(titles[0], 'Ordinary Title'); // untouched
    assert.equal(subtitles[0], 'Week 3');
});

test('M3U parser strips the badge from the channel name', () => {
    const info = m3uParser.parseExtinf(`#EXTINF:-1 tvg-id="nfl16" group-title="Sports",NFL 16 ${BADGE}`);
    assert.equal(info.name, 'NFL 16');
    // An ordinary name is unchanged.
    const plain = m3uParser.parseExtinf('#EXTINF:-1 group-title="Sports",Sky Sports Main Event');
    assert.equal(plain.name, 'Sky Sports Main Event');
});
