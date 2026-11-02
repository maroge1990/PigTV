const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const espn = require('../server/services/sportsScoresEspn');
const { createStore } = require('../server/services/sportsDashboardStore');
const dashboard = require('../server/services/sportsDashboard');
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sports-feed-evidence.json')));
const sample = label => evidence.samples.find(s => s.label === label);
const H = 3600000, NOW = Date.parse('2026-10-29T01:00Z');
const databases = [];
const store = () => { const db = new Database(':memory:'); databases.push(db); return createStore(db); };
after(() => databases.forEach(db => db.close()));
const parse = (label, league, source) => espn.normalize(sample(label), league, source || 'football/nfl');
const game = (extra = {}) => ({ id: 'espn:football/nfl:1', league: 'NFL', start: NOW - H, end: null,
    title: 'Kansas City Chiefs v Buffalo Bills', session: null, circuit: null,
    competitors: [{ id: '12', name: 'Kansas City Chiefs', aliases: ['Kansas City Chiefs', 'Chiefs', 'KC'], logo: null },
        { id: '2', name: 'Buffalo Bills', aliases: ['Buffalo Bills', 'Bills', 'BUF'], logo: null }],
    snapshot: { state: 'live', progress: { clock: '5:00', period: 2 }, scores: ['17', '14'], situation: { down: 3 } }, ...extra });

test('all followed team sports retain real score/clock fields; pregame zero is not a score', () => {
    for (const [label, league, source] of [['AFL','AFL','australian-football/afl'],['NFL-final','NFL','football/nfl'],
        ['NBA-final-retry','NBA','basketball/nba'],['MLB-final','MLB','baseball/mlb'],['EPL-final','EPL','soccer/eng.1'],
        ['FA-Cup-final','FA Cup','soccer/eng.fa'],['UEFA-Champions-final','UEFA','soccer/uefa.champions'],
        ['UEFA-Europa-final','UEFA','soccer/uefa.europa'],['Championship-final','Championship','soccer/eng.2']]) {
        const [g] = parse(label, league, source);
        assert.equal(g.snapshot.state, 'finished', league);
        assert.equal(g.snapshot.scores.length, 2, league);
        assert.ok(g.competitors.every(c => c.id && c.name), league);
        assert.ok(g.snapshot.progress.period > 0, league);
    }
    const payload = structuredClone(sample('NFL-final'));
    payload.events[0].competitions[0].status.type = { state: 'pre' };
    assert.equal(espn.normalize(payload, 'NFL', 'football/nfl')[0].snapshot.scores, null);
});

test('F1 is one session card per competition, with no driver positions, scores or inferred clock', () => {
    const games = parse('F1-final', 'F1', 'racing/f1');
    assert.equal(games.length, 5);
    assert.equal(new Set(games.map(g => g.id)).size, 5);
    assert.deepEqual(games.map(g => g.session), ['Practice 1','Practice 2','Practice 3','Qualifying','Race']);
    for (const g of games) {
        assert.deepEqual(g.competitors, []);
        assert.equal(g.snapshot.scores, null);
        assert.deepEqual(g.snapshot.progress, {});
        assert.ok(g.circuit.name);
        const { players, ...shown } = g;
        assert.ok(!JSON.stringify(shown).includes('Antonelli'));
        // #197: the entry list (what a followed driver is found by) is in name order, never the session's result order
        assert.deepEqual(players, [...players].sort((a, b) => a.localeCompare(b)));
    }
});

test('cricket stumps is a break, preserves batting innings/overs, and excludes placeholder opposition rows', () => {
    const [g] = parse('Cricket-international', 'Cricket', 'cricket/24203');
    assert.equal(g.snapshot.state, 'break');
    assert.equal(g.snapshot.breakLabel, 'Stumps');
    assert.equal(g.snapshot.progress.day, 'Day 2');
    assert.equal(g.snapshot.progress.overs, '90');
    assert.deepEqual(g.snapshot.scores, ['329','330/4 (90 ov)']);
    assert.equal(g.snapshot.situation.innings[0].length, 1);
    assert.equal(g.snapshot.situation.innings[1].length, 1);
    const p = structuredClone(sample('Cricket-international'));
    p.events[0].competitions[0].status = { type: { state: 'in', description: 'Live' }, summary: 'Starts at 10:30 local time' };
    assert.equal(espn.normalize(p, 'Cricket', 'cricket/24203')[0].snapshot.state, 'scheduled');
});

