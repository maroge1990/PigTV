/** Opt-in dashboard foundation. Network collection is separate from requests and ordinary sport classification. */
const classify = require('./sportsClassify');
const fixtures = require('./sportsFixtures');
const espn = require('./sportsScoresEspn');
const { createStore } = require('./sportsDashboardStore');
const H = 3600000;
const enabled = () => process.env.PIGTV_SPORTS_DASHBOARD === '1';
function localDay(ms, timezone) {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(ms);
    const value=type=>parts.find(p=>p.type===type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}
function timezone() {
    const zone=process.env.TZ || 'Australia/Melbourne';
    try { localDay(Date.now(),zone);return zone; } catch { return 'Australia/Melbourne'; }
}
const norm = v => classify.parseSide(v)?.tokens.join(' ') || '';
function sameGame(game,event) {
    if(event.kind && event.kind!=='event' || game.league!==event.league) return false;
    if(!Number.isFinite(event.start) || !Number.isFinite(event.end)) return false;
    if(game.league==='Cricket') {
        if(event.end<=game.start || event.start>(game.end || game.start+5*24*H)) return false;
        const namedFormat=/\b(test|odi|t20i?|first.class|list a)\b/i.exec(event.title);
        if(namedFormat && game.format) {
            const format=({'t20i':'t20','first class':'first-class','list a':'list-a'})[namedFormat[1].toLowerCase()] || namedFormat[1].toLowerCase();
            if(format!==game.format) return false;
        }
    } else if(event.end<game.start || Math.abs(event.start-game.start)>90*60000) return false;
    // Use the canonical cleaned title, not an alias which may have been wrongly merged into this event.
    if(game.league==='F1') {
        const parsed=classify.parseTitle(event.title), expected=classify.parseTitle(game.title);
        const session=classify.parseTitle(game.session).session;
        return Boolean(parsed.session && session && parsed.session.id===session.id && expected.location.length &&
            parsed.location.length && classify.locationMatch(parsed.location,expected.location));
    }
    const pair=classify.parseMatchup(event.title);
    if(!pair || game.competitors.length!==2) return false;
    const side=(team,p)=>team.aliases.some(a=>norm(a)===p.tokens.join(' '));
    return side(game.competitors[0],pair[0])&&side(game.competitors[1],pair[1]) || side(game.competitors[0],pair[1])&&side(game.competitors[1],pair[0]);
}
function matchBroadcasts(games,events) {
    const found=new Map(games.map(g=>[g.id,[]]));
    for(const event of events) {
        const candidates=games.filter(g=>sameGame(g,event));
        if(candidates.length===1) found.get(candidates[0].id).push(event);
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
function buildDashboard(store,{now=Date.now(),userId,league=null,events=[],leagues=null,follow=null,timezone:zone=timezone()}={}) {
    const prefs=store.preferences(userId),today=localDay(now,zone);
    // All catalog entries participate in ambiguity checks, even when filtered out of the requested view.
    const catalog=store.catalog(),matches=matchBroadcasts(catalog,events),games=[];
    for(const g of catalog) {
        if(league && league!==g.league || leagues && !leagues.has(g.league)) continue;
        if(follow && !follow.some(k=>classify.canonicalLeague(k)===g.league)) {
            const teams=follow.map(classify.teamFollow).filter(t=>t?.league===g.league);
            if(teams.length && !teams.some(t=>g.competitors.some(c=>c.aliases.some(a=>norm(a)===norm(t.team))))) continue;
        }
        const selected=store.delayed(g.id,now,prefs.scoreDelaySeconds),current=store.latest(g.id);
        const at=selected?.observedAt ?? null;
        const fresh=at!==null && now-at <= prefs.scoreDelaySeconds*1000+120000;
        const state=selected?.data.state || 'unknown';
        const ongoing=['live','break','suspended'].includes(state);
        const horizon=league ? now+72*H : Infinity;
        const recent=state==='finished' && g.finishedAt!==null && now<g.finishedAt+prefs.scoreDelaySeconds*1000+H;
        if(state==='finished' && !recent) continue;
        if(g.start>horizon || (!league && localDay(g.start,zone)!==today && !ongoing && !recent)) continue;
        if(g.start<now-8*24*H || (g.start<now-12*H && !ongoing && !recent && (!g.end || g.end<now))) continue;
        const airings=matches.get(g.id),terminal=['finished','cancelled','postponed'].includes(current?.data.state);
        const liveChannels=terminal ? [] : channelsFor(airings,now);
        const channels=liveChannels.length ? liveChannels : terminal ? [] : channelsFor(airings,now,true);
        const scheduled=g.start>now && (state==='scheduled' || (!selected && current?.data.state==='scheduled'));
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
function createCollector({store,fetchJson=espn.fetchJson,leagues=()=>fixtures.neededLeagues(),clock=Date.now,enabled:isEnabled=enabled}={}) {
    let running=null,timer=null,stopped=false;
    const cache=new Map(),controller=new AbortController();
    async function read(url,ttl) {
        if(stopped) return null;
        const old=cache.get(url),now=clock();
        if(old && now<old.nextAt) return old.data;
        try {
            const data=await fetchJson(url,{signal:controller.signal});
            if(!(url.includes('/scorepanel?') ? Array.isArray(data?.scores) : Array.isArray(data?.events))) throw new Error('Malformed score feed');
            const result={json:data,observedAt:clock()};
            cache.set(url,{data:result,nextAt:clock()+ttl,failures:0});
            return result;
        } catch {
            const failures=(old?.failures || 0)+1;
            // Never return a last-good payload as a NEW observation after an outage.
            cache.set(url,{data:null,nextAt:clock()+Math.min(300000,30000*2**(failures-1)),failures});
            return null;
        }
    }
    async function collect() {
        const now=clock(),days=utcDates(now),wanted=leagues(),jobs=[];
        const previous=new Date(now-24*H).toISOString().slice(0,10).replaceAll('-','');
        const queryDays=[days[0],previous,...days.slice(1)];
        for(const league of wanted) {
            if(league==='Cricket') continue;
            const paths=[fixtures.ESPN_LEAGUE_PATHS[league]].flat().filter(Boolean);
            for(const source of paths) for(const date of queryDays) jobs.push({league,source,date});
        }
        if(wanted.has('Cricket')) {
            const series=new Set();
            for(const date of days) {
                const panel=await read(`${espn.BASE}cricket/scorepanel?dates=${date}`,900000);
                if(!Array.isArray(panel?.json.scores)) continue;
                for(const block of panel.json.scores) for(const l of Array.isArray(block?.leagues)?block.leagues:[]) {
                    if(/^\d{1,12}$/.test(String(l?.id))) series.add(String(l.id));
                }
            }
            for(const seriesId of [...series].slice(0,40)) for(const date of queryDays) jobs.push({league:'Cricket',source:`cricket/${seriesId}`,date});
        }
        jobs.sort((a,b)=>queryDays.indexOf(a.date)-queryDays.indexOf(b.date));
        let index=0;
        const candidates=new Map(),deadline=clock()+20000;
        // Two requests at once, off the request/playback path. Requests have bounded body and timeout.
        async function worker() {
            while(index<jobs.length && !stopped && clock()<deadline) {
                const {league,source,date}=jobs[index++];
                const url=`${espn.BASE}${source}/scoreboard?dates=${date}&limit=1000`;
                const data=await read(url,[days[0],previous].includes(date)?30000:900000);
                if(stopped || !Array.isArray(data?.json.events)) continue;
                for(const game of espn.normalize(data.json,league,source)) {
                    const priority=queryDays.indexOf(date),old=candidates.get(game.id);
                    if(!old || priority<old.priority) candidates.set(game.id,{game,priority,at:data.observedAt});
                }
            }
        }
        await Promise.all([worker(),worker()]);
        if(!stopped) {
            for(const {game,at} of candidates.values()) store.ingest([game],at);
            store.prune(clock());
        }
        for(const [key,value] of cache) if(value.nextAt<clock()-H) cache.delete(key);
    }
    return {
        refresh() {
            if(stopped || !isEnabled()) return Promise.resolve();
            if(!running) running=collect().finally(()=>{running=null;});
            return running;
        },
        start() {
            if(timer || !isEnabled() || stopped) return;
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
function stop() {runtime?.stop();runtime=null;}
module.exports={enabled,localDay,timezone,matchBroadcasts,buildDashboard,createCollector,store,start,stop};
