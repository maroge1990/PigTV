/** Opt-in dashboard foundation. Network collection is separate from requests and ordinary sport classification. */
const classify = require('./sportsClassify');
const fixtures = require('./sportsFixtures');
const espn = require('./sportsScoresEspn');
const { createStore } = require('./sportsDashboardStore');
const { overrunEnd } = require('./sportOverrun');
const onAir = require('./sportOnAir');
const { isCricket, CRICKET_GROUPS, OTHER_CRICKET } = require('./sportCatalog');
const { cricketGroupOf } = require('./sportsFixturesEspn');
const { isTournament } = require('./sportGroups');
// #196: motorsport follows riders and drivers, who race in every session; F1 and MotoGP cards are sessions (joined by
// session and place), a Supercars card the event weekend. #197: a tennis or golf tournament, a UFC night and an IndyCar
// or NASCAR race are one card each too (sportIndividual.js), joined like a Supercars weekend.
const individual = require('./sportIndividual');
const MOTOR = new Set(['F1', 'MotoGP', 'Supercars', 'IndyCar', 'NASCAR']);
const SESSIONS = new Set(['F1', 'MotoGP']);
const WEEKENDS = new Set(['Supercars', ...Object.keys(individual.LEAGUES)]);
const feeds = require('./sportFeeds');
// The words that name an event: its title's and its town's, without the year, numbers, sponsors' common words and the
// series' own. A tour's events share words ("Open", "Masters", "Championship") the majors are named by: a major keeps them.
const WEEKEND_STOP = new Set(['supercars', 'repco', 'itm', 'bp', 'super', 'sprint', 'supersprint', 'grand', 'final', 'the', 'at', 'and', 'race', 'oil', 'power', 'tools',
    'batteries', 'mobile', 'boost', 'nsw', 'vic', 'qld', 'sa', 'wa', 'tas', 'nt', 'nz', 'act', 'triple', 'crown', 'cup',
    'nascar', 'series', 'indycar', 'prix', 'speedway', 'ufc', 'fight', 'night', 'tennis', 'golf', 'tour', 'presented', 'with']);
const TOUR_STOP = new Set(['open', 'masters', 'championship', 'championships', 'classic', 'invitational', 'international', 'finals', 'ladies',
    'womens', 'mens', 'rolex', 'pga', 'lpga', 'atp', 'wta', 'liv', 'world', 'stroke', 'play', 'tournament']);
