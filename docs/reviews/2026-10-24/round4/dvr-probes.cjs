const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../../../..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'pigtv-dvr-round4-'));
const extra=`
test('ROUND4: migration wrongly claims the0242 interrupted-copy foreign original',async()=>{
 const {rec,mp4}=finishingRow();fs.mkdirSync(path.dirname(mp4),{recursive:true});fs.writeFileSync(mp4,'mp4');
 const foreign=segments.keptOriginalPath(mp4);fs.writeFileSync(foreign,Buffer.alloc(joined.length,99));
 // Exact durable state left by0242 finishOne between completed() and keepOriginal():
 recordings.setSegmentFields(rec.id,{status:'completed',file_path:mp4,segment_state:'done',segment_keep:'duration unavailable',segment_original:null});
 recordingsDbModule.claimLegacyOriginals(sqlite.getDb());
 assert.equal(recordings.getById(rec.id).segment_original,foreign,'migration claims unrelated bytes');
 await engine.deleteRecording(rec.id);assert.equal(fs.existsSync(foreign),false,'DEFECT: deletes foreign original');
});
test('ROUND4: publication while deletion awaits work removal leaves retained original',async()=>{
 await withTools({duration:async f=>f.endsWith('recording.m3u8')?null:120},async()=>{
 const {rec,mp4}=finishingRow();const real=fs.createWriteStream;let reached,release;const atEnd=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
 fs.createWriteStream=function(file,...rest){
 if(String(file).includes('.ts.')&&String(file).endsWith('.partial')){
 fs.createWriteStream=real;const {Writable}=require('node:stream');const fd=fs.openSync(file,'wx');
 return new Writable({write(chunk,enc,cb){fs.writeSync(fd,chunk);cb();},final(cb){reached();gate.then(()=>{fs.closeSync(fd);cb();});}});
 }return real.call(this,file,...rest);};
 const finishing=segments.finishOne(rec);await atEnd;fs.createWriteStream=real;
 const remove=segments.removeWork;let deletingEntered,releaseDelete;const entered=new Promise(r=>deletingEntered=r),deleteGate=new Promise(r=>releaseDelete=r);
 segments.removeWork=async r=>{deletingEntered();await deleteGate;return remove(r);};
 let deleting;
 try {deleting=engine.deleteRecording(rec.id);await entered;release();await finishing;
 assert.ok(recordings.getById(rec.id).segment_original);releaseDelete();await deleting;
 assert.equal(recordings.getById(rec.id),null);assert.equal(fs.existsSync(segments.keptOriginalPath(mp4)),true,'DEFECT: late owned file missed by stale deletion snapshot');
 }finally{segments.removeWork=remove;release();releaseDelete();}
 });
});
test('ROUND4: delete during fallback TS copy leaves unlisted original on share',async()=>{
 await withTools({ffmpeg:async()=>({code:1,tail:['failed']})},async()=>{
 const {rec,mp4}=finishingRow();recordings.setSegmentFields(rec.id,{segment_attempts:2});
 const real=fs.createWriteStream;let reached,release;const atEnd=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
 fs.createWriteStream=function(file,...rest){
 if(String(file).includes('.ts.')&&String(file).endsWith('.partial')){
 fs.createWriteStream=real;const {Writable}=require('node:stream');const fd=fs.openSync(file,'wx');
 return new Writable({write(chunk,enc,cb){fs.writeSync(fd,chunk);cb();},final(cb){reached();gate.then(()=>{fs.closeSync(fd);cb();});}});
 }return real.call(this,file,...rest);};
 const finishing=segments.finishOne(recordings.getById(rec.id));
 try{await atEnd;await engine.deleteRecording(rec.id);}finally{fs.createWriteStream=real;release();}
 await finishing;assert.equal(recordings.getById(rec.id),null);
 assert.equal(fs.existsSync(segments.keptOriginalPath(mp4)),true,'DEFECT: fallback published after deletion');
 });
});
`;
try{for(const ref of ['HEAD','7e1481b']){
const dir=path.join(temp,ref);fs.mkdirSync(dir);cp.execFileSync('tar',['-x','-C',dir],{input:cp.execFileSync('git',['archive',ref,'server'],{cwd:root,maxBuffer:20e6})});
fs.copyFileSync(path.join(root,'package.json'),path.join(dir,'package.json'));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));fs.mkdirSync(path.join(dir,'test'));
for(const file of ['recording-segments.test.js','recording-failover.test.js','recording-rules-events.test.js']){
fs.writeFileSync(path.join(dir,'test',file),fs.readFileSync(path.join(root,'test',file),'utf8')+(ref==='HEAD'&&file==='recording-segments.test.js'?extra:''));
const pattern=ref==='HEAD'?'D1:|D2:|D3:|D4:|F4 limit:|ROUND4:':'D1: deleting|D2:|D3: a pending|D4:';
const r=cp.spawnSync(process.execPath,['--test','--test-timeout=25000','--test-name-pattern='+pattern,path.join(dir,'test',file)],{encoding:'utf8',timeout:35000,env:{...process.env,PIGTV_SKIP_PERF:'1'}});
console.log('REF',ref,'FILE',file,'EXIT',r.status);process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
if(ref==='HEAD'&&r.status!==0)process.exitCode=1;
}}
}finally{fs.rmSync(temp,{recursive:true,force:true});}
