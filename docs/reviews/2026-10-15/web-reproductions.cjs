const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const path=require('path');
const root=path.resolve(__dirname, '../../../public/js') + path.sep;
const c=vm.createContext({console,window:{},setTimeout,clearTimeout});
for(const f of ['components/EpgGuide.js','pages/HomePage.js','app.js']){
 c.document={addEventListener(){},querySelectorAll(){return []}};
 vm.runInContext(fs.readFileSync(root+f,'utf8'),c);
}
(async()=>{
 const epg=Object.create(c.window.EpgGuide.prototype); let end1; let start=1000;
 epg.renderWindow=()=>({start,end:start+86400000});
 c.API={library:{categories:async()=>[],favourites:async()=>[],guide:({start})=>start===1000?new Promise(r=>end1=r):Promise.resolve({channels:[],nextCursor:null})}};
 const first=epg.fetchEpgData(); await new Promise(setImmediate); start=2000;
 await epg.fetchEpgData(); assert.equal(epg.window.start,2000);
 end1({channels:[],nextCursor:null}); await first;
 assert.equal(epg.window.start,1000); console.log('REPRO: old guide response overwrites newer window (2000 -> 1000).');
 const home=Object.create(c.window.HomePage.prototype); let finish;
 const old={innerHTML:'loading',querySelectorAll:()=>[]}; const fresh={innerHTML:'loading',querySelectorAll:()=>[]}; let list=old;
 c.document.getElementById=id=>id==='favorite-channels-list'?list:{};
 c.window.API={library:{favourites:()=>new Promise(r=>finish=r)}};
 home.updateScrollArrows=()=>{}; home.isLoading=false;
 const pending=home.loadDashboardData(); list=fresh; await home.loadDashboardData(); finish([]); await pending;
 assert.equal(fresh.innerHTML,'loading'); console.log('REPRO: Home revisit during pending favourites load leaves new container loading.');
 c.history={pushState(){this.pushes++},replaceState(){},pushes:0};
 c.document={querySelectorAll:()=>[]};
 const app=vm.runInContext('Object.create(App.prototype)',c);
 Object.assign(app,{currentPage:'guide',currentUser:{role:'admin'},pages:{}});
 app.navigateTo('home',false); assert.equal(c.history.pushes,1);
 console.log('REPRO: popstate navigation argument false pushes a new history entry.');
})();
