# Playback, provider admission and authentication deep review

Snapshot: server a104726 (0226). Review window 2026-09-23 00:00 +10 through 2026-10-21 23:59:59 +11, newest first. This review makes no deployed-provider/device acceptance claim. No provider connection was taken. The scripts beside this report exercise actual modules with synthetic dependencies; they assert observed defects, not corrected behavior. Application code is unchanged.

## Actionable findings

### PB1 — P1: cancellation during shared-ingest startup resurrects a cleaned session

`server/services/transcodeSession.js:246` awaits ingest subscription. After that await, it proceeds to spawn at 259 and set running at 266 without rechecking cancellation. Meanwhile `stop()` at 1094–1109 caches an already resolved promise when no process exists. `cleanup()` at 1454–1464 marks cleanup complete and awaits that stop. A delayed subscription can therefore start a process after the session directory was removed and session deregistered. Another stop cannot kill this new process because it immediately returns the cached promise. This can keep a provider subscription/process alive after a superseded tune or DELETE, defeating the intent of 0180 and 0198. The 0225 network await makes an older narrow mkdir race substantially easier to hit.

Evidence: `node docs/reviews/2026-10-21/playback-cancel-reproduction.cjs` passed: cleanup finishes while subscription is pending, resolving it spawns once, subsequent stop signals zero times, and status is running although stopRequested and _cleanedUp are true. This runs the real class with a fake child process and filesystem; no ffmpeg/network is used.

Required fix: serialize start/stop ownership or check terminal cancellation after every startup await and before spawn; release any late subscription and never enter direct fallback after cancellation. Cleanup must await pending startup ownership transfer. Add regression tests for both successful and rejected late subscribe, cancellation during mkdir, no leaked feed, no spawn after cleanup, and the normal startup path. Repeat at route level with overlapping same-owner resolves.

### PB2 — P1: forced takeover counts an upstream once but releases only part of it

0223/0225 correctly deduplicate shared upstream connections for accounting. However, `streamCoordinator.js:509–514` excludes viewer sessions whose ingest is in recordings, and `:546–558` deduplicates recordings into a single representative. Forced admission at `:972–980` sacrifices only that representative and decrements the required slot count. `server/routes/playback.js:253–262` stops only the IDs returned. With either two recordings sharing ingest, or a recording plus viewer sharing ingest, at least one subscriber survives; a different-channel forced play then opens another upstream despite a one-connection limit.

Evidence: `node docs/reviews/2026-10-21/playback-coordination-reproduction.cjs` passed both cases against the real coordinator: allowed=true, one sacrifice, zero viewer releases. The script proves the returned release plan, not a real provider's enforcement behavior.

Required fix: retain all members of each resource group when counting unique upstreams. A takeover must truthfully describe and release every member of the selected upstream (finalizing recordings as partial) before admitting its replacement. Test two recordings, recording plus viewers, viewer-only sharing, same-channel joining and canceled confirmation; assert actual subscriber/provider counts, not just verdict.allowed.

### PB3 — P1: fallback admission can use recordings that were active before the asynchronous probe

`server/routes/playback.js:105` captures recordingEngine.listActive() once. The same array is passed to later candidate admission at `:205` after awaits and failed candidates. Bound recording leases are excluded from pending leases, so `streamCoordinator.js:556–557` relies on the supplied active-recording list to count those recordings. If a recording on backup B starts and binds while candidate A is probing, fallback to B can miss it and exceed B's limit. A recording ending during that interval produces the opposite false conflict.

Evidence: the coordination script proves a bound recording is invisible with the stale empty snapshot and correctly blocks with a fresh snapshot. The asynchronous route interleaving is established by source tracing; a full route reproduction has not been run.

Required fix: obtain fresh recording state immediately before each synchronous admission decision, preferably inside the coordinator's authoritative snapshot. Add a route test deferring candidate A, start/bind a B recording, fail A, and assert B cannot be acquired without explicit takeover. Include recording completion during the wait.

### PB4 — P2: the redaction acceptance criterion remains incomplete in proxy errors

