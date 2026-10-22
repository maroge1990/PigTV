# Four-week intent and outcome review

Completed source-review continuation: **22 October 2026**. Fixed original window: **23 September–21 October 2026, Australia/Melbourne**, not a rolling window moved forward on continuation. Newest-first assessment follows later fixes before earlier attempts. Snapshots: server **0226 / a104726**, Apple **46 / 8f09ea3**, branding **1.7.1 / f84d8cd**. [Inventory](COMMITS.md): **196 server/web, 115 Apple and 11 branding commits**, including documentation, tests and merges. Explicit timezone boundaries were rechecked. A read-only remote-main check during the review matched both application HEADs; documents calling them unpushed are stale. Installed versions remain unknown.

**Conclusion: the work did not achieve all its intended outcomes.** Several earlier fixes are valid, and superseded attempts have been distinguished from current implementations. Six high-priority defects remain in ingest readiness, playback cancellation, admission/takeover, recording-original retention and channel identity. Further failures concern client isolation, refresh, rules, exclusions, backups, sport association and error handling. The original iPhone Tuning incident and AUS v SA report are still not closed.

This is completed commit classification and a broad source/history, integration and synthetic-defect review. It is **not a claim that every historical line, deleted legacy body, binary asset or device behavior was independently verified**. Detailed ledgers state their evidence scope. No code review proves the absence of all defects. Physical devices, deployed configuration, provider behavior and interrupted simulator checks remain explicit acceptance gaps.

## Consolidated repair register

The first three findings below retain their original detailed explanations. The companion reports supply all additional evidence, locations and required regressions. These are one register; repeated mentions are not extra defects.

| Priority | ID | Remaining issue | Evidence/detail |
|---|---|---|---|
| P1 | I1 | Ingest readiness/reconnect can wait forever; close does not settle waiter | Finding 1 below; synthetic reproduction |
| P1 | PB1 | Delayed ingest starts a process after session cancellation/cleanup | [Playback](PLAYBACK-DEEP-REVIEW.md); synthetic reproduction |
| P1 | PB2 | Forced takeover releases only part of a shared upstream | [Playback](PLAYBACK-DEEP-REVIEW.md); synthetic release-plan reproduction |
| P1 | PB3 | Fallback admission uses stale active-recording snapshot | [Playback](PLAYBACK-DEEP-REVIEW.md); coordinator reproduction plus route tracing |
| P1 | DVR-1 | Segmented finalization discards originals despite keepOriginal | [DVR](RECORDING-DEEP-REVIEW.md); synthetic finalization reproduction |
| P1 | DVR-2 | Missing stable channel identity falls back to reused playlist position | [DVR](RECORDING-DEEP-REVIEW.md); stream and guide-end reproductions; resolver partly predates window |
| P2 | PB4 | Proxy errors can expose provider-controlled credential text | [Playback](PLAYBACK-DEEP-REVIEW.md); source-confirmed inherited gap |
| P2 | PB5 | Browser stop does not invalidate pending resolve | [Playback](PLAYBACK-DEEP-REVIEW.md); synthetic reproduction |
| P2 | DVR-3 | Cancelled sport-rule recording returns after >15-minute move | [DVR](RECORDING-DEEP-REVIEW.md); 20-minute reproduction |
| P2 | DVR-4 | Awaited recording startup can overwrite cancellation | [DVR](RECORDING-DEEP-REVIEW.md); source interleaving |
| P2 | DVR-5 | TS fallback output errors can escape as uncaught stream errors | [DVR](RECORDING-DEEP-REVIEW.md); source-confirmed error ownership gap |
| P2 | A1 | Local resume fallback crosses accounts/servers | [Apple](APPLE-DEEP-REVIEW.md); source-confirmed |
| P2 | A2 | Top Shelf can republish signed-out account data | [Apple](APPLE-DEEP-REVIEW.md); source interleaving |
| P2 | A3 | Recording-rule mutation errors are invisible in sheet | [Apple](APPLE-DEEP-REVIEW.md); source-confirmed |
| P2 | A4 | Same-shape guide corrections do not immediately refresh visible cells/layout | [Apple](APPLE-DEEP-REVIEW.md); source-confirmed, UI regression needed |
| P2 | A5 | Artwork disk cap enforced only at launch | Finding 2 below; source-confirmed |
| P2 | W1 | Returning to cached guide window leaves later fetch able to publish | [Web/services](WEB-SERVICE-REVIEW.md); synthetic reproduction |
| P2 | W2 | Keyboard focus lost on redraw/dialog return | Finding 3 below; existing acceptance incomplete |
| P2 | S1 | Excluding every imported group retains old channels | [Web/services](WEB-SERVICE-REVIEW.md); synthetic SQLite reproduction |
| P2 | S2 | Exclusion blockers are stale by time sync purges channels | [Web/services](WEB-SERVICE-REVIEW.md); synthetic favourite reproduction |
| P2 | S3 | Concurrent backup creation/cleanup interferes | [Web/services](WEB-SERVICE-REVIEW.md); actual temporary SQLite reproduction |
| P2 | S4 | Shared placeholder tvg-id cross-links unrelated slot-name games | [Web/services](WEB-SERVICE-REVIEW.md); synthetic reproduction |
| P2 | S5 | Partial ESPN refresh falsely establishes complete negative coverage | [Service supplement](SERVICE-SUPPLEMENT.md); synthetic HTTP/SQLite reproduction |
| P2 | S6 | Logo response bodies outlive the download deadline | [Service supplement](SERVICE-SUPPLEMENT.md); synthetic stalled-body reproduction |
| P2 | S7 | Sibling link status changes do not invalidate guide membership | [Service supplement](SERVICE-SUPPLEMENT.md); synthetic SQLite reproduction |

