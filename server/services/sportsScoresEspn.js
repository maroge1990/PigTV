const { isCricket, CRICKET_GROUPS } = require('./sportCatalog'); // #195: every cricket league, not only internationals
const { cricketGroupOf } = require('./sportsFixturesEspn');
/** Dashboard-only ESPN adapter. Never changes the fixture/live-replay classifier. */
const { f1Session } = require('./sportsFixtures');
const { fetchFeed } = require('./sportFetch');
const { espnState, edgeKey } = require('./espnState');
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';
const text = (v, max = 160) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const id = v => /^(?:[A-Za-z0-9_-]{1,80})$/.test(String(v ?? '')) ? String(v) : null;
const number = v => Number.isFinite(v) && v >= 0 ? v : undefined;
// A team's names as the dashboard's game↔guide join reads them (sportsDashboard.matchBroadcasts); a bare location is
// not a name unless it is the display name. 0388: also the league page's join (sportPageLeague.js).
const teamAliases = team => [...new Set(['displayName','shortDisplayName','name','abbreviation'].map(k => text(team?.[k])).filter(a => a && (a.toLowerCase() !== text(team?.location).toLowerCase() || a === text(team?.displayName))))];
function logo(v) {
    try { const u = new URL(v); return u.protocol === 'https:' && u.hostname === 'a.espncdn.com' ? u.href : null; } catch { return null; }
}
// #272 (0548): C-O's words are espnState's own; a break only with a label C-O lists (another pause is play, as before).
const C_O_BREAKS = new Set(['Stumps', 'Half-time', 'Rain delay', 'Lunch', 'Tea', 'Innings break', 'Intermission', 'Delayed']);
function statusOf(c, league) {
    const { state, breakLabel } = espnState(c.status, { cricket: isCricket(league) });
    if (state === 'break') return C_O_BREAKS.has(breakLabel) ? ['break', breakLabel] : ['live'];
    return [state];
}
function safeClock(v, football) {
    const s = text(v, 24);
    return (football ? /^\d{1,3}['′]?(?:\+\d{1,2}['′]?)?$/ : /^\d{1,3}(?::\d{2})?(?:\.\d{1,2})?$/).test(s) ? s : undefined;
}
/**
 * #212: a match an International cricket group's series lists that is not the group's by its own international class
 * (a tour match against an A side or a domestic XI, a women's match under the men's group, a series filed under the
 * group before 0397): never the group's card. A match without a class is the series' (the class is unknown).
 */
