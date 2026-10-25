// Isolated Node24 synthetic fixture runs. No working application files are replaced.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'pigtv-r5-dvr-'));
try {
 for(const [label,ref,pattern] of [
  ['current','HEAD','R4-D1:|R4-D2:'],
  ['0257-parent','3f53047^','R4-D2:'],
  ['0256-parent','65bb654^','R4-D1: reopening']
 ]) {
  const dir=path.join(temp,label);fs.mkdirSync(dir);
  cp.execFileSync('tar',['-x','-C',dir],{input:cp.execFileSync('git',['archive',ref,'server'],{cwd:root,maxBuffer:20e6})});
  fs.copyFileSync(path.join(root,'package.json'),path.join(dir,'package.json'));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  fs.mkdirSync(path.join(dir,'test'));fs.copyFileSync(path.join(root,'test/recording-segments.test.js'),path.join(dir,'test/recording-segments.test.js'));
  const r=cp.spawnSync(process.execPath,['--test','--test-timeout=30000','--test-name-pattern='+pattern,path.join(dir,'test/recording-segments.test.js')],{encoding:'utf8',timeout:40000,env:{...process.env,PIGTV_SKIP_PERF:'1'}});
  console.log('CASE',label,'REF',ref,'EXIT',r.status);process.stdout.write(r.stdout||'');process.stdout.write(r.stderr||'');
  if(label==='current'&&r.status!==0)process.exitCode=1;
 }
} finally {fs.rmSync(temp,{recursive:true,force:true});}