The register contains **25 actionable findings: six P1 and nineteen P2**. Supplemental evidence is in [SERVICE-SUPPLEMENT.md](SERVICE-SUPPLEMENT.md). Also resolve the disappeared-favourite positional-ID contract concern documented at the end of the playback report; visible wrong-channel impact is not established, so it is not overstated as a reproduced UI bug.

**Repair handoff:** [HANDOFF-PROMPT.md](HANDOFF-PROMPT.md), ready to give to the original agent. It includes every register item, supplemental findings, efficiency work and outstanding acceptance.

## Current findings, newest implementation first

### 1. P1 — shared ingest can wait indefinitely before usable bytes arrive

Introduced in `dd942a1` (0223), now reached by live resolve through `bb53f28` (0225). `server/services/ingest.js:184` disables the request timeout as soon as HTTP 200 headers arrive. Readiness requires at least three TS packets; `checkStall()` only operates in `live`, with `lastByteAt` set. A server that flushes headers and then sends nothing, or fewer than three packets, remains `connecting` indefinitely. A reconnect that receives headers but no TS similarly remains `reconnecting`: the reconnect budget is checked when scheduling retries, not by an independent deadline during that wait.

`playbackStrategy.js:110` awaits the subscription **before** starting the bounded ffprobe operation. Thus the probe deadline does not cover this stage. `close()` also does not reject unresolved readiness, so closing/reclaiming a connecting ingest does not release that waiter. These are two parts of one lifecycle gap.

**Evidence:** deterministic synthetic HTTP-event reproduction in `ingest-startup-reproduction.cjs`: after headers, request timeout is zero, state is connecting, no bytes have arrived, the stall check leaves it open, and closing it leaves subscription unsettled. This uses no network. Existing ingest tests cover working TS, refused/non-TS streams, disconnects and recovery, but not a headers-only response.

**Impact:** an in-flight play or recording start can remain pending; normal timeout/failover handling cannot run. This is a concrete new route to a tuning wait, **not proof of the cause of the original iPhone bug 8**, which predates shared ingest.

**Next change:** absolute first-usable-byte and reconnect deadlines, readiness rejection on every pre-ready close, and cancellation cleanup. Tests: headers-only, partial TS, reconnect-with-headers-only, and close while connecting; assert the caller settles and resources are released. Preserve the existing capture/bench gate for playback changes.

### 2. P2 — Apple's advertised 50 MB disk cache is only pruned at launch

The October cache work (`c63a42b`, `6776dab`) correctly adds canonical keys, shared fetches, off-main disk work and a pruning implementation. However, `PigTV/PrivateCaches.swift:112–117` calls `prune()` only during static store creation. `write()` at line 134 never enforces the size limit; `APIClient.loadArtwork` writes each downloaded image without scheduling another prune. Repository-wide search found no other artwork-store prune caller.

