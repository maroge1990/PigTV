/**
 * Settings -> Sports -> "Your sport" (#199, D-41; a first panel of its own out of Settings.js, #64). Per account.
 *
 * The account's sports in its order, each with its leagues (at least one, in order, offered under the catalogue's
 * headings) and the teams or people it follows from those leagues (each once, picked from the leagues' names); the
 * Hide scores switch; the suggested competitions of its teams (Add / No thanks); "Record every game" on a followed team
 * (a household recording rule, kind `team`); unfollowing a team that has one switches the rule off at once and deletes
 * it when the Undo notice ends (Undo switches it back on).
 * Uses GET /api/sports/catalog, GET+PUT /api/sports/follows, GET /api/sports/names, GET /api/sports/suggestions,
 * POST /api/sports/suggestions/decline (C-U) and /api/recordings/rules (C-M).
 *
 * SportFollowModel holds the pure helpers (tested without a DOM).
 */

const SportFollowModel = {
    MAX_NAMES: 20,

    same(a, b) { return String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); },

    copy(state) { return { spoilerFree: !!state.spoilerFree, sports: state.sports.map(s => ({ sport: s.sport, leagues: [...s.leagues], teams: [...s.teams] })) }; },

    /** `list` with item `index` moved by `delta` (-1 up, +1 down); unchanged at either end. */
    move(list, index, delta) {
        const to = index + delta;
        if (to < 0 || to >= list.length) return list;
        const out = [...list];
        [out[index], out[to]] = [out[to], out[index]];
        return out;
    },

    /** A followed sport added at the end with its first league (a sport needs one; a one-league sport has only that). */
    addSport(state, sport, catalog) {
        const entry = catalog.find(c => c.sport === sport);
        if (!entry || state.sports.some(s => s.sport === sport)) return state;
        const next = SportFollowModel.copy(state);
        next.sports.push({ sport, leagues: [entry.leagues[0].league], teams: [] });
        return next;
    },

    addLeague(state, sport, league) {
        const next = SportFollowModel.copy(state);
        const s = next.sports.find(x => x.sport === sport);
        if (s && !s.leagues.includes(league)) s.leagues.push(league);
        return next;
    },

    /**
     * Remove a league. -> { state, error } (a sport keeps at least one) and `orphans`: the followed names the league's
     * list has and no other chosen league's does (D-41: removed with it, after a warning). A league whose names are not
     * known yet (`namesOf` null) is never taken to lack a team.
     */
    removeLeague(state, sport, league, namesOf = () => null) {
        const s = state.sports.find(x => x.sport === sport);
        if (!s || !s.leagues.includes(league)) return { state, orphans: [] };
        if (s.leagues.length === 1) return { state, orphans: [], error: 'A sport needs at least one league: remove the sport instead.' };
        const rest = s.leagues.filter(l => l !== league);
        const has = (l, name) => { const names = namesOf(l); return names === null ? null : names.some(n => SportFollowModel.same(n, name)); };
        const orphans = s.teams.filter(t => has(league, t) === true && rest.every(l => has(l, t) === false));
        const next = SportFollowModel.copy(state);
        const entry = next.sports.find(x => x.sport === sport);
        entry.leagues = rest;
        return { state: next, orphans };
    },

    /** Follow `name` in `sport`: once (any case), at most MAX_NAMES. -> { state, error } */
    addName(state, sport, name) {
        const clean = String(name || '').replace(/\s+/g, ' ').trim();
        const s = state.sports.find(x => x.sport === sport);
        if (!s || !clean) return { state };
        if (s.teams.some(t => SportFollowModel.same(t, clean))) return { state, error: `${clean} is followed already.` };
        if (s.teams.length >= SportFollowModel.MAX_NAMES) return { state, error: `At most ${SportFollowModel.MAX_NAMES} in one sport.` };
        const next = SportFollowModel.copy(state);
        next.sports.find(x => x.sport === sport).teams.push(clean);
        return { state: next };
    },

    removeNames(state, sport, names) {
        const next = SportFollowModel.copy(state);
        const s = next.sports.find(x => x.sport === sport);
        if (s) s.teams = s.teams.filter(t => !names.some(n => SportFollowModel.same(n, t)));
        return next;
    },

    /**
     * #276: Undo of a removal, onto the state as it is now: put back only what `removed` took ({ sport, index, before:
     * the sport's entry then, leagues, names }), each in its old place where it can be, keeping every change made since.
     */
    restore(state, removed) {
        const next = SportFollowModel.copy(state);
        let s = next.sports.find(x => x.sport === removed.sport);
        if (!s) {
            s = { sport: removed.sport, leagues: [], teams: [] };
            next.sports.splice(Math.min(removed.index, next.sports.length), 0, s);
        }
        const at = (list, item, old) => list.splice(Math.min(old.indexOf(item), list.length), 0, item);
        for (const l of removed.before.leagues) if (removed.leagues.includes(l) && !s.leagues.includes(l)) at(s.leagues, l, removed.before.leagues);
        for (const n of removed.before.teams) {
            if (!removed.names.some(r => SportFollowModel.same(r, n)) || s.teams.some(t => SportFollowModel.same(t, n))) continue;
            at(s.teams, n, removed.before.teams);
        }
        return next;
    },

    /** Whether `name` is followed in `sport` in `state`. */
    follows(state, sport, name) {
        const s = state.sports.find(x => x.sport === sport);
        return !!s && s.teams.some(t => SportFollowModel.same(t, name));
    },

    /** The names a sport's chosen leagues offer, each once, in name order (`namesOf(league)`: a list or null). */
    offered(entry, namesOf) {
        const out = new Map();
        for (const l of entry.leagues) for (const n of namesOf(l) || []) if (!out.has(n.toLowerCase())) out.set(n.toLowerCase(), n);
        return [...out.values()].sort((a, b) => a.localeCompare(b));
    },

    /** The "Record every game" rule on a followed name, if any (`rules`: GET /api/recordings/rules). */
    ruleFor(rules, sport, name) {
        return (rules || []).find(r => r.kind === 'team' && r.sport === sport && SportFollowModel.same(r.match, name)) || null;
    },

    /** "Tue 4 Nov", local time. */
    day(ms) {
        const d = new Date(ms);
        return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`;
    }
};

class SportFollowSettings {
    constructor(root, { currentUser = () => null } = {}) {
        this.root = root;
        this.currentUser = currentUser;
        this.catalog = [];
        this.state = { spoilerFree: false, sports: [] };
        this.names = new Map(); // league -> [names] (absent: not asked yet)
        this.rules = [];
        this.suggestions = [];
        this.message = '';
        this.queue = Promise.resolve(); // 0420: one change at a time, each built from the state the last one left
        this.pendingRules = new Set();  // #276: rule ids whose switch-off waits for the end of its Undo notice
        this.lastSaveOk = false;
        root?.addEventListener('click', (e) => this.onClick(e));
        root?.addEventListener('change', (e) => this.onChange(e));
    }

    namesOf = (league) => (this.names.has(league) ? this.names.get(league) : null);

    async load() {
        if (!this.root) return;
        // #276: nothing is drawn until what the account follows is known: first a loading block, and on a failed load an
        // error with Try again, never the form (it showed "You follow no sport yet" and saved over the real list).
        if (!this.loaded) UI.setState(this.root, 'loading', 'Loading what you follow…');
        try {
            const [catalog, follows] = await Promise.all([API.request('GET', '/sports/catalog'), API.request('GET', '/sports/follows')]);
            this.catalog = catalog.sports || [];
            this.state = follows;
            this.unknown = false; // #208: read again: changes save again
            this.loaded = true;
            this.loadFailed = false;
            this.message = '';
        } catch (err) {
            console.error('What you follow failed to load:', err);
            this.loadFailed = true;
            UI.setState(this.root, 'error', 'What you follow could not be loaded.', { run: () => this.load() });
            return;
        }
        this.render();
        await Promise.all([this.loadRules(), this.loadSuggestions(), this.loadNames()]);
        this.render();
    }

    // 0421 (0420 Codex round 2, high): a list that could not be read is unknown, never taken as "no rules"
    async loadRules() {
        try { this.rules = await API.request('GET', '/recordings/rules'); this.rulesKnown = true; } catch { this.rules = []; this.rulesKnown = false; }
    }
    async loadSuggestions() { try { this.suggestions = (await API.request('GET', '/sports/suggestions')).suggestions || []; } catch { this.suggestions = []; } }
    async loadNames() {
        const wanted = [...new Set(this.state.sports.flatMap(s => s.leagues))].filter(l => !this.names.has(l));
        await Promise.all(wanted.map(async (l) => {
            try { this.names.set(l, (await API.request('GET', `/sports/names?league=${encodeURIComponent(l)}`)).names || []); } catch { /* unknown for now */ }
        }));
    }

    /**
     * Save the whole list (PUT replaces it), then show what the server kept; on failure, what it has. 0420 (0419 Codex
     * round 1, high): changes run one at a time, and `next` may be a function of the state when its turn comes, so two
     * quick changes never build on the same old list.
     */
    save(next, done = '') {
        // #208: while what the server holds is unknown, a change (queued or new) is dropped, never built on a stale list.
        if (this.unknown || this.loadFailed) { this.lastSaveOk = false; this.render(); return Promise.resolve(); }
        const run = this.queue.then(() => (this.unknown ? undefined : this.saveNow(typeof next === 'function' ? next(this.state) : next, done)));
        this.queue = run.catch(() => {});
        return run;
    }
    async saveNow(next, done) {
        this.lastSaveOk = false;
        try {
            this.state = await API.request('PUT', '/sports/follows', next);
            this.lastSaveOk = true;
            this.message = typeof done === 'function' ? done() : done;
            await Promise.all([this.loadNames(), this.loadSuggestions()]);
        } catch (err) {
            this.message = UI.errorText(err, 'Not saved.');
            try { this.state = await API.request('GET', '/sports/follows'); } catch {
                // #208: the PUT may have been kept: what is shown may be stale, so nothing more is saved until a load.
                this.unknown = true;
                this.message = 'Not saved, and what you follow could not be read again. Reload this page before changing anything.';
            }
        }
        this.render();
    }

    async onChange(e) {
        const t = e.target;
        if (t.id === 'sport-follow-spoilers') { const on = t.checked; return this.save(s => ({ ...SportFollowModel.copy(s), spoilerFree: on }), on ? 'Scores are hidden.' : 'Scores are shown.'); }
        if (t.dataset.addLeague !== undefined && t.value) { const sport = t.dataset.addLeague, league = t.value; return this.save(s => SportFollowModel.addLeague(s, sport, league), `Added ${this.label(league)}.`); }
        if (t.dataset.recordEvery !== undefined) return this.toggleRecording(t.dataset.sport, t.dataset.recordEvery, t.checked, t);
    }

    async onClick(e) {
        const b = e.target?.closest?.('button[data-act]');
        if (!b) return;
        const { act, sport, league, name } = b.dataset;
        const M = SportFollowModel;
        const index = this.state.sports.findIndex(s => s.sport === sport);
        if (act === 'sport-up' || act === 'sport-down') {
            return this.save(st => ({ ...M.copy(st), sports: M.move(st.sports, st.sports.findIndex(s => s.sport === sport), act === 'sport-up' ? -1 : 1) }));
        }
        if (act === 'league-up' || act === 'league-down') {
            return this.save(st => {
                const next = M.copy(st), s = next.sports.find(x => x.sport === sport);
                if (s) s.leagues = M.move(s.leagues, s.leagues.indexOf(league), act === 'league-up' ? -1 : 1);
                return next;
            });
        }
        if (act === 'league-remove') {
            const { state, orphans, error } = M.removeLeague(this.state, sport, league, this.namesOf);
            if (error) { this.message = error; return this.render(); }
            // #276 (C12): no question; Undo for 10 s puts the league (and any team it took with it) back.
            const alone = orphans.length ? ` ${orphans.join(', ')} ${orphans.length === 1 ? 'plays' : 'play'} in no other league you follow in ${sport}, so ${orphans.length === 1 ? 'it is' : 'they are'} unfollowed too.` : '';
            return this.removeWithUndo({ message: `Removed ${this.label(league)}.${alone}`, sport, names: orphans, leagues: [league],
                next: st => M.removeNames(M.removeLeague(st, sport, league).state, sport, orphans),
                undoFocus: `button[data-act="league-remove"][data-sport="${CSS.escape(sport)}"][data-league="${CSS.escape(league)}"]` });
        }
        if (act === 'sport-add') {
            const pick = this.root.querySelector('#sport-follow-add');
            const value = pick?.value;
            if (value) return this.save(st => M.addSport(st, value, this.catalog), `Following ${value}. Choose its leagues below.`);
            return;
        }
        if (act === 'sport-remove') {
            const entry = this.state.sports[index];
            if (!entry) return;
            return this.removeWithUndo({ message: `Stopped following ${sport}${entry.teams.length ? ` and ${entry.teams.join(', ')}` : ''}.`, sport, names: entry.teams, leagues: entry.leagues,
                next: st => ({ ...M.copy(st), sports: st.sports.filter(s => s.sport !== sport) }),
                undoFocus: `button[data-act="sport-remove"][data-sport="${CSS.escape(sport)}"]` });
        }
        if (act === 'name-add') return this.addName(sport);
        if (act === 'name-remove') {
            return this.removeWithUndo({ message: `Unfollowed ${name}.`, sport, names: [name], leagues: [], next: st => M.removeNames(st, sport, [name]),
                undoFocus: `button[data-act="name-remove"][data-sport="${CSS.escape(sport)}"][data-name="${CSS.escape(name)}"]` });
        }
        if (act === 'suggest-add') return this.save(st => M.addLeague(st, sport, league), `Added ${this.label(league)}.`);
        if (act === 'suggest-no') {
            try { await API.request('POST', '/sports/suggestions/decline', { team: name, league }); } catch (err) { this.message = UI.errorText(err, 'Not saved.'); }
            await this.loadSuggestions();
            return this.render();
        }
    }

    addName(sport) {
        const input = this.root.querySelector(`input[data-name-for="${CSS.escape(sport)}"]`);
        const value = input?.value || '';
        const entry = this.state.sports.find(s => s.sport === sport);
        const offered = SportFollowModel.offered(entry, this.namesOf);
        const known = offered.find(n => SportFollowModel.same(n, value));
        if (offered.length && !known) { this.message = `${value.trim() || 'That'} is not in the leagues you follow in ${sport}.`; return this.render(); }
        const { error } = SportFollowModel.addName(this.state, sport, known || value);
        if (error) { this.message = error; return this.render(); }
        return this.save(st => SportFollowModel.addName(st, sport, known || value).state, `Following ${known || value.trim()}.`);
    }

    /**
     * D-41 point 11, #276 (C12): unfollowing used to ask whether to keep a team's "Record every game". It asks nothing now:
     * the change happens at once, its recording rules stop with it, and Undo for 10 s puts it all back. -> the rules that
     * are on now for `names`, or `unknown` when the rules could not be read (0421: said, never taken as "none").
     */
    async activeRules(sport, names) {
        if (!names.length) return { rules: [], unknown: false };
        await this.loadRules(); // what is set now, not when the page opened
        if (!this.rulesKnown) return { rules: [], unknown: true };
        const found = names.map(name => ({ name, rule: SportFollowModel.ruleFor(this.rules, sport, name) })).filter(x => x.rule && x.rule.enabled);
        return { rules: found, unknown: false };
    }

    /** Switch rules on or off, all at once. -> { done, failed } ({ name, rule } each). A rule already gone is off. */
    async setRules(found, enabled) {
        const done = [], failed = [];
        await Promise.all(found.map(async (x) => {
            try { await API.request('PUT', `/recordings/rules/${x.rule.id}`, { enabled }); done.push(x); }
            catch (err) {
                if (!enabled && err && err.status === 404) { done.push(x); return; }
                console.error('A recording rule was not changed:', err);
                failed.push(x);
            }
        }));
        return { done, failed };
    }

    /**
     * Delete the rules found (already switched off), all requests started at once, with keepalive (a page left while
     * they are on their way does not drop them).
     * -> the names whose rule could not be deleted. A rule already gone counts as deleted.
     */
    async stopRules(found, { leaving = false } = {}) {
        const failed = [];
        await Promise.all(found.map(({ name, rule }) => API.request('DELETE', `/recordings/rules/${rule.id}`, null, { keepalive: true })
            .catch((err) => { if (!(err && err.status === 404)) { console.error('A recording rule was not deleted:', err); failed.push(name); } })));
        if (!leaving) await this.loadRules();
        return failed;
    }

    /**
     * Unfollow (a team, a league and the teams only it lists, or a sport), with Undo for 10 s.
     * 0420/0421, #276 review: a team's "Record every game" must never go on recording for a team no longer followed,
     * whatever happens in between (the page closed or reloaded, sign-out, Undo, a refused request). So its rule is
     * switched off BEFORE the list is saved, and the unfollow is refused if it cannot be; a list that fails to save
     * switches it back on. The rule (off by then) is deleted when the notice ends, or with keepalive when the page goes
     * first; a lost delete leaves it off, never on. Undo puts back only what was removed, onto the list as it is now,
     * then switches the rule back on. A team followed again within the 10 s keeps its rule, switched back on.
     */
    async removeWithUndo({ message, sport, names, leagues, next, undoFocus }) {
        const M = SportFollowModel;
        const index = this.state.sports.findIndex(s => s.sport === sport);
        const entry = this.state.sports[index];
        if (!entry) return;
        const removed = { sport, index, before: { leagues: [...entry.leagues], teams: [...entry.teams] }, leagues, names };
        const found = await this.activeRules(sport, names);
        if (found.rules.length) {
            const off = await this.setRules(found.rules, false);
            if (off.failed.length) {
                const back = await this.setRules(off.done, true);
                await this.loadRules();
                this.message = `Nothing was unfollowed: recording every ${off.failed.map(x => x.name).join(', ')} game could not be stopped.`
                    + (back.failed.length ? ` Recording every ${back.failed.map(x => x.name).join(', ')} game is now off: switch it on again below.` : '');
                this.render();
                return;
            }
        }
        await this.save(next, '');
        if (!this.lastSaveOk) {
            // Codex sign-off (high): a rule goes back on only for a team the server is CONFIRMED to follow still. The
            // save may have been kept with its answer lost: then the read-back shows the team unfollowed, and the
            // unfollow stands. If the read-back failed too, nothing is known: the rules stay off and the page says so.
            if (this.unknown) {
                const off = found.rules.map(x => x.name);
                if (off.length) this.message = `Could not confirm whether ${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} still followed, so recording every ${off.join(', ')} game is off for now. Reload this page.`;
                this.render();
                return;
            }
            const still = found.rules.filter(x => M.follows(this.state, sport, x.name));
            const back = await this.setRules(still, true);
            if (back.failed.length) this.message += ` Recording every ${back.failed.map(x => x.name).join(', ')} game is now off: switch it on again below.`;
            const landed = names.length > 0 && names.every(n => !M.follows(this.state, sport, n));
            if (!landed) {
                await this.loadRules();
                this.render();
                return;
            }
            // The unfollow was kept: go on as a saved one, for the rules of the teams no longer followed.
            this.message = '';
            found.rules = found.rules.filter(x => !still.includes(x));
        }
        await this.loadRules();
        const stops = found.rules.map(x => x.name);
        if (found.unknown) this.message = this.after('', { unknown: true, length: 0 });
        this.render();
        const root = this.root;
        UI.undoable(stops.length ? `${message} Recording every ${stops.join(', ')} game stops too.` : message, {
            undo: async () => {
                await this.save(st => M.restore(st, removed), '');
                // Back on only for a team the server confirms is followed again (a kept save whose answer was lost
                // reads back as followed); unknown: they stay off and the page says so.
                if (this.unknown) {
                    const off = found.rules.map(x => x.name);
                    if (off.length) this.message = `Could not confirm whether ${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} followed again, so recording every ${off.join(', ')} game is off for now. Reload this page.`;
                    this.render();
                    return;
                }
                const back = await this.setRules(found.rules.filter(x => M.follows(this.state, sport, x.name)), true);
                if (back.failed.length) this.message = `Following again, but recording every ${back.failed.map(x => x.name).join(', ')} game could not be switched back on: switch it on below.`;
                await this.loadRules();
                this.render();
            },
            commit: async (ctl = {}) => {
                const leaving = () => !!(ctl.leaving ?? ctl.keepalive);
                // Decide on the confirmed list: wait for a save still on its way, unless the page is going.
                ctl.hold?.();
                if (!leaving()) await Promise.race([this.queue, ctl.left || new Promise(() => {})].filter(Boolean));
                if (this.unknown) {
                    // Whether these teams are followed is not known: their rules stay off, neither deleted nor back on.
                    ctl.dispatched?.();
                    if (!leaving()) {
                        this.message = `Could not confirm whether ${stops.join(', ')} ${stops.length === 1 ? 'is' : 'are'} still followed, so recording every ${stops.join(', ')} game is off for now. Reload this page.`;
                        this.render();
                    }
                    return;
                }
                // A team followed again in the 10 s is Undo by another route: its rule is kept and switched back on.
                const again = found.rules.filter(x => M.follows(this.state, sport, x.name));
                const gone = found.rules.filter(x => !again.includes(x));
                const back = Promise.all(again.map(x => API.request('PUT', `/recordings/rules/${x.rule.id}`, { enabled: true }, { keepalive: true })
                    .then(() => null, (err) => { console.error('A recording rule was not switched back on:', err); return x.name; })));
                const stopping = this.stopRules(gone, { leaving: leaving() });
                ctl.dispatched?.();
                const failed = await stopping;
                const notOn = (await back).filter(Boolean);
                if (leaving()) return;
                if (notOn.length) {
                    UI.toast(`Following ${notOn.join(', ')} again, but recording every ${notOn.join(', ')} game could not be switched back on: switch it on in Settings › Sport.`, { kind: 'error' });
                }
                if (again.length || notOn.length) { await this.loadRules(); this.render(); }
                if (failed.length) {
                    this.message = `Recording every ${failed.join(', ')} game is off, but the rule could not be deleted: delete it in Recordings › Recording rules.`;
                    this.render();
                }
            },
            focus: {
                undo: () => root?.querySelector?.(undoFocus),
                end: () => (this.state.sports.some(s => s.sport === sport)
                    ? root?.querySelector?.(`input[data-name-for="${CSS.escape(sport)}"]`) : root?.querySelector?.('#sport-follow-add'))
            }
        });
    }

    /** What could not be done about the recording rules of something just unfollowed. */
    after(done, failed) {
        if (failed.unknown) return `${done} The recording rules could not be read, so any "Record every game" on it is still on: check Recordings › Recording rules.`.trim();
        return failed.length ? `${done} Every ${failed.join(', ')} game is still being recorded: stop it in Recordings › Recording rules.`.trim() : done;
    }

    async toggleRecording(sport, name, on, box) {
        try {
            const rule = SportFollowModel.ruleFor(this.rules, sport, name);
            // 0420 (0419 Codex round 1, medium): a rule switched off in Recordings is switched back on, keeping its settings
            if (on) {
                if (rule) this.pendingRules.delete(rule.id); // switched on again inside the Undo time: keep it
                await (rule ? API.request('PUT', `/recordings/rules/${rule.id}`, { enabled: true }) : API.request('POST', '/recordings/rules', { kind: 'team', match: name, sport }));
            } else if (rule && rule.enabled) {
                // #276 (C12): off at once on the page; the rule is deleted when the notice ends, Undo keeps it.
                this.pendingRules.add(rule.id);
                this.message = '';
                const box = () => this.root?.querySelector?.(`input[data-record-every="${CSS.escape(name)}"][data-sport="${CSS.escape(sport)}"]`);
                UI.undoable(`Stopped recording every ${name} game. Recordings already made stay.`, {
                    undo: () => { this.pendingRules.delete(rule.id); this.render(); },
                    // Sent once (UI.undoable), always with keepalive.
                    commit: async (ctl = {}) => {
                        if (!this.pendingRules.has(rule.id)) return;
                        try { await API.request('DELETE', `/recordings/rules/${rule.id}`, null, { keepalive: true }); }
                        catch (err) { this.message = UI.errorText(err, `Every ${name} game is still being recorded.`); }
                        this.pendingRules.delete(rule.id);
                        if (ctl.leaving ?? ctl.keepalive) return;
                        await this.loadRules();
                        this.render();
                    },
                    focus: { undo: box, end: box }
                });
            }
            this.message = on ? `Recording every ${name} game.` : this.message;
        } catch (err) {
            this.message = UI.errorText(err, 'Not saved.');
            if (box) box.checked = !on;
        }
        await this.loadRules();
        this.render();
    }

    label(league) {
        for (const s of this.catalog) for (const l of s.leagues) if (l.league === league) return l.label;
        return league;
    }

    render() {
        if (!this.root || this.loadFailed) return;
        const e = UI.escape, M = SportFollowModel;
        const me = this.currentUser()?.username;
        const unfollowed = this.catalog.filter(c => !this.state.sports.some(s => s.sport === c.sport));
        const suggestions = this.suggestions.map(s => `<li class="sport-follow-suggestion"><span>${e(s.label)} has <b>${e(s.team)}</b> games too
            (the first ${e(M.day(s.start))}).</span>
            <button class="btn btn-sm btn-secondary" data-act="suggest-add" data-sport="${e(s.sport)}" data-league="${e(s.league)}">Add ${e(s.label)}</button>
            <button class="btn btn-sm btn-secondary" data-act="suggest-no" data-name="${e(s.team)}" data-league="${e(s.league)}">No thanks</button></li>`).join('');
        const cards = this.state.sports.map((s, i) => {
            const entry = this.catalog.find(c => c.sport === s.sport) || { leagues: [] };
            const person = ['Tennis', 'Golf', 'Combat', 'Motorsport'].includes(s.sport);
            const leagues = s.leagues.map((l, j) => `<li class="sport-follow-row"><span>${e(this.label(l))}</span><span class="sport-follow-actions">
                <button class="btn btn-sm btn-secondary" data-act="league-up" data-sport="${e(s.sport)}" data-league="${e(l)}" ${j === 0 ? 'disabled' : ''} aria-label="Move ${e(this.label(l))} up">▲</button>
                <button class="btn btn-sm btn-secondary" data-act="league-down" data-sport="${e(s.sport)}" data-league="${e(l)}" ${j === s.leagues.length - 1 ? 'disabled' : ''} aria-label="Move ${e(this.label(l))} down">▼</button>
                <button class="btn btn-sm btn-secondary" data-act="league-remove" data-sport="${e(s.sport)}" data-league="${e(l)}" aria-label="Remove ${e(this.label(l))}">✕</button></span></li>`).join('');
            const groups = new Map();
            for (const l of entry.leagues) if (!s.leagues.includes(l.league)) {
                if (!groups.has(l.heading)) groups.set(l.heading, []);
                groups.get(l.heading).push(l);
            }
            const options = [...groups].map(([heading, ls]) => {
                const opts = ls.map(l => `<option value="${e(l.league)}">${e(l.label)}</option>`).join('');
                return heading ? `<optgroup label="${e(heading)}">${opts}</optgroup>` : opts;
            }).join('');
            const addLeague = options ? `<select class="sport-follow-select" data-add-league="${e(s.sport)}" aria-label="Add a league to ${e(s.sport)}"><option value="">Add a league…</option>${options}</select>` : '';
            const names = s.teams.map(t => {
                const rule = M.ruleFor(this.rules, s.sport, t);
                const by = rule?.createdByName && rule.createdByName !== me ? ` (set by ${e(rule.createdByName)})` : '';
                const record = person ? '' : `<label class="sport-follow-record"><input type="checkbox" data-record-every="${e(t)}" data-sport="${e(s.sport)}" ${rule?.enabled && !this.pendingRules.has(rule.id) ? 'checked' : ''}> Record every game${by}</label>`;
                return `<li class="sport-follow-row"><span>${e(t)}</span><span class="sport-follow-actions">${record}
                    <button class="btn btn-sm btn-secondary" data-act="name-remove" data-sport="${e(s.sport)}" data-name="${e(t)}" aria-label="Unfollow ${e(t)}">✕</button></span></li>`;
            }).join('');
            const offered = M.offered(s, this.namesOf);
            const listId = `sport-follow-names-${i}`;
            return `<section class="sport-follow-card">
                <div class="sport-follow-head"><h4>${e(s.sport)}</h4><span class="sport-follow-actions">
                    <button class="btn btn-sm btn-secondary" data-act="sport-up" data-sport="${e(s.sport)}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${e(s.sport)} up">▲</button>
                    <button class="btn btn-sm btn-secondary" data-act="sport-down" data-sport="${e(s.sport)}" ${i === this.state.sports.length - 1 ? 'disabled' : ''} aria-label="Move ${e(s.sport)} down">▼</button>
                    <button class="btn btn-sm btn-secondary" data-act="sport-remove" data-sport="${e(s.sport)}">Stop following</button></span></div>
                <h5>Leagues, in your order</h5><ul class="sport-follow-list">${leagues}</ul>${addLeague}
                <h5>${person ? 'Players, fighters and drivers' : 'Teams'}</h5>
                ${names ? `<ul class="sport-follow-list">${names}</ul>` : `<p class="setting-hint">None yet: they are highlighted in every league above they play in.</p>`}
                <div class="sport-follow-add"><input type="search" list="${listId}" data-name-for="${e(s.sport)}" placeholder="Search ${person ? 'names' : 'teams'}…" aria-label="Follow in ${e(s.sport)}">
                    <datalist id="${listId}">${offered.map(n => `<option value="${e(n)}">`).join('')}</datalist>
                    <button class="btn btn-sm btn-secondary" data-act="name-add" data-sport="${e(s.sport)}">Follow</button></div>
                ${offered.length ? '' : '<p class="setting-hint">The list fills in once these leagues\' fixtures have been read.</p>'}
            </section>`;
        }).join('');
        this.root.innerHTML = `<h3>Your sport</h3>
            <p class="setting-hint">For your account only, on every device you sign in on: the sports you follow, in your order, their leagues and your teams.</p>
            <fieldset class="sport-follow-body" ${this.unknown ? 'disabled' : ''}>
            <div class="setting-item"><label class="setting-toggle"><input type="checkbox" id="sport-follow-spoilers" ${this.state.spoilerFree ? 'checked' : ''}><span class="toggle-slider"></span></label>
                <div class="setting-info"><span class="setting-label">Hide scores</span><span class="setting-hint">Hide scores and results everywhere in Sport.</span></div></div>
            ${suggestions ? `<ul class="sport-follow-suggestions">${suggestions}</ul>` : ''}
            ${cards || UI.stateBlock('empty', { title: 'You follow no sport yet', detail: 'Choose one below to follow it.' })}
            ${unfollowed.length ? `<div class="sport-follow-add"><select id="sport-follow-add" class="sport-follow-select" aria-label="Add a sport">${unfollowed.map(c => `<option value="${e(c.sport)}">${e(c.sport)}</option>`).join('')}</select>
                <button class="btn btn-sm btn-primary" data-act="sport-add">Follow this sport</button></div>` : ''}
            </fieldset>
            <p class="lineup-status" role="status">${e(this.message)}</p>`;
    }
}

if (typeof module !== 'undefined') module.exports = { SportFollowModel, SportFollowSettings };
