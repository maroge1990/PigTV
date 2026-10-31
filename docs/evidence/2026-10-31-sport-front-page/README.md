# The Sport front page: server 0381 (C-R) and Apple 89

31 Oct 2026. Decision D-39 (Blend 1 on the "PigTV Sport mock-ups" canvas); the brief and its addenda are on #21.

## Server 0381

- `GET /api/sports/front` arranged from the dashboard projection for the household's followed sports and teams; the
  hero rule, rails and follows are in `server/services/sportFront.js`; the following store in `sportPagePrefs.js`.
- T1: `test/sport-front.test.js` (7 tests, each failing on 0380), the prefs and fixtures tests extended; `npm test`
  1527 of 1531 locally (the 4 are the known Ubuntu HE-AAC encoder gap; CI has the real encoder); `verify-build` green.
- #29: the collector now runs by default; `test/sports-worker.test.js`'s parse-cost budgets ran green inside this
  suite (perf not skipped locally). A production measurement follows the first deploy (Status › worker time).
- Fixture for the client: `test/fixtures/sport-front-0381.json` (the busy case: a followed team live, a live NBA game,
  a scheduled F1 session, a finished game from today, a guide-only cricket listing).
- Codex round 1: see below.

## Codex round 1 (0381)

Verdict needs-attention; both fixed on the spot in 0382 (D-38: no issues filed for findings fixed inside the batch).

| Finding | Severity | Disposition |
|---|---|---|
| The front inherited the dashboard's "today" scope, so a followed team's game tomorrow produced no next card, no follow-next hero and a quiet tile | high | 0382: `upcomingHours` option (the front passes 72); test: tomorrow's followed game reaches `/front` and still not the legacy `/dashboard` |
| The live-follow tie-break used start time; D-39 says closest to finishing (a Test match beat an NFL game ending in ten minutes) | medium | 0382: `finishEstimate` (the card's `end`, else start + a typical duration per sport); test: the NFL game wins |

## Server 0383–0384: the Cricket page's answer (C-S) and the play origin

- `GET /api/sports/pages/cricket` (`server/services/sportPageCricket.js`): the followed team's match with innings, days,
  crease and the day's channels; the tour with results; the other competitions today and tomorrow. Fixtures are live
  ESPN captures of 31 Oct 01:56 UTC (`test/fixtures/sport-page-cricket/`, trimmed to under 60 kB each, nothing edited).
- What the feed cannot give, sent as null: the batters at the crease outside internationals (no batting card), the
  session number (counted from the day's interval notes while live), a day's exact start after day 1 (assumed day 1's).
- 0384: the play-start event's `origin` ("sport-front", "tv", "guide") on the log line and the Status page's events,
  for the TV-tab decision in D-39.
- T1: `test/sport-page-cricket.test.js` (6, the module and the flag did not exist on 0382) and the origin test in
  `test/client-events.test.js`; Codex round 1 below.

## Codex round 1 (0383–0384)

Verdict needs-attention, two mediums, no high (so no second round, D-38); both fixed inside the batch.

| Finding | Severity | Disposition |
|---|---|---|
| A finished followed-team match stayed the lead while other matches were live | medium | fixed on top of 0384: unfinished followed matches first, then the global live/next fallback; regression test with the panel's match 1525661 marked completed |
| C-S's spoiler list left out `others[].line` (the feed's summary carries the situation) and the lead's `innings` | medium | contract corrected (C-S › Spoilers) |
