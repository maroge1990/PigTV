/** Opt-in dashboard foundation. Network collection is separate from requests and ordinary sport classification. */
const classify = require('./sportsClassify');
const fixtures = require('./sportsFixtures');
const espn = require('./sportsScoresEspn');
const { createStore } = require('./sportsDashboardStore');
const H = 3600000;
const enabled = () => process.env.PIGTV_SPORTS_DASHBOARD === '1';
const dateFormats = new Map();
function localDay(ms, timezone) {
    if (!dateFormats.has(timezone)) {
        if (dateFormats.size >= 8) dateFormats.delete(dateFormats.keys().next().value);
        dateFormats.set(timezone, new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }));
    }
    const parts = dateFormats.get(timezone).formatToParts(ms);
    const value = type => parts.find(p => p.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}
function timezone() {
    const zone=process.env.TZ || 'Australia/Melbourne';
    try { localDay(Date.now(),zone);return zone; } catch { return 'Australia/Melbourne'; }
}
const norm = v => classify.parseSide(v)?.tokens.join(' ') || '';
function prepareGame(game) {
    return { game, sides: game.competitors.map(t => new Set(t.aliases.map(norm))),
        title: game.league === 'F1' ? classify.parseTitle(game.title) : null,
        session: game.league === 'F1' ? classify.parseTitle(game.session).session : null };
}
function prepareEvent(event) {
    return { event, pair: classify.parseMatchup(event.title),
        title: event.league === 'F1' ? classify.parseTitle(event.title) : null,
        format: /\b(test|odi|t20i?|first.class|list a)\b/i.exec(event.title)?.[1]?.toLowerCase() };
}
function sameGame(prepared, parsed) {
    const { game } = prepared, { event } = parsed;
    if ((event.kind && event.kind !== 'event') || game.league !== event.league) return false;
    if (!Number.isFinite(event.start) || !Number.isFinite(event.end)) return false;
    if (game.league === 'Cricket') {
        const maximum = ({ t20: 4.5, odi: 9, 'list-a': 9, test: 120, 'first-class': 120 })[game.format] || 12;
        const limit = game.start + maximum * H;
        const end = limit; // Cricket endDate is an envelope in the captures, not trusted match duration.
        if (event.end <= game.start || event.start >= end) return false;
        if (parsed.format && game.format) {
            const format = ({ t20i: 't20', 'first class': 'first-class', 'list a': 'list-a' })[parsed.format] || parsed.format;
            if (format !== game.format) return false;
        }
    } else if (event.end < game.start || Math.abs(event.start - game.start) > 90 * 60000) return false;
    if (game.league === 'F1') {
        return Boolean(parsed.title.session && prepared.session && parsed.title.session.id === prepared.session.id &&
            prepared.title.location.length && parsed.title.location.length && classify.locationMatch(parsed.title.location, prepared.title.location));
    }
    const pair = parsed.pair;
    if (!pair || prepared.sides.length !== 2) return false;
    const a = pair[0].tokens.join(' '), b = pair[1].tokens.join(' ');
    return (prepared.sides[0].has(a) && prepared.sides[1].has(b)) || (prepared.sides[0].has(b) && prepared.sides[1].has(a));
}
function matchBroadcasts(games, events) {
    const found = new Map(games.map(g => [g.id, []])), byLeague = new Map();
    for (const game of games) {
        if (!byLeague.has(game.league)) byLeague.set(game.league, []);
        byLeague.get(game.league).push(prepareGame(game));
    }
    for (const event of events) {
        if (event.kind && event.kind !== 'event') continue;
        const parsed = prepareEvent(event);
        const candidates = (byLeague.get(event.league) || []).filter(g => sameGame(g, parsed));
        // Short-format windows normally decide the join. For cricket only, use a clearly nearest start
        // if a broad listing overlaps multiple games; ties and near-ties remain unmatched.
        if (candidates.length > 1 && event.league === 'Cricket') {
            candidates.sort((a, b) => Math.abs(a.game.start - event.start) - Math.abs(b.game.start - event.start));
            const first = Math.abs(candidates[0].game.start - event.start), second = Math.abs(candidates[1].game.start - event.start);
            if (second - first >= H) candidates.splice(1);
        }
        if (candidates.length === 1) found.get(candidates[0].game.id).push(event);
    }
    return found;
}
function channelsFor(events, now, includeUpcoming=false) {
    const seen=new Set(),out=[];
    for(const event of events.filter(e=>(e.start<=now && now<e.end && e.live===true) || (includeUpcoming && e.start>now))) {
        for(const c of event.channels || []) {
            const key=`${c.sourceId}:${c.stableId || c.id}`;
            if(seen.has(key)) continue;
            seen.add(key);
            // Explicit projection: no upstream URL, alias prose, internal fields or credentials reach the client.
            out.push({sourceId:c.sourceId,id:c.id,stableId:c.stableId || null,name:c.name,number:c.number || null,logo:c.logo || null,quality:c.quality || null});
        }
    }
    return out;
}
function buildDashboard(store,{now=Date.now(),userId,league=null,events=[],leagues=null,follow=null,broadLeagues=new Set(),timezone:zone=timezone()}={}) {
    const prefs=store.preferences(userId),today=localDay(now,zone);
    // All catalog entries participate in ambiguity checks, even when filtered out of the requested view.
    const view=store.view(now,prefs.scoreDelaySeconds);
    const catalog=view.catalog,matches=matchBroadcasts(catalog,events),games=[];
    for(const g of catalog) {
        if(league && league!==g.league || leagues && !leagues.has(g.league)) continue;
        if(follow && !broadLeagues.has(g.league) && !follow.some(k=>classify.canonicalLeague(k)===g.league)) {
            const teams=follow.map(classify.teamFollow).filter(t=>t?.league===g.league);
            if(teams.length && !teams.some(t=>g.competitors.some(c=>c.aliases.some(a=>norm(a)===norm(t.team))))) continue;
        }
        const selected=view.selected.get(g.id);
        const at=selected?.observedAt ?? null;
        const fresh=at!==null && now-at <= prefs.scoreDelaySeconds*1000+120000;
        const state=selected?.data.state || 'unknown';
        const ongoing=['live','break','suspended'].includes(state);
        const horizon=league ? now+72*H : Infinity;
        const recent=state==='finished' && selected.finishedAt!==null && now<selected.finishedAt+prefs.scoreDelaySeconds*1000+H;
        if(state==='finished' && !recent) continue;
        if(g.start>horizon || (!league && localDay(g.start,zone)!==today && !ongoing && !recent)) continue;
        if(g.start<now-8*24*H || (g.start<now-12*H && !ongoing && !recent && (!g.end || g.end<now))) continue;
        const airings=matches.get(g.id),terminal=['finished','cancelled','postponed'].includes(state);
        const liveChannels=terminal ? [] : channelsFor(airings,now);
        const channels=liveChannels.length ? liveChannels : terminal ? [] : channelsFor(airings,now,true);
        const scheduled=g.start>now && (state==='scheduled' || !selected);
        const projectedState=scheduled ? 'scheduled' : !fresh ? 'unknown' : state;
        const card={id:g.id,league:g.league,title:g.title,start:g.start,end:g.end,session:g.session,circuit:g.circuit,format:g.format || null,
            competitors:g.competitors.map(({id,name,logo})=>({id,name,logo})),
            status:projectedState, ...(fresh && selected.data.breakLabel ? {breakLabel:selected.data.breakLabel}:{}),
            freshness:!selected ? 'buffering' : fresh ? 'fresh' : 'stale',observedAt:at,
            progress:fresh ? selected.data.progress : {},
            availability:liveChannels.length || (g.start>now && channels.length) ? 'matched' : airings.length ? 'unavailable' : 'unmatched',
            broadcastStatus:liveChannels.length ? 'on-tv' : channels.length ? 'scheduled' : 'unavailable',channels,
            // Upcoming event references retain the existing details/record workflow without inventing channels.
            events:airings.map(e=>({id:e.id,start:e.start,end:e.end})),
            canWatch:liveChannels.length>0 && !['finished','cancelled','postponed'].includes(state)};
        if(!prefs.avoidSpoilers && fresh && selected.data.scores!==null) card.scores=selected.data.scores;
        if(!prefs.avoidSpoilers && fresh && selected.data.situation) card.situation=selected.data.situation;
        games.push(card);
    }
    const order={live:0,break:1,suspended:2,scheduled:3,unknown:4,postponed:5,cancelled:6,finished:7};
    games.sort((a,b)=>(order[a.status]-order[b.status]) || a.start-b.start || a.id.localeCompare(b.id));
    return {now,timezone:zone,scope:league ? 'league' : 'today',hours:league ? 72 : null,preferences:prefs,games};
}
function utcDates(now) {
    const out=[];
    const start=new Date(now);start.setUTCHours(0,0,0,0);
    for(let d=start.getTime();d<=now+72*H;d+=24*H) out.push(new Date(d).toISOString().slice(0,10).replaceAll('-',''));
    return out;
}
const requestPolicy = require('./espnRequestPolicy');
const REQUESTS_PER_TICK = 12;
const CATALOG_RESERVE = 3;
function createCollector({store,fetchJson=espn.fetchJson,leagues=()=>fixtures.neededLeagues(),clock=Date.now,enabled:isEnabled=enabled}={}) {
    let running = null, timer = null, stopped = false, remaining = 0, deadline = 0, coldRequests = 0;
    const cache = new Map(), controller = new AbortController();
    async function read(url, ttl, { cold = false, maxCold = Infinity } = {}) {
        if (stopped) return null;
        const old = cache.get(url), now = clock();
        if (old && now < old.nextAt) return old.data;
        if (remaining <= 0 || now >= deadline || requestPolicy.blocked(now) || (cold && coldRequests >= maxCold)) return null;
        remaining--;
        if (cold) coldRequests++;
        try {
            const data = await fetchJson(url, {signal: controller.signal});
            if (!(url.includes('/scorepanel?') ? Array.isArray(data?.scores) : Array.isArray(data?.events))) throw new Error('Malformed score feed');
            const result = {json: data, observedAt: clock()};
            cache.set(url, {data: result, attemptAt: now, nextAt: clock() + ttl, failures: 0});
            return result;
        } catch (error) {
            if (!error?.hostBackoffRecorded) requestPolicy.observe(error?.status, error?.retryAfter, clock());
            const failures = Math.min((old?.failures || 0) + 1, 5);
            cache.set(url, {data: null, attemptAt: now, nextAt: clock() + Math.min(300000, 30000 * 2 ** (failures - 1)), failures});
            return null;
        }
    }
    async function collect() {
        const now = clock(), days = utcDates(now), wanted = leagues(), jobs = [];
        remaining = REQUESTS_PER_TICK; coldRequests = 0; deadline = now + 20000;
        const previous = new Date(now - 24 * H).toISOString().slice(0,10).replaceAll('-', '');
        const queryDays = [days[0], previous, ...days.slice(1)];
        const catalog = store.catalog(), known = new Map(catalog.map(g => [g.id, g]));
        const hot = new Set();
        for (const g of catalog) {
            const source = /^espn:([^:]+):/.exec(g.id)?.[1];
            if (!source) continue;
            const state = store.latest(g.id)?.data;
            const nearStart = Math.abs(g.start - now) <= H && !['finished','cancelled','postponed'].includes(state?.state);
            const inPlay = state?.state === 'live' || state?.state === 'suspended' || (state?.state === 'break' && state.breakLabel !== 'Stumps');
            const maxAge = g.league === 'Cricket' ? ({t20:4.5,odi:9,'list-a':9,test:120,'first-class':120})[g.format] || 12 : 24;
            if (!nearStart && !(inPlay && now - g.start <= maxAge * H)) continue;
            hot.add(`${source}|${days[0]}`);
            const startDay = new Date(g.start).toISOString().slice(0,10).replaceAll('-', '');
            if (nearStart && g.start > now) hot.add(`${source}|${startDay}`);
            if (g.league !== 'Cricket' && inPlay && startDay === previous) hot.add(`${source}|${previous}`);
        }
        function add(league, source, date) {
            const url = `${espn.BASE}${source}/scoreboard?dates=${date}&limit=1000`;
            jobs.push({league,source,date,url,hot:hot.has(`${source}|${date}`)});
        }
        for (const league of wanted) {
            if (league === 'Cricket') continue;
            for (const source of [fixtures.ESPN_LEAGUE_PATHS[league]].flat().filter(Boolean)) for (const date of queryDays) add(league, source, date);
        }
        if (wanted.has('Cricket')) {
            const series = new Set();
            const discoveryDays = days.slice().sort((a,b) => (cache.get(`${espn.BASE}cricket/scorepanel?dates=${a}`)?.attemptAt || 0) - (cache.get(`${espn.BASE}cricket/scorepanel?dates=${b}`)?.attemptAt || 0));
            for (const date of discoveryDays) {
                const panel = await read(`${espn.BASE}cricket/scorepanel?dates=${date}`, 900000, {cold:true,maxCold:hot.size ? CATALOG_RESERVE : Infinity});
                if (!Array.isArray(panel?.json.scores)) continue;
                for (const block of panel.json.scores) for (const l of Array.isArray(block?.leagues) ? block.leagues : []) {
                    if (/^\d{1,12}$/.test(String(l?.id))) series.add(String(l.id));
                }
            }
            // Retain already-discovered series when discovery is partial, throttled or temporarily unavailable.
            for (const g of catalog) if (g.league === 'Cricket') {
                const seriesId = /^espn:cricket\/(\d+):/.exec(g.id)?.[1];
                if (seriesId) series.add(seriesId);
            }
            for (const seriesId of [...series].slice(0,40)) for (const date of queryDays) add('Cricket', `cricket/${seriesId}`, date);
        }
        // Rotate least-recently-attempted URLs within each class; reserve cold progress below.
        jobs.sort((a,b) => Number(b.hot)-Number(a.hot) || (cache.get(a.url)?.attemptAt || 0)-(cache.get(b.url)?.attemptAt || 0)
            || queryDays.indexOf(a.date)-queryDays.indexOf(b.date));
        const candidates = new Map(), processed = new Map();
        async function runJobs(batch, maxCold = Infinity) {
            let index = 0;
            async function worker() {
                while (index < batch.length && !stopped && clock() < deadline) {
                    const job = batch[index++];
                    const existing = cache.get(job.url);
                    if (job.hot && existing?.data) existing.nextAt = Math.min(existing.nextAt, existing.data.observedAt + 30000);
                    const data = await read(job.url, job.hot ? 30000 : 900000, {cold:!job.hot,maxCold});
                    if (stopped || !Array.isArray(data?.json.events) || processed.get(job.url) === data.observedAt) continue;
                    processed.set(job.url, data.observedAt);
                    for (const game of espn.normalize(data.json, job.league, job.source)) {
                        const priority = queryDays.indexOf(job.date), old = candidates.get(game.id);
                        if (!old || priority < old.priority) candidates.set(game.id, {game,priority,observedAt:data.observedAt});
                    }
                }
            }
            await Promise.all([worker(),worker()]);
        }
        const coldJobs = jobs.filter(job => !job.hot), hotJobs = jobs.filter(job => job.hot);
        // Reserve catalog progress even with more hot sources than the entire request ceiling.
        // Discovery counts toward the reservation; spare capacity returns to cold work afterward.
        await runJobs(coldJobs, hotJobs.length ? CATALOG_RESERVE : Infinity);
        await runJobs(hotJobs);
        if (remaining > 0) await runJobs(coldJobs);
        if (!stopped) {
            const entries = [...candidates.values()].filter(e => !known.has(e.game.id) || e.observedAt > known.get(e.game.id).observedAt);
            if (entries.length) store.ingestBatch(entries);
            store.prune(clock());
        }
        for (const [key,value] of cache) if (value.nextAt < clock() - H) cache.delete(key);
    }
    return {
        refresh() {
            if (stopped || !isEnabled()) return Promise.resolve();
            if (!running) running=collect().finally(()=>{running=null;});
            return running;
        },
        start() {
            if (timer || !isEnabled() || stopped) return;
            const tick=()=>this.refresh().catch(()=>{});
            tick();timer=setInterval(tick,30000);timer.unref();
        },
        stop() {stopped=true;controller.abort();clearInterval(timer);timer=null;}
    };
}
let runtime=null;
const stores=new WeakMap();
function store() {
    const db=require('../db/sqlite').getDb();
    if(!stores.has(db)) stores.set(db,createStore(db));
    return stores.get(db);
}
function start() { if(enabled() && !runtime) {runtime=createCollector({store:store()});runtime.start();} }
function stop() {runtime?.stop();runtime=null;require('./sportsDashboardResponse').close();}
module.exports={enabled,localDay,timezone,matchBroadcasts,buildDashboard,createCollector,store,start,stop,response: options => require('./sportsDashboardResponse').response(options)};
