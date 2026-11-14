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

    /** The card's "⋯": its menu (a sibling of the card's button, after it in keyboard order; right-click opens it too). */
    const moreButton = (id, title) => `<button type="button" class="more-btn" data-act="more" data-id="${e(id)}" data-key="more:${e(id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${e(`More options for ${title}`)}"><span aria-hidden="true">⋯</span></button>`;

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
        const more = terminal(g) ? '' : moreButton(g.id, g.title);
        return `<div class="gitem${more ? ' has-more' : ''}" data-game="${e(g.id)}"><button type="button" class="${cls}" data-act="game" data-id="${e(g.id)}" data-key="card:${e(g.id)}">${body}<span class="cbot">${bot}</span>${mark}</button>${more}</div>`;
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
            out += `<button type="button" class="pill" data-act="record-menu" aria-haspopup="menu" data-id="${e(g.id)}" data-key="hero:record">${ICON.rec}Record</button>`;
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

    /** A follow's carousel card (SportPhoneLayout.card): its game's card, or the follow with nothing in three days. */
    function phoneCard(index, ctx) {
        const { front, labels, links = false } = ctx;
        const f = front.follows[index], g = game(front, f.gameId), leagueWord = label(f.league, labels);
        if (!g) {
            const body = `${badge(f.name, f.logo, 48)}<span class="ft">${e(f.name)}</span>`;
            return `<div class="fcard" data-index="${index}"><div class="kicker k"><span>${e(leagueWord)}</span></div>`
                + (links ? `<button type="button" class="fbody fsolo" data-act="open-sport" data-sport="${e(f.sport || sportOf(f.league, null, front))}" data-key="fc:${index}">${body}</button>`
                    : `<div class="fbody fsolo">${body}</div>`)
                + `<div class="fline">Nothing in the next three days</div></div>`;
        }
        return gameCard(g, ctx, { key: `fc:${index}`, leagueWord, solo: f });
    }
    /** A game's carousel card: kicker, the two sides and the short score (or "v"), the line, Watch or Remind me and Record. */
    function gameCard(g, ctx, { key, leagueWord, solo = null }) {
        const { front, now } = ctx;
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
            const who = solo ? badge(solo.name, solo.logo, 48) : leagueBadge(g.league);
            mid = `<span class="fsolo">${who}<span class="ft">${e(g.title)}${g.session ? `<small>${e(g.session)}</small>` : ''}</span></span>`;
        }
        const act = action(g, now), ev = !terminal(g) ? event(g) : null;
        let buttons = '';
        if (ev) {
            if (act === 'watch') buttons += `<button type="button" class="pill primary" data-act="watch" data-id="${e(g.id)}" data-key="${e(key)}:watch">${ICON.play}Watch</button>`;
            else if (act === 'remind') buttons += `<button type="button" class="pill primary" data-act="remind" data-id="${e(g.id)}" data-key="${e(key)}:remind">${ICON.bell}Remind me</button>`;
            buttons += `<button type="button" class="pill" data-act="record-menu" aria-haspopup="menu" data-id="${e(g.id)}" data-key="${e(key)}:record">${ICON.rec}Record</button>`;
        }
        return `<div class="fcard"><div class="kicker k${live ? ' live' : ''}">${live ? dot() : ''}<span>${e(kicker)}</span></div>`
            + `<button type="button" class="fbody" data-act="game" data-id="${e(g.id)}" data-key="${e(key)}">${mid}<span class="fline pig-amount">${e(line.join(' · '))}</span></button>`
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

    // ---------- a sport's page (SportPageRules, SportPageView; SportPhonePage, SportPhonePageLayout) ----------

    const sportName = (entry) => entry.sport || entry.league;
    /** The sport's followed leagues in the order sent (playing now first); else the leagues its rails name. */
    function sportLeagues(sport, front) {
        const entries = (front.sports || []).filter(s => sportName(s) === sport);
        if (entries.length) return entries;
        const seen = [];
        for (const r of front.rails || []) if (sportOf(r.league, r.sport, front) === sport && !seen.includes(r.league)) seen.push(r.league);
        return seen.map(league => ({ league, live: 0, next: null, line: 'quiet', sport }));
    }
    const unique = (games) => games.filter((g, i) => games.findIndex(x => x.id === g.id) === i);
    function sportGames(sport, front) {
        return unique((front.rails || []).filter(r => sportOf(r.league, r.sport, front) === sport).flatMap(r => railGames(front, r)));
    }
    function leagueGames(league, front) {
        return unique((front.rails || []).filter(r => r.league === league).flatMap(r => railGames(front, r)));
    }
    /** The hero: a follow of this sport live, else a live game in its leagues, else a follow's next, else the next game. */
    function sportHero(sport, front) {
        const follows = front.follows || [];
        const mine = follows.map((f, i) => i).filter(i => (follows[i].sport || sportOf(follows[i].league, null, front)) === sport && game(front, follows[i].gameId));
        const live = mine.filter(i => follows[i].state === 'live');
        const fi = front.hero && front.hero.followIndex;
        if (live.includes(fi)) return { gameId: follows[fi].gameId, followIndex: fi };
        if (live.length) return { gameId: follows[live[0]].gameId, followIndex: live[0] };
        const games = sportGames(sport, front);
        const on = games.find(showsLive);
        if (on) return { gameId: on.id, followIndex: null };
        const start = (i) => (Number.isFinite(follows[i].start) ? follows[i].start : (game(front, follows[i].gameId) || {}).start ?? Infinity);
        const next = mine.filter(i => follows[i].state === 'next').sort((a, b) => start(a) - start(b));
        if (next.length) return { gameId: follows[next[0]].gameId, followIndex: next[0] };
        const soon = games.filter(g => g.status === 'scheduled').sort((a, b) => a.start - b.start)[0];
        return { gameId: soon ? soon.id : null, followIndex: null };
    }
    /** The league the page opens on: the chosen one while it is the sport's, else the hero's, else the first. */
    function openingLeague(sport, front, chosen = null) {
        const leagues = sportLeagues(sport, front).map(s => s.league);
        if (chosen && leagues.includes(chosen)) return chosen;
        const h = game(front, sportHero(sport, front).gameId);
        if (h && leagues.includes(h.league)) return h.league;
        return leagues[0] || null;
    }
    /** The banner's list on a sport page: its leagues, each "2 live", its next start, or "Nothing scheduled". */
    function leagueItems(sport, front, now, labels) {
        return sportLeagues(sport, front).map(entry => {
            const live = entry.live > 0 || entry.line === 'live';
            const trailing = live ? `${Math.max(entry.live || 0, 1)} live` : entry.next && Number.isFinite(entry.next.start) ? when(entry.next.start, now) : 'Nothing scheduled';
            return { key: entry.league, title: label(entry.league, labels), trailing, live, badge: leagueBadge(entry.league) };
        });
    }
    /** A league's games in groups: Live, Later today, Coming up (later days, the next round), Earlier (newest first). */
    function leagueGroups(league, front, now) {
        const games = leagueGames(league, front);
        const live = games.filter(showsLive);
        const ended = games.filter(terminal).sort((a, b) => b.start - a.start);
        const upcoming = games.filter(g => !terminal(g) && !showsLive(g)).sort((a, b) => a.start - b.start);
        const today = upcoming.filter(g => !isNextRound(g) && sameDay(g.start, now));
        const later = upcoming.filter(g => !today.includes(g));
        return [['Live', live], ['Later today', today], ['Coming up', later], ['Earlier', ended]].filter(x => x[1].length).map(([title, list]) => ({ title, games: list }));
    }
    /** The phone carousel on a sport page: the league's followed games, then its others on now; else the next to start. */
    function leagueCards(league, front) {
        const out = [], seen = [];
        (front.follows || []).forEach((f, i) => {
            const g = f.league === league ? game(front, f.gameId) : null;
            if (g && !terminal(g) && !seen.includes(g.id)) { seen.push(g.id); out.push({ g, follow: f, key: `lc:${i}` }); }
        });
        const games = leagueGames(league, front);
        for (const g of games) if (showsLive(g) && !seen.includes(g.id)) { seen.push(g.id); out.push({ g, follow: null, key: `lc:${g.id}` }); }
        if (!out.length) {
            const next = games.filter(g => g.status === 'scheduled').sort((a, b) => a.start - b.start)[0];
            if (next) out.push({ g: next, follow: null, key: `lc:${next.id}` });
        }
        return out.slice(0, 8);
    }
    const EVENT_LEAGUES = ['Grand Slams', 'ATP Tour', 'WTA Tour', 'Majors', 'PGA Tour', 'DP World Tour', 'LIV', 'LPGA', 'UFC', 'IndyCar', 'NASCAR'];
    /** What a league's own page is (by the server's flags in /api/info), else "games": its C-R games only. */
    function leagueContent(league, sport, features = {}) {
        if (league === 'F1' && features.sportPages) return 'f1';
        if (league === 'NFL' && features.sportPageNfl) return 'nfl';
        if ((league === 'Cricket' || sport === 'Cricket') && features.sportPageCricket) return 'cricket';
        if (Array.isArray(features.sportPageLeagues) && features.sportPageLeagues.includes(league)) return 'league';
        if (features.sportPageEvents && EVENT_LEAGUES.includes(league)) return 'events';
        return 'games';
    }
    /** The link to a league's own page: "Rounds and standings", "Weekend and standings", "Scoreboard and tour"… */
    function moreTitle(content, sport) {
        if (content === 'nfl' || content === 'league') return 'Rounds and standings';
        if (content === 'f1') return 'Weekend and standings';
        if (content === 'cricket') return 'Scoreboard and tour';
        if (content === 'events') return ({ Golf: 'Leaderboard', Tennis: 'Order of play', Combat: 'Fight card' })[sport] || 'Events';
        return null;
    }
    /** A league with nothing to show: its one action is Open the TV Guide (secondary: the banner's button is the rose one). */
    const nothingSoon = (name) => `<div class="sp-league-empty">${UI.stateBlock('empty', { title: 'Nothing in the next three days', detail: `${name} has no games in the next three days.` }, { label: 'Open the TV Guide', href: '#guide' })}</div>`;

    function groupsHtml(groups, ctx) {
        return groups.map(gr => `<section class="grp" aria-label="${e(gr.title)}"><h3 class="sec-title"><span class="grp-h plain"><span class="s">${e(gr.title)}</span></span></h3><div class="rows">${gr.games.map(g => rowHtml(g, ctx)).join('')}</div></section>`).join('');
    }
    /** "Rounds and standings ›  Premier League": the league's own page, where it has one (the pages that are built). */
    function moreRow(sport, league, ctx) {
        const content = leagueContent(league, sport, ctx.features);
        const title = (ctx.pages || []).includes(content) ? moreTitle(content, sport) : null;
        if (!title) return '';
        return `<button type="button" class="more-row" data-act="open-league" data-sport="${e(sport)}" data-league="${e(league)}" data-key="more:${e(league)}"><span class="s">${e(title)}</span><span class="chev" aria-hidden="true">›</span><span class="note">${e(label(league, ctx.labels))}</span></button>`;
    }

    /** A sport's page below its header: the banner and the league's groups (computer), or chips, carousel, groups (phone). */
    function sportPage(sport, ctx) {
        const { front: f, hide, now, labels, map, stale, staleSince, chosen } = ctx;
        const leagues = sportLeagues(sport, f), league = openingLeague(sport, f, chosen);
        const h = sportHero(sport, f), g = game(f, h.gameId);
        let html = (stale ? staleNote(staleSince) : '') + (f.scores === 'unavailable' ? scoresNote() : '');
        const groups = league ? leagueGroups(league, f, now) : [];
        const leagueLabel = league ? label(league, labels) : sport;
        if (!ctx.phone) {
            const words = g ? hero(g, f, hide, now, labels) : { kicker: sport, live: false, title: sport, line: 'Nothing in the next three days' };
            html += banner({ hero: words, items: leagueItems(sport, f, now, labels), listTitle: `<span class="up">${e(sport)} · Your leagues</span>`,
                selected: leagues.findIndex(x => x.league === league), art: backdrop(g, f, h.followIndex, map), back: 'Back to Sport',
                actions: heroButtons(g, now), listAct: 'league' });
            if (!league || !groups.length) return html + nothingSoon(leagueLabel);
            const col = (titles) => groupsHtml(groups.filter(x => titles.includes(x.title)), ctx);
            return html + `<div class="groups2"><div>${col(['Live', 'Later today'])}</div><div>${col(['Coming up', 'Earlier'])}</div></div>` + moreRow(sport, league, ctx);
        }
        if (leagues.length > 1) {
            html += `<div class="chips" role="group" aria-label="${e(sport)} leagues">${leagues.map(x => `<button type="button" class="lchip${x.league === league ? ' on' : ''}" data-act="league" data-league="${e(x.league)}" aria-pressed="${x.league === league}" data-key="chip:${e(x.league)}">${e(label(x.league, labels))}</button>`).join('')}</div>`;
        }
        if (!league) return html + nothingSoon(sport);
        const cards = leagueCards(league, f);
        if (cards.length) {
            const word = label(league, labels);
            html += `<div class="carousel" data-carousel="league:${e(league)}" aria-label="${e(word)}">${cards.map(c => gameCard(c.g, ctx, { key: c.key, leagueWord: word, solo: c.follow })).join('')}</div>`
                + dots(cards.length, 0, (i, n) => `${Math.min(i + 1, n)} of ${n}`);
        }
        if (!groups.length && !cards.length) return html + nothingSoon(leagueLabel);
        return html + groupsHtml(groups, ctx) + moreRow(sport, league, ctx);
    }


    // ---------- a league's page: rounds, fixtures, standings (C-T, C-Q; SportFixtureModels, SportFixtureView) ----------

    /** A followed name matches a team by its name, full name or abbreviation, any case. */
    const followsTeam = (names, ...keys) => { const want = names.map(lower); return keys.filter(Boolean).map(lower).some(k => want.includes(k)); };
    /** The detail as it may be drawn: none before the start; with scores hidden only neutral words ("Live", "Played"). */
    function fixtureDetail(detail, status, hide) {
        if (status === 'scheduled') return null;
        if (status === 'postponed') return 'Postponed';
        if (status === 'cancelled') return 'Cancelled';
        if (status === 'live' || status === 'break') return hide ? 'Live' : (detail || 'Live');
        if (detail === 'Suspended') return 'Suspended';
        return hide ? 'Played' : (detail || 'Final');
    }
    const pct = (value, key) => {
        if (key !== 'percentage' || value == null || !Number.isFinite(Number(String(value).trim()))) return value;
        return Number(value).toFixed(1);
    };
    /** "Bills" for "BUF": an NFL team's short name, else its abbreviation. */
    const nflName = (abbr, page) => (page.teams && page.teams[abbr] && page.teams[abbr].name) || abbr;
    const winShare = (r) => { const w = r.wins || 0, l = r.losses || 0, t = r.ties || 0; return w + l + t > 0 ? (w + t / 2) / (w + l + t) : 0; };

    /** The NFL page (C-Q) as a fixture league; with scores hidden no score, record, situation or result word. */
    function nflFixture(page, following, hide) {
        const followed = (abbr) => { const t = page.teams && page.teams[abbr]; return followsTeam(following, t && t.name, t && t.full, abbr); };
        const side = (s, g) => ({ id: s.abbr, abbr: s.abbr, name: nflName(s.abbr, page), logo: logo(page.teams && page.teams[s.abbr] && page.teams[s.abbr].logo),
            record: hide ? null : s.record || null, score: g.status !== 'scheduled' && !hide && s.score != null ? String(s.score) : null, followed: followed(s.abbr) });
        const rounds = (page.weeks || []).map(w => ({ key: String(w.number), label: w.label || `Week ${w.number}`, current: !!w.current,
            note: (w.byes || []).length ? `Bye: ${w.byes.map(a => nflName(a, page)).join(', ')}` : null,
            games: (w.games || []).map(g => ({ id: g.id, start: g.start, status: g.status, detail: fixtureDetail(g.detail, g.status, hide),
                situation: hide || g.status !== 'live' || !g.situation ? null : g.situation.downDistance || null,
                home: side(g.home, g), away: side(g.away, g), channels: g.channels || [] })) }));
        const divisions = (page.standings && page.standings.divisions) || [];
        const mine = divisions.flatMap(d => d.teams || []).find(r => followed(r.abbr));
        const row = (rank, r) => ({ id: r.abbr, rank, abbr: r.abbr, name: nflName(r.abbr, page), logo: logo(page.teams && page.teams[r.abbr] && page.teams[r.abbr].logo),
            values: [r.record || null, r.streak || null], followed: !!mine && r.abbr === mine.abbr });
        const hasMine = (d) => !!mine && (d.teams || []).some(r => r.abbr === mine.abbr);
        const views = !divisions.length ? [] : [
            { name: 'Division', tables: [...divisions.filter(hasMine), ...divisions.filter(d => !hasMine(d))]
                .map(d => ({ title: d.name, columns: ['W-L', 'Streak'], rows: (d.teams || []).map((r, i) => row(i + 1, r)) })) },
            { name: 'Conference', tables: (() => {
                let confs = [...new Set(divisions.map(d => d.conference).filter(Boolean))].sort();
                const my = divisions.find(hasMine);
                if (my && my.conference) confs = [my.conference, ...confs.filter(c => c !== my.conference)];
                return confs.map(c => ({ title: c, columns: ['W-L', 'Streak'], rows: divisions.filter(d => d.conference === c).flatMap(d => d.teams || [])
                    .sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99) || String(a.abbr).localeCompare(String(b.abbr))).map((r, i) => row(r.seed ?? i + 1, r)) }));
            })() },
            { name: 'Overall', tables: [{ title: 'League', columns: ['W-L', 'Streak'], rows: divisions.flatMap(d => d.teams || []).sort((a, b) => {
                const d = winShare(b) - winShare(a); if (d) return d;
                const pd = ((b.pointsFor || 0) - (b.pointsAgainst || 0)) - ((a.pointsFor || 0) - (a.pointsAgainst || 0));
                return pd || String(a.abbr).localeCompare(String(b.abbr));
            }).map((r, i) => row(i + 1, r)) }] }];
        return { league: 'NFL', rounds, views, awayFirst: true };
    }

    /** A C-T league page as a fixture league; with scores hidden no score and no result word (the standings are not drawn). */
    function leagueFixture(page, league, following, hide) {
        const teams = page.teams || {};
        const followed = (id, abbr) => (id != null && id === page.following) || followsTeam(following, teams[id] && teams[id].name, teams[id] && teams[id].full, abbr);
        const side = (s, g) => {
            const t = teams[s.id] || {};
            const played = !['scheduled', 'postponed', 'cancelled'].includes(g.status);
            return { id: s.id || s.abbr, abbr: s.abbr, name: t.name || t.full || s.abbr, logo: logo(t.logo), record: null,
                score: hide || !played || s.score == null ? null : String(s.score), followed: followed(s.id, s.abbr) };
        };
        const rounds = (page.rounds || []).map(r => ({ key: r.key, label: r.label, current: !!r.current, note: null,
            games: (r.games || []).map(g => ({ id: g.id, start: g.start, status: g.status, detail: fixtureDetail(g.detail, g.status, hide), situation: null,
                home: side(g.home, g), away: side(g.away, g), channels: g.channels || [] })) }));
        const tables = ((page.standings && page.standings.groups) || []).map(gr => ({ title: gr.name || null, columns: (gr.columns || []).map(c => c.label),
            rows: (gr.rows || []).map(r => { const t = teams[r.id] || {};
                return { id: r.id || r.abbr, rank: r.rank, abbr: r.abbr, name: t.name || t.full || r.abbr, logo: logo(t.logo),
                    values: (gr.columns || []).map(c => pct(r.values ? r.values[c.key] : null, c.key)), followed: followed(r.id, r.abbr) }; }) }));
        return { league, rounds, views: tables.length ? [{ name: '', tables }] : [] };
    }

    const roundOf = (fx, chosen) => fx.rounds.find(r => r.key === chosen) || fx.rounds.find(r => r.current) || fx.rounds[fx.rounds.length - 1] || null;
    const viewOf = (fx, chosen) => fx.views.find(v => v.name === chosen) || fx.views[0] || null;
    /** The followed team's table first. */
    const orderTables = (view) => [...view.tables.filter(t => t.rows.some(r => r.followed)), ...view.tables.filter(t => !t.rows.some(r => r.followed))];
    /** The view's tables in groups of at most four (by their title's first word, else runs of four). */
    function tableGroups(view, size = 4) {
        const all = orderTables(view);
        if (all.length <= size) return [{ name: '', tables: all }];
        const named = [];
        for (const t of all) {
            const word = (t.title || '').split(' ')[0] || '';
            const g = named.find(x => x.name === word);
            if (g) g.tables.push(t); else named.push({ name: word, tables: [t] });
        }
        if (named.length > 1 && named.every(g => g.name && g.tables.length <= size)) return named;
        const out = [];
        for (let i = 0; i < all.length; i += size) out.push({ name: `Tables ${i + 1}–${Math.min(i + size, all.length)}`, tables: all.slice(i, i + size) });
        return out;
    }

    /** A fixture's C-R card (same league, both teams named, starting within 90 minutes): its channels and actions. */
    function fixtureCard(g, league, front) {
        return ((front && front.games) || []).find(c => {
            if (c.league !== league || Math.abs(c.start - g.start) > 90 * 60000 || !twoSided(c)) return false;
            const names = c.competitors.map(x => lower(x.name));
            const named = (s) => { const mine = [s.name, s.abbr].map(lower); return names.some(n => mine.some(m => m === n || m.endsWith(' ' + n) || n.endsWith(' ' + m))); };
            return named(g.home) && named(g.away);
        }) || null;
    }
    /** A fixture without a C-R card as a game on its own channels (Watch, Remind me, Record). */
    function fixtureGame(g, fx) {
        const starts = g.channels.map(c => c.start).filter(Number.isFinite), ends = g.channels.map(c => c.end).filter(Number.isFinite);
        const start = starts.length ? Math.min(...starts) : g.start, end = ends.length ? Math.max(...ends) : g.start + 3 * 3600000;
        const sides = fx.awayFirst ? [g.away, g.home] : [g.home, g.away];
        return { id: `fx:${fx.league}:${g.id}`, synthetic: true, league: fx.league, title: sides.map(s => s.name).join(fx.awayFirst ? ' at ' : ' v '),
            start, end: Math.max(end, start + 60000), status: g.status === 'done' ? 'finished' : g.status === 'live' || g.status === 'break' ? 'live' : g.status,
            competitors: sides.map(s => ({ name: s.name, logo: s.logo })), channels: g.channels, events: [], freshness: 'unavailable', progress: {} };
    }

    /** One fixture card: the two sides (badge, star, name, record, score), the situation, then its state and channel. */
    function fixtureCardHtml(g, fx, ctx) {
        const { now } = ctx;
        const card = fixtureCard(g, fx.league, ctx.front);
        const id = card ? card.id : `fx:${fx.league}:${g.id}`;
        const sides = fx.awayFirst ? [g.away, g.home] : [g.home, g.away];
        const followed = g.home.followed || g.away.followed, ongoing = g.status === 'live' || g.status === 'break';
        const rows = sides.map(s => `<span class="trow">${badge(s.name, s.logo, 26)}${s.followed ? star() : ''}<span class="n">${e(s.name)}</span>${s.record ? `<span class="rec">${e(s.record)}</span>` : ''}${s.score != null ? `<span class="sc pig-amount">${e(s.score)}</span>` : ''}</span>`).join('');
        let bot;
        if (ongoing) bot = `${dot()}<span class="clk pig-amount">${e(g.detail || 'Live')}</span>`;
        else if (g.detail) bot = `<span class="res">${e(g.detail)} · ${e(UI.date(g.start))}</span>`;
        else bot = `<span class="when pig-amount">${e(when(g.start, now))}</span>`;
        const channel = (card && card.channels && card.channels[0] && card.channels[0].name) || (g.channels[0] && g.channels[0].name);
        if (g.status !== 'done') bot += `<span class="ch">${e(channel || 'Not in guide yet')}</span>`;
        const more = g.status === 'done' ? '' : moreButton(id, sides.map(x => x.name).join(fx.awayFirst ? ' at ' : ' v '));
        return `<div class="gitem fxitem${more ? ' has-more' : ''}"><button type="button" class="fx${followed ? ' fol' : ongoing ? ' live' : ''}" data-act="game" data-id="${e(id)}" data-key="fx:${e(g.id)}">${rows}${g.situation ? `<span class="sline">${e(g.situation)}</span>` : ''}<span class="cbot">${bot}</span></button>${more}</div>`;
    }

    function standingsHtml(fx, ctx, label_) {
        const { hide } = ctx;
        const view = viewOf(fx, ctx.standingsView);
        if (!view && !hide) return '';
        const viewChips = fx.views.length > 1 ? fx.views.map(v => `<button type="button" class="fchip${v === view ? ' on' : ''}" data-act="standings-view" data-view="${e(v.name)}" aria-pressed="${v === view}" data-key="view:${e(v.name)}">${e(v.name)}</button>`).join('') : '';
        let body;
        if (hide) {
            body = `<div class="lcard"><div class="lh"><b>Standings hidden</b></div><p class="hidden-note">${ICON.eyeOff}<span>Records, positions and points reveal results while Hide scores is on.</span></p></div>`;
        } else {
            const groups = tableGroups(view), group = groups.find(g => g.name === ctx.tableGroup) || groups[0];
            const groupChips = groups.length > 1 ? `<div class="rounds">${groups.map(g => `<button type="button" class="fchip${g === group ? ' on' : ''}" data-act="table-group" data-group="${e(g.name)}" aria-pressed="${g === group}" data-key="tg:${e(g.name)}">${e(g.name)}</button>`).join('')}</div>` : '';
            body = groupChips + group.tables.map(t => `<div class="lcard"><div class="lh"><b>${e(t.title || label_)}</b>${ctx.season ? `<span>${e(ctx.season)}</span>` : ''}</div>`
                + `<table class="st"><thead><tr><th scope="col"><span class="visually-hidden">Position</span></th><th scope="col" class="tl">Team</th>${t.columns.map(c => `<th scope="col">${e(c)}</th>`).join('')}</tr></thead><tbody>`
                + t.rows.map((r, i) => `<tr${r.followed ? ' class="me"' : ''}><td class="pos pig-amount">${e(r.rank ?? i + 1)}</td><td class="nm"><div>${badge(r.name, r.logo, ctx.phone ? 20 : 24)}${r.followed ? star() : ''}<span>${e(r.name)}</span></div></td>${r.values.map((v, j) => `<td class="pig-amount${j === r.values.length - 1 ? ' pts' : ''}">${e(v ?? '–')}</td>`).join('')}</tr>`).join('')
                + '</tbody></table></div>').join('');
        }
        return `<section class="standings" aria-label="Standings"><div class="subhead"><h3>Standings</h3>${viewChips ? `<div class="views">${viewChips}</div>` : ''}</div>${body}</section>`;
    }

    /** A fixture league's page below its header: the round switcher, the round's games, the standings beside or under. */
    function fixturePage(fx, ctx, label_) {
        const round = roundOf(fx, ctx.round);
        const chips = fx.rounds.map(r => `<button type="button" class="fchip${r === round ? ' on' : ''}" data-act="round" data-round="${e(r.key)}" aria-pressed="${r === round}" data-key="round:${e(r.key)}">${e(r.label)}</button>`).join('');
        const note = round ? round.note || `${round.games.length} ${round.games.length === 1 ? 'game' : 'games'}` : '';
        const games = round && round.games.length ? `<div class="fxgrid">${round.games.map(g => fixtureCardHtml(g, fx, ctx)).join('')}</div>` : '<p class="sp-muted">No games in this round.</p>';
        const standings = fx.views.length || ctx.hide ? standingsHtml(fx, ctx, label_) : '';
        return `<div class="league${standings ? '' : ' solo'}"><div><div class="rounds" role="group" aria-label="Rounds">${chips}<span class="rnote">${e(note)}</span></div>${games}</div>${standings ? `<div>${standings}</div>` : ''}</div>`;
    }

    /** The words of a league page's states (#280). */
    const leagueWords = (label_) => ({
        failed: { title: `${label_} didn’t load`, detail: `PigTV couldn’t get ${label_} from your server. Your other sports, the TV Guide and your recordings still work.` },
        unavailable: { title: `${label_} isn’t available right now`, detail: `Your server hasn’t had ${label_} from the scores feed yet, or can’t reach it at the moment. Your other sports, the TV Guide and your recordings still work.` },
        empty: { title: `No ${label_} games listed`, detail: `The scores feed has no rounds for ${label_} at the moment.` }
    });
    /** A league without a page of its own: its C-R games as cards. */
    function gamesGrid(league, ctx) {
        const games = leagueGames(league, ctx.front);
        if (!games.length) return nothingSoon(label(league, ctx.labels));
        return `<div class="cardgrid">${games.map(g => card(g, ctx)).join('')}</div>`;
    }

    /**
     * A league's own page below its header. `lp`: the league page's state from the controller ({ answer, failed,
     * loaded, stale, updatedAt }); `kind`: leagueContent(). Fixture leagues (C-T, C-Q) draw their rounds and standings;
     * the others their C-R games until their own page is built.
     */
    function leaguePage(sport, league, kind, lp, ctx) {
        const word = label(league, ctx.labels), words = leagueWords(word);
        if (!['league', 'nfl', 'f1', 'cricket', 'events'].includes(kind)) return gamesGrid(league, ctx);
        const a = lp && lp.answer;
        if (!a) {
            if (lp && lp.failed) return `<div class="sp-state" id="sp-state" data-state="league-error" data-title="${e(words.failed.title)}" data-detail="${e(words.failed.detail)}"></div>`;
            return '<div class="sp-state" id="sp-state" data-state="loading"></div>';
        }
        if (a.available === false) return `<div class="sp-state" id="sp-state" data-state="league-error" data-title="${e(words.unavailable.title)}" data-detail="${e(words.unavailable.detail)}"></div>`;
        const following = ctx.following || [];
        if (kind === 'f1') {
            if (!a.weekend) return (lp.stale ? staleNote(lp.updatedAt) : '') + `<div class="sp-league-empty">${UI.stateBlock('empty', { title: 'No race scheduled', detail: 'The next race weekend shows here once the scores feed lists it.' }, { label: 'Open the TV Guide', href: '#guide' })}</div>`;
            return (lp.stale ? staleNote(lp.updatedAt) : '') + f1Page(a, ctx);
        }
        if (kind === 'cricket') return (lp.stale ? staleNote(lp.updatedAt) : '') + cricketPage(a, league, ctx);
        if (kind === 'events') return (lp.stale ? staleNote(lp.updatedAt) : '') + eventsPage(a, sport, league, ctx);
        const fx = kind === 'nfl' ? nflFixture(a, following, ctx.hide) : leagueFixture(a, league, following, ctx.hide);
        const note = lp.stale ? staleNote(lp.updatedAt) : '';
        if (!fx.rounds.length) return note + `<div class="sp-league-empty">${UI.stateBlock('empty', words.empty, { label: 'Open the TV Guide', href: '#guide' })}</div>`;
        const season = a.season && (a.season.label || a.season.year) ? String(a.season.label || a.season.year) : '';
        return note + fixturePage(fx, { ...ctx, season }, word);
    }

    // ---------- Formula 1 (C-P; SportMotorViews, F1PageText) ----------

    /** A circuit map from the logo cache, at the size the server draws it (`?size=3840`), else null. */
    const mapPath = (p) => (typeof p === 'string' && /^\/api\/logo\/[A-Za-z0-9_.-]+(\?size=\d+)?$/.test(p) && !p.includes('..') ? p : null);
    const hex = (c) => (typeof c === 'string' && /^[0-9A-Fa-f]{6}$/.test(c) ? `#${c}` : null);
    const shortGp = (name) => String(name || '').replace('Grand Prix', 'GP').trim();
    const surname = (name) => String(name || '').split(' ').pop();
    /** "Fri 20 Nov · 1:30 pm". */
    const dayClock = (ms) => `${UI.date(ms)} · ${UI.clock(ms)}`;
    /** "in 35 min", "in 14 h", "in 2 days". */
    function countdown(to, now) {
        const minutes = Math.max(1, Math.ceil((to - now) / 60000));
        if (minutes < 60) return `in ${minutes} min`;
        const hours = Math.floor(minutes / 60);
        return hours < 48 ? `in ${hours} h` : `in ${Math.floor(hours / 24)} days`;
    }
    const f1Live = (s, now) => s.status === 'live' || (s.status !== 'done' && s.start <= now && now < s.end);
    const f1OnAir = (s, now) => s.onAir === true && s.status === 'scheduled' && now < s.start;
    /** The session the hero speaks about: the live one, else the next to start. */
    const focusSession = (w, now) => (w.sessions || []).find(s => f1Live(s, now)) || (w.sessions || []).find(s => s.status !== 'done' && s.start > now) || null;
    /** A session's state: live, on air, next, done (the top driver, or "Finished" with scores hidden), or later. */
    function sessionPill(s, w, now, hide) {
        if (f1Live(s, now)) return { state: 'live', line: 'On now' };
        if (f1OnAir(s, now)) return { state: 'onair', line: `On air · starts ${UI.clock(s.start)}` };
        if (s.status === 'done' || s.end <= now) {
            if (hide || !s.top || !s.top.driver) return { state: 'done', line: 'Finished' };
            return { state: 'done', line: `${({ pole: 'Pole', winner: 'Winner', fastest: 'Fastest' })[s.top.kind] || 'Top'} · ${surname(s.top.driver)}` };
        }
        const f = focusSession(w, now);
        if (f && f.id === s.id) { const c = countdown(s.start, now); return { state: 'next', line: c[0].toUpperCase() + c.slice(1) }; }
        return { state: 'later', line: '' };
    }
    /** A session as a game on its channels' own airing (Watch, Remind me, Record). */
    function sessionGame(s, w, now) {
        return { id: `f1s:${s.id}`, synthetic: true, league: 'F1', title: `${shortGp(w.name)} · ${s.name}`, session: s.name,
            start: s.start, end: s.end, status: s.status === 'done' ? 'finished' : f1Live(s, now) ? 'live' : 'scheduled',
            competitors: [], channels: s.channels || [], events: [], freshness: 'unavailable', progress: {}, onAir: s.onAir === true };
    }
    function f1Hero(page, now, following) {
        const w = page.weekend, s = focusSession(w, now);
        const kicker = [!s ? 'Weekend finished' : f1Live(s, now) ? 'Live' : f1OnAir(s, now) ? 'On air' : 'Next', 'Motorsport', 'Formula 1'];
        if (following.length) kicker.push('Your driver');
        const line = s ? [s.name, f1OnAir(s, now) ? `On air · starts ${UI.clock(s.start)}` : when(s.start, now), (s.channels || [])[0] ? s.channels[0].name : 'Not in guide yet'] : [`Round ${w.round || ''}`.trim(), w.circuit].filter(Boolean);
        return { hero: { kicker: kicker.join(' · '), live: !!s && (f1Live(s, now) || f1OnAir(s, now)), title: w.name, line: line.filter(Boolean).join(' · ') }, session: s };
    }
    function f1Tiles(page, now, hide) {
        const w = page.weekend;
        const tiles = (w.sessions || []).map(s => {
            const p = sessionPill(s, w, now, hide);
            const tag = p.state === 'live' ? '<span class="tag live">Live</span>' : p.state === 'onair' ? '<span class="tag live">On air</span>' : p.state === 'next' ? '<span class="tag next">Next</span>' : '';
            return `<button type="button" class="tile${p.state === 'done' ? ' done' : ''}" data-act="game" data-id="${e(`f1s:${s.id}`)}" data-key="tile:${e(s.id)}"><span class="tt">${e(s.name)}${tag}</span><span class="wh pig-amount">${e(dayClock(s.start))}</span><span class="ln">${e(p.line)}</span><span class="chn">${e((s.channels || [])[0] ? s.channels[0].name : 'Not in guide yet')}</span></button>`;
        }).join('');
        return tiles;
    }
    function circuitTile(info, dark) {
        const stats = [['Length', info && info.length], ['Laps', info && info.laps], ['Turns', info && info.turns], ['Lap record', info && info.lapRecord]];
        const map = mapPath(dark && info && info.mapDark ? info.mapDark : info && info.map);
        return `<div class="circuit"><dl class="stats">${stats.map(([k, v]) => `<div><dt>${e(k)}</dt><dd class="pig-amount">${e(v ?? '—')}</dd></div>`).join('')}</dl>${map ? `<img src="${e(map)}" alt="" aria-hidden="true" loading="lazy">` : ''}</div>`;
    }
    const f1Points = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : Number.isInteger(Number(v)) ? String(v) : Number(v).toFixed(1));
    function f1Lists(page, following, hide) {
        const want = following.map(lower);
        const results = page.results, st = page.standings;
        const card = (title, note, rows) => `<div class="lcard"><div class="lh"><b>${e(title)}</b>${note ? `<span>${e(note)}</span>` : ''}</div>${rows}</div>`;
        const hiddenRows = `<p class="hidden-note">${ICON.eyeOff}<span>Results and standings are hidden while Hide scores is on.</span></p>`;
        const mrow = (pos, name, color, detail, points, followed) => `<div class="mrow${followed ? ' me' : ''}"><span class="ps pig-amount">${e(pos)}</span><span class="bar" style="background:${hex(color) || 'var(--disc)'}"></span>${followed ? star('Your driver') : ''}<span class="nm">${e(name)}</span>${points != null ? `<span class="pt pig-amount">${e(points)}</span>` : detail ? `<span class="dt">${e(detail)}</span>` : ''}</div>`;
        const lists = [];
        if (results) lists.push(card(results.kind === 'grid' ? 'Starting grid' : results.title || 'Last race', '',
            hide ? hiddenRows : (results.rows || []).slice(0, 10).map(r => mrow(r.pos, r.driver, r.teamColor, r.team, null, want.includes(lower(r.driver)))).join('')));
        if (st) {
            const note = st.afterRound != null ? `After round ${st.afterRound}` : '';
            lists.push(card('Drivers', note, hide ? hiddenRows : (st.drivers || []).slice(0, 10).map(r => mrow(r.pos, r.name, r.teamColor, null, f1Points(r.points), want.includes(lower(r.name)))).join('')));
            lists.push(card('Constructors', note, hide ? hiddenRows : (st.constructors || []).slice(0, 10).map(r => mrow(r.pos, r.name, r.teamColor, null, f1Points(r.points), false)).join('')));
        }
        return lists.length ? `<div class="lists3">${lists.join('')}</div>` : '';
    }
    /** The Formula 1 page below its header: the banner (computer), the session tiles and the circuit, then the lists. */
    function f1Page(page, ctx) {
        const { now, hide, phone } = ctx, w = page.weekend, following = ctx.following || [];
        const { hero: h, session } = f1Hero(page, now, following);
        const g = session ? sessionGame(session, w, now) : null;
        let html = '';
        if (!phone) {
            html += banner({ hero: h, items: [], back: 'Back to Motorsport', art: mapPath(w.info && w.info.map) ? { map: mapPath(ctx.dark && w.info.mapDark ? w.info.mapDark : w.info.map) } : null,
                actions: heroButtons(g, now) });
            html += `<div class="tiles">${f1Tiles(page, now, hide)}${circuitTile(w.info, ctx.dark)}</div>`;
        } else {
            html += `<div class="kicker${h.live ? ' live' : ''}">${h.live ? dot() : ''}<span>${e(h.kicker.split(' · ')[0])} · ${e(w.name)}</span></div>`;
            if (g && event(g)) html += `<div class="hero-actions">${heroButtons(g, now)}</div>`;
            html += `<div class="tiles">${f1Tiles(page, now, hide)}</div><div class="circuit-p">${circuitTile(w.info, ctx.dark)}</div>`;
        }
        return html + f1Lists(page, following, hide);
    }

    // ---------- cricket (C-S; CricketPageView, CricketPageModels) ----------

    const INTERNATIONAL = ['Cricket', "Women's Cricket"];
    /** The followed league a match belongs to (C-S `league`, else its competition's name, else the one International group). */
    function cricketLeagueOf(id, named, competition, scope) {
        if (named && String(named).trim()) return String(named).trim();
        const c = lower(String(competition || '').trim());
        if (c) {
            const hit = scope.leagues.find(l => lower(l) === c || lower(label(l, scope.labels)) === c);
            if (hit) return hit;
        }
        const groups = scope.leagues.filter(l => INTERNATIONAL.includes(l));
        return groups.length === 1 ? groups[0] : null;
    }
    const cricketTitle = (teams) => (teams || []).map(t => t.name).join(' v ');
    /** One team's innings: "329 & 200/5", "406/5d"; nothing when it has not batted. */
    function innings(list) {
        const parts = (list || []).filter(i => i.runs != null).map(i => `${i.runs}${i.wickets != null && i.wickets < 10 ? `/${i.wickets}` : ''}${i.declared ? 'd' : ''}`);
        return parts.length ? parts.join(' & ') : null;
    }
    function scoreboard(lead) {
        const cols = Math.max(1, ...(lead.innings || []).map(l => l.length));
        const names = ['1st inns', '2nd inns', '3rd inns', '4th inns'];
        const headers = [...Array.from({ length: cols }, (_, i) => names[i] || `Inns ${i + 1}`), 'Overs'];
        const rows = (lead.teams || []).map((t, ti) => {
            const list = (lead.innings || [])[ti] || [];
            const open = [...list].reverse().find(i => i.current);
            return [...Array.from({ length: cols }, (_, i) => (i < list.length ? innings([list[i]]) : null)), open ? open.overs : null];
        });
        return { headers, rows };
    }
    const dayNumber = (lead) => { const n = parseInt(String(lead.day || '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : ((lead.days || []).find(d => d.state === 'live') || {}).number ?? null; };
    const nextDay = (lead) => ((lead.days || []).find(d => d.state === 'next') || {}).number ?? null;
    /** The pill: "Live"; "Day 5 in 21 h" before the next day; "Starts in 3 h"; "Finished". */
    function cricketPill(lead, now) {
        if (lead.status === 'live') return 'Live';
        if (lead.status === 'done') return 'Finished';
        const next = lead.nextStart ?? (lead.status === 'scheduled' ? lead.start : null);
        if (next == null) return lead.breakLabel || 'Break';
        const word = lead.status === 'break' ? (nextDay(lead) ? `Day ${nextDay(lead)}` : 'Play') : (lead.days || []).length > 1 && nextDay(lead) > 1 ? `Day ${nextDay(lead)}` : 'Starts';
        return next > now ? `${word} ${countdown(next, now)}` : (lead.breakLabel || 'Soon');
    }
    function daySub(day, lead, now) {
        if (day.state === 'live') return 'Live now';
        if (day.state === 'next' && lead.nextStart != null) return when(lead.nextStart, now);
        if (day.state === 'done' && lead.status === 'break' && day.number === dayNumber(lead) && lead.breakLabel) return lead.breakLabel;
        return day.date != null ? UI.date(day.date) : '';
    }
    /** A series match's right-hand words: the lead's state on its own match, the result ("Finished" hidden), else its start. */
    function seriesResult(m, lead, hide, now) {
        if (lead && (m.current || m.id === lead.id)) {
            const day = lead.day ? lead.day.toLowerCase() : null;
            if (lead.status === 'live') return ['Live', day].filter(Boolean).join(' · ');
            if (lead.status === 'break') return [lead.breakLabel || 'Break', day].filter(Boolean).join(' · ');
        }
        if (m.status === 'done') return hide ? 'Finished' : (m.result || 'Finished');
        if (m.status === 'live') return 'Live';
        if (m.status === 'break') return 'Break';
        return m.start != null ? when(m.start, now) : '';
    }
    /** A cricket match as a game on its channels (Watch, Remind me, Record). */
    function cricketGame(m) {
        const starts = (m.channels || []).map(c => c.start).filter(Number.isFinite), ends = (m.channels || []).map(c => c.end).filter(Number.isFinite);
        const start = starts.length ? Math.min(...starts) : m.nextStart ?? m.start ?? 0, end = ends.length ? Math.max(...ends) : start + 8 * 3600000;
        return { id: `ck:${m.id}`, synthetic: true, league: 'Cricket', title: cricketTitle(m.teams), start, end: Math.max(end, start + 60000),
            status: m.status === 'done' ? 'finished' : m.status === 'scheduled' ? 'scheduled' : 'live', competitors: (m.teams || []).map(t => ({ name: t.name, logo: t.logo })),
            channels: m.channels || [], events: [], freshness: 'unavailable', progress: {} };
    }
    function otherStatus(o, now) {
        if (o.status === 'live') return 'Live';
        if (o.status === 'break') return o.nextStart != null ? `Resumes ${when(o.nextStart, now)}` : 'Break';
        if (o.status === 'scheduled') { const t = o.nextStart ?? o.start; return t != null ? when(t, now) : 'Upcoming'; }
        return 'Finished';
    }
    function otherCard(o, ctx) {
        const live = o.status === 'live';
        const sc = ctx.hide ? [] : (o.scores || []);
        const rows = (o.teams || []).map((t, i) => `<span class="trow">${badge(t.name, t.logo, 26)}<span class="n">${e(t.name)}</span>${sc[i] ? `<span class="sc pig-amount">${e(sc[i])}</span>` : ''}</span>`).join('');
        const ch = (o.channels || [])[0];
        return `<div class="gitem"><button type="button" class="gcard${live ? ' live' : ''}" data-act="game" data-id="${e(`ck:${o.id}`)}" data-key="ck:${e(o.id)}"><span class="sk">${e(o.competition || 'Cricket')}</span>${rows}${!ctx.hide && o.line ? `<span class="sline">${e(o.line)}</span>` : ''}<span class="cbot">${live ? dot() : ''}<span class="${live ? 'clk' : 'when'} pig-amount">${e(otherStatus(o, ctx.now))}</span>${o.status !== 'done' ? `<span class="ch">${e(ch ? ch.name : 'Not in guide yet')}</span>` : ''}</span></button></div>`;
    }
    function leadBlock(lead, ctx, leagueLabel) {
        const { hide, now } = ctx;
        const g = cricketGame(lead), act = action(g, now), ev = lead.status !== 'done' ? event(g) : null;
        const pill = cricketPill(lead, now);
        const kicker = [lead.label || lead.competition || leagueLabel, lead.venue, hide ? null : lead.seriesLine].filter(Boolean).join(' · ');
        let board;
        if (hide) {
            board = `<div class="board"><div class="tms">${(lead.teams || []).map(t => `<div class="tm"><span class="nm">${badge(t.name, t.logo, 34)}${e(t.name)}</span></div>`).join('')}</div></div>`;
        } else {
            const b = scoreboard(lead), cols = `grid-template-columns: minmax(0, 1fr) repeat(${b.headers.length}, minmax(64px, auto))`;
            board = `<div class="board"><div class="hdr" style="${cols}"><span></span>${b.headers.map(h => `<span>${e(h)}</span>`).join('')}</div>`
                + (lead.teams || []).map((t, i) => `<div class="tm" style="${cols}"><span class="nm">${badge(t.name, t.logo, 34)}${e(t.name)}</span>${b.rows[i].map((v, j) => `<span class="${j === b.rows[i].length - 1 ? 'o' : 'r'} pig-amount">${e(v ?? '')}</span>`).join('')}</div>`).join('')
                + (lead.summary || (lead.crease && lead.crease.length) ? `<div class="sum">${lead.summary ? `<b>${e(lead.summary)}</b>` : ''}${lead.crease && lead.crease.length ? `<span>${e(lead.crease.map(c => (c.runs != null ? `${surname(c.name)} ${c.runs}*` : surname(c.name))).join(' · '))}</span>` : ''}</div>` : '')
                + '</div>';
        }
        const days = (lead.days || []).length > 1 ? `<div class="days">${lead.days.map(d => `<div class="day ${e(d.state)}"><b>Day ${e(d.number)}</b><small>${e(daySub(d, lead, now))}</small></div>`).join('')}</div>` : '';
        let actions = '';
        if (ev) {
            if (act === 'watch') actions += `<button type="button" class="pill primary" data-act="watch" data-id="${e(g.id)}" data-key="lead:watch">${ICON.play}Watch live</button>`;
            else if (act === 'remind') actions += `<button type="button" class="pill primary" data-act="remind" data-id="${e(g.id)}" data-key="lead:remind">${ICON.bell}Remind me</button>`;
            if (act !== 'none' && act !== 'details') actions += `<button type="button" class="pill" data-act="record-menu" aria-haspopup="menu" data-id="${e(g.id)}" data-key="lead:record">${ICON.rec}Record</button>`;
        }
        const chn = ev ? (act === 'remind' ? `${when(ev.start, now)} on ${ev.channel.name}` : `on ${ev.channel.name}`) : lead.status === 'done' ? '' : 'Not in guide yet';
        return `<div class="lead"><div class="lead-k"><span>${e(kicker)}</span><span class="lpill${lead.status === 'live' ? ' live' : ''}">${e(pill)}</span></div>`
            + `<h3 class="ltitle">${e(cricketTitle(lead.teams))}</h3>${board}${days}<div class="cact">${actions}${chn ? `<span class="chn">${e(chn)}</span>` : ''}</div></div>`;
    }
    function seriesPanel(series, lead, ctx) {
        return `<section class="series" aria-label="${e(series.name || 'Series')}"><div class="sh"><b>${e(series.name || '')}</b>${series.season ? `<span>${e(series.season)}</span>` : ''}</div>`
            + (series.matches || []).map(m => `<div class="sm${m.current || (lead && m.id === lead.id) ? ' cur' : ''}"><div class="a"><b>${e(m.label || '')}</b>${m.start != null ? `<span>${e(UI.date(m.start))}</span>` : ''}</div><span class="res">${e(seriesResult(m, lead, ctx.hide, ctx.now))}</span></div>`).join('')
            + '</section>';
    }
    /** The cricket page for one followed league: its lead match (scoreboard, days, actions) beside its tour, then its other matches. */
    function cricketPage(page, league, ctx) {
        const scope = { leagues: ctx.leagues || [league], labels: ctx.labels || {} };
        const mine = (m) => cricketLeagueOf(m.id, m.league, m.competition, scope) === league;
        const word = label(league, ctx.labels);
        const lead = page.lead && mine(page.lead) ? page.lead : null;
        const others = (page.others || []).filter(mine);
        if (!lead && !others.length) return ctx.front && leagueGames(league, ctx.front).length ? gamesGrid(league, ctx)
            : `<div class="sp-league-empty">${UI.stateBlock('empty', { title: 'No cricket today or tomorrow', detail: 'Matches show here once the scores feed lists them.' }, { label: 'Open the TV Guide', href: '#guide' })}</div>`;
        let html = '';
        if (lead) {
            const series = page.series && (page.series.matches || []).length ? seriesPanel(page.series, lead, ctx) : '';
            html += `<div class="cric${series ? '' : ' solo'}">${leadBlock(lead, ctx, word)}${series}</div>`;
        }
        if (others.length) html += `<section class="others" aria-label="${e(lead ? `More ${word}` : word)}"><div class="oh"><h3>${e(lead ? `More ${word}` : word)}</h3></div><div class="ogrid">${others.map(o => otherCard(o, ctx)).join('')}</div></section>`;
        return html;
    }

    // ---------- events: golf, tennis, UFC, IndyCar and NASCAR (C-V; SportEventsViews, SportEventsModels) ----------

    const EV_ONGOING = ['live', 'break', 'suspended'];
    const EV_DONE = ['finished', 'done', 'final'];
    /** A name is followed when the event's `followed` has it (a doubles pair when either of its names is). */
    function evFollowed(name, ev) {
        if (!name || !(ev.followed || []).length) return false;
        return ev.followed.includes(name) || String(name).split(' / ').some(n => ev.followed.includes(n));
    }
    /** The event the page leads with: one under way, else the next to start, else the latest. */
    function evFocus(events) {
        return events.find(x => EV_ONGOING.includes(x.status)) || events.filter(x => x.status === 'scheduled').sort((a, b) => a.start - b.start)[0]
            || [...events].sort((a, b) => b.start - a.start)[0] || null;
    }
    const evHiddenNote = (text) => `<p class="hidden-note">${ICON.eyeOff}<span>${e(text)}</span></p>`;

    /** Golf: the leaderboard (top 11; hidden: none), your players beside it, the week's other events. */
    function golfHtml(evs, focus, ctx) {
        const { hide, phone, now } = ctx;
        const parOf = (t) => { if (t == null) return null; const s = String(t).trim().replace('−', '-').replace('+', ''); return s.toUpperCase() === 'E' ? 0 : Number.isFinite(Number(s)) && s !== '' ? Number(s) : null; };
        const lb = focus.leaderboard || [], leader = lb.find(r => r.pos != null);
        const board = hide ? `<div class="lcard"><div class="lh"><b>Leaderboard</b></div>${evHiddenNote('The leaderboard is hidden while Hide scores is on.')}</div>`
            : `<div class="lcard"><div class="lh"><b>Leaderboard</b><span>Top ${Math.min(11, lb.length)}</span></div><table class="lb"><thead><tr><th scope="col" class="tl">Pos</th><th scope="col" class="tl">Player</th><th scope="col">To par</th>${phone ? '' : '<th scope="col">R1</th><th scope="col">R2</th><th scope="col">R3</th>'}</tr></thead><tbody>`
                + lb.slice(0, 11).map(r => `<tr${evFollowed(r.name, focus) ? ' class="me"' : ''}><td class="pos">${e(r.pos ?? (r.status ? r.status.toUpperCase() : '–'))}</td><td class="nm">${evFollowed(r.name, focus) ? star('Your player') : ''}${e(r.name)}</td><td class="tp pig-amount">${e(r.toPar ?? '–')}</td>${phone ? '' : [0, 1, 2].map(i => `<td class="r pig-amount">${e((r.rounds || [])[i] ?? '–')}</td>`).join('')}</tr>`).join('')
                + '</tbody></table></div>';
        let mine = lb.filter(r => evFollowed(r.name, focus));
        // #323 review: hidden, the leaderboard's order would rank your players: they go in the follow order, else by name
        if (hide) {
            const order = (n) => { const i = (focus.followed || []).findIndex(f => f === n || String(n).split(' / ').includes(f)); return i < 0 ? Infinity : i; };
            mine = [...mine].sort((a, b) => order(a.name) - order(b.name) || String(a.name).localeCompare(String(b.name)));
        }
        const players = mine.length ? `<div><h4>Your players</h4>${mine.map(r => {
            if (hide) return `<div class="pcard"><div class="t">${star('Your player')}${e(r.name)}</div></div>`;
            const mineP = parOf(r.toPar), lead = parOf(leader && leader.toPar);
            const gap = mineP != null && lead != null ? (mineP - lead <= 0 ? 'Leader' : `${mineP - lead} behind`) : null;
            return `<div class="pcard"><div class="t">${star('Your player')}${e(r.name)}<span class="ps">${e(r.pos ?? (r.status || '').toUpperCase())}</span><span class="tp pig-amount">${e(r.toPar ?? '')}</span></div>`
                + `<div class="rd pig-amount">${[0, 1, 2].map(i => `<span>R${i + 1} ${e((r.rounds || [])[i] ?? '–')}</span>`).join('')}${gap ? `<span class="gap">${e(gap)}</span>` : ''}</div></div>`;
        }).join('')}</div>` : '';
        const also = evs.filter(x => x !== focus);
        const alsoLine = (x) => {
            if (x.status === 'scheduled') return when(x.start, now);
            const lead2 = (x.leaderboard || []).find(r => r.pos != null);
            if (!hide && lead2) return [surname(lead2.name), lead2.toPar].filter(Boolean).join(' ');
            if (x.breakLabel) return x.breakLabel;
            if (EV_ONGOING.includes(x.status)) return x.round ? `Round ${x.round} in play` : 'In play';
            return hide ? 'Finished' : 'Final';
        };
        const alsoHtml = also.length ? `<div><h4>Also this week</h4>${also.map(x => `<div class="slim"><b>${e(x.name)}</b><span class="w">${e(alsoLine(x))}</span></div>`).join('')}</div>` : '';
        return `<div class="golf${players || alsoHtml ? '' : ' solo'}">${board}${players || alsoHtml ? `<div class="sidecol">${players}${alsoHtml}</div>` : ''}</div>`;
    }

    /** Tennis: Your players, Live now, Tonight, Results today; with scores hidden no sets and no winner. */
    function tennisHtml(evs, ctx) {
        const { hide, now } = ctx;
        const all = evs.flatMap(ev => (ev.matches || []).map(m => ({ ev, m })));
        const rank = (m) => (EV_ONGOING.includes(m.status) ? 0 : m.status === 'scheduled' ? 1 : 2);
        const yours = all.filter(x => (x.m.players || []).some(p => evFollowed(p.name, x.ev)))
            .sort((a, b) => rank(a.m) - rank(b.m) || (rank(a.m) === 2 ? b.m.start - a.m.start : a.m.start - b.m.start));
        const live = all.filter(x => EV_ONGOING.includes(x.m.status));
        const tonight = all.filter(x => x.m.status === 'scheduled' && sameDay(x.m.start, now) && x.m.start >= now - 3600000).sort((a, b) => a.m.start - b.m.start);
        const results = all.filter(x => EV_DONE.includes(x.m.status) && sameDay(x.m.start, now)).sort((a, b) => b.m.start - a.m.start);
        const matchCard = ({ ev, m }) => {
            const state = EV_ONGOING.includes(m.status) ? 'Live' : m.status === 'scheduled' ? when(m.start, now) : hide ? 'Finished' : 'Final';
            const rows = (m.players || []).map((p, i) => {
                const name = p.name ? (p.seed ? `${p.name} [${p.seed}]` : p.name) : 'TBD';
                const sets = hide || !m.sets ? [] : m.sets.map(s => s[i]).filter(v => v != null);
                const won = !hide && p.winner === true;
                return `<span class="trow${won ? ' won' : ''}">${evFollowed(p.name, ev) ? star('Your player') : ''}<span class="n">${e(name)}</span>${sets.length ? `<span class="sets pig-amount">${sets.map(v => `<span>${e(v)}</span>`).join('')}</span>` : ''}</span>`;
            }).join('');
            return `<div class="gitem"><div class="gcard${EV_ONGOING.includes(m.status) ? ' live' : ''}"><span class="sk">${e([m.draw, m.round].filter(Boolean).join(' · '))}</span>${rows}<span class="cbot">${EV_ONGOING.includes(m.status) ? dot() : ''}<span class="${EV_ONGOING.includes(m.status) ? 'clk' : 'when'} pig-amount">${e(state)}</span>${m.court ? `<span class="ch">${e(m.court)}</span>` : ''}</span></div></div>`;
        };
        const rail = (title, list) => (list.length ? `<section class="sec" aria-label="${e(title)}"><h3 class="sec-title"><span class="sec-h"><span class="s">${e(title)}</span></span></h3><div class="rail">${list.slice(0, 20).map(matchCard).join('')}</div></section>` : '');
        const html = rail('Your players', yours) + rail('Live now', live) + rail('Tonight', tonight) + rail('Results today', results);
        return html || '<p class="sp-muted">No matches today.</p>';
    }

    /** UFC: the main card and the prelims, the main event last; with scores hidden "Finished", no winner. */
    function fightHtml(focus, ctx) {
        const { hide } = ctx;
        const bouts = focus.bouts || [], main = bouts.filter(b => b.card !== 'prelims'), prelims = bouts.filter(b => b.card === 'prelims');
        const mainEvent = main[main.length - 1];
        const line = (b) => {
            if (EV_DONE.includes(b.status)) {
                if (hide) return 'Finished';
                const w = (b.fighters || []).find(f => f.winner === true);
                const r = b.result ? [b.result.round ? `R${b.result.round}` : null, b.result.clock].filter(Boolean).join(' ') : '';
                return [w ? surname(w.name) : null, r].filter(Boolean).join(' · ') || 'Finished';
            }
            if (EV_ONGOING.includes(b.status)) return 'Live';
            return b === mainEvent ? 'Main event' : 'Up next';
        };
        const row = (b) => `<div class="bout${b === mainEvent ? ' main' : ''}"><span class="wc">${e(b.weightClass || '')}</span><span class="f">${(b.fighters || []).map(f => `<span class="${!hide && f.winner === true ? 'won' : ''}">${evFollowed(f.name, focus) ? star('Your fighter') : ''}${e(f.name)}</span>`).join('<span class="vs" aria-hidden="true"> v </span>')}</span><span class="bl">${e(line(b))}</span></div>`;
        const list = (title, items) => (items.length ? `<div class="lcard"><div class="lh"><b>${e(title)}</b></div>${items.map(row).join('')}</div>` : '');
        return `<div class="fights">${list('Main card', main)}${list('Prelims', prelims)}</div>`;
    }

    /** IndyCar and NASCAR: the entry list (alphabetical), the last winner (hidden: none) and the next race. */
    function raceHtml(page, focus, ctx) {
        const entries = ((focus && focus.entryList) || []).map(x => x.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
        const last = !ctx.hide && page.lastWinner && page.lastWinner.name ? `<div class="slim"><b>Last winner</b><span class="w">${e(page.lastWinner.name)}${page.lastWinner.race ? ` · ${e(page.lastWinner.race)}` : ''}</span></div>` : '';
        const next = page.next && page.next.start != null ? `<div class="slim"><b>Next race</b><span class="w">${e(page.next.name || '')} · ${e(dayClock(page.next.start))}</span></div>` : '';
        return `<div class="golf"><div class="lcard"><div class="lh"><b>Entry list</b><span>${e(entries.length)} drivers</span></div><ul class="entries">${entries.map(n => `<li>${focus && evFollowed(n, focus) ? star('Your driver') : ''}${e(n)}</li>`).join('')}</ul></div><div class="sidecol">${last}${next}</div></div>`;
    }

    /**
     * An events league's page (C-V) below its header: on a computer the sport's banner (its leagues the list), then the
     * event's card and name, then the leaderboard, the matches, the fight card or the entry list.
     */
    function eventsPage(page, sport, league, ctx) {
        const { front: f, hide, now, labels, phone } = ctx;
        const evs = page.events || [];
        const word = label(league, labels);
        if (!evs.length) return `<div class="sp-league-empty">${UI.stateBlock('empty', { title: `Nothing in ${word} this week`, detail: 'Its next events show here once the scores feed lists them.' }, { label: 'Open the TV Guide', href: '#guide' })}</div>`;
        const focus = evFocus(evs);
        const g = f ? game(f, focus.id) : null;
        let html = '';
        if (!phone) {
            const leagues = f ? sportLeagues(sport, f) : [];
            const words = g ? hero(g, f, hide, now, labels) : { kicker: `${sport} · ${word}`, live: EV_ONGOING.includes(focus.status), title: focus.name, line: focus.venue && focus.venue.name ? focus.venue.name : '' };
            html += banner({ hero: words, items: f ? leagueItems(sport, f, now, labels) : [], listTitle: `<span class="up">${e(sport)} · Your leagues</span>`,
                selected: leagues.findIndex(x => x.league === league), back: `Back to ${sport}`, actions: heroButtons(g, now), listAct: 'league-page' });
        }
        const sub = [page.kind === 'golf' && focus.round ? `Round ${focus.round}` : null, focus.breakLabel || null, focus.venue && focus.venue.name ? [focus.venue.name, focus.venue.city].filter(Boolean).join(', ') : null].filter(Boolean).join(' · ');
        html += `<div class="evhead">${g ? card(g, ctx) : ''}<div><h3>${e(focus.name)}</h3>${sub ? `<div class="sub">${e(sub)}</div>` : ''}</div></div>`;
        if (page.kind === 'golf') html += golfHtml(evs, focus, ctx);
        else if (page.kind === 'tennis') html += tennisHtml(evs, ctx);
        else if (page.kind === 'fight') html += fightHtml(focus, ctx);
        else if (page.kind === 'race') html += raceHtml(page, focus, ctx);
        return html;
    }

    return {
        ICON, hidden, family, terminal, underWay, isOnAir, showsLive, isNextRound, logo, statusWord, progressLabel, situationLabel,
        scores, situation, when, headerDate, startLine, channelLine, cardClock, event, action, actionLabel, followedSides,
        followedSide, sections, alsoInYourSports, headerLine, followTrailing, hero, NO_HERO, followKey, followsGoneLive,
        resolveHero, heroFollowIndex, fastRefresh, monogram, badge, leagueBadge, header, scoresChip, card, banner, heroButtons,
        followItems, front, frontDesktop, frontPhone, row, rowHtml, phoneCard, dots, position, isEmpty, game, sportOf, label,
        railGames, staleNote, scoresNote, star, dot, recordMark, kickerWord, yours, availabilityWord, onAirLine, e, gameCard,
        sportLeagues, sportGames, leagueGames, sportHero, openingLeague, leagueItems, leagueGroups, leagueCards, leagueContent,
        moreTitle, sportPage, EVENT_LEAGUES, moreButton, groupsHtml, nothingSoon, fixtureDetail, nflFixture, leagueFixture, roundOf, viewOf,
        tableGroups, fixtureCard, fixtureGame, fixtureCardHtml, standingsHtml, fixturePage, leaguePage, gamesGrid, leagueWords,
        mapPath, countdown, focusSession, sessionPill, sessionGame, f1Hero, f1Page, cricketLeagueOf, innings, scoreboard, cricketPill,
        seriesResult, cricketGame, cricketPage, evFollowed, evFocus, golfHtml, tennisHtml, fightHtml, raceHtml, eventsPage
    };
})();

if (typeof window !== 'undefined') window.SportView = SportView;
if (typeof module !== 'undefined' && module.exports) module.exports = SportView;