test('malformed data cannot publish raw status prose, unsafe artwork, or fake clocks', () => {
    assert.deepEqual(espn.normalize({ events: [null, {}] }, 'NFL', 'football/nfl'), []);
    const p = structuredClone(sample('NFL-final'));
    const c = p.events[0].competitions[0];
    c.status.displayClock = 'Chiefs win 21-7';
    c.status.type.description = 'http://provider.invalid/password';
    c.competitors[0].team.logo = 'http://provider.invalid/token';
    const [g] = espn.normalize(p, 'NFL', 'football/nfl');
    assert.equal(g.competitors[0].logo, null);
    assert.equal(g.snapshot.progress.clock, undefined);
    assert.ok(!JSON.stringify(g).includes('provider.invalid'));
});

test('preferences persist per person, enforce revisions, reject coercions and protect other users', () => {
    const s = store();
    assert.deepEqual(s.preferences('1'), { avoidSpoilers: false, scoreDelaySeconds: 90, revision: 0 });
    const updated = s.updatePreferences('1', { avoidSpoilers: true, scoreDelaySeconds: 120, revision: 0 });
    assert.equal(updated.revision, 1);
    assert.equal(s.preferences('1').avoidSpoilers, true);
    assert.equal(s.preferences('2').avoidSpoilers, false);
    assert.throws(() => s.updatePreferences('1', { avoidSpoilers: false, revision: 0 }), /conflict/);
    for (const patch of [{ avoidSpoilers:'false', revision:1 },{ scoreDelaySeconds:301,revision:1 },{ userId:'2',revision:1 },{revision:1}])
        assert.throws(() => s.updatePreferences('1', patch), /Invalid/);
});

test('whole snapshots honor the delay boundary, buffer on startup and survive a reopened store', () => {
    const s = store();
    s.ingest([game()], NOW);
    const later = game(); later.snapshot.scores = ['20','14']; later.snapshot.progress.clock = '4:32';
    s.ingest([later], NOW + 30000);
    assert.equal(s.delayed(game().id, NOW + 89999, 90), null);
    assert.equal(s.delayed(game().id, NOW + 90000, 90).data.progress.clock, '5:00');
    assert.deepEqual(s.delayed(game().id, NOW + 120000, 90).data.scores, ['20','14']);
    assert.equal(s.delayed(game().id, NOW + 120000, 180), null);
    const file = path.join(os.tmpdir(), `pigtv-score-${process.pid}.db`);
    try {
        let db = new Database(file); createStore(db).ingest([game()], NOW); db.close();
        db = new Database(file); assert.equal(createStore(db).delayed(game().id, NOW + 90000, 90).data.progress.clock, '5:00'); db.close();
    } finally { fs.rmSync(file, { force:true }); }
});

test('out-of-order observations are ignored, history bounded, and repeated finals do not extend the result hour', () => {
    const s=store(); s.ingest([game()],NOW);
    const final=game({snapshot:{state:'finished',progress:{period:4},scores:['24','21'],situation:null}});
    s.ingest([final],NOW+60000); s.ingest([final],NOW+120000); s.ingest([game()],NOW+30000);
    assert.equal(s.catalog()[0].finishedAt,NOW+60000);
    assert.equal(s.latest(game().id).data.state,'finished');
    s.prune(NOW+24*H);
    assert.equal(s.delayed(game().id,NOW+24*H,90).data.state,'finished','last-known completion survives history pruning');
});

