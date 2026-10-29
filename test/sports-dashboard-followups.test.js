const {test,after,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const Database=require('better-sqlite3');
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'pigtv-sports-followups-'));
fs.cpSync(path.join(__dirname,'../server'),path.join(sandbox,'server'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../package.json'),path.join(sandbox,'package.json'));
fs.symlinkSync(path.resolve(__dirname,'../node_modules'),path.join(sandbox,'node_modules'),'junction');
process.env.PIGTV_DB_BACKUPS='0';
const load=p=>require(path.join(sandbox,'server',p));
const fixtures=load('services/sportsFixtures'),policy=load('services/espnRequestPolicy');
const dashboard=load('services/sportsDashboard'),{createStore}=load('services/sportsDashboardStore');
const db=load('db/sqlite').getDb(),memory=[];
const H=3600000,NOW=Date.parse('2026-10-29T01:00Z');
afterEach(()=>{fixtures.stopBackgroundRefresh();policy.reset();});
after(()=>{fixtures.stopBackgroundRefresh();db.close();memory.forEach(d=>d.close());fs.rmSync(sandbox,{recursive:true,force:true});});
function follows(){db.prepare('DELETE FROM sports_follow').run();db.prepare('DELETE FROM sport_fixture_status').run();for(const [i,name] of ['NFL','NBA','MLB'].entries())db.prepare('INSERT INTO sports_follow(position,keyword) VALUES(?,?)').run(i,name);}
function fixtureFetch(calls){let failed=false;return async url=>{calls.push(String(url));if(!failed){failed=true;return {ok:false,status:503,headers:{get:()=>null}};}return {ok:true,status:200,headers:{get:()=>null},json:async()=>({events:[],sports:[]})};};}

test('N1: dashboard off preserves legacy sequential fixture refresh after the first league gets a 503',async()=>{
    const old=global.fetch,flag=process.env.PIGTV_SPORTS_DASHBOARD;delete process.env.PIGTV_SPORTS_DASHBOARD;follows();const calls=[];
    try{global.fetch=fixtureFetch(calls);await fixtures.refreshAll(NOW);assert.ok(calls.some(u=>u.includes('basketball/nba/scoreboard')),'NBA skipped after NFL 503');assert.ok(calls.some(u=>u.includes('baseball/mlb/scoreboard')),'MLB skipped after NFL 503');}
    finally{global.fetch=old;if(flag===undefined)delete process.env.PIGTV_SPORTS_DASHBOARD;else process.env.PIGTV_SPORTS_DASHBOARD=flag;}
});

test('N1: enabled shared cooldown retries deferred fixture leagues when it expires, not 30 minutes later',async t=>{
    const old=global.fetch,flag=process.env.PIGTV_SPORTS_DASHBOARD;process.env.PIGTV_SPORTS_DASHBOARD='1';follows();const calls=[];
    t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});
    try{global.fetch=fixtureFetch(calls);await fixtures.refreshAll(NOW);assert.ok(!calls.some(u=>u.includes('basketball/nba/scoreboard')));
        const nbaBefore=db.prepare('SELECT last_error FROM sport_fixture_status WHERE league=?').get('NBA');assert.equal(nbaBefore,undefined,'deferred league must not be recorded as an upstream failure');
        t.mock.timers.tick(61000);await new Promise(r=>setImmediate(r));
        assert.ok(calls.some(u=>u.includes('basketball/nba/scoreboard')),'no automatic NBA retry after cooldown');assert.ok(calls.some(u=>u.includes('baseball/mlb/scoreboard')));
    }finally{global.fetch=old;fixtures.stopBackgroundRefresh();if(flag===undefined)delete process.env.PIGTV_SPORTS_DASHBOARD;else process.env.PIGTV_SPORTS_DASHBOARD=flag;}
});

