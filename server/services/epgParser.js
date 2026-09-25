/**
 * EPG (XMLTV) Parser (Streaming)
 * Parses XMLTV format EPG data and extracts channel/programme information using streaming XML parser
 */

const sax = require('sax');
const zlib = require('zlib');
const { Readable } = require('stream');
const { stripBadgeSuffix } = require('./textCleanup');

// 0152: XMLTV programme flags, as a bitmask (the same bits as sportsClassify.FLAGS; stored in
// epg_programs.flags): <previously-shown/> (with or without a start), <premiere/>, <new/>, and
// the non-standard <live/>; a <category>Live</category> counts as <live/>.
const PROGRAMME_FLAGS = { 'previously-shown': 1, premiere: 2, new: 4, live: 8 };
const LIVE_CATEGORY_RE = /^\s*live(?:\s+event)?\s*$/i;

/** Set a flag on a programme being parsed (a channel has no flags). */
function markFlag(obj, tag) {
    if (obj && obj.flags !== undefined && PROGRAMME_FLAGS[tag]) obj.flags |= PROGRAMME_FLAGS[tag];
}

/**
 * Parse XMLTV date format (YYYYMMDDHHmmss +ZZZZ)
 * @param {string} dateStr - XMLTV format date string
 * @returns {Date}
 */
function parseXmltvDate(dateStr) {
    if (!dateStr) return null;

    // Format: 20231225120000 +0000
    const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
    if (!match) {
        // Try ISO format fallback
        return new Date(dateStr);
    }

    const [, year, month, day, hour, minute, second, tz] = match;
    let isoStr = `${year}-${month}-${day}T${hour}:${minute}:${second}`;

    if (tz) {
        const tzHours = tz.substring(0, 3);
        const tzMins = tz.substring(3);
        isoStr += `${tzHours}:${tzMins}`;
    } else {
        isoStr += 'Z';
    }

    return new Date(isoStr);
}

/**
 * Parse XMLTV content (Stream or String)
 * @param {Readable|string} input - XMLTV content as Stream or String
 * @returns {Promise<{ channels: Array, programmes: Array }>}
 */
function parse(input) {
    return new Promise((resolve, reject) => {
        const channels = [];
        const programmes = [];

        const saxStream = sax.createStream(true, { trim: true, normalize: true }); // strict mode

        let currentTag = null;
        let currentObject = null;
        let textBuffer = '';

        saxStream.on('error', function (e) {
            // clear the error
            this._parser.error = null;
            this._parser.resume();
            console.warn('XML Parse Warning:', e.message);
        });

        saxStream.on('opentag', function (node) {
            currentTag = node.name;
            const attr = node.attributes;

            if (currentTag === 'channel') {
                currentObject = {
                    id: attr.id,
                    name: null, // Will be populated by display-name tag
                    icon: null,
                    url: null
                };
            } else if (currentTag === 'programme') {
                currentObject = {
                    channelId: attr.channel,
                    start: parseXmltvDate(attr.start),
                    stop: parseXmltvDate(attr.stop),
                    title: null,
                    subtitle: null,
                    description: null,
                    category: [],
                    icon: null,
                    date: null,
                    episodeNum: null,
                    flags: 0
                };
            } else if (currentTag === 'icon') {
                if (currentObject) {
                    currentObject.icon = attr.src;
                }
            } else {
                markFlag(currentObject, currentTag);
            }
            textBuffer = '';
        });

        saxStream.on('text', function (text) {
            textBuffer += text;
        });

        saxStream.on('cdata', function (text) {
            textBuffer += text;
        });

        saxStream.on('closetag', function (tagName) {
            if (tagName === 'channel') {
                if (currentObject) channels.push(currentObject);
                currentObject = null;
            } else if (tagName === 'programme') {
                if (currentObject) programmes.push(currentObject);
                currentObject = null;
            } else if (currentObject) {
                // Handle properties within objects
                switch (tagName) {
                    case 'display-name': // channel name
                        if (!currentObject.name) currentObject.name = stripBadgeSuffix(textBuffer);
                        break;
                    case 'url': // channel url
                        currentObject.url = textBuffer;
                        break;
                    case 'title':
                        currentObject.title = stripBadgeSuffix(textBuffer);
                        break;
                    case 'sub-title':
                        currentObject.subtitle = stripBadgeSuffix(textBuffer);
                        break;
                    case 'desc':
                        currentObject.description = textBuffer;
                        break;
                    case 'category':
                        if (textBuffer && currentObject.category) currentObject.category.push(textBuffer);
                        if (LIVE_CATEGORY_RE.test(textBuffer)) markFlag(currentObject, 'live');
                        break;
                    case 'date':
                        currentObject.date = textBuffer;
                        break;
                    case 'episode-num':
                        // Prefer system "xmltv_ns" or just take text
                        // Complex episode parsing logic can go here if needed
                        currentObject.episodeNum = textBuffer;
                        break;
                }
            }
        });

        saxStream.on('end', function () {
            resolve({ channels, programmes });
        });

        // Handle input type
        if (typeof input === 'string') {
            const inputStream = Readable.from([input]);
            inputStream.pipe(saxStream);
        } else {
            input.pipe(saxStream);
        }
    });
}

