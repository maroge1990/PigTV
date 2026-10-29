/* C-O: render only server-projected whole snapshots. No score cache, ticking clock or provider probe. */
const SportsDashboardPolicy = {
    escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); },
    family(league) {
        return ({AFL:'australianFootball',AFLW:'australianFootball',NBA:'basketball',NFL:'americanFootball',
            MLB:'baseball',Cricket:'cricket',F1:'motorsport',EPL:'football','FA Cup':'football',UEFA:'football',Championship:'football'})[league] || 'guide';
    },
    key(c) { return `${c.sourceId}:${c.stableId || c.id}`; },
    terminal(g) { return ['finished','cancelled','postponed'].includes(g.status); },
    airing(g, now, watch) {
        if (!g || this.terminal(g) || (watch && !g.canWatch)) return undefined;
        return (g.events || []).find(e => e.end > now && (!watch || e.start <= now));
    },
    order(previous, ids, focused) { return [...previous.filter(id => ids.includes(id) || id === focused), ...ids.filter(id => !previous.includes(id))]; },
    status(g) {
        if (g.status === 'live' && g.freshness === 'fresh') return 'LIVE';
        return ({finished:'FINAL',cancelled:'CANCELLED',postponed:'POSTPONED',suspended:'SUSPENDED',
            break:g.breakLabel || 'BREAK',scheduled:'UPCOMING'})[g.status] ||
            (g.broadcastStatus === 'on-tv' ? 'ON TV NOW' : g.freshness === 'buffering' ? 'BUFFERING' : 'STATUS UNAVAILABLE');
    },
    progress(g, hidden) {
        if (g.freshness !== 'fresh' || this.family(g.league) === 'motorsport') return '';
        const p = g.progress || {}, family = this.family(g.league), parts = [];
        // A shoot-out reveals a draw: never label penalties with spoilers hidden, whatever the server sent.
        const n = hidden && family === 'football' && p.period >= 5 ? 0 : p.period;
        if (n > 0) {
            if (['basketball','americanFootball','australianFootball'].includes(family)) {
                parts.push(n <= 4 ? `Quarter ${n}` : `${family === 'australianFootball' ? 'Extra time' : 'Overtime'} ${n-4}`);
            } else if (family === 'football') parts.push(({1:'First half',2:'Second half',3:'Extra time · first half',4:'Extra time · second half',5:'Penalties'})[n] || `Period ${n}`);
            else if (family === 'baseball') parts.push(`${p.half || 'Inning'} ${n}`);
        }
        if (p.clock) parts.push(p.clock);
        if (family === 'cricket') {
            if (g.format) parts.push(g.format.toUpperCase());
            if (p.day) parts.push(p.day);
            if (p.overs) parts.push(`${p.overs} overs`);
        }
        return parts.join(' · ');
    },
    situation(g, hidden) {
        if (hidden || g.freshness !== 'fresh' || !g.situation) return '';
        const s = g.situation, parts = [];
        if (this.family(g.league) === 'americanFootball') {
            if (s.down != null && s.distance != null) parts.push(`Down ${s.down} · ${s.distance} yards`);
            if (s.yardLine != null) parts.push(`Yard line ${s.yardLine}`);
        } else if (this.family(g.league) === 'baseball') {
            if (s.balls != null && s.strikes != null) parts.push(`${s.balls} balls · ${s.strikes} strikes`);
            if (s.outs != null) parts.push(`${s.outs} outs`);
            const bases = [['First',s.onFirst],['Second',s.onSecond],['Third',s.onThird]].filter(x=>x[1]===true).map(x=>x[0]);
            if (bases.length) parts.push(`On base: ${bases.join(', ')}`);
        }
        return parts.join(' · ');
    },
    time(ms, timezone) {
        if (!Number.isFinite(ms)) return 'Start time unavailable';
        try { return new Date(ms).toLocaleString([], {timeZone:timezone,weekday:'short',hour:'2-digit',minute:'2-digit'}); }
        catch { return 'Start time unavailable'; }
    },
    // A series rule matches guide titles; score-feed titles and masked guide titles never match one.
    guideTitle(g, hidden) { return g.dataSource === 'guide' && !hidden; },
    // Only canonical leagues are valid dashboard filters (others are 400); ordinary Sport filters locally.
    filters(response, legacy) { return legacy ? [...new Set([...(response.leagues || []),...response.games.map(g=>g.league)])] : [...(response.leagues || [])]; },
    ruleChoices(g) {
        const league=g.league?.trim(), names=(g.competitors || []).map(c=>c.name?.trim()).filter(n=>n?.length>=3);
        return [...new Set([...(league && league.toLowerCase()!=='sport' ? [league] : []),
            ...names.map(n=>league && league.toLowerCase()!=='sport' ? `${league}: ${n}` : n)])];
    },
    recording(g, rows) {
        return rows.some(r=>(g.channels || []).some(c=>String(c.sourceId)===String(r.source_id) &&
            (r.channel_stable_id ? c.stableId===r.channel_stable_id : !c.stableId && c.id===r.channel_item_id)));
    },
    card(g, prefs, timezone, recording=false) {
        const e = this.escape, hidden = prefs.avoidSpoilers !== false, family = this.family(g.league);
        const scores = !hidden && g.freshness === 'fresh' && family !== 'motorsport' && g.scores?.length === 2 ? g.scores : null;
        const availability = g.availability === 'unmatched' ? 'No channel found' : g.availability === 'unavailable' ? 'Channel unavailable' : '';
        let html = `<span class="sports-status">${e(this.status(g))}</span>`;
        if (availability) html += `<span class="sports-availability ${g.availability}" role="img" aria-label="${availability}" title="${availability}">${g.availability === 'unmatched' ? '!' : '×'}</span>`;
        if (family !== 'motorsport' && g.competitors?.length) {
            html += g.competitors.map((team,i)=> {
                const logo = /^\/api\/logo\/[A-Za-z0-9_.-]+$/.test(team.logo || '') && !team.logo.includes('..') ? team.logo : '';
                return `<span class="sports-team">${logo ? `<img src="${e(logo)}" alt="" loading="lazy">` : '<span aria-hidden="true" class="sports-logo-fallback">◉</span>'}<span>${e(team.name)}</span>${scores ? `<strong>${e(scores[i])}</strong>` : ''}</span>`;
            }).join('');
        } else html += `<span class="sports-event-title">${e(g.title)}</span>`;
        if (family === 'motorsport') html += `${g.session ? `<span>${e(g.session)}</span>` : ''}${g.circuit?.name ? `<span>${e(g.circuit.name)}</span>` : ''}`;
        const progress = this.progress(g, hidden);
        html += `<span class="sports-time">${e(progress && g.status !== 'scheduled' ? progress : this.time(g.start, timezone))}</span>`;
        const situation = this.situation(g,hidden);
        if (situation) html += `<span>${e(situation)}</span>`;
        const note = [hidden && family !== 'motorsport' ? 'Scores hidden' : '',g.freshness === 'buffering' ? 'Waiting for delayed data' : g.freshness === 'stale' ? 'Scores unavailable · stale data' : '',g.dataSource === 'guide' ? 'Guide only · scores unavailable' : ''].filter(Boolean).join(' · ');
        if (note) html += `<span class="sports-note">${e(note)}</span>`;
        if (!availability && !this.terminal(g) && g.channels?.length) html += `<span class="sports-note">TV · ${e(g.channels[0].name)}</span>`;
        if (recording) html += '<span class="sports-recording">● Recording</span>';
        return html;
    }
};

