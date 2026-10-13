# PigTV independent audit and prioritised delivery roadmap

**3 October 2026 · Apple TV first · Server 0191 / Apple source build 36**

## Executive assessment

PigTV has a substantial working foundation: a shared playback resolver, provider coordination, codec-aware stream copying, a virtualised UIKit guide, persisted guide data, recording preparation, and meaningful automated coverage. The right next step is targeted optimisation and hardening, not a rewrite.

The biggest experience improvement should come from **doing less work when a tab is selected and preparing recordings before Play is pressed**. The current code contains optimisations, but some stop at moving network decoding off the main thread; the screen construction, derived models, artwork publication and broad observation still create work at exactly the moment the remote needs to respond.

The Sport screen is the clearest first target. The live feed had **215 events, including 153 replays**, but both its vertical stack and horizontal shelves are eager. The server returned the feed in tens of milliseconds. This strongly implicates client-side work in the repeated pause, although a physical Apple TV trace is still needed to attribute the exact seconds among layout, focus and model updates.

Fresh recording playback is architecturally disadvantaged: the ordinary recording path waits for the first playback request before remuxing the whole file into an Apple-compatible MP4. The work should be scheduled automatically on recording completion, with durable state and a bounded queue. Longer term, an immediately playable segmented recording path would remove the completion-to-preparation gap too.

Two defects deserve prompt attention alongside that work: **unauthenticated media/raw-proxy access is enabled on the deployed server**, and **recording codec detection parses ffprobe columns in the wrong order**. The latter was reproduced with a generated sample; it can bypass the intended HEVC tagging and audio conversion branches.

Recommended order: secure exposed paths and correct codec parsing; establish trustworthy latency gates; optimise Sport and tab state; prepare recordings eagerly; protect the server event loop; then add controlled predictive stream warming. Preserve picture quality and reliable recording throughout.

## Scope, preferences and evidence boundaries

The interview established:

- Primary experience: current Apple TV 4K, wired to the Unraid server at `192.168.1.235:3000`. M2 iPad Pro is secondary and infrequently used. Web is primarily a troubleshooting tool; Mac is not a target.
- Home, TV Guide and Sport pause on every transition; Sport commonly takes 1–3 seconds before interaction. Freshly recorded programmes can take about a minute to begin.
- Desired experience: anticipate the next action and have content ready before selection.
- Server CPU and storage have generous headroom. Three providers each allow one simultaneous connection. Extra providers are possible.
- Recording priority and explicit viewer takeover prompts must be preserved. Spare connections may be used for preloading. Existing background failover preloading must be considered.
- Audit covers performance, reliability, architecture, security and maintainability. Live testing was explicitly authorised, including use of the three connections.

Audited server commit: `369962845355d007711a47cd00ed8db5a2363970`. The live `/api/version` matched build **0191**, short commit `3699628`. Audited Swift commit: `96825f860a9f8c20d45b3cec36da7be65d7667b6`, with `CURRENT_PROJECT_VERSION = 36`. Both matched GitHub main at inspection. The installed Apple binary was not independently fingerprinted; the user reports the newest versions deployed.

PigTV-Branding was reviewed for implementation and verification context. Its documents are evidence of prior work, not authorisation to push, deploy, change playback policy or inherit previous agents’ workflows. No application source, production configuration, recording schedule or deployment was changed by this audit. Playback requests may create native recording sidecars and normal history/diagnostic records. The two live sessions were released and the server subsequently reported zero active sessions.

Evidence labels used below: **confirmed** means code or a targeted experiment establishes the behaviour; **measured** is an observed timing/state; **hypothesis** needs profiling to establish its contribution. API timings are from this Mac over the LAN, not remote-button-to-picture measurements on Apple TV. There was no destructive provider-failure injection, long soak, new full-length recording or physical-device Instruments trace. No claim of exhaustive penetration testing is made.

## What was verified