**Impact:** loading new logos/programme artwork during a long app session can exceed the documented 50 MB cap until another process launch. This does not invalidate the separate 32 MB decoded-image cache or the per-response download limit.

**Next change:** one serialized cache owner, byte accounting and a coalesced prune after writes cross the budget. Avoid enumerating and sorting the whole directory for every image. Test writes that cross the cap without recreating the store; include concurrent writes/pruning and retained recently accessed files. Source-confirmed; no disk-fill experiment or device memory claim.

### 3. P2 — keyboard access was added, but refresh-safe focus was not completed

Build 0210 adds focusable role/button semantics and Enter/Space activation. It fixes the initial inability to activate core viewing actions. The original F4 acceptance also required focus to survive row recycling/redraw. `EpgGuide.render()` replaces container markup (`public/js/components/EpgGuide.js:479`); there is no corresponding capture/restore of the active channel/programme identity. Channel-list rebuilds also replace focused nodes. A keyboard user can lose their place after refresh. The 16 Oct roadmap explicitly leaves this open.

**Next change:** retain focus by stable channel/programme identity across redraw; return details-dialog focus to its originating action. Test in a real DOM/browser with activeElement assertions, not only markup-string and key-handler tests. This is incomplete acceptance of an existing finding, not a newly discovered regression.

## Reverse-order outcome ledger

| Latest work | Intended outcome | Assessment of current result |
|---|---|---|
| 18 Oct: server 0226, bug 9 | Watching and recording one ingest must show one provider connection | Implemented for active consumers: `connectionsUsed()` deduplicates `ingestKey`; UI marks shared uses and removes the generic warning for shared recordings. Regression tests exercise shared and unshared cases. It is not a complete live socket inventory: connecting probes and lingering ingests are outside this consumer count. Sharing also does not make a different channel free. Device confirmation of 0226 is absent. |
| 18 Oct: Apple 46, correcting 42 | Headers actually align; compact Search fits; remove redundant player button; fast swipes do not snap back | Latest source owns header placement in `PigPageHeaderMetrics`, explicitly selects compact search, removes the redundant control and clears `plannedRow` after focus lands. Build 42's reuse of a shared header alone did **not** achieve alignment; 46 is the relevant fix. Commit records before/after tvOS geometry and a failing-before fast-scroll test. iPhone/iPad UI tests were explicitly not run in that commit; compilation is not visual acceptance. |
| 16–18 Oct: 0223–0225 shared ingest | One upstream connection for same-stream viewers, recording and probe, preserving media bytes | Narrow sharing goal implemented. 0224 corrects queued-byte drain and opener PAT position; assess 0225 with that correction present. Historical 18 Oct bench and multi-device recording test support the happy path. Startup/reconnect lifecycle defect above remains. Warm channels, standby/relay legs and direct plays still bypass it. R7 speed-based failover is not implemented. No evidence here that the provider's repeated-content cut is eliminated. |
| 16 Oct: 0218–0222, Apple 44–45 | Watch an ongoing recording from its beginning; rules/artwork; event-slot sport; bulk EPG mapping | Implementations and dedicated tests exist; feature flags/contracts connect the Apple features. This replaces the previously removed tuner/HLS recording approach; it is not evidence that the old implementation worked. Real-feed restart/takeover, HEVC playback, rule matching and mapping acceptance remain pending in the handover. Event-slot parsing does not establish a fix for the reported AUS v SA mismatch. |
| 16 Oct: 0213–0217 | Backups before migrations/nightly; guide-following end; webhook; archive metadata; exclude groups at import | Concrete implementations. Timer rescheduling accompanies guide-end changes, rather than only updating the database. Archive metadata is capability discovery, not implemented catch-up playback. Import filtering should reduce sync/DB work, but no fresh before/after benchmark establishes magnitude. R11 live ffmpeg speed/fps remains deferred despite webhook completion. |
| 16 Oct: 0208–0212, Apple 42–43 | Earlier review F1–F8 and reported usability bugs | Web request generation, Home render ownership, explicit history modes, visibility/version gates and accent/copy are present and covered by focused tests. Apple uses favourite identities and a shared filter observer, visible recordings refresh and cancellation filtering. F4 focus remains partial; F8's proposed provenance/token-testing work should not be inferred from its colour/copy fix. Icon enlargement is present but physical appearance still needs acceptance. |
| 10 Oct: server 0207, Apple 41 | Recording list usability, per-login resume, touch layout/player/PiP | Later build 42 removes the unwanted break-times section; 46 removes redundant player navigation and adjusts headers. Judge those latest forms. Server resume storage is per login, but A1 leaves the local fallback unscoped; live comskip is not a promise for segmented recordings, which are analysed after final MP4. No new iOS interaction/PiP/device acceptance was collected. |
| 4 Oct: server 0204–0205, Apple 39 | Simplify ownership and remove unused tuner model; retain linked backup siblings | Old tuner/timeshift paths were deliberately removed; 0205 repairs the linker regression caused by hiding linked backups. File splitting is maintainability work, not measured runtime acceleration. September Start-over/tuner commits cannot be counted as delivered features today. |
| 3–4 Oct audit follow-ups: server 0192–0203, Apple 37–38 | Secure media, correct codec handling, remove tab/startup work, prepare recordings, protect event loop | Current source retains handle-only proxy/auth, JSON-by-field codec parsing, asynchronous recording I/O, Sport worker/cached responses, eager preparation and ordinary-path validation before destructive publication. DVR-1 identifies the later segmented path losing original-retention semantics. Apple retains lazy Sport, smaller observable stores, off-main derived work, coalesced artwork and concurrent break-marker loading. These are appropriate fixes; physical input-to-focus/first-picture improvements are not remeasured here. Disk-cache bound is incomplete as above. |
| 30 Sept–2 Oct: 0168–0190, Apple 36 | Multi-provider failover, account-level limits, stable links, reminders and recovery visibility | Later shared-ingest work layers on top; it does not supersede compatibility checks, explicit takeover or stable identity. Same-account pooling and stopped-start classification correct earlier provider admission/outcome behaviour. Recovery/standby remains conditional and off by default; the iPhone recording-conflict incident still lacks its diagnostic log. |
| 28–29 Sept: 0156–0167, Apple 33–35 | Recording-folder safety, visible schedule failures, prompt timeout, extending guide, sporting live/replay correctness | Later source retains these protections. Guide extension supersedes the former hard forward wall. ESPN-first classification still falls back to heuristics; a title/fixture edge case is not proof all sport recognition failed. Keep cancelled/missed history and mounted-share checks; DVR-3 and S5 expose remaining rule/fixture boundaries. |
| 23–26 Sept: 0110–0155, Apple 18–32 | Faster/bounded guide and logo work, accurate identity, codec-aware start and modern guide/player | Later paging/version/store work preserves these intentions. AVKit selector/link correction in builds 24–25 is the relevant crash fix; temporary Swift 5 rollback was an incorrect diagnosis and was superseded by Swift 6 plus real-playback tests in 28. Tuner sharing and the old Start-over UI were later removed. Siri/App Shortcuts were also removed; do not report them as current delivered capabilities. |

