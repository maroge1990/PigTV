// Review evidence: assertions document defects in 0226, not desired behaviour.
// Temporary database, synthetic playlist/parser, no network or provider connection.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pigtv-services-review-'));
fs.cpSync(path.join(root,'server'),path.join(temp,'server'),{recursive:true});
fs.copyFileSync(path.join(root,'package.json'),path.join(temp,'package.json'));
fs.symlinkSync(path.join(root,'node_modules'),path.join(temp,'node_modules'),'junction');
const load=p=>require(path.join(temp,'server',p));
(async()=>{
 const db=load('db'),sqlite=load('db/sqlite'),sync=load('services/syncService'),filter=load('services/importFilters');
 const source=await db.sources.create({type:'m3u',name:'Synthetic',url:'http://provider.invalid/list'});
 load('services/m3uParser').fetchAndParseStreaming=async function*(){yield {channels:[
 {position:1,name:'News',groupTitle:'News',url:'http://provider.invalid/live/u/p/101.ts'},
 {position:2,name:'Sport',groupTitle:'Sport',url:'http://provider.invalid/live/u/p/102.ts'}],groups:['News','Sport']};};
 const d=sqlite.getDb(),rows=()=>d.prepare("SELECT item_id,category_id FROM playlist_items WHERE source_id=? AND type='live'").all(source.id);
 await sync.syncM3u(source);assert.equal(rows().length,2);
 assert.equal((await filter.setExcluded(source.id,['News','Sport'])).ok,true);
 await sync.syncM3u(source);assert.equal(rows().length,2);
 console.log('REPRODUCED: excluding every populated group retains all old live rows.');
 await filter.setExcluded(source.id,['Sport']);
 const sport=rows().find(x=>x.category_id==='Sport');
 d.prepare("INSERT INTO favorites(user_id,source_id,item_id,item_type) VALUES(1,?,?,'channel')").run(source.id,sport.item_id);
 assert.equal(filter.blockers(source.id,['Sport']).length,1);
 await sync.syncM3u(source);assert.equal(rows().some(x=>x.category_id==='Sport'),false);
 console.log('REPRODUCED: a favourite added after exclusions were saved is purged on sync despite blocker.');
 const b=load('services/dbBackup'),now=Date.UTC(2026,9,21);
 const copies=await Promise.allSettled([b.backup(sqlite.databasePath(),{reason:'manual',now}),b.backup(sqlite.databasePath(),{reason:'manual',now})]);
 assert.ok(copies.some(x=>x.status==='rejected'));
 console.log('Concurrent backup results:',copies.map(x=>({status:x.status,error:x.reason?.code}))); 
 console.log('REPRODUCED: concurrent same-second manual backups collide; at least one rejects.');
 sqlite.getDb().close();
 const e=load('services/eventChannels'),s=load('services/sportsEvents');
 const from=Date.UTC(2026,9,1),channels=[
 {key:'1:a',id:'a',sourceId:1,name:'NHL: Pittsburgh vs Philadelphia @ Oct 1 7:30 PM :Sportsnet+ 12',tvgId:'shared-placeholder',sportChannel:true,order:0},
 {key:'1:b',id:'b',sourceId:1,name:'NHL: Boston vs Toronto @ Oct 1 7:30 PM :Sportsnet+ 13',tvgId:'shared-placeholder',sportChannel:true,order:1}];
 const p=e.syntheticProgrammes(channels,[],from,from+72*3600000,from);
 const events=s.eventsFromProgrammes(channels,p,['NHL']);
 assert.equal(events.length,2);assert.ok(events.every(x=>x.channels.length===2));
 console.log('REPRODUCED: distinct named slot events sharing a placeholder tvg-id each claim both channels.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
