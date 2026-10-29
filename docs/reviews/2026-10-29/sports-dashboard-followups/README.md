# 0315: sports own-review follow-ups to 0313

Reviewed source: **72fa3b9**. The own reviewer accepted original H1/M1–M3/L1/L3/L4 and the original L2 answer, then
requested N1/N2 changes. This record addresses that follow-up; it is not a Codex adversarial review. Codex remains
**round 0 of 2**. Feature stays off by default, no push/deployment, no live source or provider connection used.

## Dispositions

| Finding | Disposition |
|---|---|
| N1 (medium) | Fixed. Legacy fixture HTTP clients consult and update shared cooldown only while `PIGTV_SPORTS_DASHBOARD=1`. When off, a first-league 503 does not prevent the remaining leagues being fetched. Enabled passes defer remaining leagues without failure status/log entries, then coalesce a retry just after cooldown; an intervening successful pass cancels an obsolete timer. Last-good fixtures/coverage remain intact. |
| N2 (medium) | Fixed. Three request slots protect eligible least-recent non-hot work, including dated cricket discovery, before hot work; spare capacity can be borrowed. Discovery dates rotate too. Each URL/observation is normalized at most once per tick across the scheduling phases. The 12-attempt ceiling and two-in-flight limit remain. The 14-live-league/40-tick probe changes from 14 distinct hot URLs and zero future URLs to all 70 requested URLs, including 42 future URLs. |
| Low note 1 | Fixed. 10s worker job deadline rejects/terminates a hung job and starts a replacement for queued requests. Completion, error and close clear timers; there is no main-loop projection fallback. |
| Low note 2 | Deferred and registered as SD-0313-L2. Unknown-format multi-day cricket still has a conservative 12h fallback. End-date envelopes alone are unsafe evidence for five days because captured short-format matches also carry multi-day envelopes. Need an authoritative format or validated day/session signal before broadening. |
| Low note 3 | Deferred to a Mark-authorized pilot, registered as SD-0313-L3. Projection is on a worker, but collector JSON parsing/normalization remains on the serving loop. Measure payload bytes, parse/normalize/ingest time, event-loop delay, CPU/heap and HLS latency before enabling for normal use; a fresh tick can accept up to 12 x 2 MiB. No real-feed/pilot performance claim. |

## Failing-before evidence

[Exact 72fa3b9 archive](baseline-72fa3b9-before.txt), with only the new test file added:
- Disabled-dashboard 503 regression fails: NBA/MLB were never fetched.
- Enabled retry regression fails: deferred league was recorded failed and had no early retry.
- 14-source/40-tick fairness regression fails: distinct=14, future=0.
- Worker deadline/replacement regression fails: active job has no timeout.
- The extra retry-cancellation guard already passes on 0313 because no cooldown-retry timer existed there. It caught
  duplicated requests in the first implementation of the new retry: [draft before](retry-coalescing-draft-before.txt).

[Focused after](focused-after.txt) covers the new tests plus all existing sports/fixture regressions. The existing
shared-cooldown test explicitly enables the dashboard now, matching the corrected contract rather than relying on
an off-by-default feature to alter the legacy feed.

Validation used an isolated archive of committed 0314 (`1201a27`) plus only this sports change.
All **1,305 tests passed**, with zero failures/skips; build verification passed. The focused sports run passed
**81 tests**. [Final gates](final-gates.txt). All production/test files match that validated snapshot.
Concurrent media/relay work remains a separate batch; no uncommitted files from it are included.

## Mandatory next review

Hand this to Mark for the Codex review; the own-review follow-ups do not consume a Codex round. AGENTS.md assigns
this slash command to Mark:

```
/codex:adversarial-review --background --base a6e86e1 Review sports dashboard 0309/0313/0315 only: cached-event read-only worker isolation and job timeouts, per-user authorization/spoilers, delayed state/retention migration, fixture cooldown gated on dashboard enablement with deferred retry, three-slot cold/catalog fairness within the 12-request budget, cricket matching and follow-selection semantics. Check C-O and failing-before evidence against code. Exclude separate recording/relay/media commits except concrete interactions. Low notes SD-0313-L2/L3 remain registered; do not assume full unknown-format cricket coverage or collector pilot performance. Codex round 0 of 2.
```

For reviewer approval, inspect the sports repair commit against 72fa3b9 and the evidence above; return approval or
remaining findings with severity, code locations and a concrete reproduction. This does not replace mandatory Codex
review. After at most two Codex rounds only high findings block; remaining medium/low findings must remain registered.

## Pilot acceptance after review (Mark)

1. Keep the dashboard off for normal use until the required review is complete. On an isolated test server, confirm
   existing fixture updates continue after a simulated first-league 503 with the flag off.
2. With the flag enabled on that test server, confirm deferred leagues refresh just after cooldown, and future
   catalog dates keep progressing during a busy live schedule. Unit regressions provide the deterministic checks.
3. Before normal enablement, authorize a real-feed/HLS pilot and measure the collector timing and serving-loop/HLS
   latency listed in SD-0313-L3; assess unknown-format cricket against SD-0313-L2. No device/feed acceptance is claimed.