class SportsDashboardState {
    constructor(api, identity, clock = () => performance.now()) {
        this.api=api; this.identity=identity; this.clock=clock;
        this.response=null; this.serial=0; this.active=false; this.legacy=false; this.message=''; this.league=null;
        this.changed=()=>{}; this.saving=false;
    }
    clear() { this.serial++; this.response=null; this.changed(); }
    valid(serial, identity) {
        const current=this.identity();
        // API's same-window 401 handler removes the token without firing a storage event.
        // Only the current request may invalidate its published identity; older requests cannot clear a new account.
        if (this.serial===serial && current!==identity) this.clear();
        return this.active && this.serial===serial && current===identity && identity != null;
    }
    now() { return this.response ? this.response.now + Math.max(0,this.clock()-this.received) + this.roundTrip : Infinity; }
    async load(clear=false) {
        if (this.saving) return false;
        if (clear) this.clear();
        const serial=++this.serial, identity=this.identity(), started=this.clock();
        if (!this.active || !identity) { this.clear(); return false; }
        try {
            let response;
            if (this.legacy) {
                const data=await this.api.events();
                response={now:data.now,timezone:'Australia/Melbourne',preferences:{avoidSpoilers:true,revision:0},
                    leagues:[...new Set(data.events.map(e=>e.league))],
                    games:data.events.filter(e=>!this.league || e.league===this.league).map(e=>({...e,
                        competitors:[],progress:{},freshness:'unavailable',dataSource:'guide',status:'unknown',
                        availability:e.channels.length?'matched':'unmatched',events:[{id:e.id,start:e.start,end:e.end}],
                        canWatch:e.start<=data.now && e.end>data.now,
                        broadcastStatus:e.start<=data.now && e.end>data.now?'on-tv':'scheduled'}))};
            } else response=await this.api.dashboard(this.league);
            if (!this.valid(serial,identity)) return false;
            if (!response.preferences || !Array.isArray(response.games)) throw Error('Invalid sport response');
            this.response=response; this.received=this.clock(); this.roundTrip=Math.max(0,this.received-started);
            this.message=''; this.changed(); return true;
        } catch (err) {
            if (!this.valid(serial,identity)) return false;
            this.response=null;
            if (err.status===404 && !this.legacy) { this.legacy=true; return this.load(true); }
            this.message='Sport data unavailable. Scores hidden until your account settings refresh.';
            this.changed(); return false;
        }
    }
    async save(values, revision=this.response?.preferences.revision) {
        const prefs=this.response?.preferences;
        if (!prefs || this.saving) return;
        if (prefs.revision!==revision) { this.message='Settings changed. Review them and choose again.'; this.changed(); return; }
        const identity=this.identity();
        this.saving=true; this.clear(); const serial=this.serial;
        try {
            await this.api.savePreferences({...values,revision:prefs.revision});
            this.saving=false;
            if (this.valid(serial,identity)) await this.load(true);
        } catch (err) {
            this.saving=false;
            if (!this.valid(serial,identity)) return;
            await this.load(true);
            if (!this.active || this.identity()!==identity) return;
            this.message=err.status===409 ? 'Settings changed on another device. Review them and choose again.' : 'Settings were not saved. Review them and try again.';
            this.changed();
        } finally { this.saving=false; }
    }
    async action(id, key, watch) {
        if (!await this.load()) return null;
        const g=this.response.games.find(g=>g.id===id), p=SportsDashboardPolicy;
        if (!p.airing(g,this.now(),watch)) return null;
        const channel=key == null ? g.channels[0] : g.channels.find(c=>p.key(c)===key);
        if (!channel) return null;
        if (watch) return {channel,title:g.title,event:p.airing(g,this.now(),true)};
        const serial=this.serial, identity=this.identity();
        let data;
        try { data=await this.api.events(); }
        catch (err) { this.valid(serial,identity); throw err; }
        if (!this.valid(serial,identity)) return null;
        const ids=new Set(g.events.map(e=>e.id));
        const events=data.events.filter(e=>ids.has(e.id) && e.end>this.now() && (e.channels || []).some(c=>p.key(c)===p.key(channel)));
        events.sort((a,b)=>(a.start<=this.now()?0:1)-(b.start<=this.now()?0:1) || a.start-b.start);
        return events.length ? {channel:events[0].channels.find(c=>p.key(c)===p.key(channel)),title:g.title,event:{id:events[0].id,start:events[0].start,end:events[0].end}} : null;
    }
}