const airing = (extra={}) => ({id:'event1',league:'NFL',title:'Chiefs v Bills',kind:'event',start:NOW-H,end:NOW+2*H,live:true,
    channels:[{sourceId:1,id:'pos_1',stableId:'301',name:'ESPN',quality:'HD'}],...extra});

test('broadcast matching needs both teams, the right time, and a unique game; replays never match', () => {
    const games=[game()];
    assert.equal(dashboard.matchBroadcasts(games,[airing()]).get(games[0].id).length,1);
    assert.equal(dashboard.matchBroadcasts(games,[airing({title:'Bills v Chiefs'})]).get(games[0].id).length,1);
    for (const a of [airing({title:'Chiefs v Cowboys'}),airing({kind:'replay'}),airing({start:NOW+6*H,end:NOW+9*H}),airing({title:'Kansas v Buffalo'})])
        assert.equal(dashboard.matchBroadcasts(games,[a]).get(games[0].id).length,0);
    const second=game({id:'espn:football/nfl:2',start:NOW-H+60000});
    const matches=dashboard.matchBroadcasts([...games,second],[airing()]);
    assert.equal(matches.get(games[0].id).length,0,'ambiguous doubleheader must not auto-tune');
});

test('today respects Melbourne midnight and DST; sport views retain a rolling 72 hours', () => {
    assert.equal(dashboard.localDay(Date.parse('2026-10-28T23:00Z'),'Australia/Melbourne'),'2026-10-29');
    assert.notEqual(dashboard.localDay(Date.parse('2026-10-03T13:30Z'),'Australia/Melbourne'),dashboard.localDay(Date.parse('2026-10-03T14:30Z'),'Australia/Melbourne'));
    const s=store(); const future=game({id:'future',start:NOW+71*H,snapshot:{state:'scheduled',progress:{},scores:null,situation:null}});s.ingest([future],NOW);
    assert.equal(dashboard.buildDashboard(s,{now:NOW,league:'NFL',timezone:'Australia/Melbourne',userId:'1',events:[]}).games.length,1);
    assert.equal(dashboard.buildDashboard(s,{now:NOW,timezone:'Australia/Melbourne',userId:'1',events:[]}).games.length,0);
});

test('spoiler projection removes all result fields, does not leak current final status, and keeps progress/actions', () => {
    const s=store();s.ingest([game()],NOW);s.updatePreferences('1',{avoidSpoilers:true,revision:0});
    const args={now:NOW+90000,userId:'1',timezone:'Australia/Melbourne',events:[airing()]};
    const r=dashboard.buildDashboard(s,args);const card=r.games[0];
    assert.equal(card.status,'live');assert.equal(card.progress.clock,'5:00');
    assert.equal(card.scores,undefined);assert.equal(card.situation,undefined);
    assert.equal(card.channels[0].stableId,'301');
    assert.ok(!JSON.stringify(card).includes('\"17\"'));
    assert.equal(card.aliases,undefined);
    assert.deepEqual(dashboard.buildDashboard(s,{...args,userId:'2'}).games[0].scores,['17','14']);
    s.ingest([game({snapshot:{state:'finished',progress:{period:4},scores:['24','21'],situation:null}})],NOW+100000);
    const delayed=dashboard.buildDashboard(s,{...args,now:NOW+110000}).games[0];
    assert.equal(delayed.status,'live');assert.equal(delayed.channels.length,1,'undelayed completion must not change the delayed card eligibility');
});

test('unmatched and stale games remain visible; stale data loses clock/score, old finals disappear', () => {
    const s=store();s.ingest([game()],NOW);
    const args={now:NOW+90000,userId:'1',timezone:'Australia/Melbourne',events:[]};
    let card=dashboard.buildDashboard(s,args).games[0];assert.equal(card.availability,'unmatched');assert.equal(card.status,'live');
    card=dashboard.buildDashboard(s,{...args,now:NOW+90*1000+121000}).games[0];
    assert.equal(card.freshness,'stale');assert.equal(card.scores,undefined);assert.deepEqual(card.progress,{});
    s.ingest([game({snapshot:{state:'finished',progress:{},scores:['20','14'],situation:null}})],NOW+300000);
    assert.equal(dashboard.buildDashboard(s,{...args,now:NOW+300000+90000+H}).games.length,0);
});

