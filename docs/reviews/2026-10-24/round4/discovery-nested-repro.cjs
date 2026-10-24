// Local-only defective-behaviour reproduction: no network or provider access.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pigtv-discovery-'));
fs.cpSync(path.join(root,'server'),path.join(tmp,'server'),{recursive:true});
fs.copyFileSync(path.join(root,'package.json'),path.join(tmp,'package.json'));
fs.symlinkSync(path.join(root,'node_modules'),path.join(tmp,'node_modules'));
const fx=n=>JSON.parse(fs.readFileSync(path.join(root,'test/fixtures/espn',n+'.json')));
process.chdir(tmp);
const fixtures=require(path.join(tmp,'server/services/sportsFixtures'));
const sqlite=require(path.join(tmp,'server/db/sqlite'));
let malformed=false;
global.fetch=async url=>({ok:true,status:200,json:async()=>String(url).includes('scorepanel')?(malformed?{scores:[{leagues:'unavailable'}]}:fx('cricket-scorepanel')):String(url).includes('24377')?fx('cricket-24377-20260927'):{events:[]}});
(async()=>{try {
 const now=Date.parse('2026-09-27T12:00Z');
 await fixtures.refreshCricket({now});
 const before=fixtures.snapshot(new Set(['Cricket'])).get('Cricket');
 assert.equal(before.fixtures.length,1);
 malformed=true;
 await fixtures.refreshCricket({now:now+1000});
 const after=fixtures.snapshot(new Set(['Cricket'])).get('Cricket');
 assert.equal(after.fixtures.length,0,'BUG: malformed discovery erased stored game');
 assert.equal(after.coverage.at,now+1000,'BUG: malformed discovery renewed complete coverage');
 console.log('REPRODUCED: malformed nested HTTP200 cricket discovery erased known fixture and renewed full coverage',JSON.stringify({before:before.fixtures.length,after:after.fixtures.length,coverage:after.coverage}));
} finally { fixtures.stopBackgroundRefresh();sqlite.getDb().close();process.chdir(os.tmpdir());fs.rmSync(tmp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