test('N2: 14 hot leagues over 40 ticks cannot starve any requested catalog/future URL',async t=>{
    const sql=new Database(':memory:');memory.push(sql);const store=createStore(sql);let now=NOW;const calls=[];
    const leagueNames=Object.keys(fixtures.ESPN_LEAGUE_PATHS).filter(k=>k!=='UEFA').slice(0,14);
    const games=leagueNames.map((league,i)=>({id:`espn:${fixtures.ESPN_LEAGUE_PATHS[league]}:${i}`,league,start:NOW-H,end:null,title:`A${i} v B${i}`,session:null,circuit:null,format:null,competitors:[],snapshot:{state:'live',progress:{},scores:null,situation:null}}));store.ingest(games,NOW);
    const collector=dashboard.createCollector({store,leagues:()=>new Set(leagueNames),clock:()=>now,enabled:()=>true,fetchJson:async u=>{calls.push(String(u));return {events:[]};}});
    try{for(let i=0;i<40;i++){const n=calls.length;await collector.refresh();assert.ok(calls.length-n<=12,'tick budget exceeded');now+=31000;}
        const distinct=new Set(calls),future=[...distinct].filter(u=>/dates=202610(?:30|31)/.test(u)||u.includes('dates=20261101'));
        t.diagnostic(`distinct=${distinct.size}, future=${future.length}`);assert.ok(future.length>0,'hot work starved all future URLs');
        for(const league of leagueNames){const source=fixtures.ESPN_LEAGUE_PATHS[league];assert.ok([...distinct].some(u=>u.includes(`/${source}/scoreboard?dates=20261101`)),`${league} future catalog starved`);}
    }finally{collector.stop();}
});

test('L1: a hung worker job times out, is terminated, and queued/subsequent work uses a replacement',async()=>{
    const instances=[],timers=new Map();let nextTimer=0;
    class FakeWorker extends EventEmitter{
        constructor(){super();instances.push(this);this.index=instances.length;this.terminated=false;}
        ref(){} unref(){}
        postMessage(message){if(this.index>1)queueMicrotask(()=>this.emit('message',{id:message.id,response:{replacement:true}}));}
        terminate(){this.terminated=true;queueMicrotask(()=>this.emit('exit',0));return Promise.resolve();}
    }
    const module={exports:{}};
    const context={module,exports:module.exports,__dirname:path.join(sandbox,'server/services'),Buffer,Promise,
        require:name=>name==='node:worker_threads'?{Worker:FakeWorker}:name==='../db/sqlite'?{databasePath:()=>'/unused'}:require(name),
        setTimeout:(fn,ms)=>{const key=++nextTimer;timers.set(key,{fn,ms});return {key,unref(){}};},clearTimeout:handle=>timers.delete(handle?.key)};
    vm.runInNewContext(fs.readFileSync(path.join(sandbox,'server/services/sportsDashboardResponse.js'),'utf8'),context);
    const client=module.exports;
    const pending=Promise.allSettled([client.response({}),client.response({})]);
    try{assert.equal(timers.size,1,'active job has no timeout');const [key,timeout]=timers.entries().next().value;assert.ok(timeout.ms<=15000);timers.delete(key);timeout.fn();
        const result=await pending;assert.equal(result[0].status,'rejected');assert.match(result[0].reason.message,/timed out/i);assert.equal(result[1].status,'fulfilled');assert.equal(result[1].value.replacement,true);
        assert.ok(instances[0].terminated);assert.equal(instances.length,2);assert.equal(timers.size,0,'successful job leaked timeout');
        assert.equal((await client.response({})).replacement,true);
    }finally{client.close();await pending;}
});

test('N1: a successful intervening fixture pass cancels an obsolete cooldown retry',async t=>{
    const old=global.fetch,flag=process.env.PIGTV_SPORTS_DASHBOARD;process.env.PIGTV_SPORTS_DASHBOARD='1';follows();const calls=[];
    t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});
    try{global.fetch=fixtureFetch(calls);await fixtures.refreshAll(NOW);
        t.mock.timers.tick(60000);await fixtures.refreshAll(Date.now());const n=calls.length;
        t.mock.timers.tick(1000);await new Promise(r=>setImmediate(r));assert.equal(calls.length,n,'obsolete retry duplicated the successful pass');
    }finally{global.fetch=old;fixtures.stopBackgroundRefresh();if(flag===undefined)delete process.env.PIGTV_SPORTS_DASHBOARD;else process.env.PIGTV_SPORTS_DASHBOARD=flag;}
});
