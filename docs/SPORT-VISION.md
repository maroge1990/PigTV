# Sport: product vision (draft, 30 Oct 2026)

Agreed with Mark on 30 Oct. Folds into `docs/PRODUCT.md` in the documentation reset; building waits for the reset's
roadmap step. Supersedes the per-sport "next 72 hours" views and the team-follow logic of `SPORTS-DASHBOARD-DESIGN.md`.

## Why

Sport is the reason PigTV is opened about 90% of the time. The TV guide already serves everything else well. A list of
"what is on and what is next" is not engaging; a page shaped like the sport (the race weekend, the round, the ladder)
is. Reference that prompted this: sportset.app (an idea to learn from, not a design to copy). We already do better on
recording, provider failover and the "Live now" dashboard; we will not copy its generic "channels about this sport"
lists, which the guide covers.

## Shape

- **Sport has two levels.** A front page, **Live now** (the existing dashboard, reassessed), and **a page per sport**
  with its own design, chosen from inside the Sport area.
- **Each sport page covers:** what is live (with live scores and one press to join the coverage), what is next, the
  last round or last session's results, standings, and the upcoming schedule. No fixed 72-hour window: the schedule
  comes from the sport's data, and a session or game is linked to a broadcast once the guide carries it (~24–48 h out).
- **Event sport (F1):** the next race weekend leads: circuit, every session (FP1–3, Sprint Qualifying, Sprint,
  Qualifying, Race) with dates and times, live indicator and join, results filling in as sessions finish, both
  championships.
- **Fixture sport (NFL, AFL, NBA, MLB, league football):** the next round with times, live scores, last round's results,
  standings, and whatever else the data makes obvious.
- **Football is one Sport entry with chosen competitions inside it.** A banner "Football"; the user picks which leagues
  and one-off tournaments (EPL, Championship, FA Cup, UEFA, a World Cup) appear within it. To be mocked up, including
  how a tournament differs from a league and how it stays uncluttered.
- **Following a team or driver** replaces the current team logic: following a team gives the whole sport page, with that
  team highlighted (and its next game surfaced on Live now).
- **Spoiler-free is one global switch in Settings,** covering every page: scores, results, standings, finishing orders,
  championship points and form.
- **Live scores are essential.** The pages degrade honestly when the data feed is missing; Live now, the guide and
  playback never depend on it.
- **Reminders (the bell):** a reminder on a future session or game. When it starts, a banner appears on whatever screen
  is up, with Watch to switch to it. Recording is a separate action.
- **Recording from sport pages:** record a session or game, and rules such as "every race session" or "every game for
  team X".
- **Built from shared parts:** a few page templates (race weekend, rounds, knockout competition, cricket) plus
  sport-specific modules, so each page feels bespoke without ten hand-built screens per platform.

## Scope and order

- **Apple TV first,** then iPad/iPhone. The web app may lag; its version stays on the roadmap as a future feature.
- **History:** the last round and last session only.
- **First mock-ups:** F1 (event), AFL or NFL (fixtures), Cricket (hardest), and Live now reassessed; then Football's
  competition picker.
- **Parked:** scores, tables or timing over the picture while watching (with the planned rework of the player overlay).
- **First step:** a data survey of the free ESPN feeds for every followed sport (AFL, F1, EPL, Cricket, MLB, NFL, FA Cup,
  UEFA, Championship, NBA, plus a World Cup-style tournament) to decide what each page can honestly show.