test('collector is opt-in, uses single UTC days, deduplicates overlapping refreshes and discovers future cricket series', async () => {
    const s=store();const calls=[];
    // #195: a series joins the International group by its matches' international class (here a men's Test).
    const fetchJson=async url=>{calls.push(url);if(url.includes('scorepanel'))return {scores:[{leagues:[{id:url.includes('20261031')?'999':'24203'}],
        events:[{competitions:[{class:{internationalClassId:'1'}}]}]},{leagues:[{id:'21284'}],events:[{competitions:[{class:{internationalClassId:'0'}}]}]}]};
        return sample('Cricket-international');};
    const c=dashboard.createCollector({store:s,fetchJson,leagues:()=>new Set(['Cricket']),clock:()=>NOW,enabled:()=>true});
    await Promise.all([c.refresh(),c.refresh()]);
    assert.equal(calls.filter(u=>u.includes('scorepanel')).length,4);
    assert.ok(calls.some(u=>u.includes('/cricket/999/scoreboard')));
    assert.ok(!calls.some(u=>u.includes('/cricket/21284/')),'the WBBL is its own league, never the International group\'s (#195)');
    assert.ok(!calls.some(u=>/dates=\d+-\d+/.test(u)));
    const off=dashboard.createCollector({store:s,fetchJson,leagues:()=>new Set(['NFL']),clock:()=>NOW,enabled:()=>false});
    const n=calls.length;await off.refresh();assert.equal(calls.length,n);off.stop();c.stop();
});

// #212 (Mark, Apple TV): following only the men's internationals (`Cricket`), its rail held domestic and women's matches:
// series filed under `Cricket` before 0397 (every scorepanel series was) are kept by the retention above, re-fetched
// under `Cricket` and re-ingested as `Cricket` cards on every tick; a men's tour's own tour match is `Cricket` too. Now a
// match is a group's only by its own international class, and a stored card its class contradicts is forgotten.
test('#212: an International cricket group\'s cards are only its own class\'s; misfiled stored cards are forgotten', async () => {
    const s=store();
    const match=(id,cls,a,b,start=NOW+H)=>({id,competitions:[{id,date:new Date(start).toISOString(),class:{internationalClassId:cls},
        status:{type:{state:'pre'}},competitors:[{order:1,team:{id:`${id}a`,displayName:a}},{order:2,team:{id:`${id}b`,displayName:b}}]}]});
    const boards={
        '24203':{leagues:[{name:'Australia tour of South Africa 2026/27'}],events:[match('1525661','1','South Africa','Australia'),
            match('1525650','0','South Africa A','Australians')]}, // the tour's own tour match is not a men's international
        '777':{leagues:[{name:'Ranji Trophy 2026/27'}],events:[match('7771','0','Mumbai','Delhi')]},
        '888':{leagues:[{name:'England Women tour of India 2026/27'}],events:[match('8881','9','India Women','England Women')]}
    };
    // Cards filed under `Cricket` before 0397: a domestic and a women's international series.
    const legacy=(series,eventId,a,b)=>game({id:`espn:cricket/${series}:${eventId}`,league:'Cricket',start:NOW+H,title:`${a} v ${b}`,format:null,
        competitors:[{id:'1',name:a,aliases:[a],logo:null},{id:'2',name:b,aliases:[b],logo:null}],snapshot:{state:'scheduled',progress:{},scores:null,situation:null}});
    s.ingest([legacy('777','7771','Mumbai','Delhi'),legacy('888','8881','India Women','England Women')],NOW-60000);
    const fetchJson=async url=>{
        if(url.includes('scorepanel'))return {scores:[{leagues:[{id:'24203'}],events:[{competitions:[{class:{internationalClassId:'1'}}]}]},
            {leagues:[{id:'888'}],events:[{competitions:[{class:{internationalClassId:'9'}}]}]}]};
        const series=/\/cricket\/(\d+)\/scoreboard/.exec(url)?.[1];
        return structuredClone(boards[series] || {events:[]});
    };
    const c=dashboard.createCollector({store:s,fetchJson,leagues:()=>new Set(['Cricket']),clock:()=>NOW,enabled:()=>true});
    await c.refresh();c.stop();
    const shown=dashboard.buildDashboard(s,{now:NOW,userId:'1',timezone:'UTC',leagues:new Set(['Cricket']),events:[]}).games;
    assert.deepEqual(shown.map(g=>g.id),['espn:cricket/24203:1525661'],'only the men\'s international on the Cricket rail');
    assert.deepEqual(s.catalog().filter(g=>g.league==='Cricket').map(g=>g.id),['espn:cricket/24203:1525661'],'the misfiled cards are forgotten');
    // Following the women's too, their tour is theirs.
    const both=dashboard.createCollector({store:s,fetchJson,leagues:()=>new Set(['Cricket',"Women's Cricket"]),clock:()=>NOW+H,enabled:()=>true});
    await both.refresh();both.stop();
    assert.deepEqual(s.catalog().filter(g=>g.league==="Women's Cricket").map(g=>g.id),['espn:cricket/888:8881']);
    assert.deepEqual(espn.normalize(boards['24203'],'Sheffield Shield','cricket/8043').length,2,'a fixed league keeps every match its series lists');
});

