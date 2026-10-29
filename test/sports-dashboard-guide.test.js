const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createStore } = require('../server/services/sportsDashboardStore');
const { buildDashboard } = require('../server/services/sportsDashboard');
const db = new Database(':memory:'), store = createStore(db);
after(() => db.close());
const H = 3600000, now = Date.parse('2026-10-29T01:00Z');
const channel = { sourceId: 1, id: 'pos_1', stableId: 'stable', name: 'Sport', password: 'never-return' };
const event = (id, extra = {}) => ({ id, league: 'NFL', title: 'Chiefs v Bills', kind: 'event', start: now-H,
    end: now+H, live: true, channels: [channel], ...extra });
const game = (id, extra = {}) => ({ id, league: 'NFL', title: 'Chiefs v Bills', start: now-H, end: null,
    session: null, circuit: null, format: null,
    competitors: [{id:'a',name:'Chiefs',aliases:['Chiefs'],logo:null},{id:'b',name:'Bills',aliases:['Bills'],logo:null}],
    snapshot: {state:'live',progress:{},scores:['7','3'],situation:null}, ...extra });
const response = (events, extra={}) => buildDashboard(store, { now, userId:'guide', timezone:'Australia/Melbourne',events,...extra });

test('guide-only follows survive missing catalogs without claiming live scores or leaking channel fields', () => {
    const r=response([event('missing')]);
    assert.equal(r.games.length,1);
    const c=r.games[0];
    assert.equal(c.id,'guide:missing');assert.equal(c.status,'unknown');assert.equal(c.broadcastStatus,'on-tv');
    assert.equal(c.dataSource,'guide');assert.equal(c.canWatch,true);assert.equal(c.scores,undefined);
    assert.deepEqual(c.progress,{});assert.equal(c.channels[0].stableId,'stable');
    assert.equal(c.channels[0].password,undefined);
});
test('fallback obeys today/cross-midnight/72h, excludes ended listings, replays and generic shows', () => {
    const events=[event('overnight',{start:now-14*H}), event('future',{start:now+48*H,end:now+49*H,live:false}),
        event('ended',{end:now}),event('replay',{kind:'replay'}),event('show',{kind:'show'}),event('placeholder',{kind:'placeholder'})];
    assert.deepEqual(response(events).games.map(g=>g.id),['guide:overnight']);
    assert.deepEqual(response(events,{league:'NFL'}).games.map(g=>g.id),['guide:future','guide:overnight']);
    assert.equal(response(events,{league:'NFL'}).games.find(g=>g.id==='guide:future').canWatch,false);
});
test('catalog joins, ambiguous doubleheaders and delayed/expired finals cannot reappear as watchable fallback', () => {
    store.ingest([game('catalog')],now-100000);
    assert.deepEqual(response([event('joined')]).games.map(g=>g.id),['catalog']);
    store.ingest([game('second')],now-100000);
    const ambiguous=response([event('ambiguous')]);
    assert.equal(ambiguous.games.length,2);assert.ok(ambiguous.games.every(g=>!g.canWatch));
    store.ingest([game('catalog',{snapshot:{state:'finished',progress:{},scores:['7','3'],situation:null}}),
        game('second',{snapshot:{state:'finished',progress:{},scores:['7','3'],situation:null}})],now);
    const later=response([event('long-airing',{end:now+3*H})],{now:now+2*H});
    assert.deepEqual(later.games,[]);
});
test('unknown-format cricket cannot hide a possible rematch or authorize a wider playback join', () => {
    store.ingest([game('cricket',{league:'Cricket',start:now-48*H})],now-100000);
    const r=response([event('cricket-guide',{league:'Cricket'})]);
    assert.equal(r.games.filter(g=>g.league==='Cricket').length,2,'unknown identity may be a new same-team match; retain the guide listing');
    assert.equal(r.games.find(g=>g.id==='cricket').canWatch,false);
    const guide=r.games.find(g=>g.id==='guide:cricket-guide');
    assert.equal(guide.canWatch,false);assert.equal(guide.availability,'unmatched');
    assert.deepEqual(guide.channels,[],'uncertain guide fallback cannot bypass the 12h join');
});
test('hidden guide fallback never returns untrusted result prose through title, aliases or competitors', () => {
    store.updatePreferences('hidden',{revision:0,avoidSpoilers:true});
    const r=response([event('spoiler',{league:'NBA',title:'Final: A beat B 120-100',aliases:['A wins']})],{userId:'hidden'});
    const c=r.games.find(g=>g.id==='guide:spoiler');
    assert.ok(c);assert.equal(c.title,'NBA · Guide event');assert.deepEqual(c.competitors,[]);
    assert.ok(!JSON.stringify(c).includes('120-100'));assert.equal(c.aliases,undefined);
});