const MAJORS = new Set(['Grand Slams', 'Majors']);
// 0407 (0406 Codex round 1, high): a UFC night or a race is named by its title alone (fighters, number, track): its city
// hosts other nights and races ("Las Vegas").
const TITLE_ONLY = new Set(['UFC', 'IndyCar', 'NASCAR']);
function weekendWords(game) {
    const words = classify.normText(`${game.title} ${TITLE_ONLY.has(game.league) ? '' : game.circuit?.city || ''}`).split(' ');
    // a UFC night is often aired by its number alone ("UFC 334")
    const number = game.league === 'UFC' ? words.filter(w => /^\d{3}$/.test(w)) : [];
    return [...new Set([...number, ...words.filter(w => w.length >= 4 && !/^\d+$/.test(w) && !WEEKEND_STOP.has(w)
        && (MAJORS.has(game.league) || !individual.has(game.league) || !TOUR_STOP.has(w)))])];
}
const H = 3600000;
const BREAK_POLL = 5 * 60000; // 0407: how often a tournament between matches or rounds is asked again
// 0381 (D-39): the score collector runs by default (PIGTV_SPORTS_DASHBOARD=0 turns it off) whenever ESPN fixtures are on,
// for the Sport front page; the legacy /dashboard and /preferences routes stay opt-in (=1) for the current Apple app.
const collectorEnabled = () => process.env.PIGTV_SPORTS_DASHBOARD !== '0' && fixtures.enabled();
const dashboardEnabled = () => process.env.PIGTV_SPORTS_DASHBOARD === '1';
const enabled = dashboardEnabled;
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
// 0404 (#206): MotoGP's sessions as its own feed names them. F1's reader folds "Qualifying 1" and "2" into one (they are
// 25 minutes apart, so the window can't tell them apart) and reads "Grand Prix - Warm Up" as the race.
const MOTOGP_QUALIFYING_RE = /(?:^| )(?:qualifying|q) ?([12])(?= |$)/;
const MOTOGP_WARM_UP_RE = /(?:^| )warm ?up(?= |$)/;
function sessionTitle(league, text) {
    const parsed = classify.parseTitle(text);
    if (league !== 'MotoGP') return parsed;
    const q = MOTOGP_QUALIFYING_RE.exec(parsed.norm);
    const session = q ? { id: `qualifying ${q[1]}`, label: `Qualifying ${q[1]}` }
        : MOTOGP_WARM_UP_RE.test(parsed.norm) ? { id: 'warm up', label: 'Warm Up' } : parsed.session;
    return { ...parsed, session, location: parsed.location.filter(w => !['warm', 'up', 'warmup'].includes(w) && !/^q\d$/.test(w)) };
}
function prepareGame(game) {
    return { game, sides: game.competitors.map(t => new Set(t.aliases.map(norm))),
        title: SESSIONS.has(game.league) ? sessionTitle(game.league, game.title) : null,
        session: SESSIONS.has(game.league) ? sessionTitle(game.league, game.session).session : null };
}
function prepareEvent(event) {
    // #231: the merged event's display title can be one listing's wording (RDS's "Jaguars de Jacksonville"); its other
    // listings' titles (aliases) may name the teams as ESPN does. Each distinct pair is tried.
    const titles = [event.title, ...(Array.isArray(event.aliases) ? event.aliases.slice(0, 20) : [])];
    const pairs = [], seen = new Set();
    for (const t of titles) {
        const pair = typeof t === 'string' ? classify.parseMatchup(t) : null;
        const key = pair && pair.map(side => side.tokens.join(' ')).join('\u0001');
        if (pair && !seen.has(key)) { seen.add(key); pairs.push(pair); }
    }
    return { event, pair: pairs[0] || null, pairs,
        title: SESSIONS.has(event.league) ? sessionTitle(event.league, event.title) : null,
        format: /\b(test|odi|t20i?|first.class|list a)\b/i.exec(event.title)?.[1]?.toLowerCase() };
}
function sameGame(prepared, parsed) {
    const { game } = prepared, { event } = parsed;
    if ((event.kind && event.kind !== 'event') || game.league !== event.league) return false;
    if (!Number.isFinite(event.start) || !Number.isFinite(event.end)) return false;
    if (isCricket(game.league)) {
        const maximum = ({ t20: 4.5, odi: 9, 'list-a': 9, test: 120, 'first-class': 120 })[game.format] || 12;
        const limit = game.start + maximum * H;
        const end = limit; // Cricket endDate is an envelope in the captures, not trusted match duration.
        if (event.end <= game.start || event.start >= end) return false;
        if (parsed.format && game.format) {
            const format = ({ t20i: 't20', 'first class': 'first-class', 'list a': 'list-a' })[parsed.format] || parsed.format;
            if (format !== game.format) return false;
        }
    } else if (WEEKENDS.has(game.league)) {
        // #196: a Supercars card is the whole event weekend (no session times are published): an airing inside it joins
        // when it names the event's track or town (0403, Codex round 1: never another round's replay, nor a bare title).
        if (!(Number.isFinite(game.end) && event.start < game.end && event.end > game.start)) return false;
        const said = ` ${classify.normText(event.title)} `;
        const words = weekendWords(game);
        if (individual.has(game.league)) {
            // 0407 (0406 Codex round 1, high): never a replay or highlights, and a fight that names its two fighters must be
            // this night's: each side a name on its title
            const p = classify.parseTitle(event.title);
            if (p.replayWord || p.highlightsWord) return false;
            if (game.league === 'UFC' && p.teams && !p.teams.every(side => side.tokens.some(t => words.includes(t)))) return false;
            // 0408 (0407 Codex round 2, medium): a race card is the race: an airing naming another session never joins it
            if (game.session === 'Race' && p.session && p.session.id !== 'race') return false;
        }
        return words.some(w => said.includes(` ${w} `));
    } else if (event.end < game.start || Math.abs(event.start - game.start) > 90 * 60000) return false;
    if (SESSIONS.has(game.league)) {
        return Boolean(parsed.title.session && prepared.session && parsed.title.session.id === prepared.session.id &&
            prepared.title.location.length && parsed.title.location.length && classify.locationMatch(parsed.title.location, prepared.title.location));
    }
    if (prepared.sides.length !== 2) return false;
    return (parsed.pairs || (parsed.pair ? [parsed.pair] : [])).some(pair => {
        const a = pair[0].tokens.join(' '), b = pair[1].tokens.join(' ');
        return (prepared.sides[0].has(a) && prepared.sides[1].has(b)) || (prepared.sides[0].has(b) && prepared.sides[1].has(a));
    });
}
function matchBroadcasts(games, events, represented = new Set(), unresolved = new Set(), endedAt = new Map()) {
    const found = new Map(games.map(g => [g.id, []])), byLeague = new Map();
    for (const game of games) {
        if (!byLeague.has(game.league)) byLeague.set(game.league, []);
        byLeague.get(game.league).push(prepareGame(game));
    }
    for (const event of events) {
        if (event.kind && event.kind !== 'event') continue;
        const parsed = prepareEvent(event);
        const candidates = (byLeague.get(event.league) || []).filter(g => sameGame(g, parsed));
        // Mark even ambiguous/terminal candidates as represented. A fallback must not bypass
        // conservative joins or revive a final after its delayed retention expires.
        const leagueGames = byLeague.get(event.league) || [];
        // Unknown-format cricket may be a later day OR a rematch. Keep the guide listing visible,
        // but never let fallback turn an uncertain identity into wider playback permission (L2).
        if (!candidates.length && isCricket(event.league) && leagueGames.some(g => !g.game.format &&
            event.start >= g.game.start && event.start < g.game.start + 120*H &&
            sameGame(prepareGame({...g.game,start:event.start}),parsed))) unresolved.add(event.id);
        // Short-format windows normally decide the join. For cricket only, use a clearly nearest start
        // if a broad listing overlaps multiple games; ties and near-ties remain unmatched.
        if (candidates.length > 1 && isCricket(event.league)) {
            candidates.sort((a, b) => Math.abs(a.game.start - event.start) - Math.abs(b.game.start - event.start));
            const first = Math.abs(candidates[0].game.start - event.start), second = Math.abs(candidates[1].game.start - event.start);
            if (second - first >= H) candidates.splice(1);
        }
        // A later programme can be a new same-team game missing from the partial catalog.
        // Use only eligible delayed completion, never latest/raw completion or endDate. Without an
        // observed transition, a different later-starting guide window stays an uncertain listing.
        if (candidates.length && candidates.every(g => endedAt.has(g.game.id) &&
            (endedAt.get(g.game.id)===null ? event.start>g.game.start : event.start>=endedAt.get(g.game.id)))) {
            unresolved.add(event.id);
            continue;
        }
        if (candidates.length) represented.add(event.id);
        if (candidates.length === 1) found.get(candidates[0].game.id).push(event);
    }
    return found;
}
// #191 (0386): `ongoing` (the card's projected status is live, break or suspended) applies the overrun rule
// (sportOverrun.js): a channel whose airing of the game has ended within OVERRUN_MAX is projected as still airing,
// `overrun: true` with its end rolled on. `ended` are the game's matched airings that have already ended.
function channelsFor(events, now, includeUpcoming=false, times=false, ongoing=false, ended=[]) {
    const seen=new Set(),out=[];
    // C-I live is stamped when its per-minute cache is built; eligibility uses current airing bounds.
    const current=events.filter(e=>(e.start<=now && now<e.end) || (includeUpcoming && e.start>now));
    const over=new Map(ongoing ? [...events,...ended].filter(e=>e.end<=now).map(e=>[e.id,e]) : []);
    for(const event of [...current,...over.values()]) {
        const gone=event.end<=now;
        for(const c of event.channels || []) {
            const key=`${c.sourceId}:${c.stableId || c.id}`;
            if(seen.has(key)) continue;
            const extended=overrunEnd(Number.isFinite(c.end) ? c.end : event.end,ongoing,now);
            if(gone && extended===null) continue; // an ended airing counts only while the overrun rule extends it
            seen.add(key);
            // Explicit projection: no upstream URL, alias prose, internal fields or credentials reach the client.
            out.push({sourceId:c.sourceId,id:c.id,stableId:c.stableId || null,name:c.name,number:c.number || null,logo:c.logo || null,quality:c.quality || null,
                // 0381: the channel's own airing bounds (C-I), only when asked for (the front page).
                ...(times ? {start:Number.isFinite(c.start) ? c.start : null,end:extended ?? (Number.isFinite(c.end) ? c.end : null)} : {}),
                ...(extended!==null ? {overrun:true} : {})});
        }
    }
    return out;
}
// Football period 5 is the shoot-out: with spoilers hidden it reveals a draw, so penalties are never projected.
function progressFor(game,progress,hidden) {
    if(!hidden || !game.id.startsWith('espn:soccer/') || !(progress.period>=5)) return progress;
    const {period,...rest}=progress;
    return rest;
}
// 0381 (D-39): which followed names (teams[league]) a card's competitors are. F1: a followed driver races in every session.
// #197: a card that lists its players (a draw, field, fight card or entry list) is followed only for the names in it; a
// motorsport card without one (MotoGP, Supercars) for every name no other series lists (`listedBy`: name -> leagues),
// since the sport's names are one list under each of its leagues.
function followMatchesFor(g,teams,listedBy=new Map()) {
    const names=(teams?.[g.league] || []).filter(n=>typeof n==='string' && n);
    if(!names.length) return [];
    if(Array.isArray(g.players)) {
        const listed=new Set(g.players.map(individual.personKey));
        return names.filter(name=>listed.has(individual.personKey(name))).map(name=>({name,competitor:null}));
    }
    if(MOTOR.has(g.league)) return names.filter(name=>![...(listedBy.get(individual.personKey(name)) || [])].some(l=>l!==g.league))
        .map(name=>({name,competitor:null}));
    const out=[];
    for(const name of names) {
        const wanted=norm(name);
        if(!wanted) continue;
        const competitor=g.competitors.findIndex(c=>[c.name,...(c.aliases || [])].some(a=>typeof a==='string' && norm(a)===wanted));
        if(competitor>=0) out.push({name,competitor});
    }
    return out;
}
// #197: which motorsport series list each driver or rider (by personKey) in the catalogue's entry lists.
function driversListed(catalog) {
    const out=new Map();
    for(const g of catalog) if(MOTOR.has(g.league) && Array.isArray(g.players)) for(const name of g.players) {
        const key=individual.personKey(name);
        if(!out.has(key)) out.set(key,new Set());
        out.get(key).add(g.league);
    }
    return out;
}
// #218: a weekly league (NFL, AFL, EPL...) with nothing on or due within the front page's `hours` shows its next round
// instead of nothing: the first game later than that (up to ROUND_AHEAD, what the collector looks ahead) and every game of
// the league within ROUND_SPAN of it. Whole-event leagues (tennis, golf, UFC, IndyCar, NASCAR) are not rounds.
const ROUND_AHEAD = 14 * 24 * H, ROUND_SPAN = 4 * 24 * H;
function nextRounds(catalog, selected, now, hours) {
    const byLeague = new Map(), out = new Set();
    for (const g of catalog) {
        if (individual.has(g.league)) continue;
        if (!byLeague.has(g.league)) byLeague.set(g.league, []);
        byLeague.get(g.league).push(g);
    }
    for (const list of byLeague.values()) {
        const state = g => selected.get(g.id)?.data.state || 'unknown';
        const open = g => ['scheduled', 'unknown'].includes(state(g));
        if (list.some(g => ['live', 'break', 'suspended'].includes(state(g)) || (open(g) && g.start > now - 12 * H && g.start <= now + hours * H))) continue;
        const later = list.filter(g => open(g) && g.start > now + hours * H && g.start <= now + ROUND_AHEAD).sort((a, b) => a.start - b.start);
        for (const g of later) if (g.start <= later[0].start + ROUND_SPAN) out.add(g.id);
    }
    return out;
}
// #223: a followed team with nothing on or due within the front page's `hours` shows its own next game, however far ahead
// (the collector reads it from the team's schedule, teamsAhead), as a next-round card: a team on a bye, or whose league
// has games inside the window (so no next round, nextRounds) but not its own. Whole-event leagues and motorsport are not
// teams. `teams` as buildDashboard's (league -> names).
function followNext(catalog, selected, now, hours, teams) {
    const out = new Set();
    const state = g => selected.get(g.id)?.data.state || 'unknown';
    const open = g => ['scheduled', 'unknown'].includes(state(g));
    for (const [league, names] of Object.entries(teams || {})) {
        if (individual.has(league) || MOTOR.has(league) || !Array.isArray(names)) continue;
        const list = catalog.filter(g => g.league === league);
        for (const name of names) {
            const own = list.filter(g => followMatchesFor(g, { [league]: [name] }).length);
            if (own.some(g => ['live', 'break', 'suspended'].includes(state(g)) || (open(g) && g.start > now - 12 * H && g.start <= now + hours * H))) continue;
            const next = own.filter(g => open(g) && g.start > now + hours * H).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))[0];
            if (next) out.add(next.id);
        }
    }
    return out;
}
// Front-page options (0381), all off for /dashboard: keepFinishedToday keeps today's finals, `teams` marks followed
// cards, `spoilerFree` (the household switch) overrides the account's avoidSpoilers, channelTimes projects airing bounds,
// upcomingHours keeps what starts within that many hours whatever its local day (tomorrow's fixtures; 0382).
// guideCards (#194, D-41): false makes the fixture the only source of games, the guide only adding channels to them.
// nations (#195, D-41): the International groups in which the account follows a nation: there, a game that is not a
// tournament's shows only when a followed name plays in it (sportGroups.js).
/** The ESPN cricket series a fixed league owns (BBL, WBBL, Sheffield Shield...): never an International group's (#195). */
const fixedCricketSeries = () => new Set(Object.values(fixtures.ESPN_LEAGUE_PATHS).flat()
    .filter(p => typeof p === 'string' && p.startsWith('cricket/')).map(p => p.slice(8)));