test('cached future payloads never become new score observations, and malformed success retries quickly', async () => {
    const s=store();let time=NOW;let calls=0;
    const payload=sample('NFL-final');
    const c=dashboard.createCollector({store:s,leagues:()=>new Set(['NFL']),clock:()=>time,enabled:()=>true,
        fetchJson:async()=>{calls++;return payload;}});
    await c.refresh();const first=s.catalog()[0].observedAt;
    time+=1000;await c.refresh();assert.equal(s.catalog()[0].observedAt,first,'cache hits cannot extend data freshness');
    time+=30000;await c.refresh();assert.equal(s.catalog()[0].observedAt,first,'inactive catalog uses the slow cadence');
    time+=900000;await c.refresh();assert.equal(s.catalog()[0].observedAt,time);
    // five window days twice, and (#218: nothing due within 72 hours) the 11 days after the window once, kept 6 hours
    assert.equal(calls,21);c.stop();
});

test('future scheduled cards keep their scheduled label between the slower catalog polls', () => {
    const s=store();s.ingest([game({start:NOW+24*H,snapshot:{state:'scheduled',progress:{},scores:null,situation:null}})],NOW);
    const r=dashboard.buildDashboard(s,{now:NOW+10*60000,userId:'1',league:'NFL',events:[]});
    assert.equal(r.games[0].status,'scheduled');assert.equal(r.games[0].scores,undefined);
});

test('pruning retains last-known completion so old broadcasts cannot become playable after an outage', () => {
    const s=store();s.ingest([game()],NOW);
    s.ingest([game({snapshot:{state:'finished',progress:{},scores:['20','14'],situation:null}})],NOW+1000);
    s.prune(NOW+H);
    assert.equal(s.latest(game().id).data.state,'finished');
    assert.equal(dashboard.buildDashboard(s,{now:NOW+H,userId:'1',events:[airing({end:NOW+3*H})]}).games[0]?.canWatch || false,false);
});

test('unfollowed leagues and non-followed teams disappear without clearing the shared score catalog', () => {
    const s=store();s.ingest([game()],NOW);
    const args={now:NOW+90000,userId:'1',events:[]};
    assert.equal(dashboard.buildDashboard(s,{...args,leagues:new Set(['NBA'])}).games.length,0);
    assert.equal(dashboard.buildDashboard(s,{...args,follow:['NFL: Dallas Cowboys']}).games.length,0);
    assert.equal(dashboard.buildDashboard(s,{...args,follow:['NFL: Kansas City Chiefs']}).games.length,1);
});