| Check | Result | Interpretation |
|---|---|---|
| Sport API, 8 sequential requests | Median **34.88 ms**, range **30.97–48.20 ms**, 154,337 bytes | Warm feed delivery is much faster than the reported menu pause. Not a peak-load or cold rebuild bound. |
| Guide API, first 500 rows, default server time window, 3 requests | Median **321.81 ms**, range **299.67–323.66 ms**, 744,902 bytes | A significant first-page cost. This is not the Swift app’s full explicit 24-hour window or whole-library transfer. |
| Version API, 5 requests | Median **10.95 ms**, range **9.53–13.77 ms** | Basic server/LAN responsiveness was good during sampling. |
| TSN 1 resolve, one attempt | **4.446 s**; subsequent segment 2.59 MB in **88.83 ms** | Delay is before the stream is returned, not predominantly serving the prepared bytes. |
| BBC News resolve, one attempt | **8.827 s**; subsequent segment 3.34 MB in **93.17 ms** | Same pattern; one sample per channel does not separate cached profiles from cold probes. |
| Native recording playback API | Recording #3: **214 ms**; #4: **736 ms**, both HTTP 200 | Available recordings did not reproduce a minute-long wait. Their prior sidecar state was not established. These timings stop at URL readiness, not first picture. |
| Server suite | **843 passed**, zero failures/skips | Existing suite is green. Initial sandbox-only run failed because local test listeners were blocked; the unrestricted rerun passed. |
| Swift standalone contracts | **204 passed** | Synthetic API/model coverage, not full UI or device validation. Runner emitted actor-isolation warnings. |
| Local unsigned tvOS and iOS builds | Both succeeded | Confirms compilation, not interaction performance. No simulator destinations were available locally. |
| Latest Swift CI | 133 unit tests passed; UI suite failed with two assertions in one scheduled-cancellation/settings test; 3 UI tests skipped | Current release verification is not green. Failure was missing `Cancel schedule`, not a proven playback failure. |
| CI tab-switch test | Passed with worst stall **598 ms**, mean longest stall **156 ms** across 16 transitions | Existing one-second gate accepts visibly slow interaction. These are simulator frame-gap measurements, not device input latency. |
| Live security checks | Anonymous proxy to server loopback returned 200; anonymous one-byte recording request returned 206 | Media auth is not enforced and raw proxy allows a caller-chosen loopback destination. |
| Production relay state | `enabled: false`, `standby: false` | Experimental implementation exists but was not active in this deployment. |

Historical live diagnostics showed four mid-play interruptions over 10.7 watched hours, with one recorded recovery around 10 seconds. This is a small, mixed historical sample, not an experiment establishing current failover reliability. Recording storage health was OK with about 2.79 TB free. A previous recording failure attributed to a bad mount remains visible in history; it is not evidence the mount is broken now.