The October 3 audit's R-numbers and the later Dispatcharr roadmap's R-numbers describe different items. For example, audit R7 is removing recording marker waits; Plan B R7 is speed-based recovery. They must not be conflated when reporting completion.

## Reported bugs 1–9

| Bug | Verdict |
|---|---|
| 1: commercial break times on details | Swift times list removed in 42; skip/detection retained. Web status chips intentionally retained. Scrub-marker preference is still a separate decision. |
| 2: iPhone category change does not refresh | Correct observer moved to shared body in 42; source/test-supported. Hardware acceptance not newly established. |
| 3: small tvOS icon | Enlarged kit option B in 43; device appearance not newly established. |
| 4: inconsistent headers | 42 was insufficient; 46 addresses actual placement. tvOS test evidence exists; iOS appearance remains unverified. |
| 5: AUS v SA cricket not linked | Open. Need actual guide titles/channels; synthetic title work and event-slot support do not prove this case fixed. |
| 6: unreachable cancelled alert | 42 filters cancellation and changes error presentation. Implemented; no fresh physical focus test. |
| 7: missing Docker icon | Image labels added in 0208; actual Unraid display still depends on deployed image/template configuration. |
| 8: iPhone Tuning during recording | Not closed. The 20-second hint is mitigation, not a server fix. Sharing helps same-stream contention when enabled but does not prove the original root cause. New ingest wait defect adds urgency. |
| 9: double-counted shared connection | Narrow reported example fixed in 0226, with regression tests. Does not establish deployment. |

