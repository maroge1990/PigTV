/* C-O: render only server-projected whole snapshots. No score cache, ticking clock or provider probe.
   #276 (option A, 11 Nov 2026): compact cards in league shelves, a "⋯" options button in each card's corner. */
const SPORTS_ICONS = {
    tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
    err: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.3 12.9-1.4 1.4L12 13.4l-2.9 2.9-1.4-1.4 2.9-2.9-2.9-2.9 1.4-1.4 2.9 2.9 2.9-2.9 1.4 1.4-2.9 2.9 2.9 2.9z"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>'
};
const SportsDashboardPolicy = {
    escape(value) { return UI.escape(value); },
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
    live(g) { return g.status === 'live' && g.freshness === 'fresh'; },
    status(g) {
        if (this.live(g)) return 'Live';
        return ({finished:'Final',cancelled:'Cancelled',postponed:'Postponed',suspended:'Suspended',
            break:g.breakLabel || 'Break',scheduled:'Upcoming'})[g.status] ||
            (g.broadcastStatus === 'on-tv' ? 'On TV now' : g.freshness === 'buffering' ? 'Buffering' : 'Status unavailable');
    },
    progress(g, hidden) { return this.progressParts(g, hidden).map(p => p.text).join(' · '); },
    /** progress() in parts; `amount` marks the clock, drawn in the amount face. */
    progressParts(g, hidden) {
        if (g.freshness !== 'fresh' || this.family(g.league) === 'motorsport') return [];
        const p = g.progress || {}, family = this.family(g.league), parts = [];
        // A shoot-out reveals a draw: never label penalties with spoilers hidden, whatever the server sent.
        const n = hidden && family === 'football' && p.period >= 5 ? 0 : p.period;
        if (n > 0) {
            if (['basketball','americanFootball','australianFootball'].includes(family)) {
                parts.push({text: n <= 4 ? `Quarter ${n}` : `${family === 'australianFootball' ? 'Extra time' : 'Overtime'} ${n-4}`});
            } else if (family === 'football') parts.push({text: ({1:'First half',2:'Second half',3:'Extra time · first half',4:'Extra time · second half',5:'Penalties'})[n] || `Period ${n}`});
            else if (family === 'baseball') parts.push({text: `${p.half || 'Inning'} ${n}`});
        }
        if (p.clock) parts.push({text: String(p.clock), amount: true});
        if (family === 'cricket') {
            if (g.format) parts.push({text: g.format.toUpperCase()});
            if (p.day) parts.push({text: String(p.day)});
            if (p.overs) parts.push({text: `${p.overs} overs`});
        }
        return parts;
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
    /** "Sun 15 Nov" and "2:00 am" in the dashboard's zone (the viewer's locale), or null. */
    timeParts(ms, timezone) {
        if (!Number.isFinite(ms)) return null;
        try { return UI.dateParts(ms, {timeZone: timezone}); } catch { return null; } // a bad zone name throws: no time, never a wrong one
    },
    time(ms, timezone) { const t = this.timeParts(ms, timezone); return t ? `${t.day}, ${t.clock}` : 'Start time unavailable'; },
    initials(name) { return String(name || '').split(/\s+/).map(w => [...w].find(c => /[\p{L}\p{N}]/u.test(c)) || '').join('').slice(0, 2).toUpperCase(); },
    /** The card's two sibling buttons: the card (Watch or details) and the "⋯" options, never one inside the other. */
    item(title) {
        return `<button type="button" class="sports-card"></button><button type="button" class="sports-more" aria-label="${this.escape(`More options for ${title}`)}" title="More options">${SPORTS_ICONS.more}</button>`;
    },
    /** Which leagues get a shelf (they have games) and which are only named in one line (followed, nothing on). */
    layout(response, league, legacy) {
        const games = response.games || [], all = [...new Set([...(response.leagues || []), ...games.map(g => g.league)])];
        const visible = league ? [league] : all, has = l => games.some(g => g.league === l);
        return {followed: legacy || all.length > 0, shelves: visible.filter(has), quiet: visible.filter(l => !has(l))};
    },
    list(names, word) { return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${word} ${names[names.length - 1]}`; },
    /** How far the response looks: its `hours` when it gives them, "today" for the Today scope, else nothing said. */
    span(response) {
        const hours = Number(response?.hours);
        return Number.isFinite(hours) && hours > 0 ? `in the next ${hours} hours` : response?.scope === 'today' ? 'today' : '';
    },
    quietNote(names, span = '') { return `Also followed: ${this.list(names, 'and')}. Nothing on${span ? ` ${span}` : ''}.`; },
    loadingText(league) { return league ? `Loading ${league} games…` : 'Loading today’s games…'; },
    /** Loading: the page's shape, neutral card shapes in two shelves; no text in them (the status line says it is loading). */
    skeleton() {
        const card = '<div class="sports-sk-card"><span class="sports-sk sports-sk-line"></span><span class="sports-sk-team"><span class="sports-sk sports-sk-disc"></span><span class="sports-sk sports-sk-line"></span></span><span class="sports-sk-team"><span class="sports-sk sports-sk-disc"></span><span class="sports-sk sports-sk-line"></span></span><span class="sports-sk sports-sk-line"></span></div>';
        const shelf = `<div class="sports-shelf"><span class="sports-sk sports-sk-heading"></span><div class="sports-row sports-sk-row">${card.repeat(5)}</div></div>`;
        return `<div class="sports-skeleton" aria-hidden="true">${shelf}${shelf}</div>`;
    },
    skeletonChips() { return '<span class="sports-sk sports-sk-chip" aria-hidden="true"></span>'.repeat(4); },
    /** The page-level state blocks (UI.stateBlock arguments); the page binds each action's run. Settings opens only for an admin. */
    pageState(kind, {names = [], admin = false, span = ''} = {}) {
        const settings = label => admin ? {label} : null;
        if (kind === 'error') return {kind: 'error', text: {title: 'Sport could not be loaded.', detail: 'Live TV and the TV Guide still work.'}, action: {label: 'Try again'}};
        if (kind === 'nofollow') return {kind: 'empty', options: {className: 'sports-empty-page'},
            text: {title: 'Follow your teams and leagues', detail: 'Games you follow show here, live first, with the channel showing them and, when you want them, the scores.' +
                (admin ? '' : ' Choose what you follow in the PigTV app on Apple TV, iPad or iPhone.')},
            action: admin ? {label: 'Choose your sport', primary: true} : null};
        return {kind: 'empty', options: {className: 'sports-quiet'}, action: settings('Change what you follow'),
            text: {title: span === 'today' ? 'Nothing on today for the leagues you follow' : `Nothing on${span ? ` ${span}` : ''}`, detail: `${names.length ? `For ${this.list(names, 'or')}. ` : ''}Games show here as soon as the TV Guide or the scores feed lists them.`}};
    },
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
    /** A card's content: phrasing elements only (it sits in a <button>). Scores, times and clocks in the amount face. */
    card(g, prefs, timezone, recording=false) {
        const e = this.escape, hidden = prefs.avoidSpoilers !== false, family = this.family(g.league);
        const scores = !hidden && g.freshness === 'fresh' && family !== 'motorsport' && g.scores?.length === 2 ? g.scores : null;
        const availability = g.availability === 'unmatched' ? 'No channel found' : g.availability === 'unavailable' ? 'Channel unavailable' : '';
        let html = `<span class="sports-card-top"><span class="sports-status${this.live(g) ? ' is-live' : ''}">${e(this.status(g))}</span>`;
        if (hidden && family !== 'motorsport') html += '<span class="sports-hidden-tag">Scores hidden</span>';
        html += '</span>';
        if (family !== 'motorsport' && g.competitors?.length) {
            html += `<span class="sports-teams">${g.competitors.map((team,i)=> {
                const logo = /^\/api\/logo\/[A-Za-z0-9_.-]+$/.test(team.logo || '') && !team.logo.includes('..') ? team.logo : '';
                const badge = logo ? `<img class="sports-badge" src="${e(logo)}" alt="" loading="lazy" data-initials="${e(this.initials(team.name))}">`
                    : `<span class="sports-badge is-fallback" aria-hidden="true">${e(this.initials(team.name))}</span>`;
                return `<span class="sports-team">${badge}<span class="sports-team-name">${e(team.name)}</span>${scores ? `<strong class="sports-score pig-amount">${e(scores[i])}</strong>` : ''}</span>`;
            }).join('')}</span>`;
        } else html += `<span class="sports-event-title">${e(g.title)}</span>`;
        if (family === 'motorsport') {
            const sub = [g.session, g.circuit?.name].filter(Boolean);
            if (sub.length) html += `<span class="sports-sub">${e(sub.join(' · '))}</span>`;
        }
        const parts = this.progressParts(g, hidden), start = this.timeParts(g.start, timezone);
        const timing = parts.length && g.status !== 'scheduled' ? parts.map(p => p.amount ? `<span class="pig-amount">${e(p.text)}</span>` : e(p.text)).join(' · ')
            : start ? `${e(start.day)}, <span class="pig-amount">${e(start.clock)}</span>` : 'Start time unavailable';
        html += `<span class="sports-timing"><span class="sports-time">${timing}</span>`;
        const situation = this.situation(g,hidden);
        if (situation) html += `<span class="sports-situation">${e(situation)}</span>`;
        const note = [g.freshness === 'buffering' ? 'Waiting for delayed data' : g.freshness === 'stale' ? 'Scores unavailable · stale data' : '',g.dataSource === 'guide' ? 'Guide only · scores unavailable' : ''].filter(Boolean).join(' · ');
        if (note) html += `<span class="sports-note">${e(note)}</span>`;
        let meta = '';
        if (availability) meta += `<span class="sports-availability ${g.availability}">${g.availability === 'unmatched' ? SPORTS_ICONS.warn : SPORTS_ICONS.err}${availability}</span>`;
        else if (!this.terminal(g) && g.channels?.length) meta += `<span class="sports-channel">${SPORTS_ICONS.tv}${e(g.channels[0].name)}</span>`;
        if (recording) meta += '<span class="sports-recording">Recording</span>';
        if (meta) html += `<span class="sports-meta">${meta}</span>`;
        return html + '</span>';
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
        this.dialog=null; this.selection=null; this.timer=null; this.waiting=null; this.recordings=[]; this.recordingsVisit=0;
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
        // #276: the page's shape and its loading block at once, not a blank page until /api/info answers.
        this.setup();
        try {
            const info=await API.request('GET','/info');
            if (!this.state.valid(serial,identity)) return;
            this.state.legacy=info.features?.sportsDashboard!==true;
            this.rulesEnabled=info.features?.recordingRules===true;
            await this.state.load(true);
            this.watchRecordings(); this.poll();
            if(this.watchCancelled) { this.watchCancelled=false; UI.toast('Scheduled watch cancelled because Sport was closed'); }
        } catch { if (this.state.valid(serial,identity)) this.pageState('error',()=>this.show()); }
    }
    hide() { this.suspend(); }
    suspend() {
        this.unwatchRecordings?.(); this.unwatchRecordings=null; this.recordingsVisit++;
        if(this.waiting) this.watchCancelled=true;
        clearTimeout(this.timer); clearTimeout(this.waiting); this.waiting=null;
        this.state.active=false; this.recordings=[]; this.state.clear(); this.closeDialog();
        this.root?.replaceChildren(); this.cards.clear(); this.shelves.clear(); this.orders.clear(); this.shelvesArea=null; this.stateKey=null;
    }
    /** The page's frame: header with its quiet controls, the league chips, the status line, the state block and the shelves. */
    setup() {
        const el=(tag,cls,text)=> { const n=document.createElement(tag); if(cls) n.className=cls; if(text!=null) n.textContent=text; return n; };
        const header=el('div','page-header'); this.actions=el('div','sports-page-actions');
        header.append(el('h2',null,'Sport'),this.actions);
        const button=(cls,text,fn,icon)=> { const b=el('button',cls); b.type='button'; if(icon) b.innerHTML=icon; b.append(text); b.onclick=fn; this.actions.append(b); return b; };
        this.cancelWait=button('btn btn-secondary','Cancel scheduled watch',()=> {clearTimeout(this.waiting);this.waiting=null;this.cancelWait.hidden=true;this.notice('Scheduled watch cancelled.');});
        this.cancelWait.hidden=true;
        this.spoilerButton=button('btn btn-ghost','Scores & delay',()=>this.settings(),SPORTS_ICONS.eye);
        this.spoilerButton.hidden=true; // until the account's settings have arrived
        this.refreshButton=button('btn btn-ghost','Refresh',()=>this.state.load(true),SPORTS_ICONS.refresh);
        this.chips=el('div','sports-filters'); this.chips.setAttribute('role','group'); this.chips.setAttribute('aria-label','League');
        this.messageLine=el('p','sports-message'); this.messageLine.setAttribute('role','status');
        this.stateArea=el('div','sports-state'); this.shelvesArea=el('div','sports-shelves');
        this.quietLine=el('p','sports-quiet-note'); this.quietLine.hidden=true;
        this.root.replaceChildren(); this.root.append(header,this.chips,this.messageLine,this.stateArea,this.shelvesArea,this.quietLine);
        this.chips.innerHTML=SportsDashboardPolicy.skeletonChips(); this.chipNames=null;
        this.messageLine.textContent=SportsDashboardPolicy.loadingText(this.state.league);
        this.stateKey=null; this.pageState('loading');
    }
    /** One page-level block (loading, error, nothing followed, nothing on) in place of the shelves; null removes it. */
    pageState(kind,run,options={}) {
        const key=kind && `${kind}:${JSON.stringify(options)}`;
        if(!this.stateArea || this.stateKey===key) return;
        this.stateKey=key;
        if(!kind) { this.stateArea.replaceChildren(); this.stateArea.hidden=true; return; }
        this.stateArea.hidden=false;
        if(kind==='loading') { this.stateArea.innerHTML=SportsDashboardPolicy.skeleton(); return; }
        if(this.chipNames==null) this.chips.replaceChildren(); // no placeholder chips under an error or empty block
        const s=SportsDashboardPolicy.pageState(kind,options);
        this.stateArea.hidden=false;
        UI.setState(this.stateArea,s.kind,s.text,s.action && run ? {...s.action,run} : null,s.options);
    }
    /** "Choose your sport" / "Change what you follow": Settings, on its Sport tab (Your sport is its first panel), by its address. */
    openSportSettings() {
        this.app.navigateTo('settings', 'push', 'sport');
    }
    poll() {
        clearTimeout(this.timer);
        if (!this.state.active || document.hidden) return;
        this.timer=setTimeout(async()=> { await this.state.load(); this.poll(); },this.state.legacy ? 60000 : 20000);
    }
    /** #239 (0485): the recordings in progress come from the app's one feed (RecordingsFeed), not a fetch of our own. */
    watchRecordings() {
        this.unwatchRecordings?.();
        const feed=this.app.recordingsFeed;
        if (!feed) return;
        // Guarded by the account and this visit of the page, not the dashboard's request serial: that moves on every
        // dashboard load (each 20 s), which left the recording marks stale (0485 Codex round 1).
        const identity=this.state.identity(), visit=++this.recordingsVisit;
        this.unwatchRecordings=feed.subscribe(rows=> {
            if(this.recordingsVisit!==visit || !this.state.active || identity==null || this.state.identity()!==identity) return;
            this.recordings=Array.isArray(rows)?rows:[]; this.render();
        });
    }
    changeLeague(league) {
        this.closeDialog(); this.state.league=league; this.orders.clear(); this.cards.clear(); this.shelves.clear();
        this.shelvesArea?.replaceChildren();
        this.state.load(true);
    }
    render() {
        if (!this.state.active || !this.shelvesArea) return;
        const response=this.state.response, league=this.state.league, P=SportsDashboardPolicy;
        const admin=this.app?.currentUser?.role==='admin';
        const span=response ? P.span(response) : '';
        this.messageLine.textContent=this.state.message || (response ? this.state.legacy ? 'Ordinary sport · next 72 hours' : `${league ? `${league}${span && span!=='today' ? ` · ${span.replace(/^in the /,'')}` : ''}` : 'Today'} · ${response.timezone} · Scores delayed ${response.preferences.scoreDelaySeconds} s${response.preferences.avoidSpoilers?' · Scores hidden':''}` : this.cards.size ? 'Scores hidden until your account settings refresh.' : P.loadingText(league));
        if (!response) {
            for(const node of this.cards.values()) { node.querySelector('.sports-card').textContent='Scores hidden until refreshed'; node.querySelector('.sports-more').disabled=true; }
            if(this.cards.size) this.pageState(null);
            else if(this.state.message) this.pageState('error',()=>this.state.load(true));
            else this.pageState('loading');
            if(this.dialog && this.selection!=='settings') this.closeDialog();
            return;
        }
        const layout=P.layout(response,league,this.state.legacy);
        this.spoilerButton.hidden=this.state.legacy || !layout.followed; this.refreshButton.hidden=!layout.followed;
        this.chips.hidden=!layout.followed; this.messageLine.hidden=!layout.followed && !this.state.message;
        const filters=P.filters(response,this.state.legacy), chipNames=JSON.stringify([this.state.legacy,filters]);
        if(this.chipNames!==chipNames) {
            this.chips.replaceChildren(); this.chipNames=chipNames;
            const chip=(text,value)=> { const b=document.createElement('button'); b.type='button'; b.className='sports-filter'; b.textContent=text; b.dataset.league=value ?? ''; b.onclick=()=>this.changeLeague(value); this.chips.append(b); };
            chip(this.state.legacy?'All · next 72 hours':'Today',null);
            for(const name of filters) chip(name,name);
        }
        for(const b of this.chips.children) b.setAttribute('aria-pressed',String(b.dataset.league===(league ?? '')));
        const visible=[...layout.shelves,...layout.quiet];
        const focusedShelf=document.activeElement?.closest?.('.sports-shelf')?.dataset.league;
        if(focusedShelf && !visible.includes(focusedShelf)) visible.push(focusedShelf);
        const dropShelf=(name)=> {
            const shelf=this.shelves.get(name); if(!shelf) return;
            for(const article of shelf.querySelectorAll('[data-game]')) this.cards.delete(article.dataset.game);
            shelf.remove(); this.shelves.delete(name); this.orders.delete(name);
        };
        for(const name of [...this.shelves.keys()]) if(!visible.includes(name)) dropShelf(name);
        const quiet=[];
        for(const name of visible) {
            const games=response.games.filter(g=>g.league===name);
            const focused=document.activeElement?.closest?.('[data-game]')?.dataset.game;
            const order=P.order(this.orders.get(name)||[],games.map(g=>g.id),focused);
            // #276: a league with nothing on gets no empty shelf: it is named once, in the quiet line.
            if(!order.length) { dropShelf(name); if(layout.quiet.includes(name)) quiet.push(name); continue; }
            this.orders.set(name,order);
            let shelf=this.shelves.get(name);
            if(!shelf) {
                shelf=document.createElement('section'); shelf.className='sports-shelf'; shelf.dataset.league=name;
                const h=document.createElement('h3'); h.textContent=name; shelf.append(h);
                const row=document.createElement('div'); row.className='sports-row'; shelf.append(row); this.shelvesArea.append(shelf); this.shelves.set(name,shelf);
            }
            const row=shelf.querySelector('.sports-row');
            for(const id of order) {
                let article=this.cards.get(id), game=games.find(g=>g.id===id);
                if(!article) {
                    article=document.createElement('article'); article.className='sports-item'; article.dataset.game=id;
                    article.innerHTML=P.item(game ? game.title : '');
                    article.querySelector('.sports-card').onclick=()=>this.select(id);
                    article.querySelector('.sports-more').onclick=()=>this.details(id);
                    article.oncontextmenu=e=>{e.preventDefault();this.details(id);};
                    article.addEventListener('focusout',()=>setTimeout(()=>this.render(),0));
                    row.append(article); this.cards.set(id,article);
                }
                const card=article.querySelector('.sports-card'), more=article.querySelector('.sports-more');
                card.innerHTML=game ? P.card(game,response.preferences,response.timezone,P.recording(game,this.recordings)) : 'Event no longer available';
                card.querySelectorAll('img').forEach(img=> { img.onerror=()=> {
                    const disc=document.createElement('span'); disc.className='sports-badge is-fallback'; disc.setAttribute('aria-hidden','true');
                    disc.textContent=img.dataset.initials || ''; img.replaceWith(disc);
                }; });
                more.disabled=!game;
                more.setAttribute('aria-label',game ? `More options for ${game.title}` : 'Event no longer available');
            }
            for(const article of [...row.children]) if(!order.includes(article.dataset.game)) { this.cards.delete(article.dataset.game); article.remove(); }
        }
        if(!layout.followed) this.pageState('nofollow',()=>this.openSportSettings(),{admin});
        else if(!this.shelves.size) this.pageState('quiet',()=>this.openSportSettings(),{names:quiet,admin:admin && !this.state.legacy,span});
        else this.pageState(null);
        this.quietLine.hidden=!this.shelves.size || !quiet.length;
        this.quietLine.textContent=this.quietLine.hidden ? '' : P.quietNote(quiet,span);
        if(this.dialog && this.selection==='recording') {
            if(this.recordingRevision!==response.preferences.revision) this.closeDialog();
        } else if(this.dialog && this.selection!=='settings') this.renderDetails();
        if(this.dialog && this.selection==='settings' && this.settingsRevision!==response.preferences.revision) this.settings(true);
    }
    closeDialog() { const d=this.dialog; this.dialog=null; this.selection=null; d?.close(); d?.remove(); }
    openDialog(selection) {
        this.closeDialog(); this.selection=selection;
        const opener=document.activeElement;
        this.dialog=document.createElement('dialog'); this.dialog.className='ui-dialog sports-dialog';
        this.dialog.setAttribute('aria-label',selection==='settings'?'Sport account settings':selection==='recording'?'Record sport':'Sport event details');
        // Escape (the native cancel), a click on the backdrop and the dialog's own close buttons close it (UI.dialog);
        // focus goes back to the card that opened it.
        const el=this.dialog;
        UI.dialog.attach(el,{onClose:()=> { if(this.dialog===el) this.closeDialog(); }}).opener=opener;
        this.root.append(el); return el;
    }
    settings(replace=false) {
        const prefs=this.state.response?.preferences;
        if(!prefs || this.state.legacy) return;
        const dialog=replace ? this.dialog : this.openDialog('settings');
        this.settingsRevision=prefs.revision;
        dialog.innerHTML='<h2>Scores and delay · Your account</h2><form novalidate><label><input type="checkbox" name="avoidSpoilers"> Hide scores and result details</label><label>Score delay in seconds (0–300)<input type="number" name="scoreDelaySeconds" min="0" max="300" required aria-describedby="sports-delay-error"></label><p class="field-error" id="sports-delay-error" role="alert" hidden>Enter a whole number of seconds from 0 to 300.</p><p>Settings sync to devices signed in to this account.</p><button class="btn btn-primary" type="submit">Save score settings</button><button class="btn btn-secondary" type="button">Close</button></form>';
        const form=dialog.querySelector('form'); form.elements.avoidSpoilers.checked=prefs.avoidSpoilers; form.elements.scoreDelaySeconds.value=prefs.scoreDelaySeconds;
        form.onsubmit=async e=> {
            e.preventDefault(); const values={avoidSpoilers:form.elements.avoidSpoilers.checked,scoreDelaySeconds:Number(form.elements.scoreDelaySeconds.value)};
            const input=form.elements.scoreDelaySeconds, bad=form.elements.scoreDelaySeconds.value.trim()==='' || !Number.isInteger(values.scoreDelaySeconds) || values.scoreDelaySeconds<0 || values.scoreDelaySeconds>300;
            // #276 (C13): a bad number is said, beside the field, not dropped.
            form.querySelector('.field-error').hidden=!bad; input.toggleAttribute('aria-invalid',bad);
            if(bad) { input.focus(); return; }
            this.closeDialog(); await this.state.save(values,prefs.revision);
        };
        form.elements.scoreDelaySeconds.addEventListener('input',()=> { form.querySelector('.field-error').hidden=true; form.elements.scoreDelaySeconds.removeAttribute('aria-invalid'); });
        form.querySelector('[type=button]').onclick=()=>this.closeDialog();
        if(!replace) UI.dialog.attach(dialog).open();
    }
    details(id) { this.openDialog(id); this.renderDetails(); if(this.dialog) UI.dialog.attach(this.dialog).open(); }
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
            // The record dialog is neutral and modal; actual mutation revalidates again after the user chooses.
            this.confirmRecording(id,SportsDashboardPolicy.key(selected.channel),action,selected);
        } catch { if(!this.state.identity()) this.state.clear(); this.notice('Sport action unavailable. Refresh and try again.'); }
    }
    confirmRecording(id,key,action,selected) {
        const dialog=this.openDialog('recording'), revision=this.state.response.preferences.revision;
        // Treat this as a live event selection so a poll clears/reprojects it safely.
        this.selection='recording'; this.recordingRevision=revision;
        const title=document.createElement('h2'); title.textContent=action.startsWith('every:') ? `Record every game: ${action.slice(6)}` : `Record · ${selected.title}`; dialog.append(title);
        const form=document.createElement('form');
        const every=action.startsWith('every:');
        form.innerHTML=`<label>Minutes before<input name="pre" type="number" min="0" max="60" value="1" required></label><label>Minutes after<input name="post" type="number" min="0" max="120" value="5" required></label><button type="submit" class="btn btn-primary">${every ? 'Record every game' : 'Record'}</button><button type="button" class="btn btn-secondary">Cancel</button>`;
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
                } else await API.recordings.schedule({sourceId:Number(c.sourceId),channelItemId:c.id,channelName:c.name,title:fresh.title,programStart:fresh.event.start,programEnd:fresh.event.end,preBufferMin:pre,postBufferMin:post});
                // A rule that matched nothing must not read as a scheduled recording.
                const made=rule?.scheduled;
                this.notice(!rule ? 'Recording request saved.' : made>0 ? `Rule saved · ${made} scheduled.` : 'Rule saved · nothing scheduled yet: no upcoming airing matched.');
            } catch { this.notice('Recording request failed. Review Recordings before trying again.'); }
        };
        UI.dialog.attach(dialog).open();
    }
    notice(message) { this.state.message=message; this.render(); }
}
window.SportsDashboardPolicy=SportsDashboardPolicy;
window.SportsDashboardState=SportsDashboardState;
window.SportsPage=SportsPage;
