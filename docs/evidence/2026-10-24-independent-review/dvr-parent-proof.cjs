// Current tests over current server and 0241 server. Isolated copies, synthetic fixture data only.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'pigtv-dvr-parent-proof-'));
try{
 for(const ref of ['HEAD','f026c63']){
 const dir=path.join(temp,ref);fs.mkdirSync(dir);const archive=cp.execFileSync('git',['archive',ref,'server'],{cwd:root,maxBuffer:20*1024*1024});cp.execFileSync('tar',['-x','-C',dir],{input:archive});
 fs.copyFileSync(path.join(root,'package.json'),path.join(dir,'package.json'));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));fs.mkdirSync(path.join(dir,'test'));
 for(const [file,pattern] of [['recording-segments.test.js','F1: a file of the same name AND size'],['recording-rules-events.test.js','F4: both matches appearing together|F4: a pending recording follows']]){
 // Baseline predates segment_original: resolve its legacy original path so failure tests bytes, not a missing column.
 let source=fs.readFileSync(path.join(root,'test',file),'utf8');
 if(file==='recording-segments.test.js') source=source.replaceAll('fs.readFileSync(done.segment_original)', 'fs.readFileSync(done.segment_original || segments.keptOriginalPath(mp4))');
 fs.writeFileSync(path.join(dir,'test',file),source);
 const r=cp.spawnSync(process.execPath,['--test','--test-timeout=25000','--test-name-pattern='+pattern,path.join(dir,'test',file)],{encoding:'utf8',timeout:35000,env:{...process.env,PIGTV_SKIP_PERF:'1'}});
 console.log('\nBASELINE',ref,file,'EXIT',r.status);process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
 if((ref==='HEAD'&&r.status!==0)||(ref!=='HEAD'&&r.status===0))process.exitCode=1;
 }
 }
}finally{fs.rmSync(temp,{recursive:true,force:true});}
