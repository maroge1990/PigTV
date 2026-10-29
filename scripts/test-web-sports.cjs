// Optional synthetic DOM/keyboard check. Uses an already installed Playwright/Chromium; all requests are intercepted.
const {chromium}=require('playwright');
const fs=require('fs'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PIGTV_WEB_CHROMIUM ? {executablePath:process.env.PIGTV_WEB_CHROMIUM} : {})});

 const page=await browser.newPage({viewport:{width:Number(process.env.PIGTV_WEB_TEST_WIDTH || 390),height:900}});
 await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:'<html><body><div id="page-sports"></div></body></html>'}));
 await page.goto('http://pigtv.test');  page.setDefaultTimeout(10000);
 await page.addStyleTag({content:fs.readFileSync('public/css/main.css','utf8')});
 await page.evaluate(()=>{
 localStorage.setItem('authToken','synthetic');
 const g=(id,extra={})=>({id,league:'AFL',title:'A v B',start:Date.now()-1000,status:'live',freshness:'fresh',progress:{period:4,clock:'2:10'},scores:['101','99'],competitors:[{name:'Carlton Blues'},{name:'Richmond Tigers'}],availability:'unmatched',canWatch:false,channels:[],events:[],...extra});
 window.makeGame=g; window.synthetic={now:Date.now(),timezone:'Australia/Melbourne',leagues:['AFL','F1','Cricket'],preferences:{revision:0,avoidSpoilers:true,scoreDelaySeconds:90},games:[g('a'),g('b',{availability:'unavailable'}),g('c',{status:'finished'})]};
 window.API={request:async()=>({features:{sportsDashboard:true}}),sports:{dashboard:async()=>structuredClone(window.synthetic),savePreferences:async values=> {window.synthetic.preferences={...values,revision:values.revision+1};}},recordings:{getActive:async()=>[]}};
 window.fakeApp={currentPage:'sports'};
 });
 await page.addScriptTag({content:fs.readFileSync('public/js/pages/SportsPage.js','utf8')});
 await page.evaluate(async()=>{window.sportPage=new SportsPage(window.fakeApp);await sportPage.show();});
  assert.equal(await page.locator('.sports-card').count(),3);
 assert.doesNotMatch(await page.locator('.sports-card').first().innerText(),/101|99|AFL|Total points/);
 const boxes=await page.locator('.sports-card').evaluateAll(nodes=>nodes.map(n=>({width:n.offsetWidth,height:n.offsetHeight})));
 assert.deepEqual(boxes[0],boxes[1]);assert.deepEqual(boxes[1],boxes[2]);
  await page.locator('.sports-options').first().click();
 assert.equal(await page.locator('dialog').isVisible(),true);
 assert.doesNotMatch(await page.locator('dialog').innerText(),/101|99/);
 await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog').count(),0);
 await page.getByRole('button',{name:'Spoilers & delay'}).click();
 await page.locator('[name=avoidSpoilers]').uncheck();await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.sports-card').textContent.includes('101'));
 await page.locator('.sports-card').first().focus();
 await page.evaluate(async()=>{synthetic.games.shift();await sportPage.state.load();});
 assert.equal(await page.locator('.sports-card').first().innerText(),'Event no longer available');
 assert.equal(await page.locator('.sports-card').first().evaluate(n=>document.activeElement===n),true);
 await page.locator('.sports-card').nth(1).focus();
 await page.waitForFunction(()=>document.querySelectorAll('.sports-card').length===2);
 await page.evaluate(async()=>{synthetic.leagues=['F1','Cricket'];synthetic.games=[];await sportPage.state.load();});
 assert.equal(await page.locator('.sports-card').first().innerText(),'Event no longer available');
 await page.getByRole('button',{name:'Today',exact:true}).focus();
 await page.waitForFunction(()=>document.querySelectorAll('.sports-card').length===0);
 await page.evaluate(async()=>{
   synthetic.leagues=['AFL']; synthetic.games=[makeGame('record',{availability:'matched',channels:[{sourceId:1,id:'pos_1',stableId:'s1',name:'TV'}],events:[{id:'event',start:synthetic.now-1000,end:synthetic.now+3600000}]})];
   API.sports.events=async()=>({events:[{id:'event',start:synthetic.now-1000,end:synthetic.now+3600000,title:'Spoiler 101 defeats 99',channels:[{sourceId:1,id:'pos_8',stableId:'s1',name:'TV'}]}]});
   window.writes=[]; API.recordings.schedule=async body=>writes.push(body); API.recordings.addRule=async body=>writes.push(body);
   sportPage.rulesEnabled=true; await sportPage.state.load();
 });
 await page.locator('.sports-options').first().click();
 await page.getByRole('button',{name:'Record',exact:true}).click();
 await page.getByRole('button',{name:'Confirm',exact:true}).click();
 await page.waitForFunction(()=>writes.length===1);
 assert.equal(await page.evaluate(()=>writes[0].channelItemId),'pos_8');
 assert.equal(await page.evaluate(()=>writes[0].title),'A v B');
 await page.locator('.sports-options').first().click();
 await page.getByRole('button',{name:'Record every game: AFL: Carlton Blues',exact:true}).click();
 await page.getByRole('button',{name:'Confirm',exact:true}).click();
 await page.waitForFunction(()=>writes.length===2);
 assert.equal(await page.evaluate(()=>writes[1].kind),'sport');
 assert.equal(await page.evaluate(()=>writes[1].match),'AFL: Carlton Blues');
 // A score-feed card's "A v B" is not a guide title: no series rule that could never match.
 await page.locator('.sports-options').first().click();
 assert.equal(await page.getByRole('button',{name:'Record series',exact:true}).count(),0);
 await page.keyboard.press('Escape');
 // A guide card with spoilers shown carries the real guide title; a rule that matched nothing says so.
 await page.evaluate(async()=>{
   synthetic.leagues=['AFL']; synthetic.games=[makeGame('guide:event',{league:'Sport',dataSource:'guide',title:'Chiefs v Bills',competitors:[],status:'unknown',freshness:'unavailable',progress:{},scores:undefined,availability:'matched',canWatch:true,
     channels:[{sourceId:1,id:'pos_1',stableId:'s1',name:'TV'}],events:[{id:'event',start:synthetic.now-1000,end:synthetic.now+3600000}]})];
   API.recordings.addRule=async body=>{writes.push(body);return {...body,scheduled:0};};
   await sportPage.state.load();
 });
 assert.deepEqual(await page.locator('.sports-filters button').allInnerTexts(),['AFL'],'non-canonical guide leagues are not 400 filters');
 assert.equal(await page.locator('.sports-shelf[data-league="Sport"] .sports-card').count(),1);
 await page.locator('.sports-options').first().click();
 await page.getByRole('button',{name:'Record series',exact:true}).click();
 await page.getByRole('button',{name:'Confirm',exact:true}).click();
 await page.waitForFunction(()=>writes.length===3);
 assert.equal(await page.evaluate(()=>writes[2].match),'Chiefs v Bills');
 await page.waitForFunction(()=>/nothing scheduled/.test(document.querySelector('.sports-message').textContent));
 // Hidden mode masks the guide title, so the series action disappears with it.
 await page.evaluate(async()=>{synthetic.preferences.avoidSpoilers=true;synthetic.games[0].title='Sport · Guide event';await sportPage.state.load();});
 await page.locator('.sports-options').first().click();
 assert.equal(await page.getByRole('button',{name:'Record series',exact:true}).count(),0);
 await page.keyboard.press('Escape');
 await page.evaluate(()=>sportPage.suspend());assert.equal(await page.locator('.sports-card').count(),0);
 console.log('PASS synthetic mobile browser: hidden first render/details, equal geometry, visible options, Escape, synced save, retained focused expiry, background hiding');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
