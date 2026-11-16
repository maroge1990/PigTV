# Events page score delay, 16 Nov 2026 (server 0780 to 0783)

**Issue:** #328. **Mark's choice:** keep a short history of the Events page's own reads and show a delayed account the
newest read at least its delay old (tennis sets and winners, golf positions and scores to par, UFC results), with or
without a collector snapshot; status too; before any read is old enough, every match and bout shows as scheduled.
No-delay accounts are unchanged. History: at most 16 reads per event, nothing older than the longest delay (300 s).

**T1:** `PIGTV_SKIP_PERF=1 npm test`: 2779 pass, 4 fail (the known WSL-only AAC failures); `verify-build.sh` passed.
New replay tests in `test/sport-pages-agree.test.js` (90 s and 0 s accounts, cold history, bounds), each failing on the
code before its commit.

**T3:** not run: the rig's fake scores script one football game only (no tennis, golf or UFC feed).

**Codex (sport rule, highs only):** round 1: one high (a cold history still showed a finished bout's status), fixed in
0783. Sign-off: approve. The lead added 0781 and 0782 before review (a missing collector snapshot must not bypass the
delay, for detail or status).
