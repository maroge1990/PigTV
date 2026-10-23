/**
 * Event channels (R9, Wave 4): a guide entry from an event slot's own name.
 *
 * Providers carry many games on numbered event slots whose guide is empty or a placeholder
 * ("NBA 06 :", "- NO EVENT STREAMING -"), while the slot's NAME says what is on and when. Four
 * forms seen in the providers' own playlists (test/fixtures/providers):
 *
 *   NEXT | BAHRAIN: RACE | Sun 04 Oct 01:50 EDT (US) | 8K EXCLUSIVE | US: APPLE TV F1 PPV 2
 *   NHL: Pittsburgh vs Philadelphia @ Sep 30 7:30 PM :Sportsnet+  12
 *   CA (TSN+ 019) | NCAA Football: North Texas vs. Tulsa (2026-10-01 21:00:00)
 *   NBA 02: Knicks (NYK) x Timberwolves (MIN) start:2025-01-18 00:20:00 stop:2025-01-18 04:20:00
 *
 * A name with a time but no date ("Rugby 4: Australia vs Wales 5:30pm") is left alone: which
 * day it means cannot be told. A time with its zone named (EDT, EST, BST, AEST, ...) is read in
 * that zone; one without (the Canadian and US slots above) is North American Eastern time,
 * America/Toronto, with daylight saving worked out for that date. An event lasts 3 hours unless
 * the name gives its end.
 *
 * The guide comes first: a slot's name is used only where its guide has nothing at that time
 * but placeholders (sportsEvents.buildEvents). Pure: no database, no network. Native: the idea is
 * Dispatcharr's dummy EPG (AGPL, read, not copied).
 */
const sportsClassify = require('./sportsClassify');

const HOUR_MS = 3600 * 1000;
const DEFAULT_LENGTH_MS = 3 * HOUR_MS;
const EASTERN = 'America/Toronto';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
// Fixed offsets, in hours, for the zones a name may give.
const ZONES = { EDT: -4, EST: -5, CDT: -5, CST: -6, MDT: -6, MST: -7, PDT: -7, PST: -8,
    UTC: 0, GMT: 0, BST: 1, CET: 1, CEST: 2, AEST: 10, AEDT: 11, ACST: 9.5, ACDT: 10.5, AWST: 8, NZST: 12, NZDT: 13 };

/** Minutes east of UTC that `tz` is at this instant. */
function offsetMinutes(tz, utcMs) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(utcMs));
    const v = Object.fromEntries(parts.map(p => [p.type, Number(p.value)]));
    return Math.round((Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - utcMs) / 60000);
}

/** A wall-clock time in `tz` (an IANA zone or a fixed offset in hours) as UTC ms. */
function wallToUtc({ year, month, day, hour, minute }, tz) {
    const naive = Date.UTC(year, month, day, hour, minute);
    if (typeof tz === 'number') return naive - tz * HOUR_MS;
    // Twice: the offset at the guess, then at the corrected instant (right across a DST change).
    let utc = naive - offsetMinutes(tz, naive) * 60000;
    utc = naive - offsetMinutes(tz, utc) * 60000;
    return utc;
}

/** The year that puts month/day nearest to now (a slot names next week, not last year). */
function nearestYear(month, day, now) {
    const y = new Date(now).getUTCFullYear();
    let best = y;
    for (const cand of [y - 1, y, y + 1]) {
        if (Math.abs(Date.UTC(cand, month, day) - now) < Math.abs(Date.UTC(best, month, day) - now)) best = cand;
    }
    return best;
}

function hour12(h, ampm) {
    h = Number(h) % 12;
    return ampm && ampm.toLowerCase() === 'pm' ? h + 12 : h;
}

const tidy = (s) => String(s || '').replace(/\s+_\s+/g, ' · ').replace(/\s+/g, ' ').replace(/[\s|:-]+$/, '').trim();

/**
 * The event a slot's name announces: { title, start, end } (UTC ms), or null when the name
 * carries no dated event. `now` picks the year when the name gives none.
 */
