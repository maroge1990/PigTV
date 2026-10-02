const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 0150 (contract C-I): every recognised sport programme has a kind - event, replay (of an
// identifiable game), show, placeholder - and listings of one game under different titles at
// overlapping times merge by meaning (teams, or session and grand prix). League aliases: F1 =
// Formula 1 = Formula One; AFL and AFLW stay apart. The fixture is the titles from Mark's
// preview export (25 Sept). The old code has no sportsClassify module and no kinds: it listed
// "NBA 06 :" and the NFL Replay channels as events and kept the four Practice 3 titles apart.
const load = (p) => require(path.join(__dirname, '../server', p));
const classify = load('services/sportsClassify');
const sportsEvents = load('services/sportsEvents');
const { loadExport } = require('./helpers/sportsExport');

const START = Date.parse('2026-09-26T14:30:00+10:00');
const kindOf = (title, extra = {}) => classify.classifyKind({ title, channelName: 'ESPN', start: START, ...extra }).kind;

function exportItems() {
    const x = loadExport();
    return sportsEvents.eventsFromProgrammes(x.channels, x.programmes, x.follow);
}
const aliasOf = (items, title) => items.filter(e => e.aliases.includes(title));

test('placeholders: empty PPV slots, a bare colon, stale dates, nothing but league and channel', () => {
    for (const title of [
        '- NO EVENT STREAMING - | 8K EXCLUSIVE | US: NBA PASS PPV 7',
        'NBA 06 :',
        'NBA 02: Knicks (NYK) x Timberwolves (MIN) start:2025-01-18 00:20:00 stop:2025-01-18 04:20:00',
        'NBA Summer League Lakers vs. Bulls jul 16 :NBA 03',
        'NFL Replay 1', 'NFL Replay 14', 'NFL Redzone Replay 24/7', 'NFL Replay Channel Guide',
        'Off Air', 'NRL: Coming Up', 'Stay Tuned', 'Event Ends', 'NBA 06'
    ]) assert.equal(kindOf(title), 'placeholder', title);
    assert.equal(kindOf('NBA PASS PPV 7', { channelName: 'US: NBA PASS PPV 7' }), 'placeholder', 'only the channel name');
    assert.equal(kindOf('NFL Live: Chiefs v Bills Sep 26'), 'event', 'a date within a day of the airing is fine');
    assert.equal(kindOf('NFL Live: Chiefs v Bills Sep 27'), 'event', 'time zones: a day either way');
    assert.equal(kindOf('NFL: Chiefs v Bills Sep 29'), 'placeholder');
});

test('loop detection: the same title in 3+ back-to-back identical blocks on a channel', () => {
    const H = 3600000;
    const row = (ch, title, i, len = 2 * H) => ({ channel_id: ch, title, start_time: START + i * 2 * H, end_time: START + i * 2 * H + len });
    const rows = [
        row('a', 'NBA 01: Lakers v Celtics', 0), row('a', 'NBA 01: Lakers v Celtics', 1), row('a', 'NBA 01: Lakers v Celtics', 2),
        row('b', 'NBA: Lakers v Celtics', 0), row('b', 'NBA: Lakers v Celtics', 1),
        row('c', 'NBA: Lakers v Celtics', 0), row('c', 'NBA: Lakers v Celtics', 1, H), row('c', 'NBA: Lakers v Celtics', 2)
    ];
    const looped = classify.loopedProgrammes(rows);
    assert.deepEqual(rows.map(r => looped.has(r)), [true, true, true, false, false, false, false, false],
        'three identical blocks loop; two do not; different lengths do not');
    assert.equal(kindOf('NBA 01: Lakers v Celtics', { loop: true }), 'placeholder');
});

test('replays of an identifiable game are replays; replay channels with no game are placeholders; highlights are shows', () => {
    for (const title of ['NFL Game Re-Airs - 2026: Packers vs. Jets - Week 2', 'AFL: Grand Final 2025',
        'NBA Playback - 2026 NBA All-Star Game', 'NFL Mini: Packers vs. Jets', 'Classic: Chiefs v Bills'
    ]) assert.equal(kindOf(title), 'replay', title);
    for (const title of ['NFL Throwback - Super Bowl XX', 'NFL Replay 3']) assert.equal(kindOf(title), 'placeholder', title);
    for (const title of ["Women's AFL - AFLW: Carlton v Richmond Hls", 'Spanish F1 GP Bitesize Highlights', 'F1 Academy Highlights',
        'SC - NBA Plays of the Year']) assert.equal(kindOf(title), 'show', title);
    assert.equal(kindOf('AFL Grand Final 2025', { start: Date.parse('2026-02-01T10:00:00Z') }), 'event',
        'January to March still belongs to last year\'s season');
});

test('shows, magazines and pre/post shows are shows', () => {
    for (const title of ['NFL Blitz', 'NFL Films Presents', 'NFL GameDay Final', 'NFL GameDay - Week 2', 'NFL Daily', 'NFL Pro',
        'The NFL Report', 'NFL Live', 'NFL Fantasy Live', 'NFL Total Access', 'NFL Network', 'Best of the NFL 25/26',
        'The Makeshift Project : Can NFL Players Tackle Anything?', 'AFL Tonight', 'AFL 360', 'AFL Bounce',
        'AFL Grand Final Pre-Game', 'NBA Today', 'NBA Action', 'NBA Documentaries', 'NBA Draft', 'The F1 Show: Azerbaijan',
        'F1 Explained...', "Ted's Qualifying Notebook", 'Formula 1 Qualifying Pre Show', 'Formula 1 Qualifying Post Show',
        'Formula 1 Pre Qualifying'
    ]) assert.equal(kindOf(title), 'show', title);
    assert.equal(kindOf('AFL Premiership Football'), 'event', 'a broadcast title (merged, or a show when alone: see below)');
    assert.equal(kindOf('NFL RedZone'), 'show', 'matched only a keyword, no game named');
    assert.equal(kindOf('Golf: The Open', { rule: 'category' }), 'event', 'an EPG sport category is enough');
});

test('events: match-ups (v, vs, vs., at, @, x) and sessions', () => {
    for (const title of ['NFL Football - Atlanta Falcons at Green Bay Packers', 'NFL - Week 2: Dolphins @ 49ers',
        'NFL Football - Prime Vision Alt Cast: Atlanta Falcons at Green Bay Packers', 'Live AFLW: Carlton v Richmond',
        'AFL - AFL Sydney Swans v Fremantle PF2', 'AFL - AFL Hawthorn v Brisbane Lions PF1', 'AFL Grand Final 2026',
        'Formula 1 : Azerbaijan Practice 3', 'Live Azerbaijan F1 GP: Qualifying', 'NBA: Knicks x Timberwolves'
    ]) assert.equal(kindOf(title), 'event', title);
    const p = classify.parseTitle('AFL - AFL Sydney Swans v Fremantle PF2');
    assert.deepEqual(p.teams.map(t => t.name), ['Sydney Swans', 'Fremantle']);
    assert.equal(p.session.label, 'Preliminary Final 2');
    const f1 = classify.parseTitle('Formula 1 Practice 2026: FORMULA 1 QATAR AIRWAYS AZERBAIJAN GRAND PRIX 2026 Practice 3');
    assert.equal(f1.session.id, 'practice 3');
    assert.ok(f1.location.includes('azerbaijan'));
});

test('team names match by meaning: short names, nicknames, abbreviations, either order', () => {
    const team = (title) => classify.parseTitle(`X: ${title} v Somebody`).teams[0];
    const same = (a, b) => classify.teamMatch(team(a), team(b));
    assert.ok(same('Carlton Blues', 'Carlton'));
    assert.ok(same('Brisbane Lions', 'Brisbane'));
    assert.ok(same('N Melbourne', 'North Melbourne Kangaroos'));
    assert.ok(same('FRE', 'Fremantle'));
    assert.ok(same('BRL', 'Brisbane Lions'));
    assert.ok(!same('Carlton', 'Richmond'));
    assert.ok(!same('FRE', 'Brisbane Lions'));
    const pair = (t) => classify.parseTitle(t).teams;
    assert.ok(classify.pairMatch(pair('Fremantle vs. Brisbane Lions'), pair('Grand Final: BRL x FRE')), 'order ignored');
});

test('league aliases: F1 = Formula 1 = Formula One = FIA F1; AFL and AFLW stay apart', () => {
    assert.deepEqual(['F1', 'Formula 1', 'formula one', 'FIA F1', 'AFLW', "Women's AFL", 'AFL', 'NFL', 'Chiefs'].map(classify.canonicalLeague),
        ['F1', 'F1', 'F1', 'F1', 'AFLW', 'AFLW', 'AFL', 'NFL', null]);
    assert.equal(classify.detectLeague('FIA Formula One World Championship - FIA F1: Azerbaijan GP Practice 3'), 'F1');
    assert.equal(classify.detectLeague('Formula 1 : Azerbaijan Practice 3'), 'F1');
    // 0185: plain "Premier League" is the English one; other countries' and sports' are not.
    assert.equal(classify.detectLeague('Premier League: Arsenal v Leeds United'), 'EPL');
    assert.equal(classify.detectLeague('Live: English Premier League - Chelsea v Spurs'), 'EPL');
    assert.equal(classify.detectLeague('Indian Premier League: Mumbai v Chennai'), 'IPL');
    assert.equal(classify.detectLeague('Sky Sports Premier League: Brentford v Aston Villa'), 'EPL');
    assert.equal(classify.detectLeague('Soccer - Premier League - Bournemouth v Chelsea'), 'EPL');
    // 0186: any other country's is not (Mark: "Canadian Premier League Soccer - Cavalry FC at Atlético Ottawa" came up as EPL)
    for (const other of ['Canadian Premier League Soccer - Cavalry FC at Atlético Ottawa', 'Jamaica Premier League: Arnett Gardens v Cavalier',
        'Liga Premier League de Fútbol', 'Scottish Premier League: Celtic v Rangers', 'Premier League Darts', "Women's Premier League: UP v Delhi", 'Lanka Premier League']) {
        assert.equal(classify.detectLeague(other), null, other);
    }
    assert.deepEqual(['Premier League', 'EPL', 'La Liga', 'Bundesliga', 'NBL', 'Super Rugby'].map(classify.canonicalLeague),
        ['EPL', 'EPL', 'La Liga', 'Bundesliga', 'NBL', 'Super Rugby']);
    assert.equal(classify.detectLeague("AFL Women's Premiership Football - Carlton Blues vs. Richmond Tigers"), 'AFLW');
    assert.equal(classify.detectLeague("Women's AFL - AFLW: Carlton v Richmond"), 'AFLW');
    assert.equal(classify.detectLeague('AFL - AFL Grand Final: FRE v BRL'), 'AFL');

    const follow = sportsEvents.compileFollow(['Formula 1']);
    assert.deepEqual(sportsEvents.classify({ title: 'F1: Monaco Grand Prix' }, follow), { rule: 'keyword', match: 'Formula 1', league: 'F1' });
    const afl = sportsEvents.compileFollow(['AFL']);
    assert.equal(sportsEvents.classify({ title: 'Live AFLW: Carlton v Richmond' }, afl), null, 'following AFL is not following AFLW');
    assert.equal(sportsEvents.classify({ title: 'AFL: Carlton v Richmond' }, afl).league, 'AFL');
});

// 0161: cricket had no league of its own besides BBL - "Australia v India - 1st Test" named no
// league at all (detectLeague === null), so nothing could later tell it apart from any other
// unrecognised match-up, and Mark's followed "Cricket" keyword had no canonical league to stand
// for. The old code has no 'IPL' or 'Cricket' entry in LEAGUES.
test('cricket: IPL and BBL are their own leagues; international Tests/ODIs/T20Is fall to a Cricket catch-all', () => {
    assert.deepEqual(['IPL', 'Indian Premier League', 'BBL', 'Big Bash', 'Cricket', 'The Ashes', 'Test Cricket', 'T20I']
        .map(classify.canonicalLeague), ['IPL', 'IPL', 'BBL', 'BBL', 'Cricket', 'Cricket', 'Cricket', 'Cricket']);
    assert.equal(classify.detectLeague('IPL: Mumbai Indians v Chennai Super Kings'), 'IPL');
    assert.equal(classify.detectLeague('BBL: Sydney Sixers v Melbourne Stars'), 'BBL');
    assert.equal(classify.detectLeague('The Ashes: Australia v England'), 'Cricket');
    assert.equal(classify.detectLeague('Big Bash League'), 'BBL', 'more specific than the generic Cricket catch-all');
    // a bare "test" is never a league word on its own - far too common outside cricket
    assert.equal(classify.detectLeague('Screen Test'), null);
    assert.equal(classify.detectLeague('Field Test'), null);

    // "Australia v India - 1st Test" needs no keyword at all: it is already a plain match-up
    // (parseMatchup), so it gets a league only from the EPG category ("Cricket") - exactly how a
    // sport channel's Rugby or Football title already worked before this build.
    assert.deepEqual(classify.parseTitle('Australia v India - 1st Test').teams.map(t => t.name), ['Australia', 'India']);
    const follow = sportsEvents.compileFollow(['Cricket']);
    const verdict = sportsEvents.classify({ title: 'Australia v India - 1st Test', categories: ['Cricket'] }, follow);
    assert.deepEqual(verdict, { rule: 'keyword', match: 'Cricket', league: 'Cricket' });
});

test("Mark's export: the noise is classified, not listed as events", () => {
    const items = exportItems();
    const kinds = (title) => [...new Set(aliasOf(items, title).map(e => e.kind))];
    for (const t of ['- NO EVENT STREAMING - | 8K EXCLUSIVE | US: NBA PASS PPV 7', 'NBA 06 :', 'NFL Replay 1', 'NFL Replay 14',
        'NFL Redzone Replay 24/7', 'NFL Replay Channel Guide']) assert.deepEqual(kinds(t), ['placeholder'], t);
    for (const t of ['NFL Blitz', 'AFL Tonight', 'NBA Today', 'The F1 Show: Azerbaijan', 'Formula 1 Qualifying Pre Show',
        "Women's AFL - AFLW: Carlton v Richmond Hls"]) assert.deepEqual(kinds(t), ['show'], t);
    for (const t of ['NFL Game Re-Airs - 2026: Packers vs. Jets - Week 2', 'AFL: Grand Final 2025', 'NBA Playback - 2026 NBA All-Star Game'])
        assert.deepEqual(kinds(t), ['replay'], t);
    const ppv = aliasOf(items, '- NO EVENT STREAMING - | 8K EXCLUSIVE | US: NBA PASS PPV 7');
    assert.ok(ppv.every(e => e.channels.length === 20), 'the 20 empty PPV channels, per block');
});

test("Mark's export: after merging, one event per game", () => {
    const items = exportItems();
    const events = items.filter(e => e.kind === 'event');
    const byTitle = Object.fromEntries(events.map(e => [e.title, e]));
    assert.deepEqual(events.map(e => e.title).sort(), [
        'Atlanta Falcons v Green Bay Packers',
        'Azerbaijan GP · Practice 2',
        'Azerbaijan GP · Practice 3',
        'Azerbaijan GP · Qualifying',
        'Carlton Blues v Richmond Tigers',
        'Dolphins v 49ers',
        'Fremantle v Brisbane Lions · Grand Final',
        'Melbourne Demons v North Melbourne Kangaroos',
        'Western Bulldogs v Port Adelaide Power'
    ]);
    const nfl = byTitle['Atlanta Falcons v Green Bay Packers'];
    assert.equal(nfl.channels.length, 4, 'three channels and the overlapping Prime Vision alt cast');
    assert.ok(nfl.aliases.includes('NFL Football - Prime Vision Alt Cast: Atlanta Falcons at Green Bay Packers'));
    assert.equal(nfl.league, 'NFL');

    const aflw = byTitle['Carlton Blues v Richmond Tigers'];
    assert.equal(aflw.league, 'AFLW');
    assert.deepEqual([...aflw.aliases].sort(), ["AFL Women's Premiership Football - Carlton Blues vs. Richmond Tigers",
        'Live AFLW: Carlton v Richmond', "Women's AFL - AFLW: Carlton v Richmond"]);

    const gf = byTitle['Fremantle v Brisbane Lions · Grand Final'];
    assert.equal(gf.league, 'AFL', 'AFLW at the same time stays apart');
    assert.equal(gf.channels.length, 5);
    assert.deepEqual([...gf.aliases].sort(), ['AFL - AFL Grand Final: FRE v BRL', 'AFL : AFL Grand Final', 'AFL Grand Final 2026',
        'AFL Premiership Football', 'AFL Premiership Football - Fremantle vs. Brisbane Lions']);
    assert.equal(gf.start, Date.parse('2026-09-26T14:25:00+10:00'), 'the broadcast title adds a channel, not its longer coverage');

    const p3 = byTitle['Azerbaijan GP · Practice 3'];
    assert.equal(p3.channels.length, 4);
    assert.equal(p3.league, 'F1', 'F1 and Formula 1 are one league');
    assert.ok(p3.aliases.includes('Formula 1 Practice 2026: FORMULA 1 QATAR AIRWAYS AZERBAIJAN GRAND PRIX 2026 Practice 3'));
    assert.equal(byTitle['Azerbaijan GP · Qualifying'].channels.length, 3);
    assert.ok(items.filter(e => /\bF1\b|Formula/.test(e.aliases.join())).every(e => e.league === 'F1'), 'every F1 and Formula 1 item');
    assert.ok(items.filter(e => e.aliases.some(a => /AFLW|Women's AFL|AFL Women's/.test(a))).every(e => e.league === 'AFLW'));

    const replays = items.filter(e => e.kind === 'replay').map(e => e.title).sort();
    assert.deepEqual(replays, ['AFL Grand Final 2025', 'Hawthorn v Brisbane Lions · Preliminary Final 1', 'NBA All-Star Game 2026',
        'Packers v Jets', 'Packers v Jets', 'Sydney Swans v Fremantle · Preliminary Final 2'],
    '0152: last week\'s preliminary finals at 6:30 and 9:30 am on Grand Final day are re-airs (outside AFL hours)');
});

test('the Prime Vision alt cast stays its own item when it does not overlap the game (0152: a replay of it)', () => {
    const x = loadExport();
    const alt = x.programmes.find(p => p.title.includes('Prime Vision'));
    alt.start_time += 6 * 3600000;
    alt.end_time += 6 * 3600000;
    const items = sportsEvents.eventsFromProgrammes(x.channels, x.programmes, x.follow);
    const games = items.filter(e => e.title === 'Atlanta Falcons v Green Bay Packers');
    assert.deepEqual(games.map(e => [e.kind, e.channels.length]), [['event', 3], ['replay', 1]]);
    assert.equal(games[1].kindRule, 'replay: aired first 6 h 5 min earlier (NFL Game Pass 1 UHD)', 'measured from the earliest airing');
});