test('collector checks the previous UTC day for games still in progress across midnight', async () => {
    const s=store(),calls=[];
    const c=dashboard.createCollector({store:s,leagues:()=>new Set(['NBA']),clock:()=>NOW,enabled:()=>true,
        fetchJson:async url=>{calls.push(url);return {events:[]};}});
    await c.refresh();c.stop();assert.ok(calls.some(u=>u.includes('dates=20261028')));
});

test('F1 broadcast matching requires the right GP and the exact session, including race and sprint qualifying', () => {
    const games=parse('F1-final','F1','racing/f1');
    const practice=games[0],race=games[4];
    const event=airing({league:'F1',title:'United States GP · Practice 1',start:practice.start,end:practice.start+H});
    assert.equal(dashboard.matchBroadcasts(games,[event]).get(practice.id).length,1);
    assert.equal(dashboard.matchBroadcasts(games,[{...event,title:'United States GP · Qualifying'}]).get(practice.id).length,0);
    assert.equal(dashboard.matchBroadcasts(games,[{...event,title:'Mexico GP · Practice 1'}]).get(practice.id).length,0);
    assert.equal(dashboard.matchBroadcasts(games,[airing({league:'F1',title:'United States Grand Prix',start:race.start,end:race.start+3*H})]).get(race.id).length,1);
});

test('a source outage cannot refresh old scores, and a stopped collector cannot publish in-flight data', async () => {
    const s=store();let time=NOW,fail=false;
    const c=dashboard.createCollector({store:s,leagues:()=>new Set(['NFL']),clock:()=>time,enabled:()=>true,
        fetchJson:async()=>{if(fail)throw new Error('https://secret.invalid/password');return sample('NFL-final');}});
    await c.refresh();const first=s.catalog()[0].observedAt;fail=true;time+=31000;await c.refresh();
    assert.equal(s.catalog()[0].observedAt,first);c.stop();
    let resolve;const deferred=new Promise(r=>{resolve=r;});
    const stopping=dashboard.createCollector({store:s,leagues:()=>new Set(['NFL']),clock:()=>time,enabled:()=>true,fetchJson:()=>deferred});
    const running=stopping.refresh();stopping.stop();resolve(sample('NFL-final'));await running;
    assert.equal(s.catalog()[0].observedAt,first);
});

test('malformed successful HTTP payloads are retried as failures, never authoritative empty schedules', async () => {
    const s=store();let time=NOW,calls=0;
    const c=dashboard.createCollector({store:s,leagues:()=>new Set(['NFL']),clock:()=>time,enabled:()=>true,
        fetchJson:async()=>{calls++;return {not:'a scoreboard'};}});
    await c.refresh();const initial=calls;time+=31000;await c.refresh();assert.ok(calls>initial);assert.deepEqual(s.catalog(),[]);c.stop();
});

test('network adapter bounds response bodies, refuses redirects/other origins, and never follows provider-shaped refs', async () => {
    const original=global.fetch;let seen;
    try {
        global.fetch=async(url,options)=>{seen=options;return new Response(JSON.stringify(sample('NFL-final')));};
        assert.ok(Array.isArray((await espn.fetchJson(espn.BASE+'football/nfl/scoreboard?dates=20261026')).events));
        assert.equal(seen.redirect,'error');
        await assert.rejects(()=>espn.fetchJson('https://provider.invalid/password'),/Invalid score source/);
        global.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2*1024*1024+1));c.close();}}));
        await assert.rejects(()=>espn.fetchJson(espn.BASE+'football/nfl/scoreboard'),/too large/);
    } finally {global.fetch=original;}
});