0119 redacted the target URL at `server/routes/proxy.js:78`, but the next log at `:79–81` includes raw upstream 403 response text. At `:225–238`, error messages are logged and returned without redaction. A provider response/error that embeds its credential-bearing URL can therefore expose those credentials. These raw paths predate the review window; the finding is an incomplete acceptance criterion of the reviewed redaction work, not a newly introduced leak. 0196's authenticated, opaque-handle input does not sanitize provider responses.

Required fix: redact or replace provider-controlled error text before logs and JSON; preserve useful status classification without body echoes. Inject a fake 403 body and rejected-fetch error containing a synthetic credential URL, asserting neither logs nor response includes credentials. This path was source-reviewed, not exercised in a live provider response.

## Verification scope and efficiency

The initial shared-ingest headers-only/readiness timeout defect is already documented in REVIEW.md and is not counted again here. Shared ingest is an important efficiency improvement: one upstream for probe, recordings and viewers while preserving independent consumer delivery. Its accounting, cancellation and takeover boundaries above need tests before claiming the intended one-provider-connection invariant. Device playback/HDR/HE-AAC acceptance still needs actual Apple devices and representative captured feeds. A passing unit suite cannot certify those combinations.

Review evidence scripts use no provider, deployed server or real media. Historical tuner changes were superseded by a641db0; their old model should not be restored to fix current shared-ingest lifecycle defects.

## Commit coverage ledger

The ledger below combines the initial current-source pass with a 22 October continuation over the historical functional diffs flagged as incomplete. “Current source” means the relevant implementation was inspected; it does not mean a historical diff or device behavior was verified. Commits assigned to recording/web/service audit reports are cross-scope and are not silently counted here.

