# Continuation prompt after initial sports dashboard testing

Copy the block below into the next development session. Supply/link the actual initial testing and Codex review
results in that session; the agent must inspect the evidence rather than treating missing results as a pass.

```text
Continue developing PigTV's live sports dashboard following initial testing. Work in the existing PigTV and, when
needed, PigTV-Swift repositories. Read each repo's AGENTS.md, blueprint.md, docs/SPORTS-DASHBOARD-ROADMAP.md,
docs/SPORTS-DASHBOARD-DESIGN.md, CLIENT-CONTRACT C-I/C-O, docs/FINDINGS.md sports entries, and the 0315 handoff at
docs/reviews/2026-10-29/sports-dashboard-followups/README.md before editing.

First inspect current git status/history and the actual initial testing/review results available in this session or
repo. State what passed, failed, remains unobserved and which build/flags were tested. Last documented server baseline
was 0315 (8953d12), 1305 tests/build checks passed locally, flag off, mandatory Codex review 0 of 2; this may have
changed. Do not assume deployment, pilot performance, review approval or device acceptance. If results are missing,
ask concisely while continuing useful offline work. Fix confirmed blocking defects first, each with a test proven to
fail before its fix. Track all findings, respect the two-round review rule per batch, and preserve separate recording/
relay/media work. No push/deploy or deployed/provider-consuming tests without Mark's authorization.

Then progress through the remaining roadmap, with the next product milestone a reviewable Apple TV vertical slice:
capability-gated sport shelves, seven sport-specific card families, clear LIVE vs UPCOMING vs ON TV NOW/break states,
per-account synced spoiler/delay settings, preferred-channel select and existing long-press event/channel/recording
actions. Preserve ordinary Sports when capability is absent and existing rolling ~72-hour sport/team views. Before
relying on incomplete data, cover guide-only fallback/deduplication and matching gaps and show remaining edge variants
for acceptance. Keep every followed sport/game visible even when scores or broadcasts are unavailable; identify
sport/field limitations to Mark. F1 is session-only, with no live timing/positions. Free sources only.

Today includes upcoming/live, cross-midnight play and retained recent finals; final cards cannot tune unrelated TV.
Use server-projected whole delayed state (default 90s, configurable 0–300s); do not extrapolate clocks or use current
raw completion to override delayed fields. Revalidate actual airing eligibility at select time. Respect the paired
account identity, revision conflicts, safe first render/resume/offline behavior and spoiler-safe accessibility/details/
menus. Test same-account two-device sync and separate-user isolation. Use cached logos with fallback, stable remote
focus/order, and explicit labels for yellow/red availability and recording indicators. No provider probes on render.

Resolve or retain SD-0313-L2 (unknown-format multi-day cricket) explicitly; do not widen from endDate envelopes alone.
Obtain authorized pilot measurements for SD-0313-L3 (collector parse/normalize main-loop cost and HLS latency) before
normal enablement. Basic AFL points are acceptable without goals/behinds enrichment; richer NFL/MLB situations stay
optional when absent. All ten current follows remain essential. After Apple TV, implement iPhone/iPad and web
adaptations using the same contract, touch/visible options and keyboard/accessibility support.

Follow repo testing/build/version rules, prove functional regressions fail before fixes, update CLIENT-CONTRACT and
Apple route tests for relevant API changes, and obtain required adversarial review per touched repo. Commit logical
changes locally without pushing. Keep the roadmap/status/evidence current. Report implemented versus locally tested
versus device-accepted separately, remaining findings and concrete numbered live/device checks for Mark.
```
