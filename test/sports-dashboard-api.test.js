const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const express=require('express');
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'pigtv-dashboard-api-'));
fs.cpSync(path.join(__dirname,'../server'),path.join(sandbox,'server'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'../package.json'),path.join(sandbox,'package.json'));
fs.symlinkSync(path.resolve(__dirname,'../node_modules'),path.join(sandbox,'node_modules'),'junction');
const load=p=>require(path.join(sandbox,'server',p));
process.env.JWT_SECRET='test-only-sports-dashboard-key-at-least-32-characters';
process.env.PIGTV_DB_BACKUPS='0';
const auth=load('auth'),db=load('db'),dashboard=load('services/sportsDashboard');
let server,base,one,two,first,now;
before(async()=>{
    first=await db.users.create({username:'first',role:'viewer'});
    const second=await db.users.create({username:'second',role:'viewer'});
    one=auth.generateToken(first);two=auth.generateToken(second);
    load('db/sqlite').getDb().prepare('INSERT INTO sports_follow (position,keyword) VALUES(0,?)').run('NFL');
    load('services/sportsEvents').eventsFor=async()=>{throw new Error('H1: reference eventsFor must not run on the serving loop');};
    dashboard.buildDashboard=()=>{throw new Error('H1: projection must run on its worker');};
    load('services/sportsEvents').eventsResponse=async()=>({body:Buffer.from(JSON.stringify({events:[{id:'real-join',league:'NFL',title:'Chiefs v Bills',kind:'event',start:now-3600000,end:now+3600000,live:true,channels:[{sourceId:1,id:'pos_7',stableId:'stable7',name:'Sports HD',quality:'HD',providerPassword:'must-not-project'}]}]}))});
    now=Date.now();
    dashboard.store().ingest([{id:'espn:football/nfl:1',league:'NFL',title:'Chiefs v Bills',start:now-3600000,end:null,session:null,circuit:null,
        competitors:[{id:'12',name:'Chiefs',aliases:['Chiefs'],logo:null},{id:'2',name:'Bills',aliases:['Bills'],logo:null}],
        snapshot:{state:'live',progress:{clock:'5:00',period:2},scores:['17','14'],situation:{down:3}}}],now-100000);
    const app=express();app.use(express.json());app.use('/api/sports',load('routes/sports'));
    server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',err=>err?reject(err):resolve(s));});base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{dashboard.stop();load('services/sportsEvents').shutdown();if(server?.listening) await new Promise(r=>server.close(r));load('db/sqlite').getDb().close();fs.rmSync(sandbox,{recursive:true,force:true});});
async function request(url,token=one,body){const r=await fetch(base+url,{method:body?'PUT':'GET',headers:{...(token?{authorization:`Bearer ${token}`} : {}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,cache:r.headers.get('cache-control'),text:await r.text()};}

test('new routes authenticate and are disabled by default without starting a collector',async()=>{
    delete process.env.PIGTV_SPORTS_DASHBOARD;
    assert.equal((await request('/api/sports/dashboard',null)).status,401);
    assert.equal((await request('/api/sports/preferences')).status,404);
    assert.equal((await request('/api/sports/dashboard')).status,404);
});
test('two devices for one account share preferences; other accounts cannot read/write them',async()=>{
    process.env.PIGTV_SPORTS_DASHBOARD='1';
    const a=await request('/api/sports/preferences');assert.equal(a.status,200);assert.match(a.cache,/private.*no-store/);
    const revision=JSON.parse(a.text).revision;
    assert.equal((await request('/api/sports/preferences',one,{avoidSpoilers:true,revision})).status,200);
    const paired=load('services/deviceAuth');
    // A second valid bearer for this account uses the same server-backed preference row.
    const pairing=paired.startPairing({name:'Second TV',platform:'tvOS'});
    paired.approvePairing(pairing.code,first,{});
    const secondDevice=paired.pollPairing(pairing.code).token;
    assert.equal(JSON.parse((await request('/api/sports/preferences',secondDevice)).text).avoidSpoilers,true);
    assert.equal(JSON.parse((await request('/api/sports/preferences',two)).text).avoidSpoilers,false);
    assert.equal((await request('/api/sports/preferences',one,{userId:'2',avoidSpoilers:false,revision:1})).status,400);
    assert.equal((await request('/api/sports/preferences',one,{avoidSpoilers:false,revision:0})).status,409);
    assert.ok(secondDevice,'a real paired-device token reads the same user preference');
});
test('dashboard projects scores for the authenticated preference and validates league scope',async()=>{
    process.env.PIGTV_SPORTS_DASHBOARD='1';
    const hidden=await request('/api/sports/dashboard');assert.equal(hidden.status,200);assert.match(hidden.cache,/private.*no-store/);
    const a=JSON.parse(hidden.text);assert.equal(a.games.length,1);assert.equal(a.games[0].scores,undefined);
    assert.equal(a.games[0].progress.clock,'5:00');assert.equal(a.games[0].availability,'matched');
    assert.equal(a.games[0].channels[0].stableId,'stable7');
    assert.equal(a.games[0].channels[0].providerPassword,undefined);
    assert.equal(a.games[0].canWatch,true);
    const shown=JSON.parse((await request('/api/sports/dashboard',two)).text);assert.deepEqual(shown.games[0].scores,['17','14']);
    assert.equal((await request('/api/sports/dashboard?league=bad')).status,400);
    assert.equal(JSON.parse((await request('/api/sports/dashboard?league=NFL')).text).hours,72);
});
