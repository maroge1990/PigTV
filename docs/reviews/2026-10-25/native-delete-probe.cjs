const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
const root=path.resolve(__dirname,'../../..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pigtv-r5-native-'));
const extra=`
test('R5: native preparation of a fallback TS cannot publish after delete',async()=>{
 const r=makeRecording(); const ts=r.file.replace(/\\.mkv$/,'.ts');fs.renameSync(r.file,ts);
 getDb().prepare('UPDATE recordings SET file_path=?,segment_name=?,segment_state=? WHERE id=?').run(ts,'fallback','done',r.id);
 let reached,release;const arrived=new Promise(x=>reached=x),gate=new Promise(x=>release=x);
 engine._nativeTools.ffmpeg=async(args)=>{
   const input=args[args.indexOf('-i')+1];const fd=fs.openSync(input,'r');
   reached();await gate;fs.closeSync(fd);fs.writeFileSync(args.at(-1),'encoded');return {code:0,tail:[]};
 };
 const job=engine._prepareRecording(row(r.id));await arrived;
 try{await engine.deleteRecording(r.id);}finally{release();}
 await job;assert.equal(row(r.id),null);
 assert.equal(fs.existsSync(r.mp4),false,'deleted recording must leave no late MP4');
});
`;
try{
 cp.execFileSync('tar',['-x','-C',dir],{input:cp.execFileSync('git',['archive','HEAD','server'],{cwd:root,maxBuffer:20e6})});
 fs.copyFileSync(path.join(root,'package.json'),path.join(dir,'package.json'));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));fs.mkdirSync(path.join(dir,'test'));
 fs.writeFileSync(path.join(dir,'test/recording-prepare.test.js'),fs.readFileSync(path.join(root,'test/recording-prepare.test.js'),'utf8')+extra);
 const r=cp.spawnSync(process.execPath,['--test','--test-timeout=20000','--test-name-pattern=R5:',path.join(dir,'test/recording-prepare.test.js')],{encoding:'utf8',timeout:30000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status??1;
}finally{fs.rmSync(dir,{recursive:true,force:true});}