test('MLB preserves top/bottom inning as spoiler-safe progress and cricket never joins a different format', () => {
    const p=structuredClone(sample('MLB-final'));p.events[0].competitions[0].status={type:{state:'in',description:'In Progress',detail:'Top 7th'},period:7};
    assert.equal(espn.normalize(p,'MLB','baseball/mlb')[0].snapshot.progress.half,'top');
    const [cricket]=parse('Cricket-international','Cricket','cricket/24203');
    assert.equal(cricket.format,'test');
    const e=airing({league:'Cricket',title:'South Africa v Australia · T20',start:cricket.start,end:cricket.start+4*H});
    assert.equal(dashboard.matchBroadcasts([cricket],[e]).get(cricket.id).length,0);
});

test('location-only roster aliases cannot authorize a broadcast match', () => {
    const p=structuredClone(sample('NFL-final'));
    const t=p.events[0].competitions[0].competitors[0].team;
    t.location='Philadelphia';t.shortDisplayName='Philadelphia';
    const [g]=espn.normalize(p,'NFL','football/nfl');
    assert.ok(!g.competitors[0].aliases.includes('Philadelphia'));
});

test('upcoming matched games retain channel choices and event references without becoming watchable', () => {
    const s=store();const future=game({start:NOW+2*H,snapshot:{state:'scheduled',progress:{},scores:null,situation:null}});s.ingest([future],NOW);
    const e=airing({start:NOW+2*H,end:NOW+5*H,live:false});
    const card=dashboard.buildDashboard(s,{now:NOW+90000,userId:'1',events:[e]}).games[0];
    assert.equal(card.channels[0]?.stableId,'301');assert.equal(card.canWatch,false);
    assert.equal(card.broadcastStatus,'scheduled');assert.equal(card.events[0].id,e.id);
});

test('a partially malformed status cannot replace known completion and revive an old broadcast', () => {
    const s=store();s.ingest([game()],NOW);
    s.ingest([game({snapshot:{state:'finished',progress:{},scores:['24','21'],situation:null}})],NOW+1000);
    s.ingest([game({snapshot:{state:'unknown',progress:{},scores:null,situation:null}})],NOW+2000);
    assert.equal(s.latest(game().id).data.state,'finished');
    assert.equal(dashboard.buildDashboard(s,{now:NOW+100000,userId:'1',events:[airing()]}).games[0].canWatch,false);
});

// #218: a weekly league with nothing within the 72-hour window shows its next round, asked ahead once every 6 hours.
const D = 24 * H;
const espnEvent = (id, start, home, away, state = 'pre') => ({ id, date: new Date(start).toISOString(), competitions: [{ id, date: new Date(start).toISOString(),
    status: { type: { state } }, competitors: [home, away].map(([tid, name]) => ({ score: '0', team: { id: tid, displayName: name, abbreviation: name.slice(0, 3).toUpperCase() } })) }] });
// the window's days at NOW are 20261028 to 20261101; a later day is the look-ahead's
const aheadUrls = calls => calls.filter(u => (/dates=(\d{8})/.exec(u)?.[1] || '') >= '20261102');
const day = u => /dates=(\d{8})/.exec(u)?.[1];
test('#218: a league with nothing within 72 hours scans ahead day by day to its next round, then every day its 96 hours reach, once in 6 h', async () => {
    const s = store(), calls = []; let time = NOW;
    const byDay = { 20261105: [espnEvent('501', Date.parse('2026-11-05T18:00Z'), ['9', 'Packers'], ['8', 'Lions'])],
        20261106: [espnEvent('502', Date.parse('2026-11-06T18:00Z'), ['12', 'Chiefs'], ['2', 'Bills'])],
        20261109: [espnEvent('503', Date.parse('2026-11-09T18:00Z'), ['9', 'Packers'], ['2', 'Bills'])] };
    const c = dashboard.createCollector({ store: s, leagues: () => new Set(['NFL']), clock: () => time, enabled: () => true,
        fetchJson: async url => { calls.push(url); return { events: byDay[day(url)] || [] }; } });
    await c.refresh();
    assert.equal(aheadUrls(calls).length, 7, 'the tick budget (12) ends the scan after 5 window days and 7 ahead');
    time += 31000; await c.refresh(); // the next tick resumes from the cached days
    assert.deepEqual(aheadUrls(calls), ['20261102', '20261103', '20261104', '20261105', '20261106', '20261107', '20261108', '20261109']
        .map(d => `${espn.BASE}football/nfl/scoreboard?dates=${d}&limit=1000`), 'one day at a time to the first with games, then the 4 days its 96 hours reach');
    assert.deepEqual(s.catalog().map(g => g.id).sort(), ['espn:football/nfl:501', 'espn:football/nfl:502', 'espn:football/nfl:503'],
        'the next round, through the first game + 96 h (Thursday to Monday)');
    time += 5 * H; await c.refresh();
    assert.equal(aheadUrls(calls).length, 8, 'not asked again within 6 hours');
    time = NOW + 6 * H + 1000; await c.refresh();
    assert.ok(aheadUrls(calls).length > 8, 'asked again after 6 hours');
    c.stop();
});