test('empty followed sports remain named even without catalog or guide data', () => {
    const leagues=new Set(['AFL','F1','EPL','Cricket','MLB','NFL','FA Cup','UEFA','Championship','NBA']);
    const r=response([],{leagues});
    assert.deepEqual(r.leagues,[...leagues].sort());
});

test('a generic C-I event is not hidden just because an unidentified catalog game starts nearby', () => {
    // C-I already promotes category/keyword listings only under its own event/show rules.
    const r=response([event('generic-coverage',{title:'NFL coverage'})]);
    const guide=r.games.find(g=>g.id==='guide:generic-coverage');
    assert.ok(guide,'league/time overlap alone does not establish duplicate identity');
    assert.equal(guide.status,'unknown');assert.equal(guide.broadcastStatus,'on-tv');
    assert.ok(r.games.filter(g=>g.id==='catalog' || g.id==='second').every(g=>!g.canWatch),
        'the generic slot must never be silently assigned to a named catalog game');
});

test('cross-midnight games stay visible while their first delayed snapshot is buffering, even without a broadcast', () => {
    const localDb=new Database(':memory:'),s=createStore(localDb);
    try {
        s.ingest([game('midnight',{start:now-2*H})],now-30000);
        for(const events of [[],[event('midnight-airing',{start:now-2*H})]]) {
            const r=buildDashboard(s,{now,userId:'midnight',timezone:'UTC',events});
            assert.equal(r.games.length,1,'a delayed/unknown score must not remove the cross-midnight game');
            assert.equal(r.games[0].status,'unknown');assert.equal(r.games[0].freshness,'buffering');
            assert.equal(r.games[0].scores,undefined);
            assert.equal(r.games[0].canWatch,events.length>0);
        }
    } finally {localDb.close();}
});

test('cross-midnight first-seen historical finals buffer, then disappear without inventing recent-final retention', () => {
    const localDb=new Database(':memory:'),s=createStore(localDb);
    try {
        s.ingest([game('historic-midnight',{start:now-2*H,snapshot:{state:'finished',progress:{},scores:['7','3'],situation:null}})],now);
        assert.equal(buildDashboard(s,{now,userId:'midnight',timezone:'UTC'}).games.length,1);
        assert.equal(buildDashboard(s,{now:now+90000,userId:'midnight',timezone:'UTC'}).games.length,0);
    } finally {localDb.close();}
});

test('a later same-team guide game survives a partial catalog containing only an expired final, without tuning it', () => {
    for (const observedLive of [true,false]) {
    const localDb=new Database(':memory:'),s=createStore(localDb);
    try {
        const previous=game('previous-t20',{league:'Cricket',format:'t20',start:now-3*H});
        if (observedLive) s.ingest([previous],now-3*H);
        s.ingest([{...previous,snapshot:{state:'finished',progress:{},scores:['120','121'],situation:null}}],now-2*H);
        const events=[event('next-t20',{league:'Cricket',title:'Chiefs v Bills · T20',start:now,end:now+4*H})];
        let r=buildDashboard(s,{now,userId:'rematch',events,timezone:'UTC'});
        assert.equal(r.games.length,1,'a new guide window after the eligible final cannot be silently swallowed');
        assert.equal(r.games[0].id,'guide:next-t20');assert.equal(r.games[0].availability,'unmatched');
        assert.equal(r.games[0].canWatch,false);assert.deepEqual(r.games[0].channels,[]);
        s.ingest([game('new-t20',{league:'Cricket',format:'t20',start:now})],now-100000);
        r=buildDashboard(s,{now,userId:'rematch',events,timezone:'UTC'});
        assert.deepEqual(r.games.map(g=>g.id),['new-t20']);
        assert.equal(r.games[0].canWatch,true,'a newly observed unambiguous game replaces the uncertain guide listing');
    } finally {localDb.close();}
    }
});

test('selection eligibility rechecks airing bounds instead of the cached C-I live boolean', () => {
    const localDb=new Database(':memory:'),s=createStore(localDb);
    try {
        s.ingest([game('airing-boundary')],now-100000);
        const events=[event('begins-now',{start:now,end:now+H,live:false})];
        const current=buildDashboard(s,{now,userId:'boundary',events,timezone:'UTC'}).games[0];
        assert.equal(current.canWatch,true,'C-I live was false when the per-minute cache was built before this airing began');
        const before=buildDashboard(s,{now:now-1,userId:'boundary',events,timezone:'UTC'}).games[0];
        assert.equal(before.canWatch,false);
        const expired=buildDashboard(s,{now:now+H,userId:'boundary',events:[{...events[0],live:true}],timezone:'UTC'}).games[0];
        assert.equal(expired?.canWatch || false,false,'a cached true flag cannot extend an expired airing');
    } finally {localDb.close();}
});
