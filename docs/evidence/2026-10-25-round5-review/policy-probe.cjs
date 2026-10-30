const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'../../..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pigtv-r5-policy-'));
const extra=`
test('R5: ambiguous cancel must not suppress a candidate through an earlier hit', async()=>{
 const r=rule(); events=[ev(NOW+2*H)]; const [m]=await rules.evaluate({now:NOW}); await engine.cancelScheduled(m.scheduleId);
 events=[ev(NOW+6*H)]; assert.deepEqual(await rules.evaluate({now:NOW}),[]);
 events=[ev(NOW+6*H),ev(NOW+10*H)]; await rules.evaluate({now:NOW});
 assert.deepEqual(ofRule(r.id).filter(s=>s.status==='scheduled').map(s=>s.program_start),[NOW+6*H,NOW+10*H]);
});
test('R5: metadata-free airing must not steal a still-present episode schedule',async()=>{
 const r=seriesFixture([{start:NOW+H,data:JSON.stringify({ep:'1.4'})}]); await rules.evaluate({now:NOW});
 sqlite.getDb().prepare('INSERT INTO epg_programs(channel_id,source_id,start_time,end_time,title,flags) VALUES(?,?,?,?,?,0)').run('ff',source.id,NOW+2*H,NOW+3*H,'Series Example');
 await rules.evaluate({now:NOW});
 assert.deepEqual(ofRule(r.id).filter(s=>s.status==='scheduled').map(s=>s.program_start),[NOW+H,NOW+2*H]); clearAirings();
});
test('R5: a cancelled series follows its stable channel after playlist reorder',async()=>{
 const r=seriesFixture([{start:NOW+H}]);const [m]=await rules.evaluate({now:NOW});await engine.cancelScheduled(m.scheduleId);
 sqlite.getDb().prepare('UPDATE playlist_items SET item_id = ?, id = ? WHERE source_id = ?').run('pos_2',String(source.id)+':pos_2',source.id);
 shiftAirings(20*60000);
 assert.deepEqual(await rules.evaluate({now:NOW}),[],'same stable channel and20minute move: cancel holds');clearAirings();
});

`;
try {
 cp.execFileSync('tar',['-x','-C',dir],{input:cp.execFileSync('git',['archive',process.argv[2]||'HEAD','server'],{cwd:root,maxBuffer:20e6})});
 fs.copyFileSync(path.join(root,'package.json'),path.join(dir,'package.json'));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));fs.mkdirSync(path.join(dir,'test'));
 fs.writeFileSync(path.join(dir,'test/recording-rules-events.test.js'),fs.readFileSync(path.join(root,'test/recording-rules-events.test.js'),'utf8')+extra);
 const r=cp.spawnSync(process.execPath,['--test','--test-timeout=25000','--test-name-pattern='+(process.argv[3]||'R5:'),path.join(dir,'test/recording-rules-events.test.js')],{encoding:'utf8',timeout:35000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status??1;
}finally{fs.rmSync(dir,{recursive:true,force:true});}
