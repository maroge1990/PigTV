# 0309: sports dashboard server foundation

Local server slice of the approved design. No push/deployment, provider connection, playback-engine change or Apple
client edit. Off unless `PIGTV_SPORTS_DASHBOARD=1`. This does not install the mockup as the Apple/web interface.

Implemented: separate scoreboard normalization for the ten followed leagues, F1 session-only metadata, cricket
innings/break interpretation, persisted catalog/history, coherent delayed snapshots, per-user preferences with revision
conflicts, conservative event/channel joins, opt-in collection/start/stop and additive authenticated APIs. C-O documents
client-visible fields and limitations. Current `/sports/events`, playback and recording paths are unchanged.

Validation:
- 25 focused core tests plus 3 API tests; real public-response samples and deterministic clocks, no live upstream calls.
- Login and a real paired-device bearer share one preference; a second user does not. Unknown owner fields are rejected.
- [New feature before](feature-before.txt): pre-implementation module load fails because the feature is absent.
- [Old router before](api-router-before.txt): restoring `a6e86e1`'s sports router in an isolated temporary copy makes
  both the new preference and dashboard behavior tests fail with 404 instead of 200; the default-disabled case passes.
- [Draft regressions before](draft-regressions-before.txt): cached payloads incorrectly received a fresh observation and
  scheduled labels became unknown between catalog polls. Both now have passing behavioral regressions.
- Other regressions cover previous UTC day collection, source failure/backoff, in-flight cancellation, last-known final
  retention, exact F1 session/GP, cricket format, city-only aliases, upcoming channel choices and delayed completion.
- [Partial status before](partial-status-before.txt): an unknown status could replace completion. The store now retains
  known state and lets its freshness expire. The added test passes.
- [Unit after](unit-after.txt), [full suite](full-suite-summary.txt): **1,273/1,273 pass**, no skipped tests.
- [Build verification](README.md#files-kept-outside-the-repository): all checks pass. No new static-only checks were needed.

## Review status and next work

Required adversarial review has **not run**. AGENTS.md requires Mark to type the slash command. Run in the server repo:

```
/codex:adversarial-review --background --base a6e86e1 Review the 0309 opt-in sports dashboard server foundation: per-user preference authorization and revision conflicts, spoiler-safe projection and cache separation, coherent score/status delay and final retention, malformed/out-of-order feed handling, prior-day and future cricket discovery, conservative game-to-broadcast matching, collector request/body/history bounds, cancellation and startup/shutdown isolation. Check C-O against code. Existing playback, recording and /sports/events behavior must remain unchanged.
```

Round count: 0 of 2. No external findings exist yet; own implementation checks/regressions are described above.
Do not call the feature ready for deployment before that review and the remaining UI/device checks.

Next delivery slice: Apple TV cards and LIVE / ON TV NOW / UPCOMING / break labels, synced settings and actions; then
phone/tablet/web adaptations. Guide-only fallback cards and richer AFL/NFL/MLB enrichment remain delivery work. This
first API does not claim those are done. Further matching or playback-admission issues must fail closed, not pick an
unrelated sports slot. Keep the existing rolling 72-hour sport views.

## Live checks once UI and review are complete (Mark)

1. On a pilot server with the flag explicitly enabled, confirm `/api/info` advertises `sportsDashboard` and the ordinary
   Sport view still works on the current Apple app. The new client UI is not present in this build.
2. Pair two devices to the same user and use the preferences API/new UI when available: turn on Avoid spoilers, confirm
   persistence after relaunch and sync on the second device; verify a different user's preference is unchanged.
3. During a real event, confirm score/period/clock update together after the selected delay; check break and final labels.
   Source receipt age does not establish video alignment, so compare to the actual broadcast and adjust delay.
4. Check all ten follows, F1 sessions and cricket matches over the next ~72 hours. Missing data must be explicit and
   unmatched games must remain visible without an enabled watch/record action. Finish/replace an airing and verify an
   old card cannot launch unrelated content. Only Mark should initiate provider-consuming plays.
