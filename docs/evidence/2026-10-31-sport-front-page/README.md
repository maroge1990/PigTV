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