function misfiled(c, league) {
    if (!CRICKET_GROUPS.includes(league)) return false;
    const group = cricketGroupOf([{ competitions: [c] }]);
    return group !== undefined && group !== league;
}
/** #212: the card ids of a group's answer that are not the group's (misfiled), which the collector forgets. */
function misfiledIds(json, league, source) {
    if (!CRICKET_GROUPS.includes(league) || !Array.isArray(json?.events)) return [];
    return json.events.slice(0, 1000).flatMap(e => (Array.isArray(e?.competitions) ? e.competitions.slice(0, 12) : [])
        .filter(c => c && id(c.id) && misfiled(c, league)).map(c => `espn:${source}:${c.id}`));
}
function normalize(json, league, source) {
    if (!Array.isArray(json?.events) || !/^[a-z-]+\/[a-z0-9._-]+$/i.test(source)) return [];
    const out = [];
    for (const e of json.events.slice(0, 1000)) {
        if (!e || !Array.isArray(e.competitions)) continue;
        for (const c of e.competitions.slice(0, 12)) {
            if (!c || !id(c.id) || misfiled(c, league)) continue;
            const start = Date.parse(c.date || e.date), parsedEnd = Date.parse(isCricket(league) ? '' : c.endDate || '');
            if (!Number.isFinite(start)) continue;
            // Captured cricket endDate values include day/series envelopes, not reliable match ends.
            // Prefer class card over eventType (first-class matches may say eventType=Test).
            const formatKey=text(c.class?.generalClassCard || c.class?.eventType).toLowerCase().replace(/^(?:women'?s|men'?s)\s+/, '');
            const format=isCricket(league) ? ({test:'test',odi:'odi',t20:'t20',t20i:'t20','first-class':'first-class',fc:'first-class','list a':'list-a',lista:'list-a'}[formatKey] || null) : null;
            const session = league === 'F1' ? f1Session(c.type?.abbreviation)?.label : null;
            if (league === 'F1' && !session) continue;
            const raw = Array.isArray(c.competitors) ? c.competitors : [];
            const sides = raw.filter(t => t?.team && id(t.team.id ?? t.id)).slice(0, 2);
            if (league !== 'F1' && sides.length !== 2) continue;
            const competitors = league === 'F1' ? [] : sides.map(t => ({
                id: id(t.team.id ?? t.id), name: text(t.team.displayName || t.team.name),
                aliases: teamAliases(t.team),
                // #223: a team schedule's competitors carry `logos`, not `logo`
                logo: logo(t.team.logo) || (Array.isArray(t.team.logos) ? logo(t.team.logos[0]?.href) : null)
            }));
            if (competitors.some(t => !t.name) || (competitors.length && competitors[0].id === competitors[1].id)) continue;
            const [state, breakLabel] = statusOf(c, league);
            const progress = {}, situation = {};
            let scores = null;
            if (league !== 'F1' && !['scheduled','unknown'].includes(state)) {
                const values = sides.map(t => text(t.score, 80));
                if (isCricket(league)) {
                    // #235: ESPN adds the chase's target ("283 (45.5/50 ov, target 358)") and a side yet to bat has no score;
                    // either made the whole score null. The target is dropped, an empty side kept; nothing else passes.
                    const kept = values.map(s => s.replace(/,?\s*target\s+\d{1,4}/i, '').replace(/\(\s*\)/g, '').trim());
                    if (kept.every(s => s === '' || /^[\d\s/&().ovad]+$/i.test(s)) && kept.some(Boolean)) scores = kept;
                } else if (values.every(s => /^\d{1,4}$/.test(s))) scores = values;
                const clock = safeClock(c.status?.displayClock, source.startsWith('soccer/'));
                if (clock !== undefined && !isCricket(league) && league !== 'MLB') progress.clock = clock;
                const period = number(c.status?.period);
                if (period !== undefined) progress.period = period;
                if (league === 'MLB') {
                    const half=/^(top|bottom|mid|end)\b/i.exec(c.status?.type?.detail || '');
                    if(half) progress.half=half[1].toLowerCase();
                    else if(typeof c.situation?.isTopInning==='boolean') progress.half=c.situation.isTopInning?'top':'bottom';
                }
                if (isCricket(league)) {
                    const day = text(c.status?.session, 24);
                    if (/^Day \d{1,2}$/i.test(day)) progress.day = day;
                    situation.innings = sides.map(t => (Array.isArray(t.linescores) ? t.linescores : [])
                        .filter(r => r?.isBatting === true).slice(0, 4).map(r => ({ runs:number(r.runs), wickets:number(r.wickets), overs:String(r.overs ?? ''), current:r.isCurrent === 1 || r.isCurrent === true })));
                    const current = situation.innings.flat().find(r => r.current);
                    if (current && /^\d{1,3}(?:\.[0-5])?$/.test(current.overs)) progress.overs = current.overs;
                }
                if (league === 'NFL' && c.situation) {
                    for (const key of ['down','distance','yardLine']) if (number(c.situation[key]) !== undefined) situation[key] = c.situation[key];
                    if (id(c.situation.possession)) situation.possession = id(c.situation.possession);
                }
                if (league === 'MLB' && c.situation) {
                    for (const key of ['balls','strikes','outs']) if (number(c.situation[key]) !== undefined) situation[key] = c.situation[key];
                    for (const key of ['onFirst','onSecond','onThird','isTopInning']) if (typeof c.situation[key] === 'boolean') situation[key] = c.situation[key];
                }
            }
            // #197: an F1 session's entry list by name (never its order: a result), what a followed driver is found by
            // (sportsDashboard.followMatchesFor)
            const players = league === 'F1' ? [...new Set(raw.map(t => text(t?.athlete?.displayName, 80)).filter(Boolean))].sort((a, b) => a.localeCompare(b)) : [];
            // #272 (D-1): what the guide's live/replay classifier reads of a game (sportsFixtures.snapshot), which the card's
            // own fields leave out: ESPN's end as given (a cricket match's days, an F1 weekend's end), each side's town and an F1
            // session's event name (its place).
            const espnEnd = Date.parse(c.endDate || e.endDate || '');
            const fixture = { end: Number.isFinite(espnEnd) ? espnEnd : null, locations: sides.map(t => text(t.team.location) || null),
                ...(league === 'F1' ? { event: text(e.name || e.shortName) || null } : {}) };
            out.push({ id:`espn:${source}:${c.id}`, league, start, end:Number.isFinite(parsedEnd) ? parsedEnd : null, ...(players.length ? { players } : {}), fixture,
                // #195: an International cricket group's series name, which says whether it is an ICC event (sportGroups.js).
                ...(league === 'Cricket' || league === "Women's Cricket" || league === 'Other cricket' ? { competition: text(json.leagues?.[0]?.name, 120) || null } : {}),
                format, title:league === 'F1' ? text(e.name) : competitors.map(t => t.name).join(' v '), competitors, session,
                circuit:league === 'F1' ? { name:text(e.circuit?.fullName), city:text(e.circuit?.address?.city), country:text(e.circuit?.address?.country) } : null,
                snapshot:{ state, ...(breakLabel ? { breakLabel } : {}), progress, scores, situation:Object.keys(situation).length ? situation : null,
                    espn:pageFacts(c, league, source, sides) }
            });
        }
    }
    return out;
}
/**
 * #272 (batch D): what a sport page reads of a game's status, beside C-O's own words, so a page shows the collector's
 * (delayed) state in its own (sportPageState.js): espnState's edge key read as the page reads it (baseball: the end of an
 * inning is play), ESPN's detail line, clock and period as given, and which side is home (the order of `scores`).
 */