function eventFromName(name, now = Date.now()) {
    const text = String(name || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    let m;

    // 1. "start:YYYY-MM-DD HH:MM:SS stop:YYYY-MM-DD HH:MM:SS"
    if ((m = /^(.*?)\s*start:\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::\d{2})?(?:\s*stop:\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}))?/i.exec(text))) {
        const start = wallToUtc({ year: +m[2], month: +m[3] - 1, day: +m[4], hour: +m[5], minute: +m[6] }, EASTERN);
        const end = m[7] ? wallToUtc({ year: +m[7], month: +m[8] - 1, day: +m[9], hour: +m[10], minute: +m[11] }, EASTERN) : start + DEFAULT_LENGTH_MS;
        const title = tidy(m[1]);
        return title && end > start ? { title, start, end } : null;
    }

    // 2. "... | TITLE | Sun 04 Oct 01:50 EDT (US) | ... | SLOT"
    const zoned = new RegExp(`(?:mon|tue|wed|thu|fri|sat|sun)[a-z]* (\\d{1,2}) ${MONTH_RE} (\\d{1,2}):(\\d{2}) ?(am|pm)? ?([A-Z]{2,5})?\\b`, 'i');
    if (text.includes('|') && (m = zoned.exec(text))) {
        const segments = text.split('|').map(s => s.trim());
        const at = segments.findIndex(s => zoned.test(s));
        const title = tidy(segments.slice(0, at).filter(s => !/^next$/i.test(s)).pop() || '');
        if (!title) return null;
        const zone = m[6] ? m[6].toUpperCase() : null;
        const tz = zone && ZONES[zone] !== undefined ? ZONES[zone] : EASTERN;
        const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
        const day = +m[1];
        const start = wallToUtc({ year: nearestYear(month, day, now), month, day, hour: m[5] ? hour12(m[3], m[5]) : +m[3], minute: +m[4] }, tz);
        // The slot's own name ("US: APPLE TV F1 PPV 2") supplies the league a bare title lacks.
        const league = sportsClassify.detectLeague(segments[segments.length - 1]);
        const named = league && !sportsClassify.detectLeague(title) ? `${league}: ${title}` : title;
        return { title: named, start, end: start + DEFAULT_LENGTH_MS };
    }

    // 3. "... (YYYY-MM-DD HH:MM:SS)", the title after the slot's "CA (TSN+ 019) |"
    if ((m = /^(?:.*?\|\s*)?(.*?)\s*\((\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::\d{2})?\)\s*$/.exec(text))) {
        const title = tidy(m[1]);
        if (!title) return null;
        const start = wallToUtc({ year: +m[2], month: +m[3] - 1, day: +m[4], hour: +m[5], minute: +m[6] }, EASTERN);
        return { title, start, end: start + DEFAULT_LENGTH_MS };
    }

    // 4. "TITLE @ Sep 30 7:30 PM :SLOT"
    if ((m = new RegExp(`^(.*?)\\s@\\s${MONTH_RE} (\\d{1,2}),? (\\d{1,2}):(\\d{2}) ?(am|pm)`, 'i').exec(text))) {
        // "Sportsnet Central Sep 29 @ ..." - the title's own trailing date is not part of it.
        const title = tidy(m[1].replace(new RegExp(`\\s${MONTH_RE} \\d{1,2}$`, 'i'), ''));
        if (!title) return null;
        const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
        const day = +m[3];
        const start = wallToUtc({ year: nearestYear(month, day, now), month, day, hour: hour12(m[4], m[6]), minute: +m[5] }, EASTERN);
        return { title, start, end: start + DEFAULT_LENGTH_MS };
    }
    return null;
}

/** Does the guide say something real here (not a placeholder, not the slot's bare name)? */
function realGuideTitle(title) {
    const p = sportsClassify.parseTitle(title || '');
    return Boolean(title) && !p.placeholderWord && !p.endsColon;
}

/**
 * Guide rows for the visible channels whose names announce an event the guide does not show:
 * epg_live-shaped rows ({ channel_id, title, start_time, end_time, categories, flags }) for
 * eventsFromProgrammes, between `from` and `to`. A channel with no guide id gets one ("name:" +
 * its key) so the rows find it; `progs` are the guide's own rows for the same window.
 */
function syntheticProgrammes(channels, progs, from, to, now = from) {
    const byTvg = new Map();
    for (const p of progs) {
        if (!byTvg.has(p.channel_id)) byTvg.set(p.channel_id, []);
        byTvg.get(p.channel_id).push(p);
    }
    const out = [];
    for (const ch of channels) {
        const ev = eventFromName(ch.name, now);
        if (!ev || ev.end <= from || ev.start >= to) continue;
        const own = ch.tvgId ? byTvg.get(ch.tvgId) || [] : [];
        if (own.some(p => p.start_time < ev.end && p.end_time > ev.start && realGuideTitle(p.title))) continue; // the guide comes first
        if (!ch.tvgId) ch.tvgId = `name:${ch.key}`;
        // S4 (0247): the row is THIS slot's (channel_key): its name is its own, while its guide id may be a
        // placeholder other slots share - joined by the id, one slot's game was listed on all of them.
        out.push({ channel_id: ch.tvgId, channel_key: ch.key, title: ev.title, start_time: ev.start, end_time: ev.end, categories: '["Sport"]', flags: 0, fromName: true });
    }
    return out;
}

module.exports = { eventFromName, syntheticProgrammes, wallToUtc, realGuideTitle, EASTERN };
