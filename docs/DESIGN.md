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
- Fixture sports open on the current round, with rounds in chronological order (last round, then this one). Standings
  sit on the right with Division, Conference and Overall views: the whole column without a followed team, below the
  team card with one.
- Channel quality labels: today the server reads UHD / HD / SD from the channel's name (FHD counts as HD). The build
  should distinguish FHD from HD and, where a channel has been played, confirm the label from the measured stream
  (resolution, frame rate, HDR), never by probing channels in the background.

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