/**
 * Get programmes for a specific channel
 */
function getProgrammesForChannel(programmes, channelId) {
    return programmes.filter(p => p.channelId === channelId);
}

/**
 * Get current and upcoming programmes for a channel
 */
function getCurrentAndUpcoming(programmes, channelId, count = 5) {
    const now = new Date();
    const channelProgrammes = getProgrammesForChannel(programmes, channelId);

    // Sort by start time
    channelProgrammes.sort((a, b) => a.start - b.start);

    // Find current and upcoming
    const current = channelProgrammes.find(p => p.start <= now && p.stop > now);
    const upcoming = channelProgrammes
        .filter(p => p.start > now)
        .slice(0, count);

    return { current, upcoming };
}

/**
 * Fetch and parse XMLTV from URL
 */
async function fetchAndParse(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
    }

    let stream;
    if (response.body && typeof response.body.pipe === 'function') {
        stream = response.body;
    } else if (response.body) {
        stream = Readable.fromWeb(response.body);
    } else {
        stream = Readable.from([]);
    }

    // Check for GZIP
    // Note: We can't easily check for magic bytes on a stream without buffering.
    // We'll rely on response headers or file extension mostly, or try to peek.
    // For now, let's assume if content-encoding is gzip OR url ends in .gz

    // However, undici/fetch usually handles 'Content-Encoding: gzip' automatically transparently.
    // We only need to manually gunzip if the server serves it as application/octet-stream but it's actually gzipped, 
    // or if it's a .gz file download.

    // A robust way for streams is checking magic bytes, but that requires peeking.
    // Simplified approach: try to pipe through gunzip if the URL indicates it.

    const isGzipped = url.endsWith('.gz') || (response.headers.get('content-type') || '').includes('gzip');

    if (isGzipped) {
        const gunzip = zlib.createGunzip();
        stream.pipe(gunzip);
        return parse(gunzip);
    }

    // In the previous version we read magic bytes. 
    // To support that with streams we'd need a peek stream.
    // For now let's trust the transparent decompression of fetch or the URL.

    return parse(stream);
}

/**
 * Streaming EPG parser that yields batches of programmes (memory-efficient)
 * Channels are collected and returned with the first batch, then programmes are yielded in batches.
 * 
 * @param {string} url - XMLTV URL
 * @param {number} batchSize - Number of programmes per batch (default: 1000)
 * @yields {{ channels: Array|null, programmes: Array, isLast: boolean }}
 */
async function* fetchAndParseStreaming(url, batchSize = 1000) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
    }

    let stream;
    if (response.body && typeof response.body.pipe === 'function') {
        stream = response.body;
    } else if (response.body) {
        stream = Readable.fromWeb(response.body);
    } else {
        stream = Readable.from([]);
    }

    const isGzipped = url.endsWith('.gz') || (response.headers.get('content-type') || '').includes('gzip');

    if (isGzipped) {
        const gunzip = zlib.createGunzip();
        stream.pipe(gunzip);
        stream = gunzip;
    }

    // Use async iterator pattern with SAX
    yield* parseStreaming(stream, batchSize);
}

/**
 * Parse XMLTV as streaming async generator
 * @param {Readable} input - XMLTV stream
 * @param {number} batchSize - Number of programmes per batch
 * @yields {{ channels: Array|null, programmes: Array, isLast: boolean }}
 */
