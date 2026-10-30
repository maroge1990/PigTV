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
 const now=Date.now(); const sched={id:null};
 const segments=load('services/recordingSegments'),media=load('services/recordingMedia');
 const workRoot=path.join(sandbox,'work'),share=path.join(sandbox,'share');fs.mkdirSync(share);
 segments._setWorkRoot(workRoot);segments.configure({recordingsRoot:async()=>share,minFreeGB:async()=>0});
 const rec=recordings.create({scheduled_id:sched.id,title:'Synthetic',channel_name:'Synthetic',channel_logo:null,source_id:source.id,channel_item_id:'pos_1',file_path:'pending',started_at:now});
 const work=segments.workDirFor(rec.id),epoch=path.join(work,'e1');fs.mkdirSync(epoch,{recursive:true});
 fs.writeFileSync(path.join(epoch,'a000000.ts'),Buffer.alloc(4096));
 fs.writeFileSync(path.join(epoch,'archive.m3u8'),'#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na000000.ts\n#EXT-X-ENDLIST\n');
 recordings.setSegmentFields(rec.id,{work_dir:work,file_path:path.join(work,'recording.m3u8'),segment_state:'finishing',segment_name:'synthetic',segment_folder:'synthetic'});
 media.nativeTools.codecs=async()=>({video:'h264',audio:'aac'});
 media.nativeTools.duration=async file=>file.endsWith('recording.m3u8')?null:4;
 media.nativeTools.audioErrors=async()=>0;
 media.nativeTools.ffmpeg=async args=>{fs.writeFileSync(args.at(-1),Buffer.alloc(4096));return {code:0,tail:[]};};
 const check=await media.checkPrepared(path.join(work,'recording.m3u8'),'synthetic.mp4');assert.equal(check.keepOriginal,true);
 const originalWriter=fs.createWriteStream;
 let observed=false;
 fs.createWriteStream=function(file,...args) {
   if(String(file).endsWith('.ts.partial')) {
     observed=true;
     assert.equal(recordings.getById(rec.id).segment_state,'done');
     assert.equal(recordings.findSegmentWork().some(r=>r.id===rec.id),false);
     assert.equal(fs.existsSync(work),true);
     console.log('REPRODUCED: before original copy opens, row is done and excluded from restart queue; actual original remains in appdata.');
   }
   return originalWriter.call(this,file,...args);
 };
 await segments.finishOne(recordings.getById(rec.id));
 fs.createWriteStream=originalWriter; assert.ok(observed);
 sqlite.getDb().close();
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{fs.rmSync(sandbox,{recursive:true,force:true});});
