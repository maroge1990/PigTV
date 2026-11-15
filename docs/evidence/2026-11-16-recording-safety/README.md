# Recording safety batch, 16 Nov 2026 (server 0766 to 0772)

**Issues:** #329 (one game, one active schedule), #314 (waiting reason), #318 (recordings on the share read by a child
process).

**T1:** `PIGTV_SKIP_PERF=1 npm test` on the integrated tree: 2751 pass, 4 fail (the known WSL-only AAC failures);
`verify-build.sh` passed. Every new test failed on the old code.

**T3 (rig, staging on 0772, fake provider, API only):** a schedule with a `gameId` on channel A, then the same `gameId`
on channel B: the second answers the first row (same id) with `alreadyScheduled: true`; `POST
/api/recordings/scheduled/:id/move` to B keeps the id and points at B; cancel 200. Not run: a recording played from a
hanging share (the rig cannot hang its share mid-run; T1's share-hang trap covers it) and the web screens in a browser.

**Codex (full rule):**
- Round 1: three highs (the web's move cancelled a live capture before the new one was secured; a rule's
  `alreadyScheduled` hit let it re-time another rule's schedule; no bound on share readers) and one medium (the move
  ignored the replacement's reply). Fixed in 0769 (an atomic server-side move, refused once recording), 0770 (a rule
  reconciles only its own rows) and 0771 (at most 8 readers, 503 at the cap).
- Sign-off of those: one high (a start under way survived a move to a reassigned playlist position); Mark chose to fix it
  first: 0772 compares the channel's stable id. Sign-off: approve.