## Efficiency opportunities, in recommended order

1. **Finish lifecycle bounds before increasing sharing.** Avoid stuck startup work and unreleased callers. Correctness and resource release matter more than small reductions in tuning latency.
2. **Apple: enforce the disk budget during use.** Coalesce pruning using byte accounting; retain existing shared fetch/decode work, bounded decoded cache and lazy rendering. Do not replace the UI framework to solve this.
3. **Server: move warming/standby consumers onto shared ingest when its lifecycle is hardened.** This closes a known source of duplicate provider connections. Sharing an upstream does not by itself eliminate separate ffmpeg consumers or their CPU/disk work. Measure connections, processes, memory and first-picture latency independently; retain codec/HDR/timestamp compatibility and explicit admission rules.
4. **Server: measure interval throughput, not only lifetime average.** `Ingest.describe()` reports total bytes divided by lifetime. A short stall after hours of streaming barely changes this value. Collect interval bytes/rate, time since last byte, subscriber backlog and reconnect duration before deriving R7 thresholds. Logging the lifetime average once per minute is not equivalent to minute throughput.
5. **Server: batch rule evaluation inputs.** `recordingRules.seriesCandidates()` obtains and scans visible channels for each rule; `shape()` counts pending schedules separately for each rule. Build one channel identity map per evaluation and aggregate pending counts once per list. Up to 100 rules are permitted. This is a source-supported avoidable-work opportunity, not a measured current bottleneck.
6. **Apple: fetch independent recording lists concurrently and coalesce ownership.** `BrowseModel.loadRecordings()` awaits recordings and then schedules. Fetch/decode both concurrently with cancellation and coherent publication; this removes one serial request round-trip. Preserve quiet refresh, equality suppression and existing retry semantics. Measure before/after rather than promising a particular latency reduction.
7. **Web: reuse loaded guide windows.** The newest request-generation fix improves publication ownership but W1 remains; navigation also fetches overlapping windows plus categories/favourites. Reuse coverage and fetch only missing ranges under the existing single load owner. Preserve version invalidation and focus identity; avoid an additional competing cache.

## Validation and limits

All eight saved synthetic reproduction scripts were rerun successfully on 22 October under Node24. Their assertions describe current **faulty** behavior; exit zero means reproduced, not fixed. Earlier full-suite/build-check results below were recorded in the preceding review continuation; the old temporary logs are no longer available. No source changes occurred between those runs and this review.

- Deterministic ingest reproduction: confirmed pending readiness after headers and after close; no provider/network used.
- Focused server checks: **46/47 passed** initially; recording-ingest start timed out under load. Its isolated file then passed **7/7**. The isolated pass does not erase the first failure.
- `verify-build.sh`: initial run timed out at the recoverable-XML parser check; rerun with Node 24 **passed all checks**. No parser code changed.
- Swift standalone API/model contracts: **243 passed**. A fresh continuation rerun also passed 243. The interrupted simulator push tier has no confirmed final result; no fresh iOS build or hardware acceptance is claimed.
- Initial full server suite was invalidated by sandbox localhost `EPERM` failures. The permitted Node 24 rerun passed: **990 tests, 985 passed, 5 skipped, 0 failed**, about 64 seconds.
- Performance budgets are disabled in full runs with `PIGTV_SKIP_PERF=1`, matching the CI gate. Functional passes are not new performance measurements.
- Production configuration/builds and physical-device outcomes were not queried. Remote-main refs were checked read-only and matched the reviewed application HEADs. Historical docs have inconsistent push/deployment status; use installed version evidence before live acceptance.

## Acceptance to close the remaining uncertainty

1. After an ingest lifecycle fix and its synthetic tests, bench the captured reference feeds through both paths; include an uneven-timestamp capture when available.
2. On the actual installed server/app builds, reproduce recording plus iPhone playback on the same channel and on a different channel, noting sharing on/off and the provider; retain the corresponding resolve/coordinator log and elapsed time.
3. Test build 46 header positions/search on iPhone/iPad and fast guide swipes on Apple TV. A tvOS test result cannot close iOS appearance.
4. Complete the already documented segmented-recording restart/takeover/HEVC and recording-rule device checks.
5. Supply the exact AUS v SA guide titles/channel listings before changing sport grouping.

No application code was changed, deployed or pushed by this review. Review documents and blueprint annotations are left for review.
