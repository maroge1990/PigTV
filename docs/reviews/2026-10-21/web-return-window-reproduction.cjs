// Asserts the current defect, not desired behaviour. Synthetic API, no browser/network.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const c=vm.createContext({window:{},console});
vm.runInContext(fs.readFileSync('public/js/components/EpgGuide.js','utf8'),c);
let finish;
const pending=new Promise(r=>finish=r);
c.API={library:{categories:async()=>[],favourites:async()=>[],guide:()=>pending}};
(async()=>{
 const g=Object.create(c.window.EpgGuide.prototype);
 g.timeOffset=0;g.window={start:0,end:86400000};g.rows=[{id:'current'}];
 g.renderWindow=()=>({start:g.timeOffset*3600000,end:g.timeOffset*3600000+86400000});g.render=()=>{};
 const forward=g.navigate(3);await new Promise(setImmediate);
 await g.navigate(-3);
 finish({channels:[{id:'future',sourceId:1,name:'Future'}],nextCursor:null});await forward;
 assert.equal(g.timeOffset,0);assert.equal(g.window.start,10800000);assert.equal(g.rows[0].id,'future');
 console.log('REPRODUCED: Later then Back to the cached window leaves timeOffset=0 but publishes the future window.');
})().catch(e=>{console.error(e);process.exitCode=1});