Raw bounded timing samples and verification notes are in [evidence](./evidence). [Current server CI](https://github.com/maroge1990/PigTV/actions/runs/37099891173) succeeded. [Current Swift CI](https://github.com/maroge1990/PigTV-Swift/actions/runs/37099900888) failed as described above. Older branding notes mention a provider-recovery test failure; that test **passed in the current CI run**, so the old failure must not be presented as current.

## Experience budgets to adopt

These are proposed acceptance targets, not promised gains. Establish the physical-device baseline first and adjust only with recorded justification.

| Journey | Proposed acceptance target |
|---|---|
| Warm Home ↔ Guide ↔ Sport | p95 remote input to actionable focus ≤100 ms; no transition above 250 ms over 100 switches |
| Focus movement within a visible shelf/grid | p95 visual response ≤50 ms; no sustained main-thread work above 100 ms |
| Background refresh | Existing cards remain actionable; preserve focus and scroll; no page-wide loading lock |
| Prepared local recording | p95 selection to first visible picture ≤2 s; preparation API ≤100 ms warm |
| New recording, phase-one solution | Preparation starts automatically after finalisation; no first-view-triggered full-file conversion when the queue has finished |
| New recording, long-term solution | A playable initial segment is available without waiting for the entire file to be rewritten |
| Predicted live channel with compatible warm stream | Trial target ≤2 s to first picture; measure TV display-mode switching separately |
| Ordinary uncached live channel | Measure stage-by-stage; do not promise subsecond starts across providers or shorten probes blindly |
| Live playback during guide rebuild / SMB slowdown | No missed segment deadlines attributable to blocking control-plane work |

Apple describes roughly 50–100 ms main-thread unresponsiveness as noticeable and recommends very short UI-update work. Use those expectations instead of the present one-second threshold. [Apple responsiveness guidance](https://developer.apple.com/documentation/xcode/understanding-user-interface-responsiveness), [SwiftUI performance tools](https://developer.apple.com/documentation/Xcode/understanding-and-improving-swiftui-performance).

## Prioritised work packages

Estimates are **engineering person-days** for someone familiar with the code, including focused tests and a normal review cycle. S = up to 2 days; M = 3–5; L = 6–10; XL = more than 10. Complexity describes technical uncertainty, not just line count. Hardware soak and user acceptance can add elapsed days. Optional packages are identified explicitly.

| ID | Priority | Work package | Owner | Estimate | Size / complexity | Depends on |
|---|---|---|---|---:|---|---|
| R01 | P0 | Close unauthenticated media and raw proxy access | Server | 2–4 d | M / medium | None |
| R02 | P1 | Fix recording codec probe parsing | Server | 1–2 d | S / low | None |
| R03 | P1 | Input-to-focus and playback-stage instrumentation; realistic fixtures | Both | 3–5 d | M / medium | None |
| R04 | P1 | Virtualise Sport and stabilise card/focus state | Swift | 3–5 d | M / medium | R03 baseline |
| R05 | P1 | Narrow observation and move derived work off the main actor | Swift | 3–5 d | M / medium | R03, R04 |
| R06 | P1 | Prepare completed recordings automatically | Server | 4–6 d | L / medium | R02 |
| R07 | P1 | Remove ancillary waits from recording start; truthful readiness | Swift | 1–2 d | S / low | R03 |
| R08 | P1 | Correct recording artifact publication and media validation | Server | 2–4 d | M / medium | R02; before R06 rollout |
| R09 | P1 | Isolate Sport rebuilds and network-storage I/O from serving | Server | 4–6 d | L / high | R03 |
| R10 | P1 | Restore meaningful CI and unique release identity | Both | 2–3 d | M / medium | None |
| R11 | P2 | Shared provider leases and predictive channel warming | Both | 8–12 d | XL / high | R01, R03, R09; stable playback baseline |
| R12 | P2 | Validate and expose relay/standby operation | Both | 4–6 d | L / high | R03, R10; coordinate with R11 |
| R13 | P2 | Immediately playable segmented recording architecture | Both | 8–12 d | XL / high | R02, R06, R08, R12; optional second phase |
| R14 | P2 | Account-scoped caches, correct invalidation and artwork pipeline | Swift | 3–5 d | M / medium | R03 |
| R15 | P2 | Targeted service boundaries and durable job lifecycle | Server | 4–6 d | L / medium | Fold into R06/R09/R11 where possible |
| R16 | P3 | Troubleshooting web usability and accessibility | Web | 1–2 d | S / low | R03 telemetry |
| R17 | P2 | Deployment hardening and restore rehearsal | Server/ops | 2–3 d | M / medium | R01 |

P0 = directly confirmed access issue; P1 = near-term user impact or release correctness; P2 = next-phase resilience and anticipatory behaviour; P3 = polish. R01 is an application-access issue on the reachable LAN/VPN service; public internet exposure was not assessed.

### R01 — Close unauthenticated media access and the raw proxy

**Confirmed, high confidence.** [auth.js:165](/Users/markrogers/Documents/GitHub/PigTV/server/auth.js:165) makes stream enforcement optional, and settings read failure defaults to permitting requests. [proxy.js:36](/Users/markrogers/Documents/GitHub/PigTV/server/routes/proxy.js:36) accepts `req.query.url` even when opaque handles are enabled. The production endpoint fetched its own loopback `/api/version` without a token. The recording media route also served a byte without authentication.

Implement authenticated media delivery as the normal mode, preserving token propagation through master playlists, media playlists, init segments and seek requests. Remove raw URL input from the public proxy; resolve channel identities to server-owned handles. If a diagnostic arbitrary-URL capability is retained, make it explicitly administrator-only and disabled normally. Validate permitted destinations and every redirect; scheme validation alone does not stop loopback/private-network access. Allow intended local media origins only through an explicit configuration policy.

Use current user/device validity checks for media and playback control, not only the role embedded in an old token. Longer-term issue scoped, expiring media grants instead of placing a full account/device bearer on every asset URL. Scrub tokens from diagnostic logs and use an appropriate referrer policy. Roll out with paired Apple TV, browser, recordings, HLS and range tests to avoid breaking legitimate playback.

Acceptance: missing/revoked credentials cannot read or create media work; raw loopback URL request is rejected; legitimate signed playback, seek, background segments and device revocation behave correctly. No configuration was changed during this audit.

### R02 — Fix actual codec detection, not just flag tests

**Confirmed by executable sample.** [recordingEngine.js:695](/Users/markrogers/Documents/GitHub/PigTV/server/services/recordingEngine.js:695) requests `stream=codec_type,codec_name` in CSV but destructures output as `[type, name]`. The installed ffprobe returned `h264,video` and `aac,audio`, leaving both detected codec fields null. ffprobe explicitly does not guarantee the requested field ordering. [Official ffprobe documentation](https://www.ffmpeg.org/ffprobe-all.html).

Read JSON and use named `codec_type`/`codec_name` fields. Bound the subprocess with timeout, output-size cap and termination cleanup. Add real tiny H.264/AAC, HEVC, and MPEG Layer II fixtures through the actual probe-to-remux path. Current native-playback tests substitute codec results, so their passing HEVC/AAC assertions cannot catch this parser defect.

Acceptance: actual HEVC output receives `hvc1`; AAC and MP2 branches execute as intended; unsupported codec combinations produce a controlled fallback or clear error. This is a compatibility defect, not proof it caused the minute-long latency.

### R03 — Measure the action the viewer experiences

**Confirmed coverage gap.** [TabSwitchUITests.swift](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTVUITests/TabSwitchUITests.swift) fails only above 1,000 ms; its wait result is discarded and failed numeric parsing defaults to `-1`. [TabBarStyle.swift:96](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/TabBarStyle.swift:96) begins the probe after the tab-change callback. It does not directly prove that a subsequent remote selection is accepted. The production-sized Sport case is absent: [GuideFixtures.swift:226](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/GuideFixtures.swift:226) returns 13 events even when the guide contains 1,000 channels.

Add signposts for input, tab selection, visible content, focus ready, model refresh, artwork decode, resolve, probe/profile hit, first segment, item readiness and actual playback/first visible frame. Separate display-mode blackout from network buffering. Correlate stages with a request ID; record app/server commits and cache state, never tokens/provider URLs.

Create a 215-event/153-replay fixture and a larger stress variant, realistic schedules and remote artwork delays. Assert the probe completed, values are nonnegative and the expected tab control can be focused and activated. Keep CI frame budgets tolerant of runner variability, but require the hardware budget separately. Use Release profiling with Instruments Time Profiler, Hangs and SwiftUI tools on the primary Apple TV. This first measurement package governs the rest of the roadmap.

### R04 — Make Sport proportional to the viewport

**Confirmed eager construction; high-confidence bottleneck hypothesis.** [SportView.swift:60](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/SportView.swift:60) uses a vertical `VStack`; [SportView.swift:180](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/SportView.swift:180) uses an eager `HStack` for each shelf. Every tile observes large app/browse objects and owns presentation state. The code comment assumes only a few dozen cards, contradicted by the 215-event live payload.

Start with lazy vertical and horizontal containers, immutable card inputs, stable IDs and explicit focus restoration. Keep the same content and brand treatment. Move selected-event presentation to a stable screen coordinator so an offscreen cell being recycled cannot lose an open detail page. Prebuild only the visible and adjacent items. If SwiftUI lazy focus proves unreliable on tvOS, reuse the UIKit collection-view approach already proven in the Guide; do not jump to a whole-app rewrite.

Acceptance: 100 repeated Home/Guide/Sport transitions meet the device budget; focus survives updates, scrolling away and back, details dismissal and league changes; all 153 replays remain reachable. Validate light/dark appearance, long-press menus and accessibility.

### R05 — Narrow invalidation and preserve prepared screen snapshots

**Confirmed broad observation; profile the contribution.** `BrowseModel` publishes guide, recordings, favourites, busy flags, schedules and errors through one `ObservableObject`. Sport shelves and tiles subscribe to it. `SportModel.keepFresh()` updates clock and buckets on appearance even inside its freshness interval. Home recomputes its content on every appearance and some updates inspect only ID arrays. See [BrowseModel.swift](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/BrowseModel.swift), [SportModel.swift](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/SportModel.swift), [HomeView.swift:196](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/HomeView.swift:196).

Split screen state from transport/repository state, or introduce narrowly observed stores. Compute Sport buckets, league filters, Home shelves and stable-identity indexes off the main actor from immutable snapshots; publish one coherent result when its generation still matches. Cache per-league presentation results by event revision/time boundary. A return to a warm tab should reveal retained data and focus immediately, with a background freshness check.

Do not retain every offscreen view indefinitely: retain lightweight data, scroll position and focus identity. Pause visual clocks for hidden screens, coalesce requests and keep stale content selectable on transient errors. Start useful first-page preparation after launch; avoid flooding the main actor or provider connections merely because tabs exist.

Acceptance: guide-page arrival and recording refresh no longer cause every Sport tile to recompute; unchanged input produces no full-shelf rebuild; canceled/outdated computations cannot overwrite newer state.

### R06 — Prepare recordings before the viewer asks

**Confirmed architecture; likely explanation for long fresh-play waits.** [recordingEngine.js:690](/Users/markrogers/Documents/GitHub/PigTV/server/services/recordingEngine.js:690) explicitly avoids eager remuxing. `ensureNativePlayback()` reads the original, writes a complete MP4 with `+faststart`, then atomically renames it. [recordings.js:274](/Users/markrogers/Documents/GitHub/PigTV/server/routes/recordings.js:274) triggers that operation from Play and returns polling responses. The live server does not advertise `recordingHls`.

On successful finalisation, enqueue a durable `native_prepare` job keyed by recording ID and source fingerprint. Start with one concurrent worker, prioritise a user-requested recording above background preparation, and let capture always outrank preparation/ad detection/compression. A remux generally preserves video quality; do not substitute lossy compression just to make a smaller file.

Persist `queued/preparing/ready/failed` plus progress, output identity and attempt information. Resume safely after restart; reconcile missing files, completed temporary outputs, deletion, compression replacement and storage outages. Avoid two jobs for the same recording. Show preparation state in the library before Play and make retry bounded. Stage work on appropriate fast storage if measurements justify it, but publish final artifacts atomically on their destination filesystem; cross-filesystem rename is not atomic.

Acceptance: a new full-length recording is prepared without any playback request; its first subsequent Apple TV play performs no full-file conversion. Measure completion-to-ready under simultaneous recording/ad detection and on the real recording share. This first phase cannot guarantee immediate playback the instant a multi-gigabyte recording finishes; R13 addresses that remaining gap.

### R07 — Keep recording startup’s critical path small

**Confirmed unnecessary serial wait.** [RecordingPlayback.swift:86](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/RecordingPlayback.swift:86) awaits commercial markers before requesting playback. A marker request can consume the general request timeout even though missing markers should not prevent video. `ready` is set before `player.play()`, so it is not actual first-picture readiness.

Fetch markers independently with cancellation/generation guards and a short bounded budget. Install and start the playable item as soon as the media URL and audio session are ready. Apply skip markers when available. Expose preparation, buffering and playing separately; measure resumed seeks separately from fresh playback. Keep display criteria loading asynchronous as the existing implementation already does.

Acceptance: delayed/failed marker endpoint adds no time to first picture; cancel/back cannot install a late item; retry and resume work on Apple TV and iPad. This is a quick improvement, but it does not remove a full recording remux by itself.

### R08 — Publish only complete, validated recording artifacts

**Confirmed lifecycle gaps.** Native remux uses an atomic partial-file pattern, but [readyNativePlaybackPath](/Users/markrogers/Documents/GitHub/PigTV/server/services/recordingEngine.js:734) trusts any existing compressed target. Compression writes directly to that target while running ([recordingEngine.js:522](/Users/markrogers/Documents/GitHub/PigTV/server/services/recordingEngine.js:522)), so concurrent playback can pick up an unfinished MP4. Compression duration verification also accepts unknown duration (`!sourceDuration || !newDuration`).

Write compression to a private temporary output, verify required tracks and readable duration, then publish atomically and commit database state. Never delete the original on unknown verification results. Fingerprint ready artifacts so in-memory validation does not outlive a replacement, missing file or changed source. Introduce subprocess deadlines and cleanup for hung probes/remuxes.

Recording success currently treats a file larger than 1 KB as usable completion and stores wall-clock duration. Preserve partial captures, but distinguish a validated complete programme, a partial capture, an unverified capture and a failed capture. The 12-second recording observed live might have been deliberately stopped; it is not evidence of a new failure. Test early EOF, restart, missing mount, stalled read, interrupted compression and concurrent playback explicitly.

### R09 — Keep metadata work and slow storage off the serving loop

**Confirmed scheduling misconception; production impact not quantified.** [sportsEvents.js:490](/Users/markrogers/Documents/GitHub/PigTV/server/services/sportsEvents.js:490) runs `buildEvents()` synchronously. `scheduleRebuild()` schedules it with `setImmediate`, which still executes on the same Node event loop. It does not let HLS requests run during the computation. A stale cache without a matching rebuild also rebuilds synchronously inside a request.

Move event construction to a worker with an independent read-only database connection or use genuinely bounded cooperative chunks. Keep serving the last valid snapshot and atomically publish the new one; include revisions, build duration and stale age. Schedule and coalesce rebuilds, including startup. Avoid serialising/copying the whole database just to feed a worker.

`recordings.js` performs synchronous `stat` and playlist reads, and recording/status code uses synchronous filesystem operations on the network-backed recording volume. A slow SMB mount can therefore affect unrelated API and live requests despite ample CPU. Convert request-path I/O to asynchronous operations, cache filesystem health, and isolate potentially stuck storage work. Ensure file read streams handle errors and disconnects without crashing or leaking work.

Acceptance: concurrent HLS retrieval and version/API latency remain within budget during a large Sport rebuild and an injected slow-storage test in a safe environment. Add event-loop-delay and worker-queue measurements. Do not infer success from function names containing “background”.

### R10 — Make release verification describe the actual release

**Confirmed.** Current Swift CI fails in `BrandDepthUITests.testScheduledRecordingCancellationAndSettingsFooter`: it cannot find/focus `Cancel schedule`. Inspect whether fixture state, changed wording or a real interaction regression causes it; fix that cause rather than simply increasing timeouts. The existing tab test passed with 598 ms, so a green test name is not proof of responsiveness.

Give every distributed Swift build a unique build number and commit identity; several newer commits still report build 36. Generate build facts and test counts rather than duplicating stale values across READMEs and blueprints. Align the standalone contract runner’s language/isolation assumptions with the app or document deliberate differences; its warnings should not be confused with the successful full Swift 6 build.

Require current server tests, current native unit/UI checks and selected physical playback/focus checks before declaring a release verified. Attach release-mode timing evidence, preserve rollback images and record production flags. Separate historical failures from currently reproducible ones.

### R11 — Predictive channel warming with explicit resource ownership

**Opportunity, not an existing measured capability.** The measured 4.45–8.83 second resolves give useful headroom to hide preparation behind likely intent. The existing channel profiles already avoid some probes, so do not propose them as a new feature.

Add short-lived warm leases through the same provider coordinator as live playback and DVR. A lease records purpose, owner, provider/account pool, channel identity, capabilities, segment readiness and expiry. Reserve capacity atomically **before** asynchronous probing; release on failure, cancellation, departure and timeout. A requested play should adopt a compatible warm session rather than release it and resolve again.

Initial policy: recording obligations first, actual viewing next, same-channel resilience standby next, speculative next-channel preparation last. Preserve the existing explicit takeover behaviour for real viewers. A speculative lease never prompts a user or displaces a recording/viewer. When only one spare connection remains, prefer continuity of the programme being watched; when browsing without playback, warm the likely first selection. Expose this policy so it can be tuned from evidence.

Use a short focus-dwell/debounce and confidence signal: last channel, immediately adjacent channel, selected live Sport event. Limit to one speculative warm channel initially. Cancel rapid-focus churn, impose a short TTL and suppress work when the app backgrounds. Record hit rate, unused provider seconds, stream failures and time saved. Do not consume a connection for metadata, artwork or ordinary menu navigation.

Acceptance: simultaneous viewing, scheduled recording and preloading never exceed per-account capacity; near-simultaneous contenders cannot both claim the last slot; a selected compatible warm channel actually reuses its media pipeline. Evaluate more providers only after measuring useful warm-hit rate.

### R12 — Validate the existing relay and standby before relying on it

**Implementation exists; production flags were off.** [streamRelay.js](/Users/markrogers/Documents/GitHub/PigTV/server/services/streamRelay.js) starts standby after 20 seconds, uses two tail segments and checks that a second provider has free capacity. [streamCoordinator.js](/Users/markrogers/Documents/GitHub/PigTV/server/services/streamCoordinator.js) already reclaims standbys ahead of viewers for recordings. Keep those useful rules.

Validate atomic admission with R11’s lease model: `hasFreeConnection()` followed by an awaited start is not itself an atomic reservation. Check matching audio/video codec configuration, resolution, frame rate, HDR and discontinuity behaviour; the current `joinable()` gate compares segment type and video range only. This is a compatibility risk requiring a real-feed matrix, not proof all differing feeds fail. Cross-provider programmes can be offset in time, so a warm switchover does not automatically mean seamless content continuity.

Expose configured/enabled/starting/ready/promoted/reclaimed states and reason codes in Status and playback diagnostics. Run sustained primary-stop, silent-stall, incompatible-backup, all-providers-down and recording-preemption scenarios. Test fallback to an ordinary fresh resolve when a standby cannot join. Do not enable the experiment by default until Apple TV output, sound and frame-rate/HDR behaviour pass.

### R13 — Make new recordings playable without a whole-file rewrite

**Optional architectural phase after R06.** Existing tuner/HLS code provides a starting point but the ordinary path, multi-provider parts and failure recovery must remain consistent. In [playback.js](/Users/markrogers/Documents/GitHub/PigTV/server/routes/playback.js), tuner handling is a separate path described as primary-only; simply turning it on would not establish parity with current multi-provider behaviour.

Prototype recording directly into robust HLS/fMP4 segments with a persistent manifest/index, or a progressively generated playback package from the source. Serve completed segments immediately, retain original quality, and finalise an optional MP4 download in the background. Preserve seeking, resume, ad-marker timestamps, HEVC/HDR metadata, stream changes and partial/provider-failover recordings. Account for segment inode/storage overhead and deletion/restart recovery.

Acceptance: a fresh long recording starts before any whole-file remux completes; its playable duration grows safely; no source is discarded until the archival output is validated. Compare against the simpler eager-MP4 solution before committing to this larger change.

### R14 — Make caching correct, scoped and bounded

**Confirmed defects and opportunities.** `BrowseModel.cacheURL` uses one `pigtv-guide.json`, without server/account identity, and sign-out clears Top Shelf/history but not this guide file. `ChannelArtwork`’s static decoded cache keys by raw logo string; relative paths can collide between servers. The artwork disk cache has no evident age/size eviction, misses are not coalesced, and a downloaded image is written synchronously on the app’s default main-actor path. See [BrowseModel.swift:72](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/BrowseModel.swift:72), [APIClient.swift:258](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/APIClient.swift:258), [ChannelArtwork.swift](/Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/ChannelArtwork.swift).

Namespace private data by server, account and schema version; purge or invalidate appropriately on sign-out. Key artwork by canonical URL and content revision, coalesce in-flight fetch/decode, move writes off-main, set decoded-byte budgets and disk LRU limits, and reject oversized responses during transfer rather than only after download. Warm visible/adjacent artwork first.

Fix semantic invalidation too: `GuideGridStore.programmes()` caches by channel/count/first start only, so equal-shaped programme corrections can stay stale. Home watches several ID arrays, which can miss content/status changes when IDs stay the same. Use explicit content revisions or meaningful equality, and bound cache retention. Add tests for two servers with overlapping IDs, same-count EPG corrections, changed recording status and late callbacks after logout.

### R15 — Extract boundaries where they support the work

The server has good domain modules, but `recordingEngine.js` is 2,090 lines, `transcodeSession.js` 1,706 and `streamCoordinator.js` 932. They combine process ownership, scheduling, filesystem work, state and policy. Refactor along the work already needed: a recording-artifact/job service for R06/R08, provider leases for R11, a process supervisor with deadlines/cleanup, and snapshot construction for R09. Keep routes as adapters and use one canonical server/client playback contract.

Avoid a standalone “rewrite architecture” project. Add state-transition and restart tests at extracted boundaries. Persist durable jobs; keep ephemeral live sessions intentionally disposable. Ensure shutdown drains or terminates owned processes and marks interrupted jobs recoverable. This allowance overlaps implementation in other packages and should not automatically be added twice.

### R16 — Improve the web as a troubleshooting instrument

The narrow web viewport inspected during the audit exposed icon links with no accessible names: visible text spans are hidden and the links lack `aria-label`. Add permanent accessible names, selected-page state, keyboard focus and usable tooltips. Source: [index.html:38](/Users/markrogers/Documents/GitHub/PigTV/public/index.html:38), [main.css:2033](/Users/markrogers/Documents/GitHub/PigTV/public/css/main.css:2033).

Expand Status with stage timings, cache/profile hits, native preparation queue, playback-ready state, event-loop delay, provider lease purpose and standby readiness. Mark API-only audit attempts separately from genuine first-picture events where possible. Avoid replacing whole diagnostic sections every five seconds when nothing changed; pause polling when hidden and keep logs bounded/redacted. Give this less priority than Apple TV responsiveness.

### R17 — Harden deployment and rehearse recovery

The Dockerfile has no non-root `USER`, retains runtime build tooling and applies broad writable permissions to media/cache directories. Adopt a dedicated runtime identity with only necessary volume and GPU group access, a multi-stage build where practical, a health/readiness signal and pinned/reproducible dependency inputs. Reconcile the package’s Node ≥18 claim with the Node 24 deployment/native dependency requirements.

Document and test an application-consistent SQLite backup/restore, configuration recovery, provider-secret handling and recording-volume remount. Preserve the correct Unraid mount propagation. Report source health, storage health and readiness independently so a working HTTP endpoint does not imply recording is safe. These changes need a deployment rehearsal because Unraid permissions and GPU access can regress.

## Delivery sequence and estimated programme size

**First increment — correctness and baseline (about 1–2 working weeks elapsed for one engineer).** R01, R02, R03 and the immediate CI repair/release identity work from R10. Capture physical Apple TV baselines before UI changes. Correct the codec bug before changing recording preparation. Validate media authentication with existing clients before applying it to normal viewing.

**Second increment — the visible speed win (about 2–4 additional working weeks).** R04/R05 make warm navigation immediately interactive. R07 removes marker waiting. R08 then R06 makes completed recordings ready ahead of first viewing. Ship these as small independent releases where possible so gains and regressions are attributable. R09 protects playback from metadata rebuilds and slow storage.

The complete P0/P1 package set **R01–R10 totals 25–42 engineering days** before overlap or contingency. That is roughly 5–9 working weeks for one engineer; the first noticeable Sport/recording improvements should arrive before the whole tranche is finished. With separate Swift and server implementers, portions can run concurrently, but shared contracts and physical-device acceptance still need coordination.

**Third increment — anticipation and resilience.** R11/R12 add and validate provider-aware warming. R14 fixes cache boundaries and freshness. R17 hardens operations. R16 remains a small diagnostic usability package. Use a staged flag rollout and a several-evening hardware soak; measure both unused preparation and successful instant selections.

**Optional fourth increment — immediate recording availability.** R13 is justified if completion-triggered preparation still misses the desired first-view window. Decide from full-length recording measurements, not preference for a more elaborate pipeline.

All listed packages total **55–88 person-days**, including optional R13 and the R15 refactoring allowance. This is an upper planning envelope before de-duplicating R15’s overlap; apply approximately 20–30% contingency to committed estimates until profiling and storage experiments are complete. These are not fixed-price quotes or a claim that all work must happen before the app feels faster.

## Validation and rollout plan

1. **Baseline:** primary Apple TV, wired LAN, Release build, actual selected library; 100 warm tab transitions, 20 cold launches and controlled refreshes. Capture focus actionability, longest stall, allocations and memory after repeated loops. Repeat core journeys on M2 iPad, not a broad Mac/iPhone programme.
2. **Recordings:** short and full-length captures; H.264/AAC, HEVC, alternate audio; first/warm play, resume, seek, markers unavailable, mid-preparation restart, compression during playback, storage disconnect/reconnect in a test environment, cancellation and deletion racing preparation. Preserve originals during fault tests.
3. **Live:** profile-hit/miss, short/long GOP, SD/HD/UHD, SDR/HDR, primary plus two backups, incompatible standby, repeated failures, rapid zapping and all-capacity-used. Record first visible picture and audio continuity, not just HTTP success.
4. **Resource contention:** recording begins while one viewer, one standby and one prediction are active; second-device admission; recording preemption prompts; canceled resolves; two simultaneous contenders for one account. Assert capacity throughout the operation, including probes and teardown delay.
5. **Security:** missing, expired and revoked grants; raw proxy URLs; redirects; range and HLS URI authentication; hostile oversized manifests/images; redaction. Keep local-provider access an explicit configuration case.
6. **Release:** current CI green, unique commit/build visible in client and server, change flag/rollback path documented, measured before/after results attached. Keep image quality, HDR/frame rate, remote focus and recording completion as gates, not optional follow-ups.

Success is a concrete combination: the remote works immediately when a tab appears; an already finished recording is already prepared; a likely channel is warm without stealing a recording’s connection; and failures remain diagnosable and recoverable.

## Reproduction material

- [Bounded server measurement script](./measure-server.py): authenticated metadata timings by default; `--live` explicitly opens two sequential sample channels and releases each. The recorded source/channel IDs belong to this audited deployment and must be rechecked before reuse after catalogue changes. Supply credentials through `PIGTV_AUDIT_TOKEN`; never commit them.
- [Live API measurements](./evidence/server-measurements-live.json) and [read-only measurements](./evidence/server-measurements.json).
- [Current CI excerpts](./evidence/swift-ci-excerpt.txt), [verification summary](./evidence/verification.txt), and [post-test server state](./evidence/server-state-summary.json).

Source references refer to the audited checkout/commits above. This roadmap is a separate deliverable; the original repositories remain unchanged.
