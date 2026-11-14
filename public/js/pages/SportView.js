/**
 * #323: the web Sport section's words and markup, ported from the Apple apps' Sport views (SportFrontModels,
 * SportsGameModels, SportGameCard, SportBanner, SportFrontTVPage, SportFrontPhonePage, SportPhoneModels). Pure: every
 * function takes the server's answer and returns text or HTML (no fetching, no DOM), so the tests render the real thing.
 *
 * Hidden scores (#192, #278: the OR rule). `SportView.hidden()` is the one answer: the account's choice (GET
 * /api/sports/pages/preferences `spoilerFree`; unknown, stale or unread counts as hidden) OR the answer's own
 * `spoilerFree` OR a parent page's decision. With it on, no score, result or score-revealing word is written into the
 * markup at all (not hidden by CSS, not in an attribute): the functions below simply never receive or print one.
 *
 * Every server string goes through `e()` (UI.escape). Only same-server logo-cache paths are drawn (`logo()`).
 */
const SportView = (() => {
    const e = (v) => UI.escape(v);
    const ONGOING = ['live', 'break', 'suspended'];
    const TERMINAL = ['finished', 'cancelled', 'postponed'];
    const ICON = {
        play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
        rec: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/></svg>',
        bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21h4"/></svg>',
        chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
        back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
        eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/></svg>',
        eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12s3.5-6 9-6c1.6 0 3 .5 4.2 1.2M21 12s-3.5 6-9 6c-1.6 0-3-.5-4.2-1.2"/><path d="M4 20L20 4"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
        warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg>',
        channels: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="7" width="14" height="11" rx="2"/><path d="M7 4h12a2 2 0 0 1 2 2v9"/><path d="M8.5 10.5v4l3.5-2z" fill="currentColor"/></svg>',
        repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 11a4 4 0 0 1 7-2.5M16 13a4 4 0 0 1-7 2.5"/><path d="M15 6v3h-3M9 18v-3h3"/></svg>',
        sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
        star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>'
    };

    // ---------- the hidden-scores decision (#192, #278) ----------

    /**
     * Scores, situations and results are hidden when any input says so: the account's choice as last read
     * (`preference`: true, or unknown: `known` false), the answer's own `spoilerFree`, or the page's decision.
     */
    function hidden({ known = false, preference = true, answer = false, page = false } = {}) {
        if (!known || preference !== false) return true;
        if (answer === true) return true;
        return page === true;
    }

    // ---------- games (SportsGame) ----------

    const FAMILY = { AFL: 'australianFootball', AFLW: 'australianFootball', NBA: 'basketball', EPL: 'football', 'FA Cup': 'football',
        UEFA: 'football', Championship: 'football', NFL: 'americanFootball', MLB: 'baseball', Cricket: 'cricket', F1: 'motorsport' };
    const family = (g) => FAMILY[g && g.league] || 'guide';
    const terminal = (g) => TERMINAL.includes(g && g.status);
    const underWay = (status) => ONGOING.includes(status);
    const isOnAir = (g) => !!g && g.onAir === true && g.status === 'scheduled';
    const showsLive = (g) => underWay(g.status) || isOnAir(g);
    const isNextRound = (g) => g.nextRound === true && g.status === 'scheduled';
    const twoSided = (g) => Array.isArray(g.competitors) && g.competitors.length === 2;

    /** Only cached same-server logos: `/api/logo/<key>`, no query, no "..". */
    function logo(path) {
        return typeof path === 'string' && /^\/api\/logo\/[A-Za-z0-9_.-]+$/.test(path) && !path.includes('..') ? path : null;
    }

    /** The status in words, sentence case. A finished football game reads "FT", as the mocks have it. */
    function statusWord(g) {
        switch (g.status) {
            case 'finished': return family(g) === 'football' || /football|soccer/i.test(g.sport || '') ? 'FT' : 'Final';
            case 'cancelled': return 'Cancelled';
            case 'postponed': return 'Postponed';
            case 'suspended': return 'Suspended';
            case 'break': return g.breakLabel || 'Break';
            case 'scheduled': return isOnAir(g) ? 'On air' : 'Upcoming';
            default:
                if (g.status === 'live' && g.freshness === 'fresh') return 'Live';
                return g.broadcastStatus === 'on-tv' ? 'On TV now' : g.freshness === 'buffering' ? 'Buffering' : 'Status unavailable';
        }
    }

    /** "Not on your channels" and friends: what the game's channel situation is, for a finished or channel-less game. */
    function availabilityWord(g) {
        if (g.status === 'finished') return 'Event ended';
        if (g.availability === 'unmatched') return 'No channel found';
        if (g.availability === 'unavailable') return 'Channel unavailable';
        return (g.channels && g.channels[0] && g.channels[0].name) || 'No channel found';
    }

    /** A football shoot-out reveals a draw: with scores hidden its period is never named, whatever the server sent. */
    function period(g, hide) {
        const n = g.progress && g.progress.period;
        if (!(n > 0)) return 0;
        return hide && family(g) === 'football' && n >= 5 ? 0 : n;
    }

    /** Neutral progress: "Second half · 67'", "Quarter 2 · 5:00", cricket's format, day and overs. */
    function progressLabel(g, hide) {
        if (g.freshness !== 'fresh' || family(g) === 'motorsport') return '';
        const p = g.progress || {}, parts = [], n = period(g, hide), f = family(g);
        if (n > 0) {
            if (f === 'australianFootball') parts.push(n <= 4 ? `Quarter ${n}` : `Extra time ${n - 4}`);
            else if (f === 'basketball' || f === 'americanFootball') parts.push(n <= 4 ? `Quarter ${n}` : `Overtime ${n - 4}`);
            else if (f === 'football') parts.push({ 1: 'First half', 2: 'Second half', 3: 'Extra time · first half', 4: 'Extra time · second half', 5: 'Penalties' }[n] || `Period ${n}`);
            else if (f === 'baseball') parts.push(`${p.half ? p.half[0].toUpperCase() + p.half.slice(1) : 'Inning'} ${n}`);
        }
        if (p.clock) parts.push(String(p.clock));
        if (f === 'cricket') {
            if (g.format) parts.push(String(g.format).toUpperCase());
            if (p.day) parts.push(String(p.day));
            if (p.overs) parts.push(`${p.overs} overs`);
        }
        return parts.join(' · ');
    }

    /** The play situation (NFL downs, MLB count): a score-derived detail, so never with scores hidden. */
    function situationLabel(g, hide) {
        if (hide || g.freshness !== 'fresh' || !g.situation) return '';
        const s = g.situation, parts = [];
        if (family(g) === 'americanFootball') {
            if (s.down != null && s.distance != null) parts.push(`Down ${s.down} · ${s.distance} yards`);
            if (s.yardLine != null) parts.push(`Yard line ${s.yardLine}`);
        } else if (family(g) === 'baseball') {
            if (s.balls != null && s.strikes != null) parts.push(`${s.balls} balls · ${s.strikes} strikes`);
            if (s.outs != null) parts.push(`${s.outs} outs`);
            const bases = [['First', s.onFirst], ['Second', s.onSecond], ['Third', s.onThird]].filter(b => b[1] === true).map(b => b[0]);
            if (bases.length) parts.push(`On base: ${bases.join(', ')}`);
        }
        return parts.join(' · ');
    }

    /** One score per competitor, or null: hidden, stale, a session, or not two of them. */
    function scores(g, front, hide) {
        if (hide || (front && front.scores === 'unavailable')) return null;
        if (g.freshness !== 'fresh' || family(g) === 'motorsport' || !Array.isArray(g.scores) || g.scores.length !== 2) return null;
        return g.scores.map(String);
    }

    function situation(g, front, hide) {
        if (front && front.scores === 'unavailable') return '';
        return [progressLabel(g, hide), situationLabel(g, hide)].filter(Boolean).join(' · ');
    }

    // ---------- times ----------

    const sameDay = (a, b) => UI.date(a) === UI.date(b);
    const weekday = (ms) => UI.date(ms).split(' ')[0];
    /** "5:30 pm" today, else "Sat 5:30 pm" (the viewer's zone). */
    function when(ms, now) {
        if (!Number.isFinite(ms)) return '';
        return sameDay(ms, now) ? UI.clock(ms) : `${weekday(ms)} ${UI.clock(ms)}`;
    }
    /** "Saturday 14 November": the page header's date. */
    function headerDate(now) {
        try {
            const parts = Object.fromEntries(new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
                .formatToParts(new Date(now)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
            return `${parts.weekday} ${parts.day} ${parts.month}`;
        } catch { return UI.date(now); }
    }
    /** "On air · starts 3:10 pm". */
    const onAirLine = (g) => `On air · starts ${UI.clock(g.start)}`;
    /** When it starts: "5:30 pm", "Sat 5:30 pm", or a next round's "Next round · Sat 22 Nov". */
    function startLine(g, now) {
        if (isNextRound(g)) return `Next round · ${UI.date(g.start)}`;
        return when(g.start, now);
    }
    /** The channel words beside a game: its best channel, "No TV listing found" before it with none, nothing after. */
    function channelLine(g) {
        if (isNextRound(g)) return '';
        const best = g.channels && g.channels[0];
        return best ? best.name : terminal(g) ? '' : 'No TV listing found';
    }

    /** A live card's short clock: "Q4 0:17", "2nd half 67'", "Top 5"; on air: "On air · starts 3:10 pm" (or "On air"). */
    function cardClock(g, front, hide, startShown = false) {
        if (isOnAir(g)) return startShown ? 'On air' : onAirLine(g);
        if ((front && front.scores === 'unavailable') || g.freshness !== 'fresh' || family(g) === 'motorsport') return statusWord(g);
        const f = family(g), n = period(g, hide), parts = [];
        if (n > 0) {
            if (f === 'americanFootball' || f === 'basketball') parts.push(n <= 4 ? `Q${n}` : `OT${n - 4}`);
            else if (f === 'australianFootball') parts.push(n <= 4 ? `Q${n}` : `ET${n - 4}`);
            else if (f === 'football') parts.push({ 1: '1st half', 2: '2nd half', 3: 'ET 1st', 4: 'ET 2nd', 5: 'Pens' }[n] || `P${n}`);
            else if (f === 'baseball') { const h = (g.progress && g.progress.half) || 'Inn'; parts.push(`${h[0].toUpperCase()}${h.slice(1)} ${n}`); }
        }
        if (f === 'cricket') return situation(g, front, hide) || statusWord(g);
        if (g.progress && g.progress.clock) parts.push(String(g.progress.clock));
        return parts.length ? parts.join(' ') : statusWord(g);
    }

    // ---------- actions: Watch, Remind me, details (C-R; revalidated at the press) ----------

    /** The game as an event on its best channel: that channel's own airing (#20), else the game's. Null without one. */
    function event(g) {
        const best = g.channels && g.channels[0];
        if (!best) return null;
        const airing = (g.events || [])[0];
        const start = Number.isFinite(best.start) ? best.start : airing ? airing.start : g.start;
        let end = Number.isFinite(best.end) ? best.end : airing ? airing.end : Number.isFinite(g.end) ? g.end : start + 3 * 3600000;
        end = Math.max(end, start + 60000);
        return { id: airing ? airing.id : g.id, title: g.title, channel: best, start, end };
    }
    /** "watch" while its channel airs it, "remind" before, "details" after; "none" for a result, a next round, no channel. */
    function action(g, now) {
        if (terminal(g) || isNextRound(g)) return 'none';
        const ev = event(g);
        if (!ev) return 'none';
        if (ev.start <= now && now < ev.end) return 'watch';
        return ev.start > now ? 'remind' : 'details';
    }
    function actionLabel(g, now) {
        return { watch: 'Watch', remind: 'Remind me', details: 'Details' }[action(g, now)]
            || (terminal(g) || isNextRound(g) ? '' : 'Not on your channels');
    }

    // ---------- follows, stars, sections (SportFrontLayout) ----------

    const lower = (s) => String(s || '').toLowerCase();
    function nameMatches(competitor, names) {
        const n = lower(competitor);
        return names.map(lower).some(f => f === n || f.endsWith(' ' + n) || n.endsWith(' ' + f));
    }
    /** Every followed side: the server's `followedSides` (#249), else by name. */
    function followedSides(g, names) {
        if (!twoSided(g)) return [];
        if (Array.isArray(g.followedSides)) return g.followedSides.filter(i => i === 0 || i === 1);
        return [0, 1].filter(i => nameMatches(g.competitors[i].name, names));
    }
    /** The sides a card stars (touch: a followed card whose side cannot be told keeps its outline instead). */
    const cardStars = (g, names) => (g.followed === true ? followedSides(g, names) : []);
    /** Which competitor is this follow's (its name decides; else the server's match when it names one side). */
    function followedSide(g, names) {
        if (!twoSided(g)) return null;
        const byName = g.competitors.findIndex(c => nameMatches(c.name, names));
        if (byName >= 0) return byName;
        const sides = (g.followedSides || []).filter(i => i === 0 || i === 1);
        return sides.length === 1 ? sides[0] : null;
    }

    const label = (league, labels) => (labels && labels[league]) || league;
    /** The sport a league belongs to: the rail's own, else its `sports[]` entry's, else the league. */
    function sportOf(league, railSport, front) {
        if (railSport) return railSport;
        const s = (front.sports || []).find(x => x.league === league);
        return (s && s.sport) || league;
    }
    const game = (front, id) => (id == null ? null : (front.games || []).find(g => g.id === id) || null);
    const railGames = (front, rail) => (rail.gameIds || []).map(id => game(front, id)).filter(Boolean);

    /** One section per sport with a rail that has a game, in the order its first rail comes. */
    function sections(front) {
        const order = [], rails = new Map();
        for (const rail of front.rails || []) {
            if (!railGames(front, rail).length) continue;
            const sport = sportOf(rail.league, rail.sport, front);
            if (!rails.has(sport)) { order.push(sport); rails.set(sport, []); }
            rails.get(sport).push(rail);
        }
        return order.map(sport => ({ sport, rails: rails.get(sport) }));
    }
    /** Every followed sport once, in `sports[]` order (then any only a rail names). */
    function allSports(front) {
        const out = [];
        for (const name of [...(front.sports || []).map(s => s.sport || s.league), ...(front.rails || []).map(r => sportOf(r.league, r.sport, front))]) {
            if (!out.includes(name)) out.push(name);
        }
        return out;
    }
    /** "Also in your sports": followed sports with no rail. */
    function alsoInYourSports(front) {
        const shown = sections(front).map(s => s.sport);
        return allSports(front).filter(s => !shown.includes(s));
    }
    function nextStart(sport, front) {
        const starts = (front.sports || []).filter(s => (s.sport || s.league) === sport && s.next && Number.isFinite(s.next.start)).map(s => s.next.start);
        return starts.length ? Math.min(...starts) : null;
    }
    /** A section header's line: "Premier League, A-League Men · 2 live", "NBA · Sun 11:30 am". */
    function headerLine(section, front, now, labels) {
        const leagues = section.rails.map(r => r.league).filter(l => l !== section.sport).map(l => label(l, labels));
        const live = (front.sports || []).filter(s => (s.sport || s.league) === section.sport).reduce((n, s) => n + (s.live || 0), 0);
        const parts = leagues.length ? [leagues.join(', ')] : [];
        if (live > 0) parts.push(`${live} live`);
        else { const next = nextStart(section.sport, front); if (next != null) parts.push(when(next, now)); }
        return parts.join(' · ');
    }
    const alsoLine = (sport, front, now) => { const next = nextStart(sport, front); return next == null ? '' : when(next, now); };

    function opponent(follow, g) {
        const mine = followedSide(g, [follow.name]);
        return mine == null ? null : g.competitors[1 - mine].name;
    }
    /** A follow row's right-hand words: "LIVE · v Man City", "Race · Mon 7:00 am", "Mon 5:00 am", "Nothing in 3 days". */
    function followTrailing(follow, front, now) {
        const g = game(front, follow.gameId);
        if (follow.state === 'live') {
            if (g && isOnAir(g)) return g.session ? `${g.session} · ${onAirLine(g)}` : onAirLine(g);
            const other = g && twoSided(g) ? opponent(follow, g) : null;
            return other ? `Live · v ${other}` : 'Live';
        }
        if (follow.state === 'next') {
            const start = Number.isFinite(follow.start) ? follow.start : g ? g.start : null;
            if (start == null) return 'Next';
            if (g && isNextRound(g)) return startLine(g, now);
            const w = when(start, now);
            return g && g.session ? `${g.session} · ${w}` : w;
        }
        return 'Nothing in 3 days';
    }
    const yours = (sport) => ({ Motorsport: 'Your driver', Tennis: 'Your player', Golf: 'Your player', Combat: 'Your fighter' })[sport] || 'Your team';
    function kickerWord(g) {
        if (underWay(g.status)) return 'Live';
        if (g.status === 'scheduled') return isOnAir(g) ? 'On air' : 'Next';
        if (g.status === 'finished') return 'Final';
        return g.broadcastStatus === 'on-tv' ? 'On TV' : 'Next';
    }

    /** The hero's words: kicker, live dot, title, one line. No score or situation when hidden. */
    function hero(g, front, hide, now, labels) {
        const sport = sportOf(g.league, null, front), league = label(g.league, labels);
        const kicker = [kickerWord(g)];
        if (lower(sport) !== lower(g.league) && lower(sport) !== lower(league)) kicker.push(sport);
        kicker.push(league);
        if (g.followed === true) kicker.push(yours(sport));
        const line = [], sc = scores(g, front, hide), sit = situation(g, front, hide);
        if (sc) line.push(sc.join('–'));
        if (sit) line.push(sit);
        if (g.status === 'scheduled') {
            const w = isOnAir(g) ? onAirLine(g) : startLine(g, now);
            line.push(g.session ? `${g.session} · ${w}` : w);
        }
        if (!isNextRound(g)) line.push((g.channels && g.channels[0] && g.channels[0].name) || (terminal(g) ? availabilityWord(g) : 'No TV listing found'));
        return { kicker: kicker.join(' · '), live: showsLive(g), title: g.title, line: line.join(' · ') };
    }
    const NO_HERO = { kicker: 'Your sports', live: false, title: 'Nothing on right now', line: 'The next games you follow are below.' };

    // ---------- the hero (SportFrontHero) ----------

    const followKey = (f) => `${f.league}|${f.name}`;
    function followsGoneLive(previous, front) {
        if (!previous) return [];
        const before = new Map((previous.follows || []).map(f => [followKey(f), f.state]));
        return (front.follows || []).map((f, i) => (f.state === 'live' && before.get(followKey(f)) !== 'live' ? i : -1)).filter(i => i >= 0);
    }
    function resolveHero({ current, front, wentLive = [], selectedFollow = null, pinned = null }) {
        const follows = front.follows || [];
        if (pinned && game(front, pinned)) return pinned;
        if (selectedFollow != null && follows[selectedFollow] && game(front, follows[selectedFollow].gameId)) return follows[selectedFollow].gameId;
        if (wentLive.length) {
            const i = front.hero && front.hero.followIndex;
            if (wentLive.includes(i) && follows[i] && game(front, follows[i].gameId)) return follows[i].gameId;
            for (const j of wentLive) if (game(front, follows[j].gameId)) return follows[j].gameId;
        }
        const cur = game(front, current);
        if (cur && underWay(cur.status)) return current;
        const h = game(front, front.hero && front.hero.gameId);
        return h ? h.id : null;
    }
    /** The follow the hero belongs to, for the list's highlight. */
    function heroFollowIndex(front, heroId, selected) {
        if (!heroId) return null;
        const follows = front.follows || [];
        if (selected != null && follows[selected] && follows[selected].gameId === heroId) return selected;
        const i = front.hero && front.hero.followIndex;
        if (Number.isInteger(i) && follows[i] && follows[i].gameId === heroId) return i;
        const j = follows.findIndex(f => f.gameId === heroId);
        return j >= 0 ? j : null;
    }
    /** #261: a game under way, or not over and within an hour of its start: refresh every 20 s, else 60 s. */
    function fastRefresh(front, now) {
        return (front.games || []).some(g => underWay(g.status) || (!terminal(g) && Math.abs(g.start - now) <= 3600000));
    }

    // ---------- markup: small parts ----------

    /** "Green Bay Packers" -> "GP", "Bears" -> "B". */
    function monogram(name) {
        const words = String(name || '').split(/\s+/).filter(w => /^[\p{L}\p{N}]/u.test(w));
        if (!words.length) return '?';
        return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0][0]).toUpperCase();
    }
    /** A team's badge: the cached logo, the monogram disc as the fallback (also when the logo fails, `onBadgeError`). */
    function badge(name, path, size = 26) {
        const src = logo(path), mono = monogram(name);
        const box = `width:${size}px;height:${size}px`;
        return src
            ? `<img class="badge" src="${e(src)}" alt="" width="${size}" height="${size}" loading="lazy" data-mono="${e(mono)}" style="${box}">`
            : `<span class="disc" aria-hidden="true" style="${box};font-size:${Math.round(size * 0.38)}px">${e(mono)}</span>`;
    }
    /** A league's square badge ("PL", "DPW") for a session row or a league list. */
    function leagueBadge(league) {
        const text = league.length <= 3 ? league.toUpperCase() : league.replace(/\s+/g, '').slice(0, 3).toUpperCase();
        return `<span class="lbadge" aria-hidden="true">${e(text)}</span>`;
    }
    const star = (word = 'Your team') => `<span class="star" aria-hidden="true">★</span><span class="visually-hidden">${e(word)}, </span>`;
    const dot = () => '<span class="dot" aria-hidden="true"></span>';

    function scoresChip(hide) {
        return `<span class="chip-state">${hide ? ICON.eyeOff : ICON.eye}${hide ? 'Scores hidden' : 'Scores shown'}</span>`;
    }
    /** The page header: the title (and date, or a back link), the scores chip. */
    function header({ title, now, hide, back = null, extra = '' }) {
        const backLink = back ? `<button type="button" class="back-link" data-act="back">${ICON.back}<span>${e(back)}</span></button>` : '';
        const date = back ? '' : `<span class="date">${e(headerDate(now))}</span>`;
        return `<div class="sp-head"><div class="titles">${backLink}<h2>${e(title)}</h2>${date}</div>${extra}${scoresChip(hide)}</div>`;
    }
    const scoresNote = () => `<p class="sp-note" role="status">${ICON.info}<span>The scores feed isn’t available right now. The guide’s channels and times are shown.</span></p>`;
    function staleNote(since) {
        const text = since ? `Couldn’t update. Showing what you had at ${UI.clock(since)}.` : 'Couldn’t update. Showing what you had before.';
        return `<div class="sp-note sp-stale" role="status">${ICON.warn}<span>${e(text)}</span><button type="button" class="btn btn-secondary btn-sm" data-act="retry">Try again</button></div>`;
    }

    // ---------- markup: the game card (SportGameCard, the iPad's 260 x 112) ----------

    /** #310: the record mark in the card's top corner; its words for screen readers. */
    function recordMark(g) {
        const r = g.recording;
        if (r && r.scheduleId != null && r.status) {
            const clash = Array.isArray(r.clashesWith) && r.clashesWith.length ? `, Clashes with ${r.clashesWith.join(', ')}` : '';
            const words = (r.status === 'recording' ? 'Recording' : 'Set to record') + clash;
            return `<span class="rmark${r.status === 'recording' ? ' rec' : ''}${clash ? ' clash' : ''}" role="img" aria-label="${e(words)}"></span>`;
        }
        if (g.recordWhenListed) return '<span class="rmark wait" role="img" aria-label="Records when it’s listed"></span>';
        return '';
    }

    /** A card in a rail: a button (Watch, or the game's menu) with the team rows or a session's lines, then the state. */
    function card(g, ctx) {
        const { front, hide, now } = ctx;
        const names = (front.follows || []).map(f => f.name);
        const followed = g.followed === true, live = showsLive(g), mark = recordMark(g);
        const cls = `gcard${followed ? ' fol' : live ? ' live' : ''}`;
        let body;
        if (twoSided(g)) {
            const sc = scores(g, front, hide), stars = cardStars(g, names);
            body = g.competitors.map((c, i) => `<span class="trow${mark ? ' reserve' : ''}">${badge(c.name, c.logo, 26)}${stars.includes(i) ? star() : ''}<span class="n">${e(c.name)}</span>${sc ? `<span class="sc pig-amount">${e(sc[i])}</span>` : ''}</span>`).join('');
        } else {
            const line = [g.status === 'scheduled' ? startLine(g, now) : '', isNextRound(g) ? '' : (g.channels && g.channels[0] ? g.channels[0].name : '')].filter(Boolean).join(' · ');
            body = `<span class="sk${mark ? ' reserve' : ''}">${e(g.session || kickerWord(g))}</span>`
                + `<span class="stitle">${followed ? star() : ''}<span class="t">${e(g.title)}</span></span>`
                + `<span class="sline">${e(line)}</span>`;
        }
        let bot = '';
        if (live) bot += `${dot()}<span class="clk pig-amount">${e(cardClock(g, front, hide, !twoSided(g)))}</span>`;
        else if (terminal(g)) bot += `<span class="res">${e(statusWord(g))}</span>`;
        else if (twoSided(g)) bot += `<span class="when pig-amount">${e(startLine(g, now))}</span>`;
        if (twoSided(g)) bot += `<span class="ch">${e(channelLine(g))}</span>`;
        else bot += `<span class="act">${e(actionLabel(g, now))}</span>`;
        return `<div class="gitem" data-game="${e(g.id)}"><button type="button" class="${cls}" data-act="game" data-id="${e(g.id)}" data-key="card:${e(g.id)}">${body}<span class="cbot">${bot}</span>${mark}</button></div>`;
    }

    // ---------- markup: the banner (SportBanner) ----------

    /**
     * The banner: the hero on the left (kicker, title, line, its buttons, over a faded badge or a circuit map) and a list
     * on the right (follows on the front page, leagues on a sport page); with one item or none it runs full width.
     */
    function banner({ hero: h, items = [], listTitle = '', listNote = '', selected = null, art = null, back = null, actions = '', listAct = 'follow' }) {
        const full = items.length <= 1;
        let artHtml = '';
        if (art && art.map) artHtml = `<img class="art map" src="${e(art.map)}" alt="" aria-hidden="true">`;
        else if (art && logo(art.badge)) artHtml = `<img class="art" src="${e(logo(art.badge))}" alt="" aria-hidden="true">`;
        const backBtn = back ? `<button type="button" class="backbtn" data-act="back" aria-label="${e(back)}">${ICON.back}</button>` : '';
        let list = '';
        if (!full) {
            const VISIBLE = 4, below = Math.max(0, items.length - VISIBLE);
            const rest = items.slice(VISIBLE).map(i => i.title);
            const more = below ? `${below} more${rest.length ? ` · ${rest.slice(0, 3).join(', ')}` : ''}${rest.length > 3 ? ' …' : ''}` : '';
            list = `<div class="blist"><div class="blist-title">${listTitle}${listNote ? ` <span class="blist-note">${e(listNote)}</span>` : ''}</div>`
                + `<div class="brows">${items.map((it, i) => `<button type="button" class="brow${i === selected ? ' sel' : ''}" data-act="${e(listAct)}" data-index="${i}" data-key="${e(listAct)}:${e(it.key || i)}"${i === selected ? ' aria-current="true"' : ''}>${it.badge || ''}<span class="t">${e(it.title)}</span><span class="tr${it.live ? ' live' : ''}">${e(it.trailing)}</span></button>`).join('')}</div>`
                + `<div class="bmore">${e(more)}</div></div>`;
        }
        return `<section class="banner${full ? ' full' : ''}" aria-label="${e(h.title)}">${artHtml}${backBtn}`
            + `<div class="hero"><div class="kicker${h.live ? ' live' : ''}">${h.live ? dot() : ''}<span>${e(h.kicker)}</span></div>`
            + `<h3 class="htitle">${e(h.title)}</h3>${h.line ? `<div class="line pig-amount">${e(h.line)}</div>` : ''}`
            + `<div class="actions">${actions}</div></div>${list}</section>`;
    }

    /** The hero's buttons: Watch (on now) or Remind me (before), the one rose button; Record; "Open Football". */
    function heroButtons(g, now, open = null) {
        let out = '';
        const act = g ? action(g, now) : 'none';
        const ev = g && !terminal(g) ? event(g) : null;
        if (g && ev) {
            if (act === 'watch') out += `<button type="button" class="pill primary" data-act="watch" data-id="${e(g.id)}" data-key="hero:watch">${ICON.play}Watch</button>`;
            else if (act === 'remind') out += `<button type="button" class="pill primary" data-act="remind" data-id="${e(g.id)}" data-key="hero:remind">${ICON.bell}Remind me</button>`;
            out += `<button type="button" class="pill" data-act="record" data-id="${e(g.id)}" data-key="hero:record">${ICON.rec}Record</button>`;
        }
        if (open) out += `<button type="button" class="pill" data-act="open-sport" data-sport="${e(open)}" data-key="hero:open">Open ${e(open)}${ICON.chev}</button>`;
        return out;
    }

    // ---------- markup: the front page (SportFrontTVPage) ----------

    function followItems(front, now) {
        return (front.follows || []).map(f => ({ key: followKey(f), title: f.name, trailing: followTrailing(f, front, now),
            live: f.state === 'live', badge: badge(f.name, f.logo, 22) }));
    }

    /** The banner's backdrop: the F1 circuit map for a race, else the hero follow's badge, else a competitor's. */
    function backdrop(g, front, followIndex, map) {
        if (!g) return null;
        if (g.league === 'F1') return map ? { map } : null;
        const f = followIndex != null ? (front.follows || [])[followIndex] : null;
        if (f && logo(f.logo)) return { badge: f.logo };
        const c = (g.competitors || []).find(x => logo(x.logo));
        return c ? { badge: c.logo } : null;
    }

    function section(sec, ctx, { link = false } = {}) {
        const { front, now, labels } = ctx;
        const note = headerLine(sec, front, now, labels);
        const head = link
            ? `<button type="button" class="sec-h" data-act="open-sport" data-sport="${e(sec.sport)}" data-key="sec:${e(sec.sport)}"><span class="s">${e(sec.sport)}</span><span class="chev" aria-hidden="true">›</span><span class="note">${e(note)}</span></button>`
            : `<div class="sec-h"><span class="s">${e(sec.sport)}</span><span class="note">${e(note)}</span></div>`;
        const rails = sec.rails.map(r => `${sec.rails.length > 1 ? `<div class="rail-k">${e(label(r.league, labels))}</div>` : ''}<div class="rail" data-rail="${e(r.league)}">${railGames(front, r).map(g => card(g, ctx)).join('')}</div>`).join('');
        return `<section class="sec" aria-label="${e(sec.sport)}"><h3 class="sec-title">${head}</h3>${rails}</section>`;
    }

    function also(front, now, { link = false } = {}) {
        const sports = alsoInYourSports(front);
        if (!sports.length) return '';
        const chip = (s) => {
            const line = alsoLine(s, front, now), inner = `${e(s)}${line ? ` <span>${e(line)}</span>` : ''}`;
            return link ? `<button type="button" class="b" data-act="open-sport" data-sport="${e(s)}" data-key="also:${e(s)}">${inner}</button>` : `<span class="b">${inner}</span>`;
        };
        return `<div class="also"><span class="also-t">Also in your sports</span>${sports.map(chip).join('')}</div>`;
    }

    /** The desktop front page's content (the header is drawn by `page`). */
    function frontDesktop(ctx) {
        const { front, hide, now, heroId, followIndex, labels, map, links = false } = ctx;
        const g = game(front, heroId);
        const words = g ? hero(g, front, hide, now, labels) : NO_HERO;
        const sport = g ? sportOf(g.league, null, front) : null;
        const html = banner({ hero: words, items: followItems(front, now),
            listTitle: '<span class="up">Following</span> · your order, playing now on top', selected: followIndex,
            art: backdrop(g, front, followIndex, map), actions: heroButtons(g, now, links ? sport : null) });
        return html + sections(front).map(s => section(s, ctx, { link: links })).join('') + also(front, now, { link: links });
    }

    // ---------- markup: the phone front page (SportFrontPhonePage, SportPhoneModels) ----------

    /** A fixture row's parts: "★ Arsenal v Chelsea", the short score, the live clock, the line under it. */
    function row(g, ctx) {
        const { front, hide, now } = ctx;
        const names = (front.follows || []).map(f => f.name), two = twoSided(g);
        const stars = two && g.followed === true ? followedSides(g, names) : [];
        const sc = two ? scores(g, front, hide) : null;
        const ongoing = showsLive(g);
        const clock = ongoing ? cardClock(g, front, hide) : null;
        const live = isOnAir(g) ? clock : ongoing ? ['Live', clock === statusWord(g) ? null : clock].filter(Boolean).join(' ') : null;
        const channel = channelLine(g);
        const sub = ongoing ? channel : terminal(g) ? statusWord(g) : [startLine(g, now), channel].filter(Boolean).join(' · ');
        return { two, stars, score: sc ? sc.join('–') : null, live, sub };
    }
    function rowHtml(g, ctx) {
        const r = row(g, ctx);
        let l1;
        if (r.two) {
            const title = g.competitors.map((c, i) => `${r.stars.includes(i) ? star() : ''}${e(c.name)}`).join(' v ');
            l1 = `${badge(g.competitors[0].name, g.competitors[0].logo, 22)}<span class="t">${title}</span>${badge(g.competitors[1].name, g.competitors[1].logo, 22)}`;
        } else {
            l1 = `${leagueBadge(g.league)}<span class="t">${g.followed === true ? star() : ''}${e(g.session ? `${g.title}` : g.title)}</span>`;
        }
        if (r.score) l1 += `<span class="sc pig-amount">${e(r.score)}</span>`;
        const l2 = [r.live ? `<span class="lv">${dot()}${e(r.live)}</span>` : '', r.sub ? `<span>${e(r.sub)}</span>` : ''].filter(Boolean).join('<span aria-hidden="true"> · </span>');
        return `<button type="button" class="row" data-act="game" data-id="${e(g.id)}" data-key="row:${e(g.id)}"><span class="l1">${l1}</span><span class="l2 pig-amount">${l2}</span>${recordMark(g)}</button>`;
    }

    /** A follow's carousel card (SportPhoneLayout.card): kicker, the two sides and the short score, the line, its buttons. */
    function phoneCard(index, ctx) {
        const { front, hide, now, labels } = ctx;
        const f = front.follows[index], g = game(front, f.gameId), leagueWord = label(f.league, labels);
        if (!g) {
            return `<div class="fcard" data-index="${index}"><div class="kicker k"><span>${e(leagueWord)}</span></div>`
                + `<div class="fbody fsolo">${badge(f.name, f.logo, 48)}<span class="ft">${e(f.name)}</span></div>`
                + `<div class="fline">Nothing in the next three days</div></div>`;
        }
        const r = row(g, ctx), live = r.live != null;
        let kicker = live ? `${isOnAir(g) ? 'On air' : 'Live'} · ${leagueWord}` : terminal(g) ? `${statusWord(g)} · ${leagueWord}` : `${leagueWord} · ${startLine(g, now)}`;
        // the mocks: a followed game's card says whose it is, as the banner's kicker does
        if (g.followed === true) kicker += ` · ${yours(sportOf(g.league, null, front))}`;
        const line = [];
        if (isOnAir(g)) line.push(onAirLine(g));
        else if (live) { const c = r.live.replace(/^Live\s*/, ''); if (c) line.push(c); }
        else if (!terminal(g)) line.push(startLine(g, now));
        else line.push(statusWord(g));
        const ch = channelLine(g);
        if (ch && !terminal(g)) line.push(ch);
        let mid;
        if (r.two) {
            const side = (c, i) => `<span class="fside"><span class="bw">${badge(c.name, c.logo, 48)}${r.stars.includes(i) ? '<span class="st" aria-hidden="true">★</span>' : ''}</span><span class="fn">${r.stars.includes(i) ? '<span class="visually-hidden">Your team, </span>' : ''}${e(c.name)}</span></span>`;
            mid = `<span class="fsides">${side(g.competitors[0], 0)}<span class="fscore${r.score ? '' : ' v'} pig-amount">${r.score ? e(r.score) : 'v'}</span>${side(g.competitors[1], 1)}</span>`;
        } else {
            mid = `<span class="fsolo">${badge(f.name, f.logo, 48)}<span class="ft">${e(g.title)}${g.session ? `<small>${e(g.session)}</small>` : ''}</span></span>`;
        }
        const act = action(g, now), ev = !terminal(g) ? event(g) : null;
        let buttons = '';
        if (ev) {
            if (act === 'watch') buttons += `<button type="button" class="pill primary" data-act="watch" data-id="${e(g.id)}" data-key="fc:${index}:watch">${ICON.play}Watch</button>`;
            else if (act === 'remind') buttons += `<button type="button" class="pill primary" data-act="remind" data-id="${e(g.id)}" data-key="fc:${index}:remind">${ICON.bell}Remind me</button>`;
            buttons += `<button type="button" class="pill" data-act="record" data-id="${e(g.id)}" data-key="fc:${index}:record">${ICON.rec}Record</button>`;
        }
        return `<div class="fcard" data-index="${index}"><div class="kicker k${live ? ' live' : ''}">${live ? dot() : ''}<span>${e(kicker)}</span></div>`
            + `<button type="button" class="fbody" data-act="game" data-id="${e(g.id)}" data-key="fc:${index}">${mid}<span class="fline pig-amount">${e(line.join(' · '))}</span></button>`
            + (buttons ? `<div class="factions">${buttons}</div>` : '') + '</div>';
    }
    const position = (i, count) => `${Math.min(i + 1, count)} of ${count} ${count === 1 ? 'follow' : 'follows'}`;
    function dots(count, at = 0, word = position) {
        const n = Math.min(count, 12);
        return `<div class="dots" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i${i === at ? ' class="on"' : ''}></i>`).join('')}<span>${e(word(at, count))}</span></div>`;
    }

    const ROWS_PER_SPORT = 5;
    function frontPhone(ctx) {
        const { front, now, labels, links = false } = ctx;
        let html = '';
        const follows = front.follows || [];
        if (follows.length) {
            html += `<div class="carousel" data-carousel="follows" aria-label="Your follows">${follows.map((_, i) => phoneCard(i, ctx)).join('')}</div>${dots(follows.length)}`;
        }
        for (const sec of sections(front)) {
            const games = sec.rails.flatMap(r => railGames(front, r)).slice(0, ROWS_PER_SPORT);
            const note = headerLine(sec, front, now, labels);
            const head = links
                ? `<button type="button" class="grp-h" data-act="open-sport" data-sport="${e(sec.sport)}" data-key="grp:${e(sec.sport)}"><span class="s">${e(sec.sport)}</span><span class="chev" aria-hidden="true">›</span><span class="note">${e(note)}</span></button>`
                : `<div class="grp-h"><span class="s">${e(sec.sport)}</span><span class="note">${e(note)}</span></div>`;
            html += `<section class="grp" aria-label="${e(sec.sport)}"><h3 class="sec-title">${head}</h3><div class="rows">${games.map(g => rowHtml(g, ctx)).join('')}</div></section>`;
        }
        return html + also(front, now, { link: links });
    }

    /** The front page's whole content below the header, for either layout; or the state block's place when empty. */
    function front(ctx) {
        const { front: f, stale, staleSince } = ctx;
        let html = '';
        if (stale) html += staleNote(staleSince);
        if (f.scores === 'unavailable') html += scoresNote();
        return html + (ctx.phone ? frontPhone(ctx) : frontDesktop(ctx));
    }
    const isEmpty = (f) => !(f.sports || []).length;

    return {
        ICON, hidden, family, terminal, underWay, isOnAir, showsLive, isNextRound, logo, statusWord, progressLabel, situationLabel,
        scores, situation, when, headerDate, startLine, channelLine, cardClock, event, action, actionLabel, followedSides,
        followedSide, sections, alsoInYourSports, headerLine, followTrailing, hero, NO_HERO, followKey, followsGoneLive,
        resolveHero, heroFollowIndex, fastRefresh, monogram, badge, leagueBadge, header, scoresChip, card, banner, heroButtons,
        followItems, front, frontDesktop, frontPhone, row, rowHtml, phoneCard, dots, position, isEmpty, game, sportOf, label,
        railGames, staleNote, scoresNote, star, dot, recordMark, kickerWord, yours, availabilityWord, onAirLine, e
    };
})();

if (typeof window !== 'undefined') window.SportView = SportView;
if (typeof module !== 'undefined' && module.exports) module.exports = SportView;
