// Second adversarial review of the 0309-0317 sports dashboard (Eastern-date hot lane, penalties, delayed pruning).
const {test,after,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const dashboard=require('../server/services/sportsDashboard');
const espn=require('../server/services/sportsScoresEspn');
const {createStore}=require('../server/services/sportsDashboardStore');
const policy=require('../server/services/espnRequestPolicy');
const H=3600000,databases=[];
const store=()=>{const db=new Database(':memory:');databases.push(db);return createStore(db);};
afterEach(()=>policy.reset());
after(()=>databases.forEach(db=>db.close()));

test('a live game ESPN lists under the previous Eastern date polls on the 30-second lane',async()=>{
    // NFL Monday night: ESPN lists it under dates=20261026 (ET) though it starts 2026-10-27T00:15Z (captured evidence).
    const START=Date.parse('2026-10-27T00:15Z'),s=store(),fetched=[];
    let now=Date.parse('2026-10-27T00:40Z');
    const payload={events:[{date:new Date(START).toISOString(),competitions:[{id:'401',date:new Date(START).toISOString(),
        status:{period:2,displayClock:'5:00',type:{state:'in',completed:false,name:'STATUS_IN_PROGRESS',description:'In Progress'}},
        competitors:[{team:{id:'12',displayName:'Kansas City Chiefs'},score:'7'},{team:{id:'2',displayName:'Buffalo Bills'},score:'0'}]}]}]};
    const c=dashboard.createCollector({store:s,leagues:()=>new Set(['NFL']),clock:()=>now,enabled:()=>true,
        fetchJson:async url=>{fetched.push(url);return url.includes('dates=20261026') ? payload : {events:[]};}});
    try{for(let i=0;i<40;i++){await c.refresh();now+=30000;}}finally{c.stop();}
    const hits=fetched.filter(u=>u.includes('dates=20261026')).length;
    assert.ok(hits>=38,`the URL carrying the live game was fetched on ${hits} of 40 ticks`);
    const card=dashboard.buildDashboard(s,{now,userId:'1',league:'NFL',timezone:'Australia/Melbourne'}).games[0];
    assert.equal(card.status,'live');assert.equal(card.freshness,'fresh');
});

const shootout=(state,completed,name,at)=>({events:[{date:new Date(at-3*H).toISOString(),competitions:[{id:'9',date:new Date(at-3*H).toISOString(),
    status:{period:5,displayClock:"120'",type:{state,completed,name,description:name}},
    competitors:[{team:{id:'1',displayName:'Arsenal'},score:'1'},{team:{id:'2',displayName:'Chelsea'},score:'1'}]}]}]});
test('hidden football never projects the penalties period, live or final',()=>{
    const NOW=Date.parse('2026-10-29T10:00Z');
    global.window={};require('../public/js/pages/SportsPage.js');
    for(const [state,completed,name] of [['in',false,'STATUS_SHOOTOUT'],['post',true,'STATUS_FINAL_PEN']]) {
        const s=store();
        s.ingest(espn.normalize(shootout('in',false,'STATUS_IN_PROGRESS',NOW),'EPL','soccer/eng.1'),NOW-200000);
        s.ingest(espn.normalize(shootout(state,completed,name,NOW),'EPL','soccer/eng.1'),NOW-60000);
        s.updatePreferences('1',{avoidSpoilers:true,scoreDelaySeconds:0,revision:0});
        const hidden=dashboard.buildDashboard(s,{now:NOW,userId:'1',league:'EPL',timezone:'UTC'});
        assert.equal(hidden.games[0].progress.period,undefined,`${name} reveals penalties`);
        assert.equal(hidden.games[0].progress.clock,"120'",'extra time stays visible progress');
        assert.doesNotMatch(window.SportsDashboardPolicy.card(hidden.games[0],hidden.preferences,'UTC'),/Penalties/);
        s.updatePreferences('2',{avoidSpoilers:false,scoreDelaySeconds:0,revision:0});
        assert.equal(dashboard.buildDashboard(s,{now:NOW,userId:'2',league:'EPL',timezone:'UTC'}).games[0].progress.period,5);
    }
});

const NOW=Date.parse('2026-10-29T03:00Z');
const game=(state,extra={})=>({id:'espn:football/nfl:1',league:'NFL',start:NOW-2*H,end:null,title:'A v B',session:null,circuit:null,
    competitors:[{id:'1',name:'A',aliases:['A'],logo:null},{id:'2',name:'B',aliases:['B'],logo:null}],
    snapshot:{state,progress:{period:3,clock:'1:00'},scores:['7','3'],situation:null},...extra});
test('a slowly polled game keeps its delayed-eligible snapshot across pruning',()=>{
    const s=store(),t0=NOW-15*60000-10000;
    s.ingest([game('live')],t0);s.prune(t0);
    s.ingest([game('live')],NOW);s.prune(NOW);
    // Just after the next cold poll (90 s delay) the t0 snapshot is the only eligible one: honestly stale, not buffering.
    let card=dashboard.buildDashboard(s,{now:NOW+30000,userId:'1',league:'NFL',timezone:'UTC'}).games[0];
    assert.deepEqual({freshness:card.freshness,observedAt:card.observedAt},{freshness:'stale',observedAt:t0});
    card=dashboard.buildDashboard(s,{now:NOW+95000,userId:'1',league:'NFL',timezone:'UTC'}).games[0];
    assert.deepEqual({status:card.status,freshness:card.freshness},{status:'live',freshness:'fresh'});
});
test('a slowly polled final with a running guide airing stays unwatchable after pruning',()=>{
    const s=store(),t0=NOW-15*60000-10000;
    const airing={id:'event1',league:'NFL',title:'A v B',kind:'event',start:NOW-2*H,end:NOW+H,live:true,
        channels:[{sourceId:1,id:'pos_1',stableId:'301',name:'ESPN',quality:'HD'}]};
    s.ingest([game('live')],t0-15*60000);s.prune(t0-15*60000);
    s.ingest([game('finished')],t0);s.prune(t0);
    s.ingest([game('finished')],NOW);s.prune(NOW);
    const card=dashboard.buildDashboard(s,{now:NOW+30000,userId:'1',events:[airing],timezone:'UTC'}).games[0];
    assert.equal(card.canWatch,false);assert.deepEqual(card.channels,[]);assert.equal(card.freshness,'stale');
});
