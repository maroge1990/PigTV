// Review evidence; assertions deliberately confirm remaining defects. Synthetic, isolated fixtures.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../../..'), temp=fs.mkdtempSync(path.join(os.tmpdir(),'pigtv-dvr-boundaries-'));
const additions={
'recording-segments.test.js': `
test('REVIEW: delete while original copy is pending deletes unrelated TS', async () => {
 await withTools({duration:async f=>f.endsWith('recording.m3u8')?null:120},async()=>{
  const {rec,mp4}=finishingRow(); fs.mkdirSync(path.dirname(mp4),{recursive:true});
  const foreign=segments.keptOriginalPath(mp4);fs.writeFileSync(foreign,Buffer.alloc(joined.length,99));
  const restore=failTsWrites();try{await segments.finishOne(rec);}finally{restore();}
  const row=recordings.getById(rec.id); assert.equal(row.segment_state,'moving');assert.equal(row.segment_original,null);
  assert.ok(fs.existsSync(foreign));await engine.deleteRecording(rec.id);
  assert.equal(fs.existsSync(foreign),false,'DEFECT: foreign TS deleted despite never being retained');
 });
});`,
'recording-failover.test.js': `
test('REVIEW: delete while immediate failover awaits feed restarts deleted recording',async()=>{
 const held=await holdBackupFeed();try{
 setBehaviour(url.A(101),'502');const s=due();await until(()=>held.asked,'backup awaited');
 const [part]=partsOf(s.id);await engine.deleteRecording(part.id);
 const feed=lateFeed();held.resolve(feed);await sleep(400);
 assert.equal(engine.listActive().some(r=>r.id===s.id),true,'DEFECT: deleted recording restarted');
 assert.equal(feed.left,0,'DEFECT: late feed consumed');await engine.stopAllActive(200);
 }finally{await held.restore();}
});`,
'recording-rules-events.test.js': `
test('REVIEW: repeated correction back to known identity leaves pending schedule at wrong time',async()=>{
 const r=rule();events=[ev(NOW+2*H)];await rules.evaluate({now:NOW});
 events=[ev(NOW+5*H)];await rules.evaluate({now:NOW});assert.equal(ofRule(r.id)[0].program_start,NOW+5*H);
 events=[ev(NOW+2*H)];await rules.evaluate({now:NOW});
 assert.equal(ofRule(r.id)[0].program_start,NOW+5*H,'DEFECT: hit skips correction back to original slot');
});
test('REVIEW: two vanished two new events pair greedily one to one',async()=>{
 const r=rule();events=[ev(NOW+2*H),ev(NOW+10*H)];const made=await rules.evaluate({now:NOW});await engine.cancelScheduled(made[0].scheduleId);
 events=[ev(NOW+6*H),ev(NOW+11*H)];assert.equal((await rules.evaluate({now:NOW})).length,0);
 assert.deepEqual(ofRule(r.id).map(s=>[s.program_start,s.status]),[[NOW+2*H,'cancelled'],[NOW+11*H,'scheduled']]);
});
test('REVIEW: cancelled original slot outside 72 hours does not match',async()=>{
 const r=rule();events=[ev(NOW+2*H)];const [made]=await rules.evaluate({now:NOW});await engine.cancelScheduled(made.scheduleId);
 sqlite.getDb().prepare('UPDATE scheduled_recordings SET program_start=?, program_end=? WHERE id=?').run(NOW+73*H,NOW+76*H,made.scheduleId);
 events=[ev(NOW+5*H)];assert.equal((await rules.evaluate({now:NOW})).length,1);assert.equal(ofRule(r.id).length,2);
});
test('REVIEW: already recording prebuffer schedule wrongly absorbs later event',async()=>{
 const r=rule();events=[ev(NOW+2*60000)];const [made]=await rules.evaluate({now:NOW});
 scheduled.setStatus(made.scheduleId,'recording');events=[ev(NOW+H)];
 assert.equal((await rules.evaluate({now:NOW})).length,0,'DEFECT: recording status ignored for moved matching');
 assert.equal(ofRule(r.id).length,1);
});
test('REVIEW: series without episode metadata recreates cancellation after 20 minute move',async()=>{
 const d=sqlite.getDb();d.prepare('UPDATE playlist_items SET tvg_id=? WHERE source_id=?').run('ff',source.id);
 d.prepare('DELETE FROM epg_programs').run();
 d.prepare('INSERT INTO epg_programs(channel_id,source_id,start_time,end_time,title,flags) VALUES(?,?,?,?,?,0)').run('ff',source.id,NOW+H,NOW+2*H,'Series Example');
 const r=rules.create({kind:'series',match:'Series Example',sourceId:source.id,channelId:'pos_1'}).rule;
 const [made]=await rules.evaluate({now:NOW});assert.ok(made);await engine.cancelScheduled(made.scheduleId);
 d.prepare('UPDATE epg_programs SET start_time=start_time+?,end_time=end_time+?').run(20*60000,20*60000);
 assert.equal((await rules.evaluate({now:NOW})).length,1,'DEFECT: metadata-free series cancellation recreated');
 assert.equal(ofRule(r.id).length,2);
});
test('REVIEW: started schedule never takes later successor',async()=>{
 const r=rule();events=[ev(NOW+2*H)];const [made]=await rules.evaluate({now:NOW});
 scheduled.setStatus(made.scheduleId,'recording');events=[ev(NOW+5*H)];
 assert.equal((await rules.evaluate({now:NOW+3*H})).length,1);assert.equal(ofRule(r.id).length,2);
});`
};
try{fs.cpSync(path.join(root,'server'),path.join(temp,'server'),{recursive:true});fs.copyFileSync(path.join(root,'package.json'),path.join(temp,'package.json'));fs.symlinkSync(path.join(root,'node_modules'),path.join(temp,'node_modules'));fs.mkdirSync(path.join(temp,'test'));
 for(const [file,extra] of Object.entries(additions)){
 fs.writeFileSync(path.join(temp,'test',file),fs.readFileSync(path.join(root,'test',file),'utf8')+'\n'+extra);
 const run=cp.spawnSync(process.execPath,['--test','--test-timeout=25000','--test-name-pattern=REVIEW:',path.join(temp,'test',file)],{encoding:'utf8',timeout:35000,env:{...process.env,PIGTV_SKIP_PERF:'1'}});process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');if(run.status!==0)process.exitCode=1;
 }
}finally{fs.rmSync(temp,{recursive:true,force:true});}
