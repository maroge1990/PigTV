# Programme search and richer guide programmes (17 Nov 2026)

Server/web 0810–0814 (#57, #56; design D-66: today's side-by-side search, reached from every page). Apple follows.

## What was checked

- **T1:** full suite (only the 4 known WSL-only AAC failures); `verify-build.sh` clean. New tests fail on the code
  before their change: guide programme fields, search (escaping, ordering, groups, auth, 400, rebuild at the EPG swap,
  450 hidden matches before a visible one, one statement per search), web search.
- **T3 (web):** headless browser against the fake provider at 1400, 800, 600 and 390 px: empty state with recent
  searches, results, nothing found, the Record menu; no console errors. Follow not checked (no rosters in the fake
  provider).

## Codex

- Round 1, medium: programme matches on hidden channels could use up the candidate allowance and hide a visible match
  (0813). Sign-off, medium: the paging repeated the full scan (0814, one pass); approved.

## Not checked

T5 on devices; search speed on the production guide.
