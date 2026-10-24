# Review of server 0251–0255 and Apple 52–53

Review started 24 October and completed 25 October 2026 (Melbourne). Server HEAD `63a022f`, Apple HEAD `6c552cb`. Baselines: server 0250 / `7e1481b` (review docs only after `bc92dfc`); Apple51 / `6144194` (review docs only after `64f1258`). Newest repairs reviewed against the seven previous defects, with isolated old-code checks and additional lifecycle/interleaving probes.

**The direct fixes improve the reported cases, but D1, R-S5 and A5 remain partial.** D2, D3, D4 and A2-R are fixed in the examined local scope. This is not device/feed acceptance and does not establish a cause or fix for original bugs5/8.

## Dispositions

| Previous defect | Verdict | Evidence / remaining issue |
|---|---|---|
| D1 foreign TS deletion | Partial | New pending-copy deletion is repaired, but legacy migration still infers ownership unsafely, and publication during asynchronous deletion still leaves unlisted files. |
| D2 deletion during failover | Fixed locally | Owner retired before late settings/feed continuation; late feed released; schedule cancelled. |
| D3 A→B→A correction | Fixed locally | Existing schedule reconciliation now precedes historical-hit suppression. |
| D4 active prebuffer absorbs later event | Fixed locally | Moved candidates exclude recording/finished states. |
| R-S5 malformed discovery | Partial | Outer shape and series cap fixed; invalid nested series lists are still accepted as complete absence. |
| A2-R delayed Top Shelf clear | Fixed locally | Clear enqueued synchronously before main-actor clear returns, ahead of subsequent-session publications. |
| A5-R cache accounting race | Partial; new completion race | Filesystem changes and accounting serialized, but a no-removal prune can finish after a new write crosses the cap and leave it over cap without further work. |

## Remaining actionable findings

1. **P1 — Legacy original migration can still authorize deletion of a foreign TS.** `recordingsDb.js:19–24` assumes `done + keep + null path` proves ownership. Build0242 could persist exactly that state before copying the original (the F2 interruption window). The migration assigns the conventional path without checking bytes/provenance; deletion then removes it. Preserve ambiguous legacy files rather than inventing ownership. Details and synthetic historical-state reproduction: [DVR.md](DVR.md).
2. **P2 — Publication racing deletion leaves an orphan on the share.** While deletion awaits work-folder cleanup, the row still exists; a retained copy passes the new row check, updates its path, and is then missed by deletion’s stale snapshot. Separately, fallback `deliverTs` publishes after its awaited join even if deletion has completed. Retire ownership before deletion awaits and cover every publishing path, cleaning only its own output. [DVR.md](DVR.md).
3. **P2 — Nested malformed discovery still wipes fixtures and renews coverage.** An HTTP200 `{scores:[{leagues:"unavailable"}]}` passes the new outer-array check, becomes no series, and deletes a seeded fixture (1→0). Preserve the prior snapshot/coverage when series enumeration is incomplete. [SERVICE.md](SERVICE.md), [reproduction](discovery-nested-repro.cjs).
4. **P2 — Cache pruning can stop above cap after a concurrent write.** A pass lists an under-cap folder and removes nothing; a write crosses the cap while `pruning` is still true; `finished` requires `removedAny` before repeating, so stops. Reproduction yields actual=counted2000, cap1500, prune idle. Handle intervening writes without requiring a successful prior removal, while keeping failure retries bounded. [APPLE.md](APPLE.md).

These are additional paths/interleavings, not assertions that the provided direct regression cases still fail. The new cricket shape is a remaining validation gap; it does not establish the original AUS v SA cause. Apple race evidence is a deterministic production-code scheduling harness, not physical-device observation.

## Contract and policy

The new repair status honestly retains bugs5/8, physical acceptance, deferred efficiency work and the proposed F4 ambiguity policy. The policy proposal is not implemented or approved; tests pin current behavior, not correctness of real-world identity guesses.

However `docs/CLIENT-CONTRACT.md:236–240` still promises cancellation is never recreated when guide time moves and says “however far it moved.” That conflicts with the documented72-hour horizon and metadata-free series cancellation recreation after20 minutes. Update the authoritative C-M contract, including the actual status behavior after delete during failover; an unchanged API schema does not excuse inaccurate behavioral promises. Do not close DVR-3's broader durable-identity intent until the policy is accepted or stronger identity is implemented.

Efficiency register remains unstarted/unmeasured. No performance gain is claimed. Browser focus code did not change in these commits, so the previous real-browser before/after evidence remains applicable; no new browser run is claimed.

## Validation

See [CHECKS.md](CHECKS.md) for independent results, including the first full-server run's timing failure and subsequent checks. [DVR.md](DVR.md), [SERVICE.md](SERVICE.md), and [APPLE.md](APPLE.md) document focused before/after evidence and probe limitations.

No application source changes, commits, push, deployment, provider connection, or deployed-server access. Only review artifacts and blueprint status notes changed.

[Handoff prompt](HANDOFF-PROMPT.md)
