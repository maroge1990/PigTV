/** Dashboard-only ESPN adapter. Never changes the fixture/live-replay classifier. */
const { f1Session } = require('./sportsFixtures');
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';
const text = (v, max = 160) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const id = v => /^(?:[A-Za-z0-9_-]{1,80})$/.test(String(v ?? '')) ? String(v) : null;
const number = v => Number.isFinite(v) && v >= 0 ? v : undefined;
function logo(v) {
    try { const u = new URL(v); return u.protocol === 'https:' && u.hostname === 'a.espncdn.com' ? u.href : null; } catch { return null; }
}
function statusOf(c, league) {
    const s = c.status || {}, t = s.type || {}, description = `${t.name || ''} ${t.description || ''}`;
    if (/cancel|abandon/i.test(description)) return ['cancelled'];
    if (/postpon/i.test(description)) return ['postponed'];
    if (/suspend/i.test(description)) return ['suspended'];
    if (t.completed === true || t.state === 'post') return ['finished'];
    if (t.state === 'pre' || (league === 'Cricket' && /^Starts (?:at|in)/i.test(s.summary || ''))) return ['scheduled'];
    for (const [re, label] of [[/stumps/i,'Stumps'],[/half.?time/i,'Half-time'],[/rain/i,'Rain delay'],[/lunch/i,'Lunch'],[/tea\b/i,'Tea'],[/innings.?break/i,'Innings break'],[/intermission/i,'Intermission'],[/delay/i,'Delayed']]) {
        if (re.test(description)) return ['break', label];
    }
    if (t.state === 'in') return ['live'];
    return ['unknown'];
}
function safeClock(v, football) {
    const s = text(v, 24);
    return (football ? /^\d{1,3}['′]?(?:\+\d{1,2}['′]?)?$/ : /^\d{1,3}(?::\d{2})?(?:\.\d{1,2})?$/).test(s) ? s : undefined;
}
function normalize(json, league, source) {
    if (!Array.isArray(json?.events) || !/^[a-z-]+\/[a-z0-9._-]+$/i.test(source)) return [];
    const out = [];
    for (const e of json.events.slice(0, 1000)) {
        if (!e || !Array.isArray(e.competitions)) continue;
        for (const c of e.competitions.slice(0, 12)) {
            if (!c || !id(c.id)) continue;
            const start = Date.parse(c.date || e.date), parsedEnd = Date.parse(c.endDate || (league === 'Cricket' ? e.endDate : ''));
            if (!Number.isFinite(start)) continue;
            const formatKey=text(c.class?.eventType || c.class?.generalClassCard).toLowerCase();
            const format=league==='Cricket' ? ({test:'test',odi:'odi',t20:'t20',t20i:'t20','first-class':'first-class',fc:'first-class','list a':'list-a',lista:'list-a'}[formatKey] || null) : null;
            const session = league === 'F1' ? f1Session(c.type?.abbreviation)?.label : null;
            if (league === 'F1' && !session) continue;
            const raw = Array.isArray(c.competitors) ? c.competitors : [];
            const sides = raw.filter(t => t?.team && id(t.team.id ?? t.id)).slice(0, 2);
            if (league !== 'F1' && sides.length !== 2) continue;
            const competitors = league === 'F1' ? [] : sides.map(t => ({
                id: id(t.team.id ?? t.id), name: text(t.team.displayName || t.team.name),
                aliases: [...new Set(['displayName','shortDisplayName','name','abbreviation'].map(k => text(t.team[k])).filter(a => a && (a.toLowerCase() !== text(t.team.location).toLowerCase() || a === text(t.team.displayName))))],
                logo: logo(t.team.logo)
            }));
            if (competitors.some(t => !t.name) || (competitors.length && competitors[0].id === competitors[1].id)) continue;
            const [state, breakLabel] = statusOf(c, league);
            const progress = {}, situation = {};
            let scores = null;
            if (league !== 'F1' && !['scheduled','unknown'].includes(state)) {
                const values = sides.map(t => text(t.score, 80));
                if (values.every(s => league === 'Cricket' ? /^[\d\s/&().ovad]+$/i.test(s) : /^\d{1,4}$/.test(s))) scores = values;
                const clock = safeClock(c.status?.displayClock, source.startsWith('soccer/'));
                if (clock !== undefined && league !== 'Cricket' && league !== 'MLB') progress.clock = clock;
                const period = number(c.status?.period);
                if (period !== undefined) progress.period = period;
                if (league === 'MLB') {
                    const half=/^(top|bottom|mid|end)\b/i.exec(c.status?.type?.detail || '');
                    if(half) progress.half=half[1].toLowerCase();
                    else if(typeof c.situation?.isTopInning==='boolean') progress.half=c.situation.isTopInning?'top':'bottom';
                }
                if (league === 'Cricket') {
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
            out.push({ id:`espn:${source}:${c.id}`, league, start, end:Number.isFinite(parsedEnd) ? parsedEnd : null,
                format, title:league === 'F1' ? text(e.name) : competitors.map(t => t.name).join(' v '), competitors, session,
                circuit:league === 'F1' ? { name:text(e.circuit?.fullName), city:text(e.circuit?.address?.city), country:text(e.circuit?.address?.country) } : null,
                snapshot:{ state, ...(breakLabel ? { breakLabel } : {}), progress, scores, situation:Object.keys(situation).length ? situation : null }
            });
        }
    }
    return out;
}
async function fetchJson(url, { signal } = {}) {
    const u = new URL(url);
    if (u.origin !== 'https://site.api.espn.com' || !u.pathname.startsWith('/apis/site/v2/sports/')) throw new Error('Invalid score source');
    const response = await fetch(u, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), redirect:'error' });
    if (!response.ok) throw new Error('Score source unavailable');
    const reader=response.body.getReader(),chunks=[];
    let bytes=0;
    try {
        for(;;) {
            const {value,done}=await reader.read();
            if(done) break;
            bytes+=value.byteLength;
            if(bytes>2*1024*1024) { await reader.cancel();throw new Error('Score response too large'); }
            chunks.push(Buffer.from(value));
        }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
}
module.exports = { BASE, normalize, fetchJson };