| Commit (newest first) | Intent and current outcome / evidence scope |
|---|---|
| bb53f28 0225 | Shared live/probe ingest. Actual diff and current coordinator/start path reviewed; PB1/PB2 show lifecycle/admission incomplete. |
| 14597ae 0224 | Drain all queued bytes; opener starts at first PAT. Diff reviewed; source implements distinction between opener and joining reader. Capture/device acceptance separate. |
| dd942a1 0223 | Shared recording ingest. Diff/current membership counting reviewed; PB2. Recording pipeline separately reviewed in RECORDING-DEEP-REVIEW.md. |
| ba93756 0215 | Provider-down notifications: providerRouting trip is wired to best-effort notify; notifications implementation belongs to service review. |
| a641db0 | Remove old tuner model and rollback flags. Current playback has no tuner branch; supersedes 0126–0131/0155. Removal wiring, retained-path deltas and rollback-flag removal reviewed in the continuation; deleted tuner implementation bodies are treated as superseded, not re-certified. |
| 68c8c41 0202 | Standby may reclaim warm connection. Actual diff/current reserveTakingWarm reviewed: preference for genuinely free pool, then warm reclaim, with lease reservation. |
| 205db98 0198 | Leases before probe and channel warming. Actual functional sections/current admission reviewed; PB1/PB3 remain at asynchronous boundaries. Warm/standby implementation source inspected; full concurrent integration validation remains. |
| d9992d7 0197 | Recovery/standby switches. Current relay/warming settings integration reviewed; settings UI covered elsewhere; historical relay/settings integration diff inspected in the continuation. |
| b52ec54 0196 | Always authenticate media/control and opaque proxy inputs. Full auth/proxy/index diff and current auth/handles source reviewed; anonymous-media gap closed at middleware level; PB4 remains for output sanitization. |
| 3699628 0191 | Recover reconnect timestamp loops; flag low-bitrate blank pictures. Actual transcode diff and provider listeners reviewed. Thresholds are heuristics; no claim all low-bitrate pictures are actually black. No VideoPlayer diff in this commit. |
| d414c2f 0190 | Status must not touch session activity. Current peek/get distinction inspected; full status review belongs to root report. |
| e3c57a2 0189 | Relay recovery and hot standby. Current relay startup/compatibility/selection code inspected; historical relay, coordinator and transcode-route functional diff inspected in the continuation. Device discontinuity behavior needs acceptance. |
| 65d3bcd 0188 | Count mid-play losses/recovery. Current lost/provider callbacks inspected; historical metrics and route-hook diff inspected: recovery correlates owner/channel within three minutes, with seven-day summary and thirty-day retention. |
| 616b1f2 0182 | Consolidate providers/settings. Provider migration/account pooling source reviewed; UI/complete diff belongs to root report. |
| 9224b27 0181 | Same-account shared pool. Current code and original account-key/pool/provider-response diff reviewed. Hash uses origin plus username; shared pool uses the lowest effective configured limit. |
| f9d636c 0180 | Superseded start is not provider failure. Actual diff reviewed. Explicit stopRequested/superseded handling exists, but PB1/PB5 reveal cancellation coverage incomplete. |
| b462c37 0174 | Failover/breaker/quarantine. Current providerRouting and playback source reviewed; quarantine expiry, distinct-channel breaker and candidate order visible. PB3 affects admission after fallback. Original provider-routing, strategy, transcode lifecycle and playback-route functional diffs inspected in continuation. |
| 7651fd0 0173 | Per-provider pools. Current coordinator grouping/admission reviewed; PB2/PB3 affect composed behavior. Original pool/accounting/admission functional diff inspected in continuation. |
| 3d2216f 0158 | Bounded recording prompt. Current coordinator request/expiry path inspected; recording scheduling acceptance delegated to recording review. |
| 555a21f 0155 | Compatible tuner joining. Superseded by a641db0 and shared ingest; historical behavior not claimed current. |
| 14934ff 0144 | Finite input initial burst8 then realtime. Current paceArgs/readrateBurstSec inspected, bounded environment override retained. Original pacing functional diff inspected: finite-source-only burst, bounded override and real-time pacing retained. |
| de1cb40 0143 | Two refused reconnect retries. Current session exit/retry machinery inspected; original retry and deadline-allowance diff inspected; provider enforcement not exercised. |
| 6a9d12a 0142 | Stall health. Current lost classification/watchdog callbacks reviewed; health aggregate review delegated. |
| be14f17 0136 | Remove passport. Current auth.js fully inspected (token authentication reads current user/device revocation, role handling); original auth middleware/login/mount migration diff and direct-JWT tests inspected; removed Passport initialization is replaced, not an auth bypass. |
| 58f9ee4 0135 | Move JSON configuration/users into SQLite. Current db.js migration inspected: parses legacy input before transaction, copies/renames after migration; original migration/settings/source/user CRUD diff inspected in continuation; transaction boundary, post-commit legacy rename and cache invalidation retain intent. |
| 42a6df5 0133 | Channel health. Current playback callbacks reviewed; aggregate/history implementation belongs to root service review. |
| d0a98ee 0131 | Recording reacquires dead tuner. Superseded by tuner removal; no current acceptance claim. |
| f996769 0130 | Recording tuner Apple default caps. Superseded; current recording/shared ingest paths reviewed separately. |
| 761724f 0128 | Tuner timeshift. Superseded; not treated as current functionality. |
| bd7e77a 0127 | Recordings join tuner. Superseded. |
| 9ff958f 0126 | Shared viewer tuner. Superseded. |
| b8bb576 0124 | Admin status. Root status review; playback accounting integration inspected. |
| 6b2ac88 0122 | Fork cleanup. Current delivery architecture inspected; mounts, coordinator soft-admission removal and retained transcode changes inspected; removed VOD pages/styles and passthrough bodies are classified by deletion, not re-certified as current functionality. |
| 1c7ceec 0119 | Opaque playback handles/redacted logs. Current bounded TTL handle registry and proxy reviewed; adjacent redaction change inspected; PB4 incomplete. |
| 41fad36 0118 | Client-safe resolve errors. Current playback error classification inspected; original error-message/strategy/session/route functional diff and contract assertions inspected in continuation. |
| e5711ec 0116 | HE-AAC capability. Actual diff inspected; allows copy only with capability, current default remains conservative. Physical decoder acceptance outstanding. |
| 773fd84 0115 | Frame-rate-aware master. Actual diff and master builder inspected: rational frame rate parsed; invalid/missing omitted; VIDEO-RANGE emitted. Device acceptance outstanding. |
| 51bd72c 0114 | Cached channel profiles. Current hash/TTL/profile storage and strategy integration inspected; successful playlist gates profile acceptance. Original profile storage/cache/strategy functional diff inspected in continuation; fresh success gates persistence, profile failure invalidates both caches. |
| cc83485 0113 | Faster classified failure, first refusal retry. Current strategy/session classifiers inspected; later lifecycle changes must satisfy PB1. Original fail-fast/refusal-retry/session-status functional diff inspected in continuation; 0143 later expands refusal retry count. |
| 968bc69 0110 | Favorites track stable identity. Actual diff/current tests inspected; disappeared identity still returns stored item_id (see residual coverage note below). |
| 90fcc6b 0107 | Remove duplicate routes. Root route review; no independent full review here. |
| ae5f0ec 0106 | Guide/favourite stable identity serialization. Actual diff inspected; stable_id selected and stableId emitted. |
| f45d0ae 0104 | Honest ffmpeg exit/narrow retry/network-only inputs. Current start/exit/streamUrl gate inspected; original URL validation/session exit/retry/proxy streaming functional diff inspected in continuation. |
| 31ed4f6 0103 | Retire remux/legacy pipe. Current live path uses resolve/session; original strategy/coordinator/probe functional diff and route retirement wiring inspected; deleted remux body is superseded. |
| b29b188 0102 | One web playback path and bounded recovery. Functional additions, removed strategy entry points and current player reviewed; retired browser probe/remux bodies are superseded. PB5 remains. |
| 97fb829 0100 | HDR VIDEO-RANGE master. Current master source inspected and subsequent0115 diff reviewed; physical HDR output not verified. |