/**
 * #212 (server 0451): an International group card from a fixed league's series, stored by a build before 0435. The group
 * never reads those series again, so nothing corrects it: never shown, and the collector forgets it.
 */
function strayGroupCard(g, fixed = fixedCricketSeries()) {
    return CRICKET_GROUPS.includes(g.league) && fixed.has(/^espn:cricket\/(\d+):/.exec(g.id)?.[1]);
}

function buildDashboard(store,{now=Date.now(),userId,league=null,events=[],leagues=null,follow=null,broadLeagues=new Set(),timezone:zone=timezone(),
    keepFinishedToday=false,teams=null,spoilerFree,channelTimes=false,upcomingHours=0,endedEvents=[],guideCards=true,nations=[]}={}) {
    const narrowed=new Set(nations);
    const prefs=store.preferences(userId),today=localDay(now,zone);
    const hidden=typeof spoilerFree==='boolean' ? spoilerFree : prefs.avoidSpoilers;
    const followMatches=teams ? {} : null;
    // All catalog entries participate in ambiguity checks, even when filtered out of the requested view.
    const view=store.view(now,prefs.scoreDelaySeconds);
    const endedAt=new Map([...view.selected].filter(([,s])=>s.data.state==='finished')
        .map(([id,s])=>[id,s.finishedAt===null ? null : s.finishedAt+prefs.scoreDelaySeconds*1000]));
    const catalog=view.catalog,listedBy=driversListed(catalog),represented=new Set(),unresolved=new Set(),matches=matchBroadcasts(catalog,events,represented,unresolved,endedAt),games=[];
    // #191: airings that have already ended (sportsEvents.endedEvents), joined exactly as the current ones but on their own,
    // so they never change a card's `events`, nor which guide listings count as represented or unresolved.
    const endedMatches=matchBroadcasts(catalog,endedEvents.filter(e=>e.end<=now),new Set(),new Set(),endedAt);
    const rounds=upcomingHours>0 && !league ? new Set([...nextRounds(catalog,view.selected,now,upcomingHours),...followNext(catalog,view.selected,now,upcomingHours,teams)]) : new Set();
    const fixedSeries=fixedCricketSeries();
    for(const g of catalog) {
        if(league && league!==g.league || leagues && !leagues.has(g.league) || strayGroupCard(g,fixedSeries)) continue;
        if(narrowed.has(g.league) && !isTournament(g) && !followMatchesFor(g,teams,listedBy).length) continue;
        if(follow && !broadLeagues.has(g.league) && !follow.some(k=>classify.canonicalLeague(k)===g.league)) {
            const teams=follow.map(classify.teamFollow).filter(t=>t?.league===g.league);
            if(teams.length && !teams.some(t=>g.competitors.some(c=>c.aliases.some(a=>norm(a)===norm(t.team))))) continue;
        }
        const selected=view.selected.get(g.id);
        const at=selected?.observedAt ?? null;
        // 0407 (0406 Codex round 1, medium): a tournament between matches or rounds is polled every BREAK_POLL, not hot:
        // its break stays fresh that long (plus the usual two minutes).
        const allowance=individual.has(g.league) && selected?.data.state==='break' ? BREAK_POLL+120000 : 120000;
        const fresh=at!==null && now-at <= prefs.scoreDelaySeconds*1000+allowance;
        const state=selected?.data.state || 'unknown';
        const ongoing=['live','break','suspended'].includes(state);
        const airings=matches.get(g.id);
        const onGuide=airings.some(e=>e.start<=now && now<e.end);
        // A just-started cross-midnight game must not vanish while delayed history is unknown.
        // Keep neutral pending cards within conservative sport bounds; never inspect an undelayed final.
        const pendingHours=isCricket(g.league) ? ({t20:4.5,odi:9,'list-a':9,test:120,'first-class':120})[g.format] || 12 : 12;
        const pending=['unknown','scheduled'].includes(state) && g.start<=now && now-g.start<=pendingHours*H;
        const horizon=league ? now+72*H : Infinity;
        const recent=state==='finished' && selected.finishedAt!==null && now<selected.finishedAt+prefs.scoreDelaySeconds*1000+H;
        // A final from today stays on the front page with its (delayed) result, however long ago it ended.
        const finalToday=keepFinishedToday && state==='finished' && localDay(g.start,zone)===today;
        if(state==='finished' && !recent && !finalToday) continue;
        const upcoming=upcomingHours>0 && ['scheduled','unknown'].includes(state) && g.start>now && g.start<=now+upcomingHours*H;
        // #197: a tournament spans days: it is today's on every day it runs, whatever day it began.
        const running=individual.has(g.league) && Number.isFinite(g.end) && g.start<=now && now<g.end && !['finished','cancelled','postponed'].includes(state);
        const nextRound=rounds.has(g.id);
        if(g.start>horizon || (!league && localDay(g.start,zone)!==today && !ongoing && !recent && !pending && !onGuide && !upcoming && !running && !nextRound)) continue;
        if(g.start<now-8*24*H && !running || (g.start<now-12*H && !ongoing && !recent && !finalToday && !pending && !onGuide && (!g.end || g.end<now))) continue;
        const terminal=['finished','cancelled','postponed'].includes(state);
        const shown=fresh || finalToday; // a final does not go stale
        const scheduled=g.start>now && (state==='scheduled' || !selected);
        const projectedState=scheduled ? 'scheduled' : finalToday ? 'finished' : !fresh ? 'unknown' : state;
        // #191: only the status this card reports (delayed, eligible, fresh) extends an overrunning airing.
        const extend=!terminal && ['live','break','suspended'].includes(projectedState);
        const liveChannels=terminal ? [] : channelsFor(airings,now,false,channelTimes,extend,endedMatches.get(g.id));
        const channels=liveChannels.length ? liveChannels : terminal ? [] : channelsFor(airings,now,true,channelTimes);
        const card={id:g.id,league:g.league,title:g.title,start:g.start,end:g.end,session:g.session,circuit:g.circuit,format:g.format || null,
            competitors:g.competitors.map(({id,name,logo})=>({id,name,logo})),
            status:projectedState, ...(fresh && selected.data.breakLabel ? {breakLabel:selected.data.breakLabel}:{}),
            freshness:!selected ? 'buffering' : fresh ? 'fresh' : 'stale',observedAt:at,
            progress:shown ? progressFor(g,selected.data.progress,hidden) : {},
            availability:liveChannels.length || (g.start>now && channels.length) ? 'matched' : airings.length ? 'unavailable' : 'unmatched',
            broadcastStatus:liveChannels.length ? 'on-tv' : channels.length ? 'scheduled' : 'unavailable',channels,
            // Upcoming event references retain the existing details/record workflow without inventing channels.
            events:airings.map(e=>({id:e.id,start:e.start,end:e.end})),
            canWatch:liveChannels.length>0 && !['finished','cancelled','postponed'].includes(state),...(nextRound ? {nextRound:true} : {})};
        // #203 (D-42 point 5): coverage on air with play within 30 min; status stays scheduled (sportOnAir.js).
        if(onAir.onAir({status:projectedState,start:g.start,now,airings:onAir.channelAirings(airings)})) card.onAir=true;
        if(!hidden && shown && selected.data.scores!==null) card.scores=selected.data.scores;
        if(!hidden && shown && selected.data.situation) card.situation=selected.data.situation;
        if(followMatches) {
            const found=followMatchesFor(g,teams,listedBy);
            card.followed=found.length>0;
            if(found.length) followMatches[g.id]=found;
        }
        games.push(card);
    }
    // C-I has already selected configured follows/categories. Preserve guide-only coverage,
    // including leagues without a score adapter. Never treat guide airtime as confirmed play.
    const seenGuide = new Set();
    for (const e of guideCards ? events : []) {
        if ((e.kind && e.kind !== 'event') || represented.has(e.id) || seenGuide.has(e.id) ||
            (league && league !== e.league) || !Number.isFinite(e.start) || !Number.isFinite(e.end) ||
            e.end <= now || e.end <= e.start || e.start > now+72*H) continue;
        const onNow = e.start <= now && now < e.end;
        const upcoming = upcomingHours > 0 && e.start > now && e.start <= now + upcomingHours*H;
        if (!league && localDay(e.start,zone)!==today && !onNow && !upcoming) continue;
        seenGuide.add(e.id);
        const liveChannels=unresolved.has(e.id) ? [] : channelsFor([e],now,false,channelTimes),channels=unresolved.has(e.id) ? [] : liveChannels.length ? liveChannels : channelsFor([e],now,true,channelTimes);
        games.push({id:`guide:${e.id}`,dataSource:'guide',league:e.league,
            // Guide titles are not trusted neutral team metadata. Do not expose result prose in hidden mode.
            title:hidden ? `${e.league} · Guide event` : e.title,
            start:e.start,end:e.end,session:null,circuit:null,format:null,competitors:[],
            status:e.start>now ? 'scheduled' : 'unknown',freshness:'unavailable',observedAt:null,progress:{},
            availability:unresolved.has(e.id) ? 'unmatched' : channels.length ? 'matched' : 'unavailable',
            broadcastStatus:liveChannels.length ? 'on-tv' : channels.length ? 'scheduled' : 'unavailable',
            channels,events:[{id:e.id,start:e.start,end:e.end}],canWatch:liveChannels.length>0,...(followMatches ? {followed:false} : {})});
    }
    const order={live:0,break:1,suspended:2,scheduled:3,unknown:4,postponed:5,cancelled:6,finished:7};
    games.sort((a,b)=>(order[a.status]-order[b.status]) || a.start-b.start || a.id.localeCompare(b.id));
    return {now,timezone:zone,leagues:[...new Set([...(leagues || []),...games.map(g=>classify.canonicalLeague(g.league)).filter(Boolean)])].sort(),scope:league ? 'league' : 'today',hours:league ? 72 : null,preferences:prefs,games,
        ...(followMatches ? {followMatches} : {})};
}
function utcDates(now) {
    const out=[];
    const start=new Date(now);start.setUTCHours(0,0,0,0);
    for(let d=start.getTime();d<=now+72*H;d+=24*H) out.push(new Date(d).toISOString().slice(0,10).replaceAll('-',''));
    return out;
}
const requestPolicy = require('./espnRequestPolicy');
const cost = require('./sportCollectorCost');
const REQUESTS_PER_TICK = 12;
// #218: how far ahead, and how often, a league with nothing within the 72-hour window is asked for its next round.
const AHEAD_TTL = 6 * H, AHEAD_DAYS = 11;
// #223: how often a followed team with no game ahead in the catalogue is asked for its own schedule.
const TEAM_TTL = 6 * H;
const CATALOG_RESERVE = 3;
function createCollector({store,fetchJson=espn.fetchJson,leagues=()=>fixtures.neededLeagues(),clock=Date.now,enabled:isEnabled=collectorEnabled,
    followed=()=>require('./sportPagePrefs').allTeams(),roster=league=>fixtures.teamsOf(league),
    feedGames=(league,o)=>feeds.games(league,{...o,registerImage:require('./logoCache').registerLogo}),recordFeed=fixtures.recordFeed}={}) {
    let running = null, timer = null, stopped = false, remaining = 0, deadline = 0, coldRequests = 0, current = null;
    const cache = new Map(), controller = new AbortController(), recordedFeeds = new WeakSet();
    // ESPN groups scoreboards by US Eastern date, so a game after 00:00Z is listed under the previous
    // UTC date's URL. Remember which query date returned each game and poll that one while it is hot.
    const listedOn = new Map();
    // #197: one URL can serve two leagues (ATP's feed: Grand Slams and ATP Tour): a second read while the first is in
    // flight waits for it rather than asking again.
    const inFlight = new Map();
    function read(url, ttl, options = {}) {
        if (!inFlight.has(url)) inFlight.set(url, fetchOnce(url, ttl, options).finally(() => inFlight.delete(url)));
        return inFlight.get(url);
    }
    async function fetchOnce(url, ttl, { cold = false, maxCold = Infinity, maxBytes } = {}) {
        if (stopped) return null;
        const old = cache.get(url), now = clock();
        if (old && now < old.nextAt) return old.data;
        if (remaining <= 0 || now >= deadline || requestPolicy.blocked(now) || (cold && coldRequests >= maxCold)) return null;
        remaining--;
        if (cold) coldRequests++;
        try {
            const counting = current; // #29: this tick's counters, whichever tick reads the answer
            const data = await fetchJson(url, {signal: controller.signal, ...(maxBytes ? {maxBytes} : {}), onParsed: (bytes, ms) => counting && cost.parsed(counting, bytes, ms)});
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
        const started = performance.now(), counting = current = cost.tick();
        const now = clock(), days = utcDates(now), wanted = leagues(), jobs = [];
        remaining = REQUESTS_PER_TICK; coldRequests = 0; deadline = now + 20000;
        const previous = new Date(now - 24 * H).toISOString().slice(0,10).replaceAll('-', '');
        const queryDays = [days[0], previous, ...days.slice(1)];
        const catalog = store.catalog(), known = new Map(catalog.map(g => [g.id, g]));
        for (const id of listedOn.keys()) if (!known.has(id)) listedOn.delete(id);
        const hot = new Set(), warm = new Set();
        for (const g of catalog) {
            const source = /^espn:([^:]+):/.exec(g.id)?.[1];
            if (!source) continue;
            const state = store.latest(g.id)?.data;
            const nearStart = Math.abs(g.start - now) <= H && !['finished','cancelled','postponed'].includes(state?.state);
            // #197: a tournament between matches or rounds is not polled hot (its feed is large and changes slowly).
            const inPlay = individual.has(g.league) ? state?.state === 'live'
                : state?.state === 'live' || state?.state === 'suspended' || (state?.state === 'break' && state.breakLabel !== 'Stumps');
            const maxAge = isCricket(g.league) ? ({t20:4.5,odi:9,'list-a':9,test:120,'first-class':120})[g.format] || 12 : 24;
            const inWindow = individual.has(g.league) && Number.isFinite(g.end) ? now <= g.end + H : now - g.start <= maxAge * H;
            // 0407: ...but every BREAK_POLL, so its break stays fresh and play resuming shows within minutes
            if (individual.has(g.league) && state?.state === 'break' && inWindow) warm.add(`${source}|current`);
            if (!nearStart && !(inPlay && inWindow)) continue;
            hot.add(`${source}|${days[0]}`);
            hot.add(`${source}|current`);
            const startDay = new Date(g.start).toISOString().slice(0,10).replaceAll('-', '');
            if (nearStart && g.start > now) hot.add(`${source}|${startDay}`);
            if (!isCricket(g.league) && inPlay && startDay === previous) hot.add(`${source}|${previous}`);
            if (listedOn.has(g.id)) hot.add(`${source}|${listedOn.get(g.id)}`);
        }
        function add(league, source, date) {
            // #197: tennis and golf ask for this week's events ('current'), without a date
            const url = date === 'current' ? `${espn.BASE}${source}/scoreboard` : `${espn.BASE}${source}/scoreboard?dates=${date}&limit=1000`;
            jobs.push({league,source,date,url,hot:hot.has(`${source}|${date}`),warm:warm.has(`${source}|${date}`)});
        }
        for (const league of wanted) {
            const spec = individual.LEAGUES[league];
            if (spec) { for (const date of spec.dated ? queryDays : ['current']) add(league, spec.path, date); continue; }
            if (CRICKET_GROUPS.includes(league) || feeds.has(league)) continue;
            for (const source of [fixtures.ESPN_LEAGUE_PATHS[league]].flat().filter(Boolean)) for (const date of queryDays) add(league, source, date);
        }
        // #195 (D-41): the International cricket groups take ESPN's active series by their international class; a series
        // with a fixed league (BBL, WBBL, Shield...) or none (domestic, youth) is never theirs.
        // #230: "Other cricket" takes its cards straight from this daily list (no request of its own): every match of a
        // series no fixed league owns whose own class is known and not international.
        const others = [];
        if (CRICKET_GROUPS.some(l => wanted.has(l)) || wanted.has(OTHER_CRICKET)) {
            const series = new Map(); // series id -> its group
            const fixed = fixedCricketSeries();
            const take = (id, group) => { if (group && wanted.has(group) && !fixed.has(id) && !series.has(id)) series.set(id, group); };
            const discoveryDays = days.slice().sort((a,b) => (cache.get(`${espn.BASE}cricket/scorepanel?dates=${a}`)?.attemptAt || 0) - (cache.get(`${espn.BASE}cricket/scorepanel?dates=${b}`)?.attemptAt || 0));
            for (const date of discoveryDays) {
                const panel = await read(`${espn.BASE}cricket/scorepanel?dates=${date}`, 900000, {cold:true,maxCold:hot.size ? CATALOG_RESERVE : Infinity});
                if (!Array.isArray(panel?.json.scores)) continue;
                for (const block of panel.json.scores) for (const l of Array.isArray(block?.leagues) ? block.leagues : []) {
                    if (/^\d{1,12}$/.test(String(l?.id))) take(String(l.id), cricketGroupOf(block.events));
                }
                if (wanted.has(OTHER_CRICKET)) for (const block of panel.json.scores) {
                    const id = String(block?.leagues?.[0]?.id ?? '');
                    if (!/^\d{1,12}$/.test(id) || fixed.has(id) || !Array.isArray(block.events)) continue;
                    const own = block.events.slice(0, 1000).filter(e => cricketGroupOf([e]) === null);
                    if (own.length) for (const game of espn.normalize({ leagues: block.leagues, events: own }, OTHER_CRICKET, `cricket/${id}`))
                        others.push({ game, date, observedAt: panel.observedAt });
                }
            }
            // Retain already-discovered series when discovery is partial, throttled or temporarily unavailable.
            for (const g of catalog) if (CRICKET_GROUPS.includes(g.league)) {
                const seriesId = /^espn:cricket\/(\d+):/.exec(g.id)?.[1];
                if (seriesId) take(seriesId, g.league);
            }
            for (const [seriesId, group] of [...series].slice(0,40)) for (const date of queryDays) add(group, `cricket/${seriesId}`, date);
        }
        // Rotate least-recently-attempted URLs within each class; reserve cold progress below.
        jobs.sort((a,b) => Number(b.hot)-Number(a.hot) || (cache.get(a.url)?.attemptAt || 0)-(cache.get(b.url)?.attemptAt || 0)
            || queryDays.indexOf(a.date)-queryDays.indexOf(b.date));
        const candidates = new Map(), processed = new Map();
        for (const { game, date, observedAt } of others) { // #230: today's listing first (the fresher), as the jobs below
            const priority = Math.max(0, queryDays.indexOf(date)), old = candidates.get(game.id);
            if (!old || priority < old.priority) candidates.set(game.id, { game, priority, observedAt });
        }
        const misfiled = new Map(); // #212: card id -> the International cricket group whose series listed it, not its own
        const ymd = ms => new Date(ms).toISOString().slice(0,10).replaceAll('-', '');
        const closed = state => ['finished','cancelled','postponed'].includes(state);
        // on or due: playing, or not over and starting between 12 hours ago and the end of the window
        const due = (g, state) => ['live','break','suspended'].includes(state) || (!closed(state) && g.start > now - 12 * H && g.start <= now + 72 * H);
        const later = g => ['scheduled','unknown'].includes(g.snapshot?.state) && g.start > now + 72 * H && g.start <= now + 14 * 24 * H;
        // #218: ESPN's date ranges answer HTTP 400 on team leagues (sportPageLeague.js), so the days after the window are
        // read one at a time, each kept AHEAD_TTL: up to the first with games, then every day its 96 hours reach (the round),
        // never past 14 days ahead: at most AHEAD_DAYS requests per path per 6 hours. A day not answered (budget, cooldown,
        // failure) stops the scan until a later tick.
        async function scanAhead(league, source) {
            const found = [];
            let hit = null;
            for (let d = 0, day = (Math.floor((now + 72 * H) / (24 * H)) + 1) * 24 * H; d < AHEAD_DAYS && day <= now + 14 * 24 * H; d++, day += 24 * H) {
                if (hit !== null && day > hit + 4 * 24 * H) break; // the first game's day + 4: a Thursday's round reaches Monday
                const data = await read(`${espn.BASE}${source}/scoreboard?dates=${ymd(day)}&limit=1000`, AHEAD_TTL, {cold:true});
                if (stopped || !Array.isArray(data?.json.events)) return [];
                const t0 = performance.now();
                const games = espn.normalize(data.json, league, source).filter(later).map(game => ({game, observedAt: data.observedAt}));
                counting.normalizeMs += performance.now() - t0;
                if (games.length && hit === null) hit = day;
                found.push(...games);
            }
            const first = Math.min(...found.map(e => e.game.start));
            return found.filter(e => e.game.start <= first + 4 * 24 * H);
        }
        // a team league with at most 2 ESPN paths (never the International groups), its every window day answered, and
        // nothing on or due within 72 hours
        async function lookAhead() {
            const seen = [...candidates.values()].map(e => [e.game, e.game.snapshot?.state])
                .concat(catalog.filter(g => !candidates.has(g.id)).map(g => [g, store.latest(g.id)?.data.state]));
            for (const league of wanted) {
                const paths = [fixtures.ESPN_LEAGUE_PATHS[league]].flat().filter(Boolean);
                if (stopped || !paths.length || paths.length > 2 || individual.has(league) || CRICKET_GROUPS.includes(league) || feeds.has(league)) continue;
                const own = jobs.filter(j => j.league === league);
                if (!own.length || !own.every(j => cache.get(j.url)?.data)) continue; // the window is not known yet
                if (seen.some(([g, state]) => g.league === league && due(g, state))) continue;
                for (const source of paths) for (const {game, observedAt} of await scanAhead(league, source)) {
                    // a window day's answer is fresher than the look-ahead's, so it always wins
                    if (!candidates.has(game.id)) candidates.set(game.id, {game, priority: queryDays.length, observedAt});
                }
            }
        }
        // #223: a followed team (of a team league with at most 2 ESPN paths, its window answered) with no game on or due
        // within the window asks ESPN for its own schedule (football: its fixture list), by its roster id, each answer
        // kept TEAM_TTL, so asked again every 6 hours until its next game is inside the window (0450 Codex round 1,
        // medium: a stored distant game never stops the asking). The first game it has not played joins the catalogue,
        // however far ahead (followNext shows it), the answer's other stored games are renewed, and a stored game of the
        // team past the window that the answer no longer lists (moved off, removed) is forgotten.
        const dropped = new Set();
        async function teamsAhead() {
            let byLeague;
            try { byLeague = followed(); } catch { return; }
            if (!byLeague?.size) return;
            const seen = [...candidates.values()].map(e => [e.game, e.game.snapshot?.state])
                .concat(catalog.filter(g => !candidates.has(g.id)).map(g => [g, store.latest(g.id)?.data.state]));
            for (const league of wanted) {
                const names = [...(byLeague.get(league) || [])];
                const paths = [fixtures.ESPN_LEAGUE_PATHS[league]].flat().filter(Boolean);
                if (stopped || !names.length || !paths.length || paths.length > 2 || individual.has(league) || MOTOR.has(league)
                    || CRICKET_GROUPS.includes(league) || feeds.has(league)) continue;
                const own = jobs.filter(j => j.league === league);
                if (!own.length || !own.every(j => cache.get(j.url)?.data)) continue; // the window is not known yet
                let teams;
                try { teams = roster(league) || []; } catch { continue; }
                for (const name of names) {
                    const mine = g => followMatchesFor(g, { [league]: [name] }).length > 0;
                    if (seen.some(([g, state]) => g.league === league && due(g, state) && mine(g))) continue;
                    const key = norm(name);
                    const team = key && teams.find(t => /^\d{1,12}$/.test(String(t?.id ?? '')) && [t.displayName, t.name, t.shortDisplayName, t.abbreviation].some(a => typeof a === 'string' && norm(a) === key));
                    if (!team) continue;
                    for (const source of paths) {
                        const football = source.startsWith('soccer/');
                        const data = await read(`${espn.BASE}${source}/teams/${team.id}/schedule${football ? '?fixture=true' : ''}`, TEAM_TTL, {cold:true});
                        if (stopped || !Array.isArray(data?.json.events)) continue;
                        // a club's fixture list under one competition's path is that competition's; never another's
                        const slug = source.slice(source.indexOf('/') + 1);
                        const events = data.json.events.filter(e => !football || !e?.league?.slug || e.league.slug === slug);
                        const t0 = performance.now();
                        const listed = espn.normalize({ events }, league, source).filter(mine);
                        counting.normalizeMs += performance.now() - t0;
                        const next = listed.filter(g => g.snapshot.state === 'scheduled' && g.start > now).sort((a, b) => a.start - b.start)[0];
                        const ids = new Set(listed.map(g => g.id));
                        // a window day's or the round's answer is fresher, so it always wins
                        for (const g of listed) if ((g === next || known.has(g.id)) && !candidates.has(g.id)) candidates.set(g.id, {game: g, priority: queryDays.length, observedAt: data.observedAt});
                        for (const g of catalog) if (g.league === league && g.id.startsWith(`espn:${source}:`) && g.start > now + 72 * H && !ids.has(g.id) && !candidates.has(g.id) && mine(g)) dropped.add(g.id);
                    }
                }
            }
        }
        async function runJobs(batch, maxCold = Infinity) {
            let index = 0;
            async function worker() {
                while (index < batch.length && !stopped && clock() < deadline) {
                    const job = batch[index++];
                    const existing = cache.get(job.url);
                    if (job.hot && existing?.data) existing.nextAt = Math.min(existing.nextAt, existing.data.observedAt + 30000);
                    else if (job.warm && existing?.data) existing.nextAt = Math.min(existing.nextAt, existing.data.observedAt + BREAK_POLL);
                    const data = await read(job.url, job.hot ? 30000 : job.warm ? BREAK_POLL : 900000, {cold:!job.hot,maxCold,maxBytes:individual.has(job.league) ? individual.MAX_BYTES : undefined});
                    // #197: one answer can serve two leagues (ATP's feed: Grand Slams and ATP Tour)
                    const done = `${job.league}|${job.url}`;
                    if (stopped || !Array.isArray(data?.json.events) || processed.get(done) === data.observedAt) continue;
                    processed.set(done, data.observedAt);
                    const t0 = performance.now();
                    const games = individual.has(job.league) ? individual.normalize(data.json, job.league, job.source) : espn.normalize(data.json, job.league, job.source);
                    if (CRICKET_GROUPS.includes(job.league)) for (const id of espn.misfiledIds(data.json, job.league, job.source)) misfiled.set(id, job.league);
                    counting.normalizeMs += performance.now() - t0;
                    for (const game of games) {
                        const priority = queryDays.indexOf(job.date), old = candidates.get(game.id);
                        if (!old || priority < old.priority) {
                            candidates.set(game.id, {game,priority,observedAt:data.observedAt});
                            listedOn.set(game.id, job.date);
                        }
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
        // #218: a league with nothing on or due within 72 hours: its next round, from the days after the window
        await lookAhead();
        // #223: a followed team with nothing ahead: its own next game, from its schedule
        await teamsAhead();
        // #196 (D-41): the leagues ESPN does not cover, from their own feeds (sportFeeds.js keeps each answer a while).
        for (const league of wanted) {
            if (!feeds.has(league) || stopped) continue;
            const answer = await feedGames(league, { now: clock() });
            if (!recordedFeeds.has(answer)) { // a kept answer is recorded once, not on every tick
                recordedFeeds.add(answer);
                try { recordFeed(league, answer, clock()); } catch { /* status is best-effort */ }
            }
            if (!answer.ok) continue;
            for (const game of answer.games) candidates.set(game.id, { game, priority: 0, observedAt: answer.observedAt });
        }
        if (!stopped) {
            const entries = [...candidates.values()].filter(e => !known.has(e.game.id) || e.observedAt > known.get(e.game.id).observedAt);
            const t0 = performance.now();
            // #212: a card a group's series listed that its own class says is not the group's (a domestic or women's match,
            // or one filed under the group before 0397) is forgotten, so it leaves the group's rail and its series is no
            // longer kept on the group's behalf (the retention above) once none of its cards are left.
            const forget = [...misfiled].filter(([id, group]) => known.get(id)?.league === group && !candidates.has(id)).map(([id]) => id)
                .concat([...dropped].filter(id => !candidates.has(id)))
                .concat(catalog.filter(g => strayGroupCard(g) && !candidates.has(g.id)).map(g => g.id));
            if (forget.length) store.forget(forget);
            if (entries.length) store.ingestBatch(entries);
            store.prune(clock());
            counting.ingestMs += performance.now() - t0;
            counting.tickMs = performance.now() - started;
            cost.record(counting);
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
function start() { if(collectorEnabled() && !runtime) {runtime=createCollector({store:store()});runtime.start();} }
function stop() {runtime?.stop();runtime=null;require('./sportsDashboardResponse').close();}
module.exports={enabled,collectorEnabled,dashboardEnabled,localDay,timezone,matchBroadcasts,buildDashboard,createCollector,store,start,stop,response: options => require('./sportsDashboardResponse').response(options)};
