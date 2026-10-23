// Review evidence against 0241: expected defective behaviour, not a regression test.
// Uses a temporary copy, SQLite and synthetic tool results; no sockets/provider/ffmpeg.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-dvr-review-'));
fs.cpSync(path.join(root, 'server'), path.join(sandbox, 'server'), {recursive:true});
fs.copyFileSync(path.join(root, 'package.json'), path.join(sandbox, 'package.json'));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), 'junction');
const load = p => require(path.join(sandbox, 'server', p));
(async () => {
 const db = load('db'), sqlite = load('db/sqlite');
 const engine = load('services/recordingEngine'); engine._setPrepareQueue(false);
 const {scheduled,recordings,initSchema} = load('db/recordingsDb'); initSchema();
 const source = await db.sources.create({type:'m3u',name:'Synthetic',url:'http://provider.invalid/list'});
 const d = sqlite.getDb();
 d.prepare(`INSERT INTO playlist_items(id,source_id,item_id,type,name,category_id,stream_url,data,sort_order,stable_id,tvg_id) VALUES(?,?,'pos_1','live','Replacement','Sport','http://provider.invalid/replacement','{}',1,'replacement','replacement.epg')`).run(`${source.id}:pos_1`,source.id);
 const now=Date.now(), start=now+3600000;
 const sports=load('services/sportsEvents');
 let eventStart=start, eventID='original';
 sports.eventsFor=async()=>({events:[{id:eventID,kind:'event',title:'AFL: Collingwood v Carlton',aliases:[],league:'AFL',start:eventStart,end:eventStart+3600000,channels:[{sourceId:source.id,id:'pos_1',name:'Replacement'}]}]});
 const rules=load('services/recordingRules'); const rule=rules.create({kind:'sport',match:'Collingwood'}).rule;
 const made=await rules.evaluate({now}); assert.equal(made.length,1);
 eventStart+=3*3600000;eventID='second-distinct-match';
 const second=await rules.evaluate({now});assert.equal(second.length,0);
 console.log('REPRODUCED: distinct second event with same teams/title three hours later is not scheduled.');
 await engine.cancelScheduled(made[0].scheduleId);
 eventStart=start+7*3600000;eventID='original-rescheduled-next-session';
 const remade=await rules.evaluate({now});assert.equal(remade.length,1);
 console.log('REPRODUCED: canceled original moved seven hours is scheduled again.');
 sqlite.getDb().close();
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{fs.rmSync(sandbox,{recursive:true,force:true});});
