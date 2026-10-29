const {test,after,afterEach}=require('node:test');
afterEach(()=>{try{require('../server/services/espnRequestPolicy').reset();}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}});
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {performance}=require('node:perf_hooks');
const dashboard=require('../server/services/sportsDashboard');
const {createStore}=require('../server/services/sportsDashboardStore');
const espn=require('../server/services/sportsScoresEspn');
const fixtures=require('../server/services/sportsFixtures');
const perf=require('./helpers/perf');
const H=3600000,NOW=Date.parse('2026-10-29T01:00Z'),databases=[];
const makeStore=()=>{const db=new Database(':memory:');databases.push(db);return {db,store:createStore(db)};};
after(()=>databases.forEach(db=>db.close()));
const game=(i=0,extra={})=>({id:`espn:football/nfl:${i}`,league:'NFL',title:`Alpha${i} v Beta${i}`,start:NOW-H,end:null,format:null,session:null,circuit:null,
    competitors:[{id:`a${i}`,name:`Alpha${i}`,aliases:[`Alpha${i}`],logo:null},{id:`b${i}`,name:`Beta${i}`,aliases:[`Beta${i}`],logo:null}],
    snapshot:{state:'live',progress:{clock:'5:00',period:2},scores:['17','14'],situation:null},...extra});
const event=(i=0,extra={})=>({id:`event${i}`,league:'NFL',title:`Alpha${i} v Beta${i}`,kind:'event',start:NOW-H,end:NOW+H,live:true,
    channels:[{sourceId:1,id:`pos_${i}`,stableId:`${i}`,name:'Test Sports',quality:'HD',secret:'must-not-project'}],...extra});

test('M1: latest completion cannot leak through delayed channel/availability/action fields',()=>{
    const {store:s}=makeStore();s.updatePreferences('1',{avoidSpoilers:true,scoreDelaySeconds:300,revision:0});
    s.ingest([game()],NOW-301000);
    const opts={now:NOW,userId:'1',events:[event()]};
    const before=dashboard.buildDashboard(s,opts).games[0];
    s.ingest([game(0,{snapshot:{state:'finished',progress:{period:4},scores:['24','21'],situation:null}})],NOW-1000);
    const after=dashboard.buildDashboard(s,opts).games[0];
    assert.equal(after.status,'live');
    for(const field of ['channels','availability','broadcastStatus','canWatch','events']) assert.deepEqual(after[field],before[field],field);
    assert.equal(after.canWatch,true);assert.equal(after.scores,undefined);
    assert.equal(dashboard.buildDashboard(s,{...opts,now:NOW+300000}).games[0].canWatch,false);
});

test('M3: three short-format cricket matches two days apart each join their own airing',()=>{
    for(const format of ['t20','odi']){
        const games=[0,1,2].map(i=>game(i,{league:'Cricket',format,start:NOW+i*48*H,title:'Australia v India',
            competitors:[{id:'a',name:'Australia',aliases:['Australia'],logo:null},{id:'b',name:'India',aliases:['India'],logo:null}]}));
        const events=games.map((g,i)=>event(i,{league:'Cricket',title:`Australia v India · ${format.toUpperCase()}`,start:g.start,end:g.start+4*H}));
        const joins=dashboard.matchBroadcasts(games,events);
        assert.deepEqual(games.map(g=>joins.get(g.id).map(e=>e.id)),[['event0'],['event1'],['event2']],format);
    }
});

test('M3: cricket parent/day end is not a trustworthy match end, and short-format windows stay bounded',()=>{
    const p={events:[{id:'parent',name:'Series',endDate:'2026-11-30T23:59Z',competitions:[{id:'1',date:'2026-10-29T01:00Z',class:{eventType:'T20'},status:{type:{state:'pre'}},
        competitors:[{id:'a',team:{id:'a',displayName:'Australia'}},{id:'b',team:{id:'b',displayName:'India'}}]}]}]};
    const [g]=espn.normalize(p,'Cricket','cricket/123');assert.equal(g.end,null);
    p.events[0].competitions[0].endDate=p.events[0].endDate;
    const [untrusted]=espn.normalize(p,'Cricket','cricket/123');assert.equal(untrusted.end,null);
    assert.equal(dashboard.matchBroadcasts([untrusted],[event(0,{league:'Cricket',title:'Australia v India · T20',start:NOW+48*H,end:NOW+52*H})]).get(untrusted.id).length,0);
});

test('H1: statements are prepared once, not twice per card on each poll',()=>{
    const {store:s,db}=makeStore();s.ingest(Array.from({length:300},(_,i)=>game(i)),NOW-100000);
    let prepared=0;const original=db.prepare;db.prepare=function(...args){prepared++;return original.apply(this,args);};
    dashboard.buildDashboard(s,{now:NOW,userId:'1',events:Array.from({length:300},(_,i)=>event(i))});
    assert.ok(prepared<=5,`request prepared ${prepared} statements`);
});