function pageFacts(c, league, source, sides) {
    const t = c.status?.type || {};
    return { key: edgeKey(espnState(c.status, { cricket: isCricket(league), baseball: source.startsWith('baseball/') })),
        detail: text(t.shortDetail, 80) || text(t.detail, 80) || null, clock: text(c.status?.displayClock, 24) || null,
        period: number(c.status?.period) ?? null, sides: sides.map(x => (x.homeAway === 'home' || x.homeAway === 'away' ? x.homeAway : null)),
        ...(league === 'NFL' && c.situation ? { situation: nflSituation(c.situation, sides) } : {}) };
}
/** The NFL page's down-and-distance line, the side in possession (home/away) and the red zone (C-Q `situation`). */
function nflSituation(sit, sides) {
    const holder = sides.find(x => String(x?.id) === String(sit.possession) || String(x?.team?.id) === String(sit.possession));
    return { downDistance: text(sit.downDistanceText, 80) || text(sit.shortDownDistanceText, 80) || null,
        possession: holder?.homeAway === 'home' || holder?.homeAway === 'away' ? holder.homeAway : null, redZone: sit.isRedZone === true };
}
// The collector's words for the one fetch's refusals (its throw shape, sportsDashboard.fetchOnce).
const WORDS = { 'host not allowed': 'Invalid score source', 'answer too large': 'Score response too large' };
/**
 * The score collector's (and follow suggestions') way of asking: the JSON, or a throw with `.status`, `.retryAfter` and
 * `.hostBackoffRecorded` (the cooldown already saw the answer, so the collector does not record it twice). The request
 * itself is the one sport fetch (sportFetch.js, #272); 8 s and 2 MB unless the caller says (individual leagues: 6 MB).
 */
async function fetchJson(url, { signal, maxBytes = 2 * 1024 * 1024, onParsed } = {}) {
    const r = await fetchFeed(url, { signal, maxBytes, onParsed, timeoutMs: 8000 });
    if (r.ok) return r.json;
    if (r.status) throw Object.assign(new Error('Score source unavailable'), { status: r.status, retryAfter: r.retryAfter, hostBackoffRecorded: r.recorded });
    throw new Error(WORDS[r.error] || r.error);
}
module.exports = { BASE, normalize, misfiledIds, fetchJson, teamAliases };