test('#218: a daily league with a game tomorrow, or a window not yet answered, makes no look-ahead request', async () => {
    const s = store(), calls = [];
    const c = dashboard.createCollector({ store: s, leagues: () => new Set(['NBA']), clock: () => NOW, enabled: () => true,
        fetchJson: async url => { calls.push(url); return { events: url.includes('dates=20261029') ? [espnEvent('601', NOW + 20 * H, ['1', 'Lakers'], ['2', 'Celtics'])] : [] }; } });
    await c.refresh(); c.stop();
    assert.ok(calls.length >= 5, 'the window was read');
    assert.equal(s.catalog().length, 1);
    assert.deepEqual(aheadUrls(calls), []);
    const s2 = store(), calls2 = [];
    const failing = dashboard.createCollector({ store: s2, leagues: () => new Set(['NFL']), clock: () => NOW, enabled: () => true,
        fetchJson: async url => { calls2.push(url); if (url.includes('dates=20261030')) throw new Error('down'); return { events: [] }; } });
    await failing.refresh(); failing.stop();
    assert.ok(calls2.length >= 5);
    assert.deepEqual(aheadUrls(calls2), [], 'a window day that failed is not "nothing"');
    const s3 = store(), calls3 = [];
    const group = dashboard.createCollector({ store: s3, leagues: () => new Set(['Internationals']), clock: () => NOW, enabled: () => true,
        fetchJson: async url => { calls3.push(url); return { events: [] }; } });
    for (let i = 0; i < 10; i++) await group.refresh();
    group.stop();
    assert.ok(calls3.length >= 12);
    assert.deepEqual(aheadUrls(calls3), [], 'a group of many paths never looks ahead');
});

test('#218: the front page\'s options show a league\'s next round past 72 hours as cards with nextRound, channels []', () => {
    const s = store(), sched = { state: 'scheduled', progress: {}, scores: null, situation: null };
    s.ingest([game({ id: 'espn:football/nfl:501', start: NOW + 5 * D, snapshot: sched }), game({ id: 'espn:football/nfl:502', start: NOW + 6 * D, snapshot: sched }),
        game({ id: 'espn:football/nfl:503', start: NOW + 10 * D, snapshot: sched })], NOW - 1000);
    const opts = { now: NOW, userId: '1', events: [], leagues: new Set(['NFL']), keepFinishedToday: true, channelTimes: true, upcomingHours: 72, guideCards: false };
    const r = dashboard.buildDashboard(s, opts);
    assert.deepEqual(r.games.map(g => [g.id, g.nextRound, g.channels]), [['espn:football/nfl:501', true, []], ['espn:football/nfl:502', true, []]]);
    assert.equal(dashboard.buildDashboard(s, { now: NOW, userId: '1', events: [] }).games.length, 0, 'the legacy dashboard is unchanged');
    s.ingest([game({ id: 'espn:football/nfl:500', start: NOW + 2 * D, snapshot: sched })], NOW - 1000);
    assert.deepEqual(dashboard.buildDashboard(s, opts).games.map(g => [g.id, g.nextRound]), [['espn:football/nfl:500', undefined]],
        'a game within 72 hours: no next round');
});
