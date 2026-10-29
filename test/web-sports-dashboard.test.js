const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function load(api = {}) {
    const context = vm.createContext({ window: {}, API: api, performance: { now: () => 0 },
        localStorage: { getItem: () => 'account-token' }, setTimeout, clearTimeout,
        document: { hidden: false, addEventListener() {} } });
    vm.runInContext(fs.readFileSync('public/js/pages/SportsPage.js', 'utf8'), context);
    return context.window;
}
const game = (extra = {}) => ({ id: 'g', league: 'NBA', title: 'A v B', status: 'live', freshness: 'fresh',
    progress: { period: 5, clock: '1:20' }, scores: ['99', '98'], availability: 'matched', canWatch: true,
    channels: [{ sourceId: 1, stableId: 'stable', id: 'pos_1', name: 'TV' }],
    events: [{ id: 'e', start: 100, end: 1000 }], ...extra });
const reply = (extra = {}) => ({ now: 500, timezone: 'Australia/Melbourne', leagues: ['NBA'],
    preferences: { revision: 0, avoidSpoilers: false, scoreDelaySeconds: 90 }, games: [game()], ...extra });
function model(api) {
    const w = load(api);
    const m = new w.SportsDashboardState(api, () => 'account-token', () => 0);
    m.active = true;
    return { w, m };
}
test('seven sport families and all ten follows have a family', () => {
    const p = load().SportsDashboardPolicy;
    assert.equal(new Set(['AFL','NBA','EPL','NFL','MLB','Cricket','F1'].map(p.family)).size, 7);
    for (const s of ['FA Cup','UEFA','Championship']) assert.equal(p.family(s), 'football');
});
test('hidden/stale scores and F1 timing cannot leak through card HTML or accessibility', () => {
    const p = load().SportsDashboardPolicy;
    for (const g of [game(), game({ freshness: 'stale' }), game({ league: 'F1' })]) {
        const html = p.card(g, { avoidSpoilers: true }, 'UTC');
        assert.doesNotMatch(html, /99|98|Total points/);
    }
    assert.doesNotMatch(p.card(game({ league: 'F1' }), { avoidSpoilers: false }, 'UTC'), /1:20|99|98/);
});
test('one time row, no repeated shelf name, corner availability labels and safe cached logos', () => {
    const p = load().SportsDashboardPolicy;
    const html = p.card(game({ start: 1234567890000, availability: 'unmatched',
        competitors: [{name: '<team>', logo:'https://remote/logo'}, { name:'B', logo:'/api/logo/cached' }] }), {}, 'UTC');
    assert.match(html, /Overtime 1/);
    assert.doesNotMatch(html, /2009|NBA|remote\/logo|<team>/);
    assert.match(html, /No channel found/);
    assert.match(html, /\/api\/logo\/cached/);
    assert.match(p.card(game({ status:'scheduled' }), {}, 'UTC'), /UPCOMING/);
});
test('final and expired airings never watch; cached live bit cannot permit early playback', () => {
    const p = load().SportsDashboardPolicy;
    assert.equal(p.airing(game({ status:'finished' }), 500, true), undefined);
    assert.equal(p.airing(game(), 1000, true), undefined);
    assert.equal(p.airing(game({ events:[{ start:501, end:1000, live:true }] }), 500, true), undefined);
    assert.equal(p.airing(game(), 500, true).id, 'e');
});
test('first render has no prefs; failed refresh clears previously revealed state', async () => {
    let fail = false;
    const { m } = model({ dashboard: async () => { if(fail) throw Error('offline'); return reply(); } });
    assert.equal(m.response, null);
    assert.equal(await m.load(), true);
    fail = true;
    assert.equal(await m.load(), false);
    assert.equal(m.response, null);
});
test('late response from prior scope/account/background cannot republish scores', async () => {
    let resolve;
    const { m } = model({ dashboard: () => new Promise(r => resolve = r) });
    const pending = m.load();
    m.clear(); m.active = false;
    resolve(reply());
    assert.equal(await pending, false);
    assert.equal(m.response, null);
});
test('overlapping requests publish only newest complete delayed snapshot', async () => {
    let resolve, calls = 0;
    const { m } = model({ dashboard: () => ++calls === 1 ? new Promise(r => resolve=r) : Promise.resolve(reply({now:600})) });
    const first = m.load();
    await m.load();
    resolve(reply()); await first;
    assert.equal(m.response.now, 600);
});
test('identity change invalidates a pending response', async () => {
    let resolve, identity = 'one';
    const w = load();
    const m = new w.SportsDashboardState({dashboard:()=> new Promise(r=> resolve=r)}, ()=>identity, ()=>0);
    m.active = true;
    const pending = m.load(); identity = 'two'; resolve(reply()); await pending;
    assert.equal(m.response, null);
});
test('preference revision conflict rereads and asks for an explicit retry, never blind overwrite', async () => {
    let writes=0;
    const {m} = model({dashboard:async()=>reply({preferences:{revision:2,avoidSpoilers:true,scoreDelaySeconds:100}}),
        savePreferences:async data => { writes++; assert.equal(data.revision, 2); throw Object.assign(Error(),{status:409}); }});
    await m.load(); await m.save({avoidSpoilers:false,scoreDelaySeconds:0});
    assert.equal(writes,1); assert.equal(m.response.preferences.revision,2);
    assert.match(m.message,/another device/);
});
test('recording associates selected stable channel with its own airing and safe projected title', async () => {
    const {m} = model({dashboard:async()=>reply({games:[game({events:[{id:'other',start:100,end:900},{id:'e',start:200,end:1000}]})]}),
        events:async()=>({events:[{id:'other',start:100,end:900,channels:[{sourceId:1,stableId:'other'}]},
            {id:'e',title:'99 defeats 98',aliases:['spoiler'],start:200,end:1000,channels:game().channels}]})});
    const selected = await m.action('g','1:stable',false);
    assert.equal(selected.event.id,'e'); assert.equal(selected.title,'A v B');
    assert.equal(selected.event.start,200); assert.equal(selected.aliases,undefined);
    assert.equal(await m.action('g','1:missing',false),null);
});
test('recording response after backgrounding cannot enable an action', async () => {
    let resolve;
    const {m} = model({dashboard:async()=>reply(),events:()=>new Promise(r=> resolve=r)});
    const pending = m.action('g',null,false); await new Promise(setImmediate);
    m.active=false; m.clear(); resolve({events:[]});
    assert.equal(await pending,null);
});
test('stable card order retains a focused expired placeholder until focus moves', () => {
    const p = load().SportsDashboardPolicy;
    assert.deepEqual([...p.order(['a','b'],['b','c'],'a')],['a','b','c']);
    assert.deepEqual([...p.order(['a','b','c'],['b','c'],null)],['b','c']);
});
test('recording takes the current item ID from the selected channel airing after reorder', async () => {
    const {m}=model({dashboard:async()=>reply(),events:async()=>({events:[{id:'e',start:100,end:1000,
        channels:[{...game().channels[0],id:'pos_8'}]}]})});
    const selected=await m.action('g','1:stable',false);
    assert.equal(selected.channel.id,'pos_8');
});
test('dashboard 404 falls back to a rolling 72h ordinary schedule with actions', async () => {
    let reads=0;
    const {m}=model({dashboard:async()=>{throw Object.assign(Error(),{status:404});},events:async()=>{
        reads++;return {now:500,events:[{id:'e',title:'Ordinary event',league:'NBA',start:100,end:1000,channels:game().channels}]};}});
    assert.equal(await m.load(),true);
    assert.equal(m.legacy,true);
    assert.equal(m.response.games[0].title,'Ordinary event');
    assert.ok(await m.action('e',null,true));
    assert.equal(reads,2);
});
test('recording badge has explicit text and strict source/stable identity', () => {
    const p=load().SportsDashboardPolicy;
    assert.equal(p.recording(game(),[{source_id:1,channel_stable_id:'stable',channel_item_id:'pos_99'}]),true);
    assert.equal(p.recording(game(),[{source_id:2,channel_stable_id:'stable'}]),false);
    assert.equal(p.recording(game(),[{source_id:1,channel_stable_id:'gone',channel_item_id:'pos_1'}]),false);
    assert.match(p.card(game(),{},'UTC',true),/Recording/);
});
test('a settings form captured at an older revision cannot overwrite the newer polled settings', async () => {
    let writes=0;
    const {m}=model({dashboard:async()=>reply({preferences:{revision:2,avoidSpoilers:true,scoreDelaySeconds:100}}),savePreferences:async()=>{writes++;}});
    await m.load(); await m.save({avoidSpoilers:false,scoreDelaySeconds:0},1);
    assert.equal(writes,0);
    assert.match(m.message,/changed/);
});
test('web API uses authenticated C-O routes, encoded league filters and preserves revision conflict status', async () => {
    const calls=[];
    const c=vm.createContext({localStorage:{getItem:()=> 'synthetic'},window:{},fetch:async(url,options)=>{
        calls.push({url,...options}); return {ok:options.method!=='PUT',status:options.method==='PUT'?409:200,
            headers:{get:()=> 'application/json'},json:async()=>({error:'conflict'})}; }});
    vm.runInContext(fs.readFileSync('public/js/api.js','utf8'),c);
    const api=vm.runInContext('API',c);
    await api.sports.dashboard('FA Cup');
    assert.equal(calls[0].url,'/api/sports/dashboard?league=FA%20Cup');
    assert.equal(calls[0].headers.Authorization,'Bearer synthetic');
    await assert.rejects(api.sports.savePreferences({revision:1,avoidSpoilers:true}),e=>e.status===409);
    assert.equal(JSON.parse(calls[1].body).revision,1);
});
test('select revalidates expired/final cards before any existing channel player is called', async () => {
    let plays=0;
    const {w,m}=model({dashboard:async()=>reply({games:[game({status:'finished'})]})});
    const page=Object.create(w.SportsPage.prototype);
    Object.assign(page,{state:m,app:{channelList:{loadSources:async()=>{},loadChannels:async()=>{},
        channels:game().channels,selectChannel:()=>plays++}},notice(){},closeDialog(){}});
    await page.perform('g',null,'watch');
    assert.equal(plays,0);
});
test('record-every-game choices use neutral league/team metadata, never score prose', () => {
    const p=load().SportsDashboardPolicy;
    const choices=p.ruleChoices(game({title:'A wins 99 to 98',competitors:[{name:'Chiefs'},{name:'Bills'}],league:'NFL'}));
    assert.deepEqual([...choices],['NFL','NFL: Chiefs','NFL: Bills']);
    assert.doesNotMatch(choices.join(','),/wins|99|98/);
    assert.deepEqual([...p.ruleChoices(game({league:'F1',competitors:[]}))],['F1']);
});
test('global recording banner cannot expose raw programme result prose over the Sport dashboard', async () => {
    const text={textContent:''}, banner={style:{}};
    const c=vm.createContext({window:{},document:{addEventListener(){},getElementById:id=>id==='recording-banner-text'?text:banner},
        API:{recordings:{getActive:async()=>[{title:'A defeats B 101-99',channel_name:'Sports',program_end:1000}]}}});
    vm.runInContext(fs.readFileSync('public/js/app.js','utf8'),c);
    const app=Object.create(vm.runInContext('App.prototype',c)); app.currentPage='sports';
    await app.updateRecordingBanner();
    assert.doesNotMatch(text.textContent,/defeats|101-99/);
    assert.match(text.textContent,/Recording/);
});
test('entering Sport masks an already visible raw recording title synchronously', () => {
    const text={textContent:'Recording A defeats B 101-99'};
    const c=vm.createContext({window:{},history:{pushState(){}},document:{addEventListener(){},querySelectorAll:()=>[],getElementById:()=>text}});
    vm.runInContext(fs.readFileSync('public/js/app.js','utf8'),c);
    const app=Object.create(vm.runInContext('App.prototype',c)); Object.assign(app,{currentPage:'home',pages:{},currentUser:{role:'admin'}});
    app.navigateTo('sports');
    assert.doesNotMatch(text.textContent,/defeats|101-99/);
});
test('visible polling cannot republish old revealed scores while a preference write is pending', async () => {
    let finish, reads=0;
    const {m}=model({dashboard:async()=>{reads++;return reply();},savePreferences:()=>new Promise(r=>finish=r)});
    await m.load();
    const save=m.save({avoidSpoilers:true,scoreDelaySeconds:90});
    assert.equal(m.response,null);
    assert.equal(await m.load(),false);
    assert.equal(m.response,null);
    assert.equal(reads,1);
    finish(); await save;
});
test('authentication invalidated inside a refresh hides an already revealed snapshot', async () => {
    let identity='account', invalidate=false;
    const w=load();
    const m=new w.SportsDashboardState({dashboard:async()=>{
        if(invalidate){identity=null;throw Object.assign(Error(),{status:401});}return reply();}},()=>identity,()=>0);
    m.active=true; await m.load(); invalidate=true; await m.load();
    assert.equal(m.response,null);
});
test('hidden football never labels penalties, even from a server that projects period 5', () => {
    const p=load().SportsDashboardPolicy;
    for (const status of ['live','finished']) {
        const g=game({league:'EPL',status,progress:{period:5,clock:"120'"}});
        assert.doesNotMatch(p.card(g,{avoidSpoilers:true},'UTC'),/Penalties/);
        assert.match(p.card(g,{avoidSpoilers:false},'UTC'),/Penalties/);
    }
});
test('Record series is offered only for a real guide title, never a projected or masked one', () => {
    const p=load().SportsDashboardPolicy;
    assert.equal(p.guideTitle(game(),false),false,'score-feed titles are "A v B", not guide titles');
    assert.equal(p.guideTitle(game({dataSource:'guide',title:'NFL · Guide event'}),true),false);
    assert.equal(p.guideTitle(game({dataSource:'guide',title:'NFL: Chiefs at Bills'}),false),true);
});
test('league filters are canonical response leagues; guide-only leagues keep a shelf but no 400 filter', () => {
    const p=load().SportsDashboardPolicy, r=reply({leagues:['NFL'],games:[game({league:'NFL'}),game({id:'x',league:'A-League'})]});
    assert.deepEqual([...p.filters(r,false)],['NFL']);
    assert.deepEqual([...p.filters(r,true)],['NFL','A-League'],'ordinary Sport filters locally, so any league is safe');
});
test('Watch when it starts re-arms, not consumes, when the timer fires before the server start', async () => {
    const timers=[], context=vm.createContext({window:{},API:{},performance:{now:()=>0},localStorage:{getItem:()=>'account-token'},
        setTimeout:(fn,ms)=>timers.push({fn,ms}),clearTimeout(){},document:{hidden:false,addEventListener(){}}});
    vm.runInContext(fs.readFileSync('public/js/pages/SportsPage.js','utf8'),context);
    const w=context.window;
    let serverNow=500, clock=0, plays=0, notices=[];
    const upcoming=()=>reply({now:serverNow,games:[game({canWatch:serverNow>=600,events:[{id:'e',start:600,end:2000}]})]});
    // Each request takes 200 ms, so now() runs a whole round trip ahead of the server clock.
    const m=new w.SportsDashboardState({dashboard:async()=>{clock+=200;return upcoming();},
        events:async()=>({events:[{id:'e',start:600,end:2000,channels:game().channels}]})},()=>'account-token',()=>clock);
    m.active=true;
    const page=Object.create(w.SportsPage.prototype);
    Object.assign(page,{state:m,cancelWait:{hidden:true},notice:t=>notices.push(t),closeDialog(){},app:{navigateTo(){},channelList:{
        loadSources:async()=>{},loadChannels:async()=>{},channels:game().channels,selectChannel:async()=>{plays++;}}}});
    await page.perform('g',null,'wait');
    assert.equal(timers.length,1);
    await timers[0].fn();
    assert.equal(plays,0); assert.equal(timers.length,2,'early fire re-arms the scheduled watch');
    assert.equal(page.cancelWait.hidden,false); assert.ok(!notices.some(t=>/no longer watchable/.test(t)));
    serverNow=650; await timers[1].fn();
    assert.equal(plays,1);
});
