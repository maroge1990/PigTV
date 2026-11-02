# PigTV design

How PigTV should look and feel on each platform. The brand itself (artwork, tokens, the kit's tools) lives in
**Pig-Branding** (`../Pig-Branding`); this page holds what PigTV takes from it and the UX rules that are PigTV's own.
Implementation detail stays with the code: the Apple client's `docs/ARCHITECTURE.md` › Branding implementation, the web
app's `public/css/`.

## Principles

- **Picture quality and stability come first**, then less overhead and complexity; stability outranks channel-change
  speed (decision D-1).
- **Sport first.** Sport is why the app is opened about 90% of the time ([`PRODUCT.md`](PRODUCT.md) › Sport).
- **One player on the TV**, PigTV's own, driven by the remote; iPad and iPhone get PigTV's own large touch controls
  (D-4, D-6).
- **Honest states.** A screen says when data is missing, delayed, unavailable or ended, and never tunes a channel that
  may now show something else (a finished game is not selectable).
- **No surprise takeovers.** Taking another device's stream is always an explicit choice; browsing and focus never take a
  provider connection.
- The web app is admin plus light viewing (D-4): complete and safe for administration, simple for watching.

## Apple TV and iOS patterns

- **Design rules:** page background `PigPageBackground` (tab roots use `.pigPageBackdrop()`, build 32) (set explicitly on every page — Guide, Recordings and Settings gained it in build 28; without it tvOS shows its blurred grey system backdrop in dark mode); surfaces `Color.guideCell` + `PigSurfaceButtonStyle` (pink accent outline on focus); selection chips `GuideFilterStyle` (now internal, in `TVActionStyle.swift`); tvOS type scale in `GuideTypography` (guide) and `DetailType` (detail pages); player overlays force dark scheme and provide an opaque fallback for Reduce Transparency. **Pink is `Color.pigAccent`** (the asset colour), never `Color.accentColor`: on tvOS `accentColor` resolved to white outside a NavigationStack, which is why the unreachable screen's Try again was a blank white capsule (fixed in build 28). `PigPrimaryButtonStyle` is 26 pt semibold on tvOS (was `.headline`, 38 pt, which dwarfed the capsules beside it). New screens reuse these rather than defining new styles.

- tvOS: prefer an in-page choice (`confirmationDialog`, or the page switching its own state) over another full-screen
  cover layer; stacked covers can strand focus (W6, the client's `docs/ARCHITECTURE.md` › Known limitations).
- tvOS text is read from ten feet: check sizes on the TV, not only in the simulator (#116).

## Web patterns

- Every viewing action is a real button or link with keyboard semantics (the 15 Oct review's F4); native browser buttons
  and dialogs keep focus.
- A setting saves only its own key and says "Saved" or shows the server's error (#9 is the open defect).
- Destructive bulk actions confirm and can be undone (#16).

## Brand

### PigTV brand standard (Pig family 1.6.0)

The source of truth is the Pig-Branding kit, version 1.6.0 (`Pig-Branding/docs/pig-family-brand-guide.md`, `docs/integration.md`, `tokens/brand-tokens.json`). This note only records what PigTV takes from it and where. When the kit changes, re-copy the files below rather than editing them here.

#### What PigTV vendors

| PigTV path | From the kit |
| --- | --- |
| `docs/brand-tokens.json` | `tokens/brand-tokens.json` (1.6.0), copied verbatim. |
| `public/css/pig-radiance.css`, `public/css/pig-glass.css` | `tokens/pig-radiance.css`, `tokens/pig-glass.css`, copied verbatim. Do not edit them. |
| `public/img/brand/` | `assets/products/pigtv/`: `mark.svg`, `wordmark-{light,dark}.svg`, `lockup-{horizontal,stacked}-{light,dark}.svg`, and from `icons/`: `favicon-{light,dark}.ico`, `web-small-{light,dark}.svg`, `web-{light,dark}-{180,192,512}.png`. |
| `public/site.webmanifest` | Based on `web-manifest.example.json`, with real URLs (`start_url` and `scope` are `/`). |

`*-light` files are for light backgrounds (dark text), `*-dark` files for dark backgrounds. The palette is the same as 1.0 and lives in `public/css/main.css` as `--color-*` tokens (dark in `:root`, light in `[data-theme="light"]`). `public/js/theme.js` always writes the resolved `data-theme` on `<html>`. A small alias block in `main.css` defines every `--pig-*` role the vendored CSS reads as `var(--color-...)`, so it follows the theme.

#### Identity

PigTV uses its own product pig (a pig-shaped TV screen), never the generic family pig. The navbar shows the horizontal lockup (`.brand-lockup`, 120 px wide, theme-switched by `[data-theme]`), the sign-in page the stacked lockup (`.login-lockup`), the loading splash the mark. Use the supplied SVGs at their intrinsic proportions and do not reassemble a pig and wordmark by hand. The accessible name "PigTV" appears once per lockup (`role="img"` and `aria-label`).

#### Classes in use

| Class | Where |
| --- | --- |
| `pig-canvas-bloom` | `<body>` of `index.html` and `login.html`: the corner bloom on the canvas. `#app`, `.main-content` and pages stay transparent so it shows in gaps; cards and bars are opaque above it. The live player area is an opaque media surface. |
| `pig-splash` | The initial Home loading state in `index.html` (`.page-splash`): mark centred, text below, `--pig-r` about 1.35 times the visible pig. HomePage replaces it when it renders. |
| `pig-glass` | The navbar only (the floating control layer). |
| `pig-amount` | Figures only: channel numbers, EPG times, recording times and sizes, Status page durations, times, sizes and counts, backup link counts, the player quality badge. Wrap the figure in a span when it sits in words. |

#### Rules

- Glass is for the floating control layer only. Never on cards, lists or content, and never on the player. Playback keeps its protected dark surfaces (`.watch-*`, captions and overflow menus). The mobile dropdown stays on the more opaque `--glass-bg`, because it is nested inside the glass navbar and cannot blur the page behind it.
- Radiance is never behind forms or reading content. The sign-in halo sits only behind the pig of the lockup. With `prefers-reduced-transparency` the halo and bloom are removed and glass becomes a solid surface.
- Only one primary action per screen is full-strength accent (`.btn-primary`).
- Playback surfaces, channel artwork and programme artwork keep their own colours.

## Sport pages

From the F1 mock-up review (30 Oct), for the sport rebuild (#21):

- Stat values (lap length, lap record) never wrap onto a second line.
- Lists that sit side by side are symmetric: ten results beside the top ten drivers and the top ten constructors.
- Spacing and alignment are checked on the real screens at build time; the mock-ups are not pixel-final. Save
  vertical space: paired actions (e.g. "Watch at kick-off" and "Record every Packers game") sit on one line.
- No redundant labels: the current week or session is evident from its content ("Week 8", not "Week 8 · this week").
- No section tabs on a sport page (Mark, 30 Oct): the championship already sits on the main page, so F1 has no
  Race weekend / Championship / Calendar tabs, and no season calendar either: the next race weekend is enough. The
  mock-ups' spacing and overlaps are fixed at build time, on the real screens.
- Fixture sports open on the current round, with rounds in chronological order (last round, then this one). Standings
  sit on the right with Division, Conference and Overall views: the whole column without a followed team, below the
  team card with one.
- Approved by Mark on 31 Oct (canvas "PigTV Sport mock-ups"): **Cricket · Apple TV** (the followed team's match leads:
  day and session, both innings, the lead, who is batting, the five days, Watch / Channels / Record; the whole tour on the
  right; other competitions today and next below), **Formula 1 · iPhone** (one scrolling column; whether it should be
  split into pages is open, #177) and **· iPad** (the Apple TV layout in landscape, one column in portrait), and **Web ·
  channel changes** (held smaller lists, New on the provider, Show all / Hide all with a confirm and Undo).
- **Sport front page, approved 31 Oct (D-39, canvas "Blend 1"):** the app's tabs stay on screen; followed sports as
  tiles at the top; a hero band (hero left, the followed teams and drivers as a flip list right, compact rows beyond
  three); a rail per followed sport below, live cards first. Team badges beside every score; the monogram disc only as
  a fallback. Spoiler-free keeps neutral progress (Q4, 2nd session) and hides scores, situations and results; without
  the scores feed the page says so once and shows the guide's channels and start times. Never invent a clock, a leader
  or 0–0. Since 1 Nov the tiles are gone and the hero band is the banner below (D-43).
- Channel quality labels: today the server reads UHD / HD / SD from the channel's name (FHD counts as HD). The build
  should distinguish FHD from HD and, where a channel has been played, confirm the label from the measured stream
  (resolution, frame rate, HDR), never by probing channels in the background.

### Apple TV sport pages, chosen 1 Nov (D-43)

Mark chose these from the canvas "PigTV Sport mock-ups" (rounds 1–3, 1 Nov). They supersede the page layouts above
where they differ. They are built and checked on the Apple TV first; the iPad and iPhone mock-ups (D-42 point 6) follow
  that device check, and the web is parked.

- **One banner on every page.** The front page and every sport page open with the same banner, 250 pt high, under the
  app's tabs: the hero on the left (kicker, title, one line, Watch / Record or Remind me, over the faded badge or the
  circuit map) and a list on the right inside the same banner, split by a thin line. The front page lists your follows;
  a sport page lists that sport's leagues. Selecting an item flips the hero (front page) or the league (sport page).
- **The hero:** a follow live, else the sport's league live, else your next game (C-R's order), on a sport page within
  that sport. With nothing live or next for you it shows the league's next game with Remind me, never an empty banner.
- **The list:** four items, then a "5 more · …" line; moving down scrolls the list inside the banner, which never grows.
  Items are in your order of sports and leagues, and anything playing now moves to the top until it ends (D-41 point
  10). This replaces the front page's "live first, then soonest".
- **One league:** when a sport has one league (NFL, UFC) or you picked only one (Motorsport with only F1), the banner
  runs full width with no list and no line, and the badge or map moves to the right.
- **Front page:** no sport tiles. Each rail's header ("Football ›") opens its sport page; sports with nothing in the
  next 72 hours, and so no rail, sit as small buttons on the last line ("Also in your sports"). A follow in the banner
  opens its sport too.
- **Your team or player:** a pink tint and a star on rows, a pink outline on cards, on every page.
- **Under the banner, per sport:**
  - *Motorsport:* the sessions as five tiles plus a circuit-stats tile, then the starting grid (or last race), drivers
    and constructors side by side, ten each. IndyCar and NASCAR, whose feed has the race only: the entry list
    (alphabetical, not a running order), the last winner, the next race, and no standings.
  - *Fixture leagues* (NFL, AFL, EPL, NBA …): the round as a three-column grid with the last and current round to switch
    between; standings on the right (Division / Conference / Overall where the league has them, else one table).
  - *Cricket:* the lead match's scoreboard (innings by column, the lead, who is batting, the five days) beside the whole
    tour; other leagues' matches today below.
  - *Tennis:* rails: Your players (only when someone you follow plays this week), Live now, Tonight, Results today, then
    the draws.
  - *Golf:* the leaderboard (top 11, rounds 1–3) on the left; on the right your players' cards (position, to par, rounds
    1–3, the gap to the lead) with Also this week below them as slim rows. With no followed player in the event, the right
    column holds Also this week only. No rounds column.
  - *UFC:* the main card and the prelims as two lists, each finished bout with its winner, round and clock. The two are
    told apart by the bouts' start times.
- **What the feeds do not give, so the pages never show:** a NASCAR or IndyCar running order, practice or standings; a
  UFC method or record; golf tee times or the hole a player is on; a tennis point score or server. Tennis set scores and
  golf round strokes come from ESPN's linescores, to confirm on a live event before the build relies on them.

### Apple TV app screens, chosen 2 Nov (D-44)

From the canvas "PigTV Apple TV app mock-ups" (rounds 1–2). Every screen keeps the Sport pages' palette, type and white
focus; only the Sport pages and the long-press menu on a Sport card use the banner.

- **Tabs:** Sport · TV Guide · Recordings · Settings, opening on Sport; the TV tab is gone (#216).
- **One long-press menu** everywhere: a card beside the focused item, Record first (this one; every episode or every
  game; More options…), then Watch from start, details, Channel schedule, favourites. More options… opens the
  **record page**, a centred sheet: What · When it stops (ESPN for sport, else the guide plus Start early / Finish
  late) · Record on (only when several channels carry it).
- **TV Guide:** the full grid, a slim focus strip above it, chips and Now / Earlier / Later / Search / Jump to.
  Programme details (hero card) and the channel page (hero, favourite, Up next, then the days) are pages. Search and
  Jump to share one page, side by side.
- **Recordings:** no library. A featured recording across the top, the rest as large cards, Coming up as a slim strip
  at the bottom whose "All ›" opens Scheduled (coming up with clash choices, rules, needs attention; two columns).
  View recording is full-screen art with an info bar, team logos for sport.
- **Destructive actions** happen at once with a 10-second Undo; only Sign out confirms, inside its row.
- **Settings:** a menu beside the page; Sport holds Hide scores, Score delay and your sports. Sign in: server, then two
  big tiles (Pair with browser, Username and password). Offline: the pig in a retry ring.
- **iPad and iPhone:** the iPad is the Apple TV layout at touch size (top tabs, pink outline for the selection, split
  view in Settings). The iPhone is one column with bottom tabs; Recordings is a swipeable card stack with Coming up in a
  pull-up sheet; the guide lists what is on now when upright and becomes the scrollable grid when turned sideways.
  The tabs are the system TabView on both (Liquid Glass on iOS 26); never replace them with a custom bar.
- **Brand (D-44 point 14):** the Sport pages follow the same rules as everything else: brand tokens, the corner bloom,
  the pink focus ring on Apple TV (the white focus fill in the D-43 mock-ups is not built), one rose primary action per
  screen, the PigTV mark on tab pages, rounded tabular figures, no ticks for app-owned state.

## Sport: Live now cards

Use the selected sport-shelf layout (live, upcoming, recently finished); retain the match grid for comparison. The inline mockup uses invented
match situations and monogram badges, not current results. Its league chips exercise each card type; future schedules,
real logos, actual playback, recording, sync and authoritative score delay are not implemented in the mockup. The
updated league views include illustrative future cards across the next ~72 hours. A focused revised F1 preview
shows a session-only card: GP, session, circuit/location, scheduled start and channels; no positions or live timing.

Default ordering: live first, upcoming by start, recently finished last. Within live, keep order stable across score
updates; do not sort by who is winning. Keep focused cards stationary; defer removal/reflow of a focused finished card
until focus moves. For long lists use lazy shelves/grids. No automatic audio/video preview.

Use one configured dashboard timezone (proposed: server setting, Australia/Melbourne), with the zone visible, so devices
agree on today's slate. Query the actual local-midnight interval including DST, not a fixed 24-hour offset or ESPN's
unqualified default day. Include a game still live across midnight even if it began yesterday. Multi-day cricket uses
its current day's playing session: stumps/overnight is a break, not a completed match. Include today's remaining
sessions of a longer event rather than only events whose overall start is today.

| Card type | Applies to current follows | Visible situation | Hidden with Avoid spoilers |
|---|---|---|---|
| Australian football | AFL | Teams, quarter, clock, total points plus goals.behinds | All score fields, winner emphasis |
| Basketball | NBA | Teams, quarter/overtime, clock, points | Points and score-derived markers |
| Football | EPL, FA Cup, UEFA, Championship | Teams, half, elapsed time incl. stoppage/extra time, goals | Goals, aggregate/penalties, winner emphasis; no goal/red-card ticker |
| American football | NFL | Teams, quarter/overtime, clock, points, possession/down-distance/field position | Points and possession/down-distance/field position to avoid play-result leaks |
| Baseball | MLB | Teams, top/bottom inning, runs, outs, count, occupied bases | Runs, outs, count and bases; retain inning/half as game progress |
| Cricket | Cricket | Teams, format/day/session, runs/wickets, innings, overs, target/lead when available | Runs, wickets, targets, lead, required rate and outcome text; retain neutral innings/overs/day/session |
| Motorsport | F1 | GP, session, circuit/location, scheduled start, broadcast availability and channels | No results/timing/positions are included in this card, so its content is unchanged |

Data absence is normal: never invent a ticking clock, leader, possession, base state, overs or a 0–0 score.
F1 uses one card per practice, qualifying, sprint qualifying, sprint or race session. No Q1/Q2/Q3 countdown, live lap,
leader, position, gap, fastest lap, winner or result is required for the initial build (Mark, 29 Oct). Use an on-now
broadcast label only when a current match exists; retain scheduled start wording rather than inferring actual start.
Cricket needs Test, ODI/T20, innings break, stumps, rain delay and completed variants. Football needs penalties/aggregate
and postponed fixtures; MLB needs extra innings/suspended games; NFL/NBA/AFL need overtime/breaks as applicable.
The initial mockup samples the families and some edge states; remaining edge variants require acceptance before the dashboard is enabled for normal use.

Proposed availability markers reuse existing visual vocabulary but need explicit labels:
- No dot: a confident currently usable broadcast match exists. The label still names the preferred channel.
- Yellow dot + "No channel found": no confident match, or ambiguous candidate set. Details remain accessible;
  watch/record are disabled until a real match exists. Never silently pick a generic sports slot.
- Red dot + "Channel unavailable": a known match is blocked/unavailable according to existing channel state.
- Recording retains its existing red recording indicator **with a recording label/icon**. Color alone cannot distinguish
  recording from an unavailable feed. Do not probe/tune channels just to populate these markers.

On iPhone/iPad: touch-and-hold plus a visible more-options action; web: a visible options action and keyboard access.
Apple TV: remote select/long press, native focus, readable team names and distinct focused card styling. Screen readers
must receive the same spoiler-safe fields as sighted users. Real graphics should use cached source team/league or driver/
constructor assets with name/initial fallback; validate availability, attribution and permitted use before shipping.

**Mark's 29 Oct decisions**

Mark's preview feedback: cards within a sport always have the same size, and a labelled sport shelf makes repeated
sport names on each card unnecessary. Apple 59 reserves a scaled card size through live/upcoming/break/unknown/final,
missing channel, hidden score and expired-focus states; cards show the status alone. Details retain league context.
Long team names have two lines beside square cached-logo/name-fallback tiles. Availability uses yellow/red icons in the card’s top corner, with explicit VoiceOver labels and words in details. Offline fixtures/screenshots and test evidence are in the
[continuation handoff](evidence/2026-10-29-sports-0316-continuation/README.md); device acceptance remains open.

Mark's next preview iteration shortens the equal-size cards, removes “Total points,” shows current game progress OR
scheduled start (one timing row), and moves unavailable/no-channel markers to icons in the top corner. VoiceOver and
event details retain explicit meanings; recording keeps its distinct labelled indicator.

**Compact-card feedback (Mark, 29 Oct)**

The next preview iteration reduces the reserved size, removes “Total points,” shows current game progress OR scheduled
start, and uses top-corner yellow/red availability icons. Their VoiceOver meanings remain explicit; details still name
the reason. [Before](evidence/2026-10-29-sports-0316-continuation/apple-compact-before.json) fails the redundant-label/timing regression; [all three focused UI checks
pass after](evidence/2026-10-29-sports-0316-continuation/apple-compact-focused-after.json). The linked light/dark screenshots above show the compact layout.
An obsolete full UI run was intentionally interrupted when this feedback arrived; it is not a failed assertion or a
final gate. Later full UI/contract/unit/iOS runs pass before the final recording-integration follow-ups, which remain
under validation. No device acceptance is inferred.