class SportsPage {
    constructor(app) {
        this.app=app; this.root=document.getElementById('page-sports'); this.orders=new Map(); this.cards=new Map(); this.shelves=new Map();
        this.state=new SportsDashboardState(API.sports,()=>localStorage.getItem('authToken'));
        this.state.changed=()=>this.render();
        this.dialog=null; this.selection=null; this.timer=null; this.waiting=null; this.recordings=[];
        this.visibility=()=> {
            if (document.hidden) this.suspend();
            else if (this.app.currentPage==='sports') this.show();
        };
        document.addEventListener('visibilitychange',this.visibility);
        window.addEventListener('pagehide',()=>this.suspend());
        window.addEventListener('pageshow',this.visibility);
        window.addEventListener('offline',()=>this.suspend());
        window.addEventListener('online',this.visibility);
        window.addEventListener('storage',e=> { if(e.key==='authToken') { this.suspend(); this.visibility(); } });
    }
    async show() {
        this.suspend(); this.state.active=true;
        const serial=this.state.serial, identity=this.state.identity();
        try {
            const info=await API.request('GET','/info');
            if (!this.state.valid(serial,identity)) return;
            this.state.legacy=info.features?.sportsDashboard!==true;
            this.rulesEnabled=info.features?.recordingRules===true;
            this.setup();
            await this.state.load(true);
            await this.refreshRecordings(); this.poll();
        } catch { if (this.state.valid(serial,identity)) this.root.textContent='Sport unavailable. Try opening Sport again.'; }
    }
    hide() { this.suspend(); }
    suspend() {
        clearTimeout(this.timer); clearTimeout(this.waiting); this.waiting=null;
        this.state.active=false; this.recordings=[]; this.state.clear(); this.closeDialog();
        this.root?.replaceChildren(); this.cards.clear(); this.shelves.clear(); this.orders.clear();
    }
    setup() {
        this.root.innerHTML='<h1>Sport</h1><div class="sports-toolbar"></div><p class="sports-message" role="status"></p><div class="sports-shelves"></div>';
        const toolbar=this.root.querySelector('.sports-toolbar');
        const button=(text,fn)=> { const b=document.createElement('button'); b.className='btn btn-secondary'; b.textContent=text; b.onclick=fn; toolbar.append(b); return b; };
        button('Today',()=>this.changeLeague(null));
        button('Spoilers & delay',()=>this.settings());
        button('Refresh',()=>this.state.load(true));
        this.cancelWait=button('Cancel scheduled watch',()=> {clearTimeout(this.waiting);this.waiting=null;this.cancelWait.hidden=true;this.notice('Scheduled watch cancelled.');});
        this.cancelWait.hidden=true;
        this.chips=document.createElement('div'); this.chips.className='sports-filters'; toolbar.append(this.chips);
    }
    poll() {
        clearTimeout(this.timer);
        if (!this.state.active || document.hidden) return;
        this.timer=setTimeout(async()=> { await this.state.load(); await this.refreshRecordings(); this.poll(); },this.state.legacy ? 60000 : 20000);
    }
    async refreshRecordings() {
        const identity=this.state.identity(), serial=this.state.serial;
        try {
            const rows=await API.recordings.getActive();
            if(this.state.valid(serial,identity)) { this.recordings=Array.isArray(rows)?rows:[]; this.render(); }
        } catch { if(this.state.valid(serial,identity)) { this.recordings=[]; this.render(); } }
    }
    changeLeague(league) {
        this.closeDialog(); this.state.league=league; this.orders.clear(); this.cards.clear(); this.shelves.clear();
        this.root.querySelector('.sports-shelves').replaceChildren();
        this.state.load(true);
    }
    render() {
        if (!this.state.active || !this.root.querySelector('.sports-shelves')) return;
        const response=this.state.response;
        this.root.querySelector('.sports-message').textContent=this.state.message || (response ? this.state.legacy ? 'Ordinary Sport · Next 72 hours' : `${this.state.league ? `${this.state.league} · Next 72 hours` : 'Today'} · ${response.timezone} · Scores delayed ${response.preferences.scoreDelaySeconds}s${response.preferences.avoidSpoilers?' · Spoilers hidden':''}` : 'Scores hidden until your account settings refresh.');
        if (!response) {
            for(const node of this.cards.values()) { node.querySelector('.sports-card').textContent='Scores hidden until refreshed'; node.querySelector('.sports-options').disabled=true; }
            if(this.dialog && this.selection!=='settings') this.closeDialog();
            return;
        }
        this.root.querySelector('.sports-toolbar > button:nth-child(2)').hidden=this.state.legacy;
        this.root.querySelector('.sports-toolbar > button:first-child').textContent=this.state.legacy?'All · Next 72 hours':'Today';
        const leagues=[...new Set([...(response.leagues || []),...response.games.map(g=>g.league)])];
        const filters=SportsDashboardPolicy.filters(response,this.state.legacy), chipNames=JSON.stringify(filters);
        if(this.chips.dataset.names!==chipNames) {
            this.chips.replaceChildren(); this.chips.dataset.names=chipNames;
            for(const league of filters) { const b=document.createElement('button'); b.className='btn btn-secondary'; b.textContent=league; b.onclick=()=>this.changeLeague(league); this.chips.append(b); }
        }
        for(const b of this.chips.children) b.setAttribute('aria-pressed',String(b.textContent===this.state.league));
        const visible=this.state.league ? [this.state.league] : [...leagues];
        const focusedShelf=document.activeElement?.closest?.('.sports-shelf')?.dataset.league;
        if(focusedShelf && !visible.includes(focusedShelf)) visible.push(focusedShelf);
        for(const [league,shelf] of this.shelves) if(!visible.includes(league)) {
            for(const article of shelf.querySelectorAll('[data-game]')) this.cards.delete(article.dataset.game);
            shelf.remove(); this.shelves.delete(league); this.orders.delete(league);
        }
        const container=this.root.querySelector('.sports-shelves');
        for(const league of visible) {
            let shelf=this.shelves.get(league);
            if(!shelf) {
                shelf=document.createElement('section'); shelf.className='sports-shelf'; shelf.dataset.league=league;
                const h=document.createElement('h2'); h.textContent=league; shelf.append(h);
                const row=document.createElement('div'); row.className='sports-row'; shelf.append(row); container.append(shelf); this.shelves.set(league,shelf);
            }
            const games=response.games.filter(g=>g.league===league), row=shelf.querySelector('.sports-row');
            const focused=document.activeElement?.closest?.('[data-game]')?.dataset.game;
            const order=SportsDashboardPolicy.order(this.orders.get(league)||[],games.map(g=>g.id),focused); this.orders.set(league,order);
            for(const id of order) {
                let article=this.cards.get(id), game=games.find(g=>g.id===id);
                if(!article) {
                    article=document.createElement('article'); article.dataset.game=id;
                    article.innerHTML='<button type="button" class="sports-card"></button><button type="button" class="btn btn-secondary sports-options">More options</button>';
                    article.querySelector('.sports-card').onclick=()=>this.select(id);
                    article.querySelector('.sports-options').onclick=()=>this.details(id);
                    article.oncontextmenu=e=>{e.preventDefault();this.details(id);};
                    article.addEventListener('focusout',()=>setTimeout(()=>this.render(),0));
                    row.append(article); this.cards.set(id,article);
                }
                const card=article.querySelector('.sports-card');
                card.innerHTML=game ? SportsDashboardPolicy.card(game,response.preferences,response.timezone,SportsDashboardPolicy.recording(game,this.recordings)) : 'Event no longer available';
                card.querySelectorAll('img').forEach(img=> { img.onerror=()=> { img.hidden=true; }; });
                article.querySelector('.sports-options').disabled=!game;
                article.querySelector('.sports-options').setAttribute('aria-label',game ? `More options for ${game.title}` : 'Event no longer available');
            }
            for(const article of [...row.children]) if(!order.includes(article.dataset.game)) { this.cards.delete(article.dataset.game); article.remove(); }
            let empty=shelf.querySelector('.sports-empty');
            if(!games.length && !order.length) { if(!empty) { empty=document.createElement('p'); empty.className='sports-empty'; empty.textContent='No games or guide listings available.'; shelf.append(empty); } }
            else empty?.remove();
        }
        if(this.dialog && this.selection==='recording') {
            if(this.recordingRevision!==response.preferences.revision) this.closeDialog();
        } else if(this.dialog && this.selection!=='settings') this.renderDetails();
        if(this.dialog && this.selection==='settings' && this.settingsRevision!==response.preferences.revision) this.settings(true);
    }
    closeDialog() { this.dialog?.close(); this.dialog?.remove(); this.dialog=null; this.selection=null; }
    openDialog(selection) {
        this.closeDialog(); this.selection=selection;
        this.dialog=document.createElement('dialog'); this.dialog.className='sports-dialog';
        this.dialog.setAttribute('aria-label',selection==='settings'?'Sports account settings':selection==='recording'?'Confirm sports recording':'Sports event details');
        this.dialog.addEventListener('cancel',e=> {e.preventDefault();this.closeDialog();});
        this.root.append(this.dialog); return this.dialog;
    }
    settings(replace=false) {
        const prefs=this.state.response?.preferences;
        if(!prefs || this.state.legacy) return;
        const dialog=replace ? this.dialog : this.openDialog('settings');
        this.settingsRevision=prefs.revision;
        dialog.innerHTML='<h2>Spoilers & delay · Your account</h2><form><label><input type="checkbox" name="avoidSpoilers"> Hide scores and result details</label><label>Score delay in seconds (0–300)<input type="number" name="scoreDelaySeconds" min="0" max="300" required></label><p>Settings sync to devices signed in to this account.</p><button class="btn btn-primary" type="submit">Save</button><button class="btn btn-secondary" type="button">Close</button></form>';
        const form=dialog.querySelector('form'); form.elements.avoidSpoilers.checked=prefs.avoidSpoilers; form.elements.scoreDelaySeconds.value=prefs.scoreDelaySeconds;
        form.onsubmit=async e=> {
            e.preventDefault(); const values={avoidSpoilers:form.elements.avoidSpoilers.checked,scoreDelaySeconds:Number(form.elements.scoreDelaySeconds.value)};
            if(!Number.isInteger(values.scoreDelaySeconds) || values.scoreDelaySeconds<0 || values.scoreDelaySeconds>300) return;
            this.closeDialog(); await this.state.save(values,prefs.revision);
        };
        form.querySelector('[type=button]').onclick=()=>this.closeDialog();
        if(!replace) dialog.showModal();
    }
    details(id) { this.openDialog(id); this.renderDetails(); this.dialog?.showModal(); }
    renderDetails() {
        const response=this.state.response, g=response?.games.find(g=>g.id===this.selection), dialog=this.dialog;
        if(!dialog) return;
        if(!g) { this.closeDialog(); return; }
        const focus=document.activeElement?.dataset?.actionKey;
        const e=SportsDashboardPolicy.escape;
        dialog.innerHTML=`<h2>Event details · ${e(g.league)}</h2><div class="sports-detail-card">${SportsDashboardPolicy.card(g,response.preferences,response.timezone)}</div><p>${SportsDashboardPolicy.terminal(g)?'Event ended · playback unavailable':g.availability==='unmatched'?'No channel found':g.availability==='unavailable'?'Channel unavailable':'Choose a channel'}</p><p role="status">${e(this.state.message)}</p><div class="sports-channel-actions"></div><button class="btn btn-secondary sports-close">Close</button>`;
        const actions=dialog.querySelector('.sports-channel-actions');
        if(!SportsDashboardPolicy.terminal(g)) for(const channel of g.channels) {
            const key=SportsDashboardPolicy.key(channel), group=document.createElement('div');
            const name=document.createElement('h3'); name.textContent=channel.name; group.append(name);
            const button=(label,action)=> { const b=document.createElement('button'); b.className='btn btn-secondary'; b.textContent=label; b.dataset.actionKey=`${action}:${key}`; b.onclick=()=>this.perform(g.id,key,action); group.append(b); };
            if(g.canWatch) button('Watch','watch');
            else if(g.events.some(e=>e.start>this.state.now())) button('Watch when it starts','wait');
            button('Record','record');
            if(this.rulesEnabled && SportsDashboardPolicy.guideTitle(g,!this.state.legacy && response.preferences.avoidSpoilers!==false)) button('Record series','rule');
            actions.append(group);
        }
        if(this.rulesEnabled && !SportsDashboardPolicy.terminal(g)) for(const choice of SportsDashboardPolicy.ruleChoices(g)) {
            const b=document.createElement('button'); b.className='btn btn-secondary'; b.textContent=`Record every game: ${choice}`;
            b.dataset.actionKey=`every:${choice}`; b.onclick=()=>this.perform(g.id,null,`every:${choice}`); actions.append(b);
        }
        dialog.querySelector('.sports-close').onclick=()=>this.closeDialog();
        if(focus) [...dialog.querySelectorAll('[data-action-key]')].find(b=>b.dataset.actionKey===focus)?.focus();
    }
    async select(id) {
        const g=this.state.response?.games.find(g=>g.id===id);
        if(g?.canWatch) await this.perform(id,null,'watch'); else this.details(id);
    }
    async perform(id,key,action) {
        try {
            if(action==='watch') {
                // Library reload can move pos_N. Resolve by stable identity, then revalidate airing at select time.
                const cl=this.app.channelList;
                await cl.loadSources(); await cl.loadChannels();
                const selected=await this.state.action(id,key,true);
                if(!selected) { this.notice('This airing is no longer watchable.'); return; }
                const match=cl.channels.find(c=>SportsDashboardPolicy.key(c)===SportsDashboardPolicy.key(selected.channel));
                if(!match) { this.notice('Channel unavailable. Refresh the library and try again.'); return; }
                this.closeDialog(); this.app.navigateTo('live');
                await cl.selectChannel({sourceId:match.sourceId,channelId:match.id}); return;
            }
            const selected=await this.state.action(id,key,false);
            if(!selected) { this.notice('No current or upcoming airing for this channel.'); return; }
            if(action==='wait') {
                clearTimeout(this.waiting); this.closeDialog();
                this.notice('Scheduled watch set. Keep Sport open until it starts.'); this.cancelWait.hidden=false;
                // now() includes the whole round trip, so the timer can fire before the server's start:
                // re-arm while the server still says the airing is in the future, rather than consuming the watch.
                const fire=async()=> {
                    const pending={}; this.waiting=pending;
                    const early=await this.state.load() && this.state.response.now<selected.event.start;
                    if(this.waiting!==pending) return;
                    if(early) { this.waiting=setTimeout(fire,Math.max(1000,selected.event.start-this.state.response.now)); return; }
                    this.waiting=null; this.cancelWait.hidden=true;
                    await this.perform(id,SportsDashboardPolicy.key(selected.channel),'watch');
                };
                this.waiting=setTimeout(fire,Math.max(0,selected.event.start-this.state.now()));
                return;
            }
            // Confirmation is neutral and modal; actual mutation revalidates again after the user chooses.
            this.confirmRecording(id,SportsDashboardPolicy.key(selected.channel),action,selected);
        } catch { if(!this.state.identity()) this.state.clear(); this.notice('Sport action unavailable. Refresh and try again.'); }
    }
    confirmRecording(id,key,action,selected) {
        const dialog=this.openDialog('recording'), revision=this.state.response.preferences.revision;
        // Treat this as a live event selection so a poll clears/reprojects it safely.
        this.selection='recording'; this.recordingRevision=revision;
        const title=document.createElement('h2'); title.textContent=action.startsWith('every:') ? `Record every game: ${action.slice(6)}` : `${action==='rule'?'Record series':'Record'} · ${selected.title}`; dialog.append(title);
        const form=document.createElement('form');
        form.innerHTML='<label>Minutes before<input name="pre" type="number" min="0" max="60" value="1" required></label><label>Minutes after<input name="post" type="number" min="0" max="120" value="5" required></label><button type="submit" class="btn btn-primary">Confirm</button><button type="button" class="btn btn-secondary">Cancel</button>';
        dialog.append(form); form.querySelector('[type=button]').onclick=()=>this.closeDialog();
        form.onsubmit=async e=> {
            e.preventDefault(); const pre=Number(form.elements.pre.value), post=Number(form.elements.post.value);
            this.closeDialog();
            try {
                const fresh=await this.state.action(id,key,false);
                if(!fresh || this.state.response.preferences.revision!==revision) { this.notice('Event or settings changed. Review and choose again.'); return; }
                const c=fresh.channel;
                let rule=null;
                if(action.startsWith('every:')) {
                    const choice=action.slice(6), game=this.state.response.games.find(g=>g.id===id);
                    if(!game || !SportsDashboardPolicy.ruleChoices(game).includes(choice)) { this.notice('Event changed. Review and choose again.'); return; }
                    rule=await API.recordings.addRule({kind:'sport',match:choice,preBufferMin:pre,postBufferMin:post});
                } else if(action==='rule') {
                    const game=this.state.response.games.find(g=>g.id===id);
                    if(!game || !SportsDashboardPolicy.guideTitle(game,!this.state.legacy && this.state.response.preferences.avoidSpoilers!==false)) { this.notice('Event changed. Review and choose again.'); return; }
                    rule=await API.recordings.addRule({kind:'series',match:fresh.title,sourceId:Number(c.sourceId),channelId:c.id,channelName:c.name,preBufferMin:pre,postBufferMin:post});
                } else await API.recordings.schedule({sourceId:Number(c.sourceId),channelItemId:c.id,channelName:c.name,title:fresh.title,programStart:fresh.event.start,programEnd:fresh.event.end,preBufferMin:pre,postBufferMin:post});
                // A rule that matched nothing must not read as a scheduled recording.
                const made=rule?.scheduled;
                this.notice(!rule ? 'Recording request saved.' : made>0 ? `Rule saved · ${made} scheduled.` : 'Rule saved · nothing scheduled yet: no upcoming airing matched.');
            } catch { this.notice('Recording request failed. Review Recordings before trying again.'); }
        };
        dialog.showModal();
    }
    notice(message) { this.state.message=message; this.render(); }
}
window.SportsDashboardPolicy=SportsDashboardPolicy;
window.SportsDashboardState=SportsDashboardState;
window.SportsPage=SportsPage;