async function* parseStreaming(input, batchSize = 1000) {
    const channels = [];
    let programmeBatch = [];
    let channelsYielded = false;

    // How many completed-but-not-yet-yielded batches can pile up before the
    // source is paused. The old code had no such limit and no queue either
    // - a single pendingBatch slot, overwritten by whichever batch finished
    // most recently. Two batches completing before the consumer loop got a
    // chance to read it meant the first one vanished with no error, no log
    // line - just a channel that silently "has no EPG today". A real queue
    // fixes the loss on its own; this limit is what keeps that queue from
    // growing unboundedly if the consumer (a synchronous DB insert per
    // batch, in syncService.js) is ever slower than parsing, which bursty
    // gzip input can otherwise outrun by a wide margin.
    const BATCH_QUEUE_LIMIT = 3;

    const saxStream = sax.createStream(true, { trim: true, normalize: true });

    let currentTag = null;
    let currentObject = null;
    let textBuffer = '';
    let resolveNext = null;
    const batchQueue = [];
    let ended = false;

    function enqueueBatch(batch) {
        if (resolveNext) {
            resolveNext(batch);
            resolveNext = null;
            return;
        }
        batchQueue.push(batch);
        if (batchQueue.length >= BATCH_QUEUE_LIMIT && !ended && typeof input.pause === 'function') {
            input.pause();
        }
    }

    // sax reports both recoverable problems (a malformed entity, an
    // unexpected tag) and anything else wrong with the feed the same way:
    // an 'error' event, after which the stream stalls unless resumed.
    // There is no way to tell a shrug-and-continue problem from a fatal one
    // from this event alone, and losing an entire sync over one bad entity
    // in a 500k-programme feed is worse than the occasional garbled record
    // - so every one is logged and resumed from, never allowed to fail the
    // sync. (This used to be two separate handlers: this one, and a second
    // one further down that independently captured the same event into an
    // outer variable and re-threw it once the generator finished - undoing
    // the resume() below and turning a warning into a failed sync, after
    // programmes had already been deleted and partially re-inserted. One
    // handler, one behaviour.)
    saxStream.on('error', function (e) {
        this._parser.error = null;
        this._parser.resume();
        console.warn('XML Parse Warning:', e.message);
    });

    saxStream.on('opentag', function (node) {
        currentTag = node.name;
        const attr = node.attributes;

        if (currentTag === 'channel') {
            currentObject = {
                id: attr.id,
                name: null,
                icon: null,
                url: null
            };
        } else if (currentTag === 'programme') {
            currentObject = {
                channelId: attr.channel,
                start: parseXmltvDate(attr.start),
                stop: parseXmltvDate(attr.stop),
                title: null,
                subtitle: null,
                description: null,
                category: [],
                icon: null,
                date: null,
                episodeNum: null,
                flags: 0
            };
        } else if (currentTag === 'icon') {
            if (currentObject) {
                currentObject.icon = attr.src;
            }
        } else {
            markFlag(currentObject, currentTag);
        }
        textBuffer = '';
    });

    saxStream.on('text', function (text) {
        textBuffer += text;
    });

    saxStream.on('cdata', function (text) {
        textBuffer += text;
    });

    saxStream.on('closetag', function (tagName) {
        if (tagName === 'channel') {
            if (currentObject) channels.push(currentObject);
            currentObject = null;
        } else if (tagName === 'programme') {
            if (currentObject) {
                programmeBatch.push(currentObject);

                if (programmeBatch.length >= batchSize) {
                    const batch = {
                        channels: !channelsYielded ? channels : null,
                        programmes: programmeBatch,
                        isLast: false
                    };
                    channelsYielded = true;
                    programmeBatch = [];
                    enqueueBatch(batch);
                }
            }
            currentObject = null;
        } else if (currentObject) {
            switch (tagName) {
                case 'display-name':
                    if (!currentObject.name) currentObject.name = stripBadgeSuffix(textBuffer);
                    break;
                case 'url':
                    currentObject.url = textBuffer;
                    break;
                case 'title':
                    currentObject.title = stripBadgeSuffix(textBuffer);
                    break;
                case 'sub-title':
                    currentObject.subtitle = stripBadgeSuffix(textBuffer);
                    break;
                case 'desc':
                    currentObject.description = textBuffer;
                    break;
                case 'category':
                    if (textBuffer && currentObject.category) currentObject.category.push(textBuffer);
                    if (LIVE_CATEGORY_RE.test(textBuffer)) markFlag(currentObject, 'live');
                    break;
                case 'date':
                    currentObject.date = textBuffer;
                    break;
                case 'episode-num':
                    currentObject.episodeNum = textBuffer;
                    break;
            }
        }
    });

    // Not saxStream.on('end', ...): after a recoverable error+resume (above),
    // sax's internal parser.closed flag never flips true even though the
    // document parses correctly to the end - verified directly (closetag
    // fires for every element including the root, the tag stack correctly
    // empties to 0), so saxStream's own end/finish/close events silently
    // never fire, and a sync that hit one recoverable warning would hang
    // forever instead of completing. This is a sax quirk in its own
    // error-recovery path, not something worth working around inside sax
    // itself - the input stream's end event is the actually trustworthy
    // "no more data is coming" signal, unaffected by the parser's opinion
    // of its own state, and by the time it fires every write() into
    // saxStream has already been made (pipe() only calls dest.end() after
    // every upstream 'data' event, and therefore every write(), completes).
    function finishParsing() {
        if (ended) return;
        ended = true;
        const batch = {
            channels: !channelsYielded ? channels : null,
            programmes: programmeBatch,
            isLast: true
        };
        enqueueBatch(batch);
    }
    input.on('end', finishParsing);

    // Start piping
    input.pipe(saxStream);

    // Yield batches as they become available
    while (!ended || batchQueue.length > 0) {
        if (batchQueue.length > 0) {
            const batch = batchQueue.shift();
            if (batchQueue.length < BATCH_QUEUE_LIMIT && typeof input.resume === 'function' && typeof input.isPaused === 'function' && input.isPaused()) {
                input.resume();
            }
            yield batch;
            if (batch.isLast) break;
        } else if (!ended) {
            // Wait for next batch
            const batch = await new Promise(resolve => {
                resolveNext = resolve;
            });
            if (batch) {
                yield batch;
                if (batch.isLast) break;
            }
        }
    }
}

module.exports = {
    PROGRAMME_FLAGS,
    parse,
    parseXmltvDate,
    fetchAndParse,
    fetchAndParseStreaming,
    parseStreaming,
    getProgrammesForChannel,
    getCurrentAndUpcoming
};

