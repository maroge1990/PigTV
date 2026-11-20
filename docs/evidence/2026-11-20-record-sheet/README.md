# Record sheet and Record safety, 20 Nov 2026 (#358, #357, #351)

Builds: server 0879–0884, Apple 359–370. Decisions D-75 (TestFlight via Xcode Cloud), D-76 (Record sheet, Usual = ESPN's end).

Codex rounds (full text in `/home/markr/wt/codex-*.txt`, not in the repo):

| Batch | Round | Findings | Fixed in |
|---|---|---|---|
| Web #357 (0879–0880) | review | 1 medium (cached Sport answer keeps Cancelling…) | tracked on #357 |
| Apple #357 (359–360) | review | 4 mediums | 361–364 |
| Apple #357 | sign-off | 1 high (Record after sign-out) | 365; check: approve |
| Web #358 (0881–0882) | review | 1 high (stale scores cut a game at the guide end), 2 mediums | 0883; mediums on #358 |
| Server 0883 | sign-off | 1 high (start-up used built-in padding) | 0884; check: approve |
| Apple #358 (366) | review | 2 highs (Done overwrote padding; hard-coded defaults), 1 medium (row copy) | 367–369 |
| Apple 368 | sign-off | 1 high (session-cached Settings) | 370; check: approve |

T3: web screenshots from the real window with faked API answers; Apple TV, iPad and iPhone simulator screenshots (both
kept in the session scratchpad). Full server suite: 2988 pass, 4 known WSL ffmpeg failures. Apple unit tests: iPhone 888,
Apple TV 890. Xcode Cloud release `tf/365-2` green; TestFlight build 322 = Apple 365.