test('H1/L4: realistic 300-game and 72-hour guide matching has a cold projection budget',perf,t=>{
    const {store:s}=makeStore();const games=Array.from({length:300},(_,i)=>game(i,{start:NOW+(i%72-1)*H}));s.ingest(games,NOW-100000);
    const events=Array.from({length:1200},(_,i)=>event(i%300,{id:`airing${i}`,start:games[i%300].start+(Math.floor(i/300)*24*H),end:games[i%300].start+(Math.floor(i/300)*24*H)+2*H}));
    const started=performance.now();const result=dashboard.buildDashboard(s,{now:NOW,userId:'1',league:'NFL',events});
    const ms=performance.now()-started;t.diagnostic(`projection=${ms.toFixed(1)}ms`);assert.ok(result.games.length>0);assert.ok(ms<100,`300 games/1200 airings took ${ms.toFixed(1)}ms (budget 100ms)`);
});

test('M2: measured worst-case ticks obey a 12-request ceiling including cricket discovery',async t=>{
    const {store:s}=makeStore();let now=NOW,calls=0;
    const c=dashboard.createCollector({store:s,leagues:()=>new Set(Object.keys(fixtures.ESPN_LEAGUE_PATHS).concat('Cricket')),clock:()=>now,enabled:()=>true,
        fetchJson:async url=>{calls++;return url.includes('scorepanel')?{scores:[{leagues:Array.from({length:40},(_,i)=>({id:String(100+i)}))}]}:{events:[]};}});
    try{await c.refresh();const first=calls;now+=31000;await c.refresh();t.diagnostic(`cold=${first}, next=${calls-first}`);assert.ok(first<=12,`cold tick made ${first} requests`);assert.ok(calls-first<=12);}finally{c.stop();}
});

test('M2: inactive sources use the slow cadence; only active/starting-soon sources poll after 30 seconds',async()=>{
    const {store:s}=makeStore();let now=NOW;const calls=[];
    const c=dashboard.createCollector({store:s,leagues:()=>new Set(['NFL']),clock:()=>now,enabled:()=>true,fetchJson:async u=>{calls.push(u);return {events:[]};}});
    try{await c.refresh();const first=calls.length;now+=31000;await c.refresh();assert.equal(calls.length,first,'inactive source refetched');
        s.ingest([game()],now);now+=31000;await c.refresh();assert.ok(calls.length>first,'active source must refresh');}finally{c.stop();}
});

test('M2: one upstream throttle pauses every dashboard URL and bounds concurrent in-flight requests',async()=>{
    const {store:s}=makeStore();let now=NOW,calls=0;
    const c=dashboard.createCollector({store:s,leagues:()=>new Set(['NFL','NBA','MLB']),clock:()=>now,enabled:()=>true,fetchJson:async()=>{calls++;throw Object.assign(new Error('Throttled'),{status:429});}});
    try{await c.refresh();assert.ok(calls<=2,`throttle allowed ${calls} requests`);const n=calls;now+=31000;await c.refresh();assert.equal(calls,n,'host-wide cooldown must survive next tick');}finally{c.stop();}
});

test('L1: category-wide selection is unioned with team follows; team-only follows remain narrow',()=>{
    const {store:s}=makeStore();s.ingest([game()],NOW-100000);
    const opts={now:NOW,userId:'1',follow:['NFL: Another Team'],leagues:new Set(['NFL']),events:[]};
    assert.equal(dashboard.buildDashboard(s,opts).games.length,0);
    assert.equal(dashboard.buildDashboard(s,{...opts,broadLeagues:new Set(['NFL'])}).games.length,1);
});

test('L2: first-seen historic finals buffer without fabricating a recent finish, then disappear',()=>{
    const {store:s}=makeStore();s.ingest([game(0,{snapshot:{state:'finished',progress:{},scores:['24','21'],situation:null}})],NOW);
    assert.equal(s.catalog()[0].finishedAt,null);
    assert.equal(dashboard.buildDashboard(s,{now:NOW+1000,userId:'1'}).games[0].freshness,'buffering');
    assert.equal(dashboard.buildDashboard(s,{now:NOW+90000,userId:'1'}).games.length,0);
});