This is an intent/retained-behavior coverage ledger. The continuation inspected the historical functional changes previously flagged as incomplete, including auth/SQLite migration, pool/failover, relay/metrics, profiles/retries and delivery retirement. It does not claim a line-by-line re-audit of deleted legacy implementations, generated lockfiles, visual CSS or every historical test. Removed tuner/remux/VOD paths were assessed through their callers, mounts and deletion, then traced to current replacements. Existing suite results from the main review are separate from these child-agent reproductions; this continuation ran no additional heavy tests or provider requests.

## Additional browser finding

### PB5 — P2: stopping while resolve is pending can restart playback afterwards

`public/js/components/VideoPlayer.js:1010–1022` accepts a late successful decision without a local generation/cancellation check. `stop()` at 1445 clears the current session and media but does not invalidate outstanding resolve requests. Server499 handling covers some competing starts, but an ordinary stop sends no superseding resolve and cannot prevent this late completion. Likewise, out-of-order successful/direct responses can replace a newer screen. The one-path0102 and superseded0180 changes therefore do not establish a complete browser cancellation lifecycle.

Evidence: `node docs/reviews/2026-10-21/playback-web-cancel-reproduction.cjs` runs the actual play()/stop() methods with a deferred resolve and stubbed DOM/media; after stop, fulfilling resolve still calls playDecision. No browser/network was used.

Required fix: client request generation plus AbortController; increment/invalidate on stop and selection, gate prompts/retries/decision application by generation, and delete any stale returned server session. Add deferred stop and out-of-order success tests, plus a test that a stale409 cannot take over a newer selection. Ensure play's internal stop does not invalidate its own fresh generation.

## Residual stable-identity check

`server/routes/favorites.js:40–45` returns the stored favorite when a stable_id has no current playlist row, including its stale positional item_id. That conflicts with the comment/invariant that identified rows must not fall back to pos_N. Existing tests cover moved identity and unidentified orphans, not vanished identified channels with positions reused by another channel. The current main web library uses a different favorite endpoint, so this is a contract/data-shape concern rather than a proven visible wrong-channel regression. Decide whether to omit disappeared favorites or represent an unavailable identity without a playable positional ID; add a reused-position test before calling0110 fully achieved.
