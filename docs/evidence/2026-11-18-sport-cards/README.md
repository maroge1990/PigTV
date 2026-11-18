# Sport cards, finished-game scores, look fixes and splash (18 Nov 2026)

Server 0820–0834, Apple 292–319. Issues: #343 (finished scores), #345 (card select and hold, D-68), #344 (no pink
selection line), #341 (helper text), #339 (tvOS header), #340 (flat record page), #342 (splash, D-69).

## Tests

- Server: `npm test` 2885 pass, 4 fail (the known WSL AAC/ffmpeg tests); `verify-build.sh` passed.
- Apple: tvOS push tier (contract checks, unit tests, regression UI tests) passed; iPad unit tests passed; iPhone unit
  tests pass except `SportHeroStripTests.testTheStripNeverClaimsMoreWidthThanItIsGiven`, which fails on main too (#346).
  Contract checks (321) pass against the batch's goldens (a recordings row carries a string `gameId`).
- T3: simulator screenshots of the hold menus (live and upcoming) on Apple TV, iPad and iPhone, the record page before
  and after, Settings selection, the tvOS Sport top row at rest and focused, and splash stills on Apple TV and iPhone
  (one pig throughout, landing on the Home header). Web: phone and desktop sport menus, Settings, record options.
  Not kept in the repo.

## Reviews

Codex was out in the morning, so Opus stood in (Mark's call), then Codex reviewed both batches when it returned.

Fixed (each with a test that fails before):
- Server/web: recording order (whole, then still recording from its start, then partial) in C-R and the web; stale
  card-press lookups cancelled by a newer press, route change, leaving Sport or Watch another channel; the game id kept
  on the recording itself (column, backfill, copied on dismiss) so dismissing a failed schedule keeps the link; a
  scoreless final no longer erases a known final score, including across pruning; a still-recording finished game plays
  from its start with no Go to live.
- Apple: Settings summary build error; a finished game opens its recording from the start with no Go to live, no
  Resume question and no saved-position request; live means any channel on air (cards, hero, iPhone, player list);
  cricket and F1 cards follow the card rules; a finished F1 session never tunes a channel still airing; a live overrun
  keeps Watch; fixture presses keep the game id; recordings are chosen only from a fresh answer and never across a
  session change; Home takes no input, focus or VoiceOver until the splash has gone; the hold menu records on real
  airing times.

Left as issues (mediums, sport-batch rule): durable game id for fixture, F1 and cricket cards (#347); a score-delay
pruning edge case (#343); a press during a slow scheduled-list refresh, and Watch another channel during an untimed F1
overrun (#345).