test('L3: one collection tick batches all candidate writes into a single ingest transaction',async()=>{
    const {store:s}=makeStore();let writes=0;
    const original=s.ingest;s.ingest=(...args)=>{writes++;return original(...args);};
    const batch=s.ingestBatch;if(batch)s.ingestBatch=(...args)=>{writes++;return batch(...args);};
    const c=dashboard.createCollector({store:s,leagues:()=>new Set(['NFL']),clock:()=>NOW,enabled:()=>true,fetchJson:async()=>({events:Array.from({length:20},(_,i)=>({competitions:[{id:String(i),date:'2026-10-29T00:00Z',status:{type:{state:'in'}},competitors:[{team:{id:'a',displayName:'A'}},{team:{id:'b',displayName:'B'}}]}]}))})});
    try{await c.refresh();assert.equal(s.catalog().length,20);assert.equal(writes,1);}finally{c.stop();}
});


test('M2: 429/5xx cooldown is shared by the real scoreboard client and the existing fixture client',async()=>{
    const original=global.fetch,flag=process.env.PIGTV_SPORTS_DASHBOARD;let calls=0;
    process.env.PIGTV_SPORTS_DASHBOARD='1';
    try{
        global.fetch=async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'120'}});};
        await assert.rejects(()=>espn.fetchJson(espn.BASE+'football/nfl/scoreboard'));
        const after=calls;
        const result=await require('../server/services/sportsFixturesEspn').fetchScoreboard('basketball/nba',NOW,NOW);
        assert.equal(result.ok,false);assert.equal(calls,after,'fixture client must respect the scoreboard throttle');
    }finally{global.fetch=original;if(flag===undefined)delete process.env.PIGTV_SPORTS_DASHBOARD;else process.env.PIGTV_SPORTS_DASHBOARD=flag;}
});

test('M3: clearly nearest cricket start wins overlapping multi-day windows; equal starts remain ambiguous',()=>{
    const first=game(1,{league:'Cricket',format:'test',start:NOW-72*H});
    const second=game(2,{league:'Cricket',format:'test',start:NOW,competitors:first.competitors,title:first.title});
    const e=event(1,{league:'Cricket',title:first.title,start:NOW,end:NOW+8*H});
    let joined=dashboard.matchBroadcasts([first,second],[e]);assert.equal(joined.get(second.id).length,1);assert.equal(joined.get(first.id).length,0);
    joined=dashboard.matchBroadcasts([{...first,start:NOW},second],[e]);assert.equal(joined.get(second.id).length,0);
});


test('M3: women’s T20 class labels use short-format windows, not an unknown five-day envelope',()=>{
    const p={events:[{id:'1',endDate:'2026-10-31T23:59Z',competitions:[{id:'1',date:'2026-10-29T01:00Z',endDate:'2026-10-31T23:59Z',class:{eventType:"Women's T20",generalClassCard:"Women's T20"},status:{type:{state:'pre'}},competitors:[{team:{id:'a',displayName:'Australia'}},{team:{id:'b',displayName:'India'}}]}]}]};
    const [g]=espn.normalize(p,'Cricket','cricket/123');assert.equal(g.format,'t20');assert.equal(g.end,null);
});

test('M1: a newer correction cannot remove a delayed final card through latest finishedAt metadata',()=>{
    const {store:s}=makeStore();s.updatePreferences('1',{scoreDelaySeconds:300,revision:0});
    s.ingest([game()],NOW-400000);
    s.ingest([game(0,{snapshot:{state:'finished',progress:{period:4},scores:['24','21'],situation:null}})],NOW-350000);
    const opts={now:NOW,userId:'1',events:[event()]};
    const before=dashboard.buildDashboard(s,opts).games;
    assert.equal(before.length,1);assert.equal(before[0].status,'finished');
    s.ingest([game(0,{snapshot:{state:'postponed',progress:{},scores:null,situation:null}})],NOW-1000);
    assert.deepEqual(dashboard.buildDashboard(s,opts).games,before);
});

test('M1: existing 0309 history upgrades final-transition times without trusting a newer catalog correction',()=>{
    const {store:s,db}=makeStore();s.updatePreferences('1',{scoreDelaySeconds:300,revision:0});
    s.ingest([game()],NOW-400000);
    s.ingest([game(0,{snapshot:{state:'finished',progress:{period:4},scores:['24','21'],situation:null}})],NOW-350000);
    s.ingest([game(0,{snapshot:{state:'postponed',progress:{},scores:null,situation:null}})],NOW-1000);
    // Restore the exact 0309 history payload shape, which lacked per-snapshot retention metadata.
    for(const row of db.prepare('SELECT * FROM sports_score_history').all()){
        const data=JSON.parse(row.data);delete data.finishedAt;
        db.prepare('UPDATE sports_score_history SET data=? WHERE game_id=? AND observed_at=?').run(JSON.stringify(data),row.game_id,row.observed_at);
    }
    const upgraded=createStore(db);
    const card=dashboard.buildDashboard(upgraded,{now:NOW,userId:'1',events:[event()]}).games[0];
    assert.equal(card.status,'finished');assert.equal(card.canWatch,false);
});
