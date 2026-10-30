# Apple client deep review — 21 October 2026 window

Reviewed HEAD `8f09ea3` (build 46). Fixed window: 23 September 2026 00:00 +10 through 21 October 2026 23:59:59 +11. Report continued on 22 October after interruption. No application source changes, commits, provider requests or deployed-server access.

## Scope and evidence limits

Newest-first commit classification follows below, tracing retained implementation and later corrections before assessing older attempts. Functional diffs and current owners were inspected across playback, recordings, guide, stores, caches, auth and Top Shelf. Every non-merge commit is classified; this is not a claim that every historical deleted line or binary asset was audited. Some broad historical diff output was truncated; retained behavior and focused diffs received deeper review. Hardware visual quality, real-provider formats and device lifecycle acceptance remain pending. “Current” means retained implementation, not user-verified outcome.

## Confirmed findings

### A1 — P2: Recording resume fallback crosses server/account boundaries

Evidence: [key and read](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/RecordingPlayback.swift:70), [shared local key](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/RecordingProgress.swift:16), [fallback selection](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/RecordingResume.swift:17), [logout cleanup](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/AppModel.swift:227), [existing test explicitly asserts fallback](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTVTests/RecordingResumeTests.swift:14).

`PigTV/RecordingPlayback.swift` builds the local key as `pigtv.resume.<recording.id>` and reads/saves that key. `RecordingProgress.swift` uses the same ID-only convention. `RecordingResume.swift` selects local state when the server position lookup returns nil, including a timeout/failure while server resume is enabled. `AppModel.clearSession` does not clear or scope these keys. Consequently server A/account A's recording 42 can supply a resume position for server B/account B's unrelated recording 42 when its position lookup fails, or when using an older server. Build 41's per-login server positions do not close this fallback path.

Fix: scope persisted local progress by canonical server, authenticated account and recording identity; deliberately retire or migrate legacy keys without applying them to an unknown identity. Ensure Home Continue and playback use the same scope. Add two-server/two-account same-ID tests, failed/timed-out position lookup, sign-out/re-login and disabled-feature cases. Source-confirmed; no real account data was accessed.

### A2 — P2: Top Shelf can republish signed-out account data

Evidence: [render task](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/TopShelfCards.swift:243), [detached save](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/TopShelfExport.swift:71), [detached clear](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/TopShelfExport.swift:107), [cache retirement](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/BrowseModel.swift:78), [logout](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/AppModel.swift:227).

`TopShelfCards.swift` keeps a static render task whose cancellation happens only when another render is scheduled. It awaits artwork and then calls `TopShelfExport.save`. `TopShelfExport.swift` launches detached writes; `clear` launches a detached deletion, with no shared publication generation or ordering. `BrowseModel.retirePrivateCaches` retires only the guide cache. Logout can therefore delete the snapshot and then have an already running render or save recreate it; late old-account guide/favourite completion can also schedule publication after retirement. The clear operation does not establish an enduring privacy boundary.

Fix: give all rendering, snapshot publication and clear operations one session-generation owner. Retire the generation before logout, cancel pending render work, and check generation inside serialized publication immediately before file mutation. Guard late guide/favourite exports too. Add delayed-logo logout, late-guide completion, old-save/new-account-save reordering and clear-after-save tests. This is a source-confirmed interleaving, not a physical Top Shelf reproduction.

### A3 — P2: Recording rule mutation errors are invisible in the sheet

Evidence: [mutation catches](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/BrowseModel.swift:717), [rules sheet](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/RecordingsView.swift:682), [only success displayed](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/RecordingsView.swift:717).

`BrowseModel.setRule` and `deleteRule` catch failures into `actionError`. `RecordingRulesSheet` in `RecordingsView.swift` displays its own GET/reload error and `actionMessage`, but never the mutation's `actionError`. Each mutation is followed by reload, so a failed PUT/DELETE followed by successful GET silently presents the unchanged rule. This leaves users unable to distinguish failure from an action that worked.

Fix: render mutation errors in the sheet, clear stale success feedback before mutations, expose mutation result and serialize/disable actions while pending. Add failed PUT and failed DELETE with successful subsequent GET UI/model tests. Current success fixtures do not establish error visibility.

### Related already-reported efficiency gap

Artwork memory/fetch coalescing and background disk writes are implemented. Disk pruning is launch-only, so the claimed bound is not maintained during a long-running browsing session. See the parent review's existing cache finding; do not count this twice.

## Newest-first coverage ledger

Disposition notes include superseding commits and acceptance gaps. File lists are the actual changed files; test files show coverage introduced or modified by that commit, not proof that every intent is asserted.

### 8f09ea3 — 2026-10-18 — Build 46: one header position on every tab, iPhone Guide search icon, no player TV Guide pill, tvOS fast-scroll snap-back

**Current correction; hardware acceptance pending.** Shared metrics now own actual header placement; compact search is explicit, redundant control removed and plannedRow cleared. Supersedes 42's incomplete header alignment. Current tests: PageHeaderPlacement/TouchLayout/GuideFastScroll.

Changed: `AGENTS.md`, `PigTV.xcodeproj/project.pbxproj`, `PigTV/ContentView.swift`, `PigTV/GuideGridView.swift`, `PigTV/GuideView.swift`, `PigTV/HomeView.swift`, `PigTV/LibraryView.swift`, `PigTV/PlayerExtras.swift`, `PigTV/RecordingsView.swift`, `PigTV/SportView.swift`, `PigTV/TVActionStyle.swift`, `PigTVUITests/GuideFastScrollUITests.swift`, `PigTVUITests/PageHeaderPlacementUITests.swift`, `PigTVUITests/TouchLayoutUITests.swift`, `TESTING.md`, `blueprint.md`.

Test evidence changed: `PigTVUITests/GuideFastScrollUITests.swift`, `PigTVUITests/PageHeaderPlacementUITests.swift`, `PigTVUITests/TouchLayoutUITests.swift`, `TESTING.md`.

### 4e3046b — 2026-10-16 — docs: builds 44-45 in the blueprint (watch from start, rules, artwork) and the current build

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `AGENTS.md`, `blueprint.md`.

### f8b98e4 — 2026-10-16 — Build 45: recording rules and programme artwork (C-M, C-N; server 0219, 0220)

**Current with defect A3.** Flag-gated rule actions and artwork decode exist. Rule mutation failures are not rendered by the rule sheet; the success-only contract fixtures do not cover that UI failure.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/BrowseModel.swift`, `PigTV/DVRModels.swift`, `PigTV/DetailScreens.swift`, `PigTV/Models.swift`, `PigTV/RecordingsView.swift`, `PigTV/SportPages.swift`, `PigTVTests/ContractChecks.swift`.

Test evidence changed: `PigTVTests/ContractChecks.swift`.

### fe0173c — 2026-10-16 — Build 44: watch a recording from the start while it records (C-L, server 0218)

**Current; lifecycle acceptance pending.** Bounded watch polling, feature gate and same-position file fallback are present. RealPlaybackTests drives the live-end seam; physical HEVC/discontinuity/restart and actual notification timing remain acceptance tasks.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/APIClient.swift`, `PigTV/DVRModels.swift`, `PigTV/DetailScreens.swift`, `PigTV/DisplayMode.swift`, `PigTV/Models.swift`, `PigTV/RecordingPlayback.swift`, `PigTV/RecordingsView.swift`, `PigTVTests/ContractChecks.swift`, `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`.

### a6482af — 2026-10-16 — Build 43: the larger tvOS app icon (kit 1.7.1, option B)

**Current; visual acceptance pending.** Asset integration is later than the undersized original. Device icon/parallax acceptance cannot be inferred from an asset commit.

Changed: `AGENTS.md`, `PigTV.xcodeproj/project.pbxproj`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Back.imagestacklayer/Content.imageset/back@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Front.imagestacklayer/Content.imageset/front@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Content.imageset/back@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Content.imageset/back@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Content.imageset/front@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Content.imageset/front@2x.png`.

### 78eb3dd — 2026-10-16 — Build 42: one page header, iPhone category refresh, no "cancelled" errors

**Partly superseded; current refresh/error fixes.** Identity-based favourites and shared filter observer correct invalidation; visible recordings refresh and cancellation filtering remain. Header placement corrected again in 46; tuning hint is mitigation only.

Changed: `AGENTS.md`, `PigTV.xcodeproj/project.pbxproj`, `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/ContentView.swift`, `PigTV/GuideFixtures.swift`, `PigTV/GuideView.swift`, `PigTV/HomeView.swift`, `PigTV/LibraryView.swift`, `PigTV/Models.swift`, `PigTV/PlayerShared.swift`, `PigTV/RecordingProgress.swift`, `PigTV/RecordingsView.swift`, `PigTV/SportModel.swift`, `PigTV/SportView.swift`, `PigTV/TVActionStyle.swift`, `PigTVTests/ContractChecks.swift`, `PigTVTests/PlayerSharedTests.swift`, `PigTVTests/RecordingsRowsTests.swift`, `PigTVUITests/PhoneGuideFilterUITests.swift`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVTests/PlayerSharedTests.swift`, `PigTVTests/RecordingsRowsTests.swift`, `PigTVUITests/PhoneGuideFilterUITests.swift`.

### 3eff8cd — 2026-10-16 — docs: commit-only workflow and the 15 Oct review note

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `AGENTS.md`, `blueprint.md`.

### 63f9a43 — 2026-10-14 — tests: run in tiers, cheapest first (Tools/test.sh)

**Test/harness change.** Coverage or runner adjustment; no separate production behavior claim.

Changed: `AGENTS.md`, `TESTING.md`, `Tools/test.sh`.

Test evidence changed: `TESTING.md`, `Tools/test.sh`.

### 6889c18 — 2026-10-13 — docs: AGENTS.md, a trimmed blueprint, working test commands

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `TESTING.md`, `blueprint.md`, `docs/SERVER-REQUESTS.md`, `docs/archive/README.md`, `docs/archive/SERVER-REQUESTS-2026-09-26.md`, `docs/archive/blueprint-2026-10-13.md`, `docs/archive/brand-standard-1.0-2026-10-02.md`, `docs/brand-standard.md`.

Test evidence changed: `TESTING.md`.

### 72beb6f — 2026-10-10 — Build 41: recordings grid, landscape guide, resume, landscape player, PiP

**Current with defect A1; PiP acceptance pending.** Per-login server resume has unscoped local fallback. Recording grid/delete/failure workflows and touch playback exist. Actual auto-PiP/background/restoration needs device tests.

Changed: `AppConfiguration-iOS.plist`, `PigTV.xcodeproj/project.pbxproj`, `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/ContentView.swift`, `PigTV/DVRModels.swift`, `PigTV/GuideFixtures.swift`, `PigTV/GuideView.swift`, `PigTV/HomeView.swift`, `PigTV/Models.swift`, `PigTV/PigTVApp.swift`, `PigTV/PlaybackWindow.swift`, `PigTV/PlayerExtras.swift`, `PigTV/RecordingPlayback.swift`, `PigTV/RecordingProgress.swift`, `PigTV/RecordingResume.swift`, `PigTV/RecordingTouchChrome.swift`, `PigTV/RecordingsView.swift`, `PigTVTests/RecordingResumeTests.swift`, `PigTVTests/RecordingsRowsTests.swift`, `PigTVUITests/RecordingsUITests.swift`.

Test evidence changed: `PigTVTests/RecordingResumeTests.swift`, `PigTVTests/RecordingsRowsTests.swift`, `PigTVUITests/RecordingsUITests.swift`.

### d007d8e — 2026-10-10 — Build 40: Pig family brand 1.6.0

**Current brand baseline; icon superseded.** New kit integration replaces Spotlight artwork. 43 supersedes icon sizing; 46 supersedes header placement. Source helpers reviewed; no fresh visual acceptance.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/AppIcon.icon/Assets/body-mono.svg`, `PigTV/AppIcon.icon/Assets/body.svg`, `PigTV/AppIcon.icon/Assets/face-mono.svg`, `PigTV/AppIcon.icon/Assets/face.svg`, `PigTV/AppIcon.icon/Assets/halo-dark.png`, `PigTV/AppIcon.icon/Assets/halo-light.png`, `PigTV/AppIcon.icon/icon.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Back.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Back.imagestacklayer/Content.imageset/back@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Back.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Front.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Front.imagestacklayer/Content.imageset/front@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Front.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Middle.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Middle.imagestacklayer/Content.imageset/middle@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Middle.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Content.imageset/back@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Content.imageset/back@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Content.imageset/front@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Content.imageset/front@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Middle.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Middle.imagestacklayer/Content.imageset/middle@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Middle.imagestacklayer/Content.imageset/middle@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Middle.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image Wide.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image Wide.imageset/shelf@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image Wide.imageset/shelf@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image.imageset/shelf@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image.imageset/shelf@2x.png`, `PigTV/Assets.xcassets/AppIcon.appiconset/Contents.json`, `PigTV/Assets.xcassets/AppIcon.appiconset/icon-dark.png`, `PigTV/Assets.xcassets/AppIcon.appiconset/icon-light.png`, `PigTV/Assets.xcassets/AppIcon.appiconset/icon-tinted.png`, `PigTV/Assets.xcassets/BrandGlow.imageset/Contents.json`, `PigTV/Assets.xcassets/BrandGlow.imageset/glow.png`, `PigTV/Assets.xcassets/BrandPlate.imageset/Contents.json`, `PigTV/Assets.xcassets/BrandPlate.imageset/dark.png`, `PigTV/Assets.xcassets/BrandPlate.imageset/light.png`, `PigTV/Assets.xcassets/BrandWordmark.imageset/Contents.json`, `PigTV/Assets.xcassets/BrandWordmark.imageset/dark.png`, `PigTV/Assets.xcassets/BrandWordmark.imageset/light.png`, `PigTV/Assets.xcassets/BrandWordmark.imageset/wordmark-dark.svg`, `PigTV/Assets.xcassets/BrandWordmark.imageset/wordmark-light.svg`, `PigTV/Assets.xcassets/LaunchBrand.imageset/phone@2x-dark.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/phone@2x.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/phone@3x-dark.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/phone@3x.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/tv@2x-dark.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/tv@2x.png`, `PigTV/Assets.xcassets/PigDanger.colorset/Contents.json`, `PigTV/Assets.xcassets/PigHover.colorset/Contents.json`, `PigTV/Assets.xcassets/PigLogo.imageset/Contents.json`, `PigTV/Assets.xcassets/PigLogo.imageset/PigLogo.png`, `PigTV/Assets.xcassets/PigLogo.imageset/mark.svg`, `PigTV/Assets.xcassets/PigSuccess.colorset/Contents.json`, `PigTV/Assets.xcassets/PigWarning.colorset/Contents.json`, `PigTV/BrandLayout.swift`, `PigTV/BrandSplash.swift`, `PigTV/ContentView.swift`, `PigTV/CustomPlayer.swift`, `PigTV/DetailComponents.swift`, `PigTV/DetailScreens.swift`, `PigTV/GuideGridCells.swift`, `PigTV/GuideGridView.swift`, `PigTV/GuideStyle.swift`, `PigTV/HomeView.swift`, `PigTV/LibraryView.swift`, `PigTV/OnNowList.swift`, `PigTV/PageBackdrop.swift`, `PigTV/PlayerExtras.swift`, `PigTV/RecordingPlayer.swift`, `PigTV/RecordingsView.swift`, `PigTV/SportCards.swift`, `PigTV/SportPages.swift`, `PigTV/SportView.swift`, `PigTV/TVActionStyle.swift`, `PigTVUITests/BrandSplashUITests.swift`, `TESTING.md`, `Tools/make-brand-assets.swift`, `Tools/render-launch.swift`, `Tools/sync-brand.sh`, `blueprint.md`.

Test evidence changed: `PigTVUITests/BrandSplashUITests.swift`, `TESTING.md`.

### 156ab0e — 2026-10-04 — Build 39: guide long-press test waits for the details cover to settle

**Test/harness change.** Coverage or runner adjustment; no separate production behavior claim.

Changed: `PigTVUITests/GuideGridNavigationUITests.swift`.

Test evidence changed: `PigTVUITests/GuideGridNavigationUITests.swift`.

### af511a6 — 2026-10-04 — chore: build 39; blueprint for the simplification build

**Current cleanup/build metadata.** Small model/layout/cache cleanup accompanies version bump; original growing-recording model removed, not validated by this bump.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/DVRModels.swift`, `PigTV/GuideGridLayout.swift`, `PigTV/GuideStyle.swift`, `PigTV/PrivateCaches.swift`, `blueprint.md`.

### dd317d8 — 2026-10-04 — simplify: the largest app files split by type; tests wait for state, not a fixed time

**Current structural refactor.** File/type separation and state-based test waits; no independent runtime speedup implied. PlaybackFallback, GuideGridSupport, PlayerControls and SportPages remain owners.

Changed: `PigTV/CustomPlayer.swift`, `PigTV/GuideGridSupport.swift`, `PigTV/GuideGridView.swift`, `PigTV/GuideStyle.swift`, `PigTV/GuideView.swift`, `PigTV/PlaybackFallback.swift`, `PigTV/PlaybackModel.swift`, `PigTV/PlayerControls.swift`, `PigTV/SportCards.swift`, `PigTV/SportPages.swift`, `PigTV/SportView.swift`, `PigTVTests/ObservationTests.swift`, `PigTVUITests/BrandDepthUITests.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`, `PigTVUITests/Waiting.swift`.

Test evidence changed: `PigTVTests/ObservationTests.swift`, `PigTVUITests/BrandDepthUITests.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`, `PigTVUITests/Waiting.swift`.

### 8eef2ee — 2026-10-04 — simplify: Start over, the timeshift window and HLS recordings are gone from the app

**Deliberate removal; later replacement.** Retires old tuner Start-over/window/HLS paths. New C-L watch-from-start in 44 is separate, not resurrection of old C-E implementation.

Changed: `PigTV/AppModel.swift`, `PigTV/CustomPlayer.swift`, `PigTV/DVRModels.swift`, `PigTV/HomeView.swift`, `PigTV/Models.swift`, `PigTV/PlaybackModel.swift`, `PigTV/PlayerExtras.swift`, `PigTV/PlayerShared.swift`, `PigTV/PlayerTimeMath.swift`, `PigTV/RecordingPlayback.swift`, `PigTV/RecordingPlayer.swift`, `PigTV/RecordingsView.swift`, `PigTV/Timeshift.swift`, `PigTVTests/ContractChecks.swift`, `PigTVTests/PlayerSharedTests.swift`, `PigTVTests/PlayerTimeMathTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `PigTVTests/TimeshiftMathTests.swift`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVTests/PlayerSharedTests.swift`, `PigTVTests/PlayerTimeMathTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `PigTVTests/TimeshiftMathTests.swift`.

### 1aa8210 — 2026-10-04 — test: the recovery-allowance test waits for the model to know it played

**Test correction.** Wait for actual playing evidence before recovery allowance test; does not independently prove hardware recovery.

Changed: `PigTV/PlaybackModel.swift`, `PigTVTests/ProviderFailoverTests.swift`.

Test evidence changed: `PigTVTests/ProviderFailoverTests.swift`.

### 3cd33c0 — 2026-10-04 — docs: build 38 in the blueprint (Phase 3 client work, test baseline)

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `blueprint.md`.

### ffabd68 — 2026-10-04 — chore: build 38

**Build metadata / supporting change.** Version/build or harness support; no independent feature outcome established.

Changed: `PigTV.xcodeproj/project.pbxproj`.

### c6acddb — 2026-10-04 — perf: screens observe only what they show (audit R05)

**Current; isolation incomplete at session boundary.** Small stores and equality suppression retained. Guide private-cache retirement works, but Top Shelf export retirement is missing (A2).

Changed: `PigTV/BrowseModel.swift`, `PigTV/BrowseStores.swift`, `PigTV/DetailComponents.swift`, `PigTV/DetailScreens.swift`, `PigTV/GuideSheets.swift`, `PigTV/GuideView.swift`, `PigTV/HomeModel.swift`, `PigTV/HomeView.swift`, `PigTV/OnNowList.swift`, `PigTV/PlayerExtras.swift`, `PigTV/RecordingsView.swift`, `PigTV/SportModel.swift`, `PigTV/SportView.swift`, `PigTV/WhileVisible.swift`, `PigTVTests/ObservationTests.swift`, `TESTING.md`, `blueprint.md`.

Test evidence changed: `PigTVTests/ObservationTests.swift`, `TESTING.md`.

### 9244fb6 — 2026-10-04 — feat: the app warms the channel you are likely to play next (audit R11; server setting, off by default)

**Current optional optimization.** Dwell/visibility/start gate and one target task retained. Provider saving depends on server's opt-in switch and adoption; no measured device gain here.

Changed: `PigTV/APIClient.swift`, `PigTV/AppModel.swift`, `PigTV/ChannelWarmer.swift`, `PigTV/ContentView.swift`, `PigTV/HomeView.swift`, `PigTV/Models.swift`, `PigTV/PlaybackModel.swift`, `PigTV/SportView.swift`, `PigTVTests/ChannelWarmerTests.swift`, `PigTVTests/ContractChecks.swift`, `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `PigTVTests/Support/LocalHTTPServer.swift`, `TESTING.md`.

Test evidence changed: `PigTVTests/ChannelWarmerTests.swift`, `PigTVTests/ContractChecks.swift`, `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `PigTVTests/Support/LocalHTTPServer.swift`, `TESTING.md`.

### ba10988 — 2026-10-04 — fix: the guide store notices programme corrections of the same shape (audit R14)

**Regression coverage only.** Diff changes GuideGridStoreTests only, despite fix subject. Current programme revision key exists in GuideGridSupport; test verifies it rather than introducing a separate implementation.

Changed: `PigTVTests/GuideGridStoreTests.swift`.

Test evidence changed: `PigTVTests/GuideGridStoreTests.swift`.

### f83295e — 2026-10-04 — perf: the TV Guide opens without a first-visit stall

**Current.** Deferred initial grid frame and progressive reveal retained; performance assertions are simulator evidence, not hardware timings.

Changed: `PigTV/GuideGridLayout.swift`, `PigTV/GuideGridView.swift`, `PigTV/GuideView.swift`, `PigTV/NextFrame.swift`, `PigTVUITests/TabSwitchUITests.swift`, `blueprint.md`.

Test evidence changed: `PigTVUITests/TabSwitchUITests.swift`.

### c63a42b — 2026-10-04 — perf: artwork is fetched once per logo, written off the main thread, and bounded

**Current with known disk-bound gap.** Canonical fetch coalescing and off-main decode/write implemented; disk prune only on launch, not maintained during use.

Changed: `PigTV/APIClient.swift`, `PigTV/ChannelArtwork.swift`, `PigTV/GuideFixtures.swift`, `PigTV/TopShelfCards.swift`, `blueprint.md`.

### 6776dab — 2026-10-04 — fix: private caches are per server and account, and cleared on sign-out (audit R14)

**Partial privacy outcome.** Guide scope/retire lock works; local resume and Top Shelf publication remain outside scope (A1/A2).

Changed: `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/HomeView.swift`, `PigTV/PrivateCaches.swift`, `PigTVTests/CacheTests.swift`, `Tools/test-contracts.sh`.

Test evidence changed: `PigTVTests/CacheTests.swift`, `Tools/test-contracts.sh`.

### 4febfcd — 2026-10-04 — test: the first TV Guide visit keeps the 1 s limit until the Guide work lands

**Test/harness change.** Coverage or runner adjustment; no separate production behavior claim.

Changed: `PigTVUITests/TabSwitchUITests.swift`.

Test evidence changed: `PigTVUITests/TabSwitchUITests.swift`.

### 5359474 — 2026-10-04 — docs: build 37 in the blueprint (audit client work, test baseline)

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `blueprint.md`.

### ce7dfdc — 2026-10-04 — test: the tab-switch test measures what the remote feels, with signposts for device profiling (audit R03)

**Current instrumentation.** Signposts and input-to-focus tests improve measurement; threshold/pass is not a new device benchmark.

Changed: `PigTV/BrowseModel.swift`, `PigTV/ChannelArtwork.swift`, `PigTV/HomeView.swift`, `PigTV/LibraryView.swift`, `PigTV/PigTVSignpost.swift`, `PigTV/PlaybackModel.swift`, `PigTV/RecordingPlayback.swift`, `PigTV/SportModel.swift`, `PigTVUITests/TabSwitchUITests.swift`, `TESTING.md`.

Test evidence changed: `PigTVUITests/TabSwitchUITests.swift`, `TESTING.md`.

### e6380dd — 2026-10-04 — perf: Sport builds only what is on screen (audit R04/R05)

**Current.** Lazy Sport shelves, equatable card inputs and shared presenter remove eager work; no framework rewrite indicated.

Changed: `PigTV/BrowseModel.swift`, `PigTV/HomeView.swift`, `PigTV/SportModel.swift`, `PigTV/SportModels.swift`, `PigTV/SportView.swift`, `PigTVTests/SportTests.swift`, `PigTVUITests/SportUITests.swift`, `PigTVUITests/TabSwitchUITests.swift`.

Test evidence changed: `PigTVTests/SportTests.swift`, `PigTVUITests/SportUITests.swift`, `PigTVUITests/TabSwitchUITests.swift`.

### dd326d9 — 2026-10-04 — feat: recordings show when the server is still preparing them

**Current.** Native preparation status decoded and shown; server controls actual readiness.

Changed: `PigTV/DVRModels.swift`, `PigTV/RecordingsView.swift`, `PigTVTests/ContractChecks.swift`.

Test evidence changed: `PigTVTests/ContractChecks.swift`.

### bdb79b0 — 2026-10-04 — fix: a recording starts without waiting for its break markers (audit R07)

**Current.** Markers load concurrently with bounded wait; playback no longer awaits markers. New resume-position request can still delay play after item install by its own bounded timeout.

Changed: `PigTV/RecordingPlayback.swift`, `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/SportTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`.

Test evidence changed: `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/SportTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`.

### 337a942 — 2026-10-04 — test: the large Sport fixture lands in every bucket at a fixed clock

**Test/harness change.** Coverage or runner adjustment; no separate production behavior claim.

Changed: `PigTV/GuideFixtures.swift`, `PigTVTests/SportTests.swift`.

Test evidence changed: `PigTVTests/SportTests.swift`.

### 110e604 — 2026-10-04 — test: the large Sport fixture lands in every bucket at a fixed clock

**Test/harness change.** Coverage or runner adjustment; no separate production behavior claim.

Changed: `PigTV/GuideFixtures.swift`, `PigTVTests/SportTests.swift`.

Test evidence changed: `PigTVTests/SportTests.swift`.

### 529f6f6 — 2026-10-04 — fix: recordings fixture is offline and the UI-test focus helper waits for focus

**Test isolation improvement.** Offline fixture avoids server dependency and focus helper polls state; production behavior unchanged.

Changed: `PigTV/BrowseModel.swift`, `PigTVUITests/BrandDepthUITests.swift`.

Test evidence changed: `PigTVUITests/BrandDepthUITests.swift`.

### d1eadb2 — 2026-10-03 — fix: the provider reminder no longer asks for dates to be typed

**Current correction.** Reminder wording now tells provider renewal is detected automatically; removes misleading manual-date instruction.

Changed: `PigTV/ProviderReminders.swift`, `PigTVTests/ContractChecks.swift`, `PigTVTests/ProviderFailoverTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVTests/ProviderFailoverTests.swift`.

### f897ad6 — 2026-10-03 — chore: remove Siri and App Shortcuts (not wanted; failed on tvOS)

**Deliberate removal.** Siri/Shortcuts and old channel directory removed; cannot count earlier Siri commits as delivered functionality.

Changed: `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/ContentView.swift`, `PigTV/PlayChannelIntent.swift`, `PigTV/TopShelfExport.swift`, `PigTVTests/ChannelQueryTests.swift`, `PigTVTests/SportTests.swift`, `PigTVTests/TopShelfTests.swift`, `README.md`, `Shared/TopShelfSnapshot.swift`, `TESTING.md`, `blueprint.md`.

Test evidence changed: `PigTVTests/ChannelQueryTests.swift`, `PigTVTests/SportTests.swift`, `PigTVTests/TopShelfTests.swift`, `TESTING.md`.

### ca367d5 — 2026-10-03 — chore: Tools/bump-build.sh; build 37

**Build metadata / supporting change.** Version/build or harness support; no independent feature outcome established.

Changed: `PigTV.xcodeproj/project.pbxproj`, `TESTING.md`, `Tools/bump-build.sh`.

Test evidence changed: `TESTING.md`.

### 424a0e9 — 2026-10-03 — test: production-sized Sport fixture (PIGTV_UI_TEST_SPORT_EVENTS)

**Test fixture coverage.** Large deterministic Sport data improves stress coverage; not production traffic or performance evidence by itself.

Changed: `PigTV/AppModel.swift`, `PigTV/GuideFixtures.swift`, `PigTVTests/SportTests.swift`.

Test evidence changed: `PigTVTests/SportTests.swift`.

### 96825f8 — 2026-10-03 — Updated TV Guide categories

**Current with later refinements.** Category-chip layout/filter work retained; later 42 observer fixes iPhone invalidation and 46 header choice corrects compact layout.

Changed: `PigTV/GuideFixtures.swift`, `PigTV/GuideView.swift`, `PigTVUITests/BrandDepthUITests.swift`.

Test evidence changed: `PigTVUITests/BrandDepthUITests.swift`.

### 736813a — 2026-10-03 — Detailed brand refresh

**Mostly superseded styling; preserved behavior.** Dark player presentation/design fixtures and interaction changes traced into current players; later kit 40 and touch player 41 override appearance.

Changed: `PigTV/AppModel.swift`, `PigTV/ContentView.swift`, `PigTV/CustomPlayer.swift`, `PigTV/DetailComponents.swift`, `PigTV/DetailScreens.swift`, `PigTV/PigTVApp.swift`, `PigTV/PlaybackModel.swift`, `PigTV/PlayerShared.swift`, `PigTV/RecordingPlayback.swift`, `PigTV/RecordingPlayer.swift`, `PigTV/SportView.swift`, `PigTVUITests/BrandDepthUITests.swift`, `Tools/generate-brand-review-media.sh`.

Test evidence changed: `PigTVUITests/BrandDepthUITests.swift`.

### 9d63eaa — 2026-10-03 — Design Refresh

**Superseded brand master.** Old Spotlight assets/tokens replaced by 40's kit; do not report old visual acceptance as current.

Changed: `PigTV/Assets.xcassets/AccentColor.colorset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Back.imagestacklayer/Content.imageset/back@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Front.imagestacklayer/Content.imageset/front@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Middle.imagestacklayer/Content.imageset/middle@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Content.imageset/back@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Content.imageset/back@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Content.imageset/front@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Content.imageset/front@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Middle.imagestacklayer/Content.imageset/middle@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Middle.imagestacklayer/Content.imageset/middle@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image Wide.imageset/shelf@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image Wide.imageset/shelf@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image.imageset/shelf@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image.imageset/shelf@2x.png`, `PigTV/Assets.xcassets/AppIcon.appiconset/icon-dark.png`, `PigTV/Assets.xcassets/AppIcon.appiconset/icon-light.png`, `PigTV/Assets.xcassets/AppIcon.appiconset/icon-tinted.png`, `PigTV/Assets.xcassets/BrandGlow.imageset/glow.png`, `PigTV/Assets.xcassets/BrandPlate.imageset/Contents.json`, `PigTV/Assets.xcassets/BrandPlate.imageset/dark.png`, `PigTV/Assets.xcassets/BrandPlate.imageset/light.png`, `PigTV/Assets.xcassets/BrandPlate.imageset/plate.png`, `PigTV/Assets.xcassets/BrandWordmark.imageset/Contents.json`, `PigTV/Assets.xcassets/BrandWordmark.imageset/dark.png`, `PigTV/Assets.xcassets/BrandWordmark.imageset/light.png`, `PigTV/Assets.xcassets/BrandWordmark.imageset/wordmark.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/Contents.json`, `PigTV/Assets.xcassets/LaunchBrand.imageset/phone@2x-dark.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/phone@2x.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/phone@3x-dark.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/phone@3x.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/tv@2x-dark.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/tv@2x.png`, `PigTV/Assets.xcassets/LaunchEdge.colorset/Contents.json`, `PigTV/Assets.xcassets/PigAccentText.colorset/Contents.json`, `PigTV/Assets.xcassets/PigBorder.colorset/Contents.json`, `PigTV/Assets.xcassets/PigCanvas.colorset/Contents.json`, `PigTV/Assets.xcassets/PigControlBorder.colorset/Contents.json`, `PigTV/Assets.xcassets/PigLogo.imageset/PigLogo.png`, `PigTV/Assets.xcassets/PigOnAccent.colorset/Contents.json`, `PigTV/Assets.xcassets/PigRaised.colorset/Contents.json`, `PigTV/Assets.xcassets/PigSecondary.colorset/Contents.json`, `PigTV/Assets.xcassets/PigSurface.colorset/Contents.json`, `PigTV/Assets.xcassets/PigText.colorset/Contents.json`, `PigTV/BrandLayout.swift`, `PigTV/BrandSplash.swift`, `PigTV/ContentView.swift`, `PigTV/CustomPlayer.swift`, `PigTV/DetailComponents.swift`, `PigTV/GuideView.swift`, `PigTV/HomeView.swift`, `PigTV/LibraryView.swift`, `PigTV/PageBackdrop.swift`, `PigTV/PlayerExtras.swift`, `PigTV/PlayerShared.swift`, `PigTV/RecordingPlayer.swift`, `PigTV/SportView.swift`, `PigTV/TVActionStyle.swift`, `PigTV/TabBarStyle.swift`, `PigTV/TopShelfCards.swift`, `Tools/make-brand-assets.swift`, `docs/brand-standard.md`, `docs/brand-tokens.json`.

### 6fffdbd — 2026-09-30 — ci: sign tvOS tests ad hoc so the App Group exists

**Current CI correction.** Ad-hoc simulator signing supplies App Group entitlement; sandbox cannot stand in for provisioned device validation.

Changed: `.github/workflows/ci.yml`.

### 88398e3 — 2026-09-30 — feat: multi-provider client (provider on resolve, licence reminders, renewed recovery allowance)

**Current; acceptance pending.** Provider decode, once-daily reminder and two-minute recovery renewal remain. No automatic takeover added; recovery tests use playing evidence.

Changed: `PigTV/AppModel.swift`, `PigTV/ContentView.swift`, `PigTV/Models.swift`, `PigTV/PlaybackModel.swift`, `PigTV/ProviderReminderModel.swift`, `PigTV/ProviderReminders.swift`, `PigTV/StreamInfo.swift`, `PigTVTests/ContractChecks.swift`, `PigTVTests/ProviderFailoverTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `TESTING.md`, `Tools/test-contracts.sh`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVTests/ProviderFailoverTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `TESTING.md`, `Tools/test-contracts.sh`.

### 367545e — 2026-09-30 — chore: bump app build to 36

**Build metadata / supporting change.** Version/build or harness support; no independent feature outcome established.

Changed: `PigTV.xcodeproj/project.pbxproj`.

### 4dcb48c — 2026-09-29 — docs: handover state at build 35

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `PigTV/Models.swift`, `TESTING.md`, `blueprint.md`.

Test evidence changed: `TESTING.md`.

### 5ec8f86 — 2026-09-29 — feat: Spotlight branding (icons, Top Shelf, launch screen, animated splash)

**Superseded artwork; current splash concept.** Spotlight bitmap assets replaced by kit 40. Startup-gated splash retained; old artwork intent is superseded.

Changed: `AppConfiguration.plist`, `PigTV.xcodeproj/project.pbxproj`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Back.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Back.imagestacklayer/Content.imageset/back@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Back.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Front.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Front.imagestacklayer/Content.imageset/front@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Front.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Middle.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Middle.imagestacklayer/Content.imageset/middle@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon - App Store.imagestack/Middle.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Content.imageset/back@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Content.imageset/back@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Back.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Content.imageset/front@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Content.imageset/front@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Front.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Middle.imagestacklayer/Content.imageset/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Middle.imagestacklayer/Content.imageset/middle@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Middle.imagestacklayer/Content.imageset/middle@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/App Icon.imagestack/Middle.imagestacklayer/Contents.json`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image Wide.imageset/shelf@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image Wide.imageset/shelf@2x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image.imageset/shelf@1x.png`, `PigTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets/Top Shelf Image.imageset/shelf@2x.png`, `PigTV/Assets.xcassets/AppIcon.appiconset/icon-dark.png`, `PigTV/Assets.xcassets/AppIcon.appiconset/icon-light.png`, `PigTV/Assets.xcassets/AppIcon.appiconset/icon-tinted.png`, `PigTV/Assets.xcassets/BrandGlow.imageset/Contents.json`, `PigTV/Assets.xcassets/BrandGlow.imageset/glow.png`, `PigTV/Assets.xcassets/BrandPlate.imageset/Contents.json`, `PigTV/Assets.xcassets/BrandPlate.imageset/plate.png`, `PigTV/Assets.xcassets/BrandWordmark.imageset/Contents.json`, `PigTV/Assets.xcassets/BrandWordmark.imageset/wordmark.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/Contents.json`, `PigTV/Assets.xcassets/LaunchBrand.imageset/phone@2x.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/phone@3x.png`, `PigTV/Assets.xcassets/LaunchBrand.imageset/tv@2x.png`, `PigTV/Assets.xcassets/LaunchEdge.colorset/Contents.json`, `PigTV/BrandLayout.swift`, `PigTV/BrandSplash.swift`, `PigTV/ContentView.swift`, `PigTV/PigTVApp.swift`, `PigTVUITests/BrandSplashUITests.swift`, `TESTING.md`, `Tools/make-brand-assets.swift`, `blueprint.md`, `docs/evidence/branding/ios-icon-light-dark-tinted.png`, `docs/evidence/branding/sim-ipad-launch-screen.png`, `docs/evidence/branding/sim-ipad-splash-final.png`, `docs/evidence/branding/sim-tvos-launch-screen.png`, `docs/evidence/branding/sim-tvos-splash-final.png`, `docs/evidence/branding/top-shelf-1920x720.png`, `docs/evidence/branding/top-shelf-2320x720.png`, `docs/evidence/branding/tv-icon-at-rest.png`, `docs/evidence/branding/tv-icon-parallax.png`.

Test evidence changed: `PigTVUITests/BrandSplashUITests.swift`, `TESTING.md`.

### eb2b2b6 — 2026-09-29 — fix: guide Jump to… and Search are full-screen pages on tvOS

**Current.** tvOS Search/Jump full-screen presentation retained; stacked-cover focus acceptance still a known device limitation.

Changed: `PigTV/DetailComponents.swift`, `PigTV/GuideSheets.swift`, `PigTV/GuideView.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`.

Test evidence changed: `PigTVUITests/GuideGridNavigationUITests.swift`.

### 4181f3c — 2026-09-29 — chore: bump app build to 35

**Build metadata / supporting change.** Version/build or harness support; no independent feature outcome established.

Changed: `PigTV.xcodeproj/project.pbxproj`.

### b1c50d3 — 2026-09-28 — fix: review follow-ups for build 34 (sport buckets use the new clock; problem rows focusable on tvOS; empty text counts active schedules only)

**Current correction.** Sport advances clock before derived buckets; problem rows gain TV focus; scheduled empty state counts active rows.

Changed: `PigTV/RecordingsView.swift`, `PigTV/SportModel.swift`.

### 6af71f6 — 2026-09-28 — chore: bump app build to 34

**Build metadata / supporting change.** Version/build or harness support; no independent feature outcome established.

Changed: `PigTV.xcodeproj/project.pbxproj`, `blueprint.md`.

### c4fb7b4 — 2026-09-28 — perf: optimize sport refresh to avoid unnecessary work

**Current, later refined.** Equality/memoization avoids repeated Sport publication; later snapshots and narrow stores improve same path.

Changed: `PigTV/SportModel.swift`, `PigTV/SportModels.swift`, `PigTV/SportView.swift`, `PigTVTests/SportTests.swift`.

Test evidence changed: `PigTVTests/SportTests.swift`.

### f6e47de — 2026-09-28 — feat: show missed and failed recordings from last 7 days

**Current.** Recent failed/missed schedule states decoded and shown; 41 consolidates recording problem rows and duplicate handling.

Changed: `PigTV/BrowseModel.swift`, `PigTV/DVRModels.swift`, `PigTV/Models.swift`, `PigTV/RecordingsView.swift`.

### ede9ca6 — 2026-09-28 — docs: blueprint and testing notes for the sport-channel and guide-forward fixes; build 33

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `TESTING.md`, `blueprint.md`.

Test evidence changed: `TESTING.md`.

### 722dca9 — 2026-09-28 — fix: the TV guide extends forward instead of hitting a wall; build 33

**Current.** Loaded horizon propagated to layout; extend/merge retries prevent 24-hour wall; revision key later handles same-shape changes.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/DVRModels.swift`, `PigTV/GuideFixtures.swift`, `PigTV/GuideGridView.swift`, `PigTV/GuideView.swift`, `PigTVTests/ContractChecks.swift`, `PigTVTests/GuideModelTests.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVTests/GuideModelTests.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`.

### c44309f — 2026-09-28 — fix: an upcoming sport event's secondary channels offer Record or Watch when it starts, not an immediate tune

**Current.** Upcoming secondary channel offers future watch/record rather than immediate tune; common SportChannelList handles distinction.

Changed: `PigTV/PigTVApp.swift`, `PigTV/SportModels.swift`, `PigTV/SportView.swift`, `PigTVTests/SportTests.swift`, `PigTVUITests/SportUITests.swift`.

Test evidence changed: `PigTVTests/SportTests.swift`, `PigTVUITests/SportUITests.swift`.

### 3b5be1e — 2026-09-26 — Docs: handover once-over

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `README.md`, `TESTING.md`, `blueprint.md`, `docs/SERVER-REQUESTS.md`, `docs/archive/README.md`, `docs/archive/TESTING-2026-09-23.md`.

Test evidence changed: `TESTING.md`, `docs/archive/TESTING-2026-09-23.md`.

### 9aac4ea — 2026-09-26 — feat: Sport covers 72 hours in Tomorrow and weekday sections

**Current.** 72-hour request and day buckets remain; absolute horizon still depends on server guide data.

Changed: `PigTV/GuideFixtures.swift`, `PigTV/SportModel.swift`, `PigTV/SportModels.swift`, `PigTV/SportView.swift`, `PigTVTests/SportTests.swift`, `blueprint.md`, `docs/evidence/2026-09-26-b32-sport-days-dark.jpg`.

Test evidence changed: `PigTVTests/SportTests.swift`.

### 266b5da — 2026-09-26 — feat: Top Shelf shows rendered 16:9 cards instead of stretched logos

**Current rendering with defect A2.** Native-resolution logo placement/card snapshots fix stretched source artwork; export/logout races remain.

Changed: `PigTV/ChannelArtwork.swift`, `PigTV/GuideFixtures.swift`, `PigTV/PigTVApp.swift`, `PigTV/TopShelfCards.swift`, `PigTV/TopShelfExport.swift`, `PigTVTests/TopShelfCardTests.swift`, `PigTVTests/TopShelfTests.swift`, `PigTVTopShelf/ContentProvider.swift`, `PigTVUITests/TopShelfCardsUITests.swift`, `Shared/TopShelfSnapshot.swift`, `blueprint.md`, `docs/evidence/2026-09-26-b32-topshelf-cards-fixture.jpg`, `docs/evidence/2026-09-26-b32-topshelf-sim.jpg`.

Test evidence changed: `PigTVTests/TopShelfCardTests.swift`, `PigTVTests/TopShelfTests.swift`, `PigTVUITests/TopShelfCardsUITests.swift`.

### bc54149 — 2026-09-25 — fix: tab switches never show tvOS's backdrop; build 32

**Current.** Window/container backdrop avoids system-colored tab flashes; later kit changes color values, not ownership.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/GuideGridView.swift`, `PigTV/GuideView.swift`, `PigTV/HomeView.swift`, `PigTV/LibraryView.swift`, `PigTV/PageBackdrop.swift`, `PigTV/PigTVApp.swift`, `PigTV/RecordingsView.swift`, `PigTV/SportView.swift`, `PigTVUITests/TabFlashUITests.swift`, `Tools/analyse-tab-flash.py`, `blueprint.md`, `docs/evidence/2026-09-25-b32-tabswitch-after-dark.jpg`, `docs/evidence/2026-09-25-b32-tabswitch-after-light.jpg`, `docs/evidence/2026-09-25-b32-tabswitch-before-dark.jpg`, `docs/evidence/2026-09-25-b32-tabswitch-before-light.jpg`.

Test evidence changed: `PigTVUITests/TabFlashUITests.swift`.

### c96c95e — 2026-09-25 — feat: Sport tab has a Replays section

**Current.** Replays section separated from live/home sport; tolerant kind decoding retained.

Changed: `PigTV/GuideFixtures.swift`, `PigTV/SportModel.swift`, `PigTV/SportModels.swift`, `PigTV/SportView.swift`, `PigTVTests/SportTests.swift`, `blueprint.md`, `docs/evidence/2026-09-25-b31-sport-replays-tv-dark.jpg`, `docs/evidence/2026-09-25-b31-sport-replays-tv-light.jpg`.

Test evidence changed: `PigTVTests/SportTests.swift`.

### de2da66 — 2026-09-25 — perf: tabs switch without reloading; measured on 1,000 channels

**Current, later refined.** Freshness gates/off-main decode reduce tab reloads; narrow stores later reduce redraws. Visible refresh added in 42 for recordings.

Changed: `PigTV/APIClient.swift`, `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/DVRModels.swift`, `PigTV/GuideFixtures.swift`, `PigTV/GuideView.swift`, `PigTV/HomeView.swift`, `PigTV/LibraryView.swift`, `PigTV/RecordingsView.swift`, `PigTV/TabBarStyle.swift`, `PigTVTests/SportTests.swift`, `PigTVUITests/TabSwitchUITests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/SportTests.swift`, `PigTVUITests/TabSwitchUITests.swift`.

### da32dc9 — 2026-09-25 — fix: Siri App Shortcuts register channels at launch; Open PigTV shortcut

**Superseded by removal.** Siri launch registration removed in f897ad6; no current feature claim.

Changed: `PigTV/AppModel.swift`, `PigTV/ContentView.swift`, `PigTV/PlayChannelIntent.swift`, `PigTV/TopShelfExport.swift`, `PigTVTests/TopShelfTests.swift`, `Shared/TopShelfSnapshot.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/TopShelfTests.swift`.

### 1102411 — 2026-09-25 — feat: iPad and iPhone player has one set of large touch controls

**Current, later refined.** One touch control set retained; 41 replaces backing player for PiP and 46 removes redundant Guide pill.

Changed: `PigTV/AppModel.swift`, `PigTV/ContentView.swift`, `PigTV/LibraryView.swift`, `PigTV/PlaybackModel.swift`, `PigTV/PlayerExtras.swift`, `PigTV/PlayerShared.swift`, `PigTVTests/PlayerSharedTests.swift`, `blueprint.md`, `docs/evidence/2026-09-25-b31-ipad-player-channels.jpg`, `docs/evidence/2026-09-25-b31-ipad-player-landscape.jpg`, `docs/evidence/2026-09-25-b31-ipad-player-portrait.jpg`, `docs/evidence/2026-09-25-b31-iphone-player-landscape.jpg`, `docs/evidence/2026-09-25-b31-iphone-player-portrait.jpg`.

Test evidence changed: `PigTVTests/PlayerSharedTests.swift`.

### a91770c — 2026-09-25 — fix: Top Shelf extension enters through NSExtensionMain; diagnostics in Settings

**Current.** Top Shelf extension entry point and diagnostics retained; App Group signing still required.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/LibraryView.swift`, `PigTVTests/TopShelfTests.swift`, `PigTVTopShelf/ContentProvider.swift`, `Shared/TopShelfSnapshot.swift`, `blueprint.md`, `docs/evidence/2026-09-25-b31-topshelf-sim.jpg`.

Test evidence changed: `PigTVTests/TopShelfTests.swift`.

### 99b6ffa — 2026-09-25 — fix: Home fits the hero and two shelves on one TV screen; build 31

**Current layout intent; later metrics.** Home density adjusted; later shared header/kit refine layout. Fresh physical fit not measured.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/HomeView.swift`, `PigTV/SportView.swift`, `blueprint.md`, `docs/evidence/2026-09-25-b31-home-tv-dark.jpg`, `docs/evidence/2026-09-25-b31-home-tv-light.jpg`, `docs/evidence/2026-09-25-b31-home-tv-shelves.jpg`, `docs/evidence/2026-09-25-b31-ipad-home-dark.jpg`.

### 6e2ba71 — 2026-09-25 — docs: blueprint and screenshots for the Sport feature (build 30)

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `blueprint.md`, `docs/evidence/2026-09-25-b30-home-sport-tv-dark.jpg`, `docs/evidence/2026-09-25-b30-home-sport-tv-light.jpg`, `docs/evidence/2026-09-25-b30-sport-card-focused-tv-dark.jpg`, `docs/evidence/2026-09-25-b30-sport-channel-picker-tv-dark.jpg`, `docs/evidence/2026-09-25-b30-sport-channels-tv-light.jpg`, `docs/evidence/2026-09-25-b30-sport-event-ipad-light.jpg`, `docs/evidence/2026-09-25-b30-sport-event-page-tv-dark.jpg`, `docs/evidence/2026-09-25-b30-sport-ipad-dark.jpg`, `docs/evidence/2026-09-25-b30-sport-ipad-light.jpg`, `docs/evidence/2026-09-25-b30-sport-long-press-menu-tv-dark.jpg`, `docs/evidence/2026-09-25-b30-sport-tv-dark.jpg`, `docs/evidence/2026-09-25-b30-sport-tv-empty.jpg`, `docs/evidence/2026-09-25-b30-sport-tv-light.jpg`.

### 6f21a62 — 2026-09-25 — feat: Sport tab and Home "Sport now & next" from sport events (C-I); build 30

**Current, later optimized.** Sport events replace category-based Home sport; 72-hour/replay/lazy-store refinements supersede initial implementation details.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/DetailComponents.swift`, `PigTV/DetailScreens.swift`, `PigTV/GuideFixtures.swift`, `PigTV/HomeRows.swift`, `PigTV/HomeView.swift`, `PigTV/LibraryView.swift`, `PigTV/Models.swift`, `PigTV/PigTVApp.swift`, `PigTV/SportModel.swift`, `PigTV/SportModels.swift`, `PigTV/SportView.swift`, `PigTVTests/HomeRowsTests.swift`, `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/SportTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `PigTVUITests/SportUITests.swift`.

Test evidence changed: `PigTVTests/HomeRowsTests.swift`, `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/SportTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `PigTVUITests/SportUITests.swift`.

### 3f6362a — 2026-09-25 — feat: iPad and iPhone player and guide match the TV

**Current, later refined.** iPad UIKit guide/free touch and touch player retained; later custom PiP layer and responsive layout supersede original backing view.

Changed: `PigTV/AppModel.swift`, `PigTV/ContentView.swift`, `PigTV/CustomPlayer.swift`, `PigTV/GuideGridCells.swift`, `PigTV/GuideGridLayout.swift`, `PigTV/GuideGridMath.swift`, `PigTV/GuideGridView.swift`, `PigTV/GuideView.swift`, `PigTV/PigTVApp.swift`, `PigTV/PlaybackModel.swift`, `PigTV/PlayerExtras.swift`, `PigTV/PlayerShared.swift`, `PigTVTests/GuideGridMathTests.swift`, `PigTVTests/PlayerSharedTests.swift`, `TESTING.md`, `blueprint.md`, `docs/evidence/2026-09-25-b29-ipad-channels.jpg`, `docs/evidence/2026-09-25-b29-ipad-guide-dark.jpg`, `docs/evidence/2026-09-25-b29-ipad-guide-light.jpg`, `docs/evidence/2026-09-25-b29-ipad-player-info.jpg`, `docs/evidence/2026-09-25-b29-ipad-tuning.jpg`, `docs/evidence/2026-09-25-b29-iphone-channels.jpg`, `docs/evidence/2026-09-25-b29-iphone-tuning.jpg`.

Test evidence changed: `PigTVTests/GuideGridMathTests.swift`, `PigTVTests/PlayerSharedTests.swift`, `TESTING.md`.

### 6e6728a — 2026-09-25 — feat: channel numbers never over artwork; muted text after the name

**Current.** Channel numbers rendered after names; not artwork overlays. Keeps provider guide order.

Changed: `PigTV/ContentView.swift`, `PigTV/CustomPlayer.swift`, `PigTV/DetailComponents.swift`, `PigTV/GuideGridCells.swift`, `PigTV/GuideView.swift`, `PigTV/HomeView.swift`, `PigTV/OnNowList.swift`, `PigTV/PlayerExtras.swift`, `PigTVTests/TopShelfTests.swift`, `PigTVTopShelf/ContentProvider.swift`, `Shared/TopShelfSnapshot.swift`, `blueprint.md`, `docs/evidence/2026-09-25-b29-numbers-guide-tv.jpg`, `docs/evidence/2026-09-25-b29-numbers-home-tv.jpg`.

Test evidence changed: `PigTVTests/TopShelfTests.swift`.

### 0bebaa0 — 2026-09-25 — fix: shared App Group files live under Library/Caches (tvOS refuses the container root); build 29

**Current.** App Group paths under Library/Caches; fixes tvOS root-write refusal.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/PlayChannelIntent.swift`, `PigTV/TopShelfExport.swift`, `PigTVTests/TopShelfTests.swift`, `Shared/TopShelfSnapshot.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/TopShelfTests.swift`.

### e2337da — 2026-09-25 — feat: programme information redesign and a consistency pass

**Current, later styled.** Programme details/action layouts retained; rules/watch-from-start added later. Visual consistency relies on latest kit/header, not this older screenshot state.

Changed: `PigTV/ChannelArtwork.swift`, `PigTV/ContentView.swift`, `PigTV/CustomPlayer.swift`, `PigTV/DetailComponents.swift`, `PigTV/DetailScreens.swift`, `PigTV/GuideFixtures.swift`, `PigTV/GuideGridCells.swift`, `PigTV/GuideSheets.swift`, `PigTV/GuideView.swift`, `PigTV/HomeView.swift`, `PigTV/LibraryView.swift`, `PigTV/OnNowList.swift`, `PigTV/PigTVApp.swift`, `PigTV/PlayerExtras.swift`, `PigTV/RecordingsView.swift`, `PigTV/TVActionStyle.swift`, `PigTVTests/DetailTextTests.swift`, `blueprint.md`, `docs/evidence/2026-09-25-details-channel-dark.jpg`, `docs/evidence/2026-09-25-details-jump-dark.jpg`, `docs/evidence/2026-09-25-details-onboarding-dark.jpg`, `docs/evidence/2026-09-25-details-programme-dark.jpg`, `docs/evidence/2026-09-25-details-programme-light.jpg`, `docs/evidence/2026-09-25-details-record-dark.jpg`, `docs/evidence/2026-09-25-details-recording-dark.jpg`, `docs/evidence/2026-09-25-details-schedule-light.jpg`, `docs/evidence/2026-09-25-details-search-dark.jpg`, `docs/evidence/2026-09-25-details-unreachable-light.jpg`.

Test evidence changed: `PigTVTests/DetailTextTests.swift`.

### 5132e76 — 2026-09-25 — feat: Home screen, the tab the app opens on

**Current, later optimized.** Home initial tab/hero/shelves exist; narrower HomeModel and kit/headers replace initial computation and appearance.

Changed: `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/ChannelArtwork.swift`, `PigTV/GuideFixtures.swift`, `PigTV/GuideView.swift`, `PigTV/HomeRows.swift`, `PigTV/HomeView.swift`, `PigTV/LibraryView.swift`, `PigTV/Models.swift`, `PigTV/PigTVApp.swift`, `PigTVTests/HomeRowsTests.swift`, `PigTVTests/PlaybackLifecycleTests.swift`, `PigTVTests/RealPlaybackTests.swift`, `PigTVUITests/HomeUITests.swift`, `blueprint.md`, `docs/evidence/2026-09-25-home-tv-card-focus.jpg`, `docs/evidence/2026-09-25-home-tv-dark-shelves.jpg`, `docs/evidence/2026-09-25-home-tv-dark.jpg`, `docs/evidence/2026-09-25-home-tv-first-run.jpg`, `docs/evidence/2026-09-25-home-tv-light-shelves.jpg`, `docs/evidence/2026-09-25-home-tv-light.jpg`.

Test evidence changed: `PigTVTests/HomeRowsTests.swift`, `PigTVTests/PlaybackLifecycleTests.swift`, `PigTVTests/RealPlaybackTests.swift`, `PigTVUITests/HomeUITests.swift`.

### 3acdad7 — 2026-09-25 — build: Swift 6 language mode for the app and Top Shelf, callbacks made explicit

**Current correction.** Swift 6 restored with explicit Sendable AV callbacks; supersedes temporary Swift 5 diagnosis. Explicit AVKit availability remains separate fix.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/APIClient.swift`, `PigTV/PlayChannelIntent.swift`, `PigTV/PlaybackModel.swift`, `PigTV/RecordingPlayback.swift`, `PigTV/TabBarStyle.swift`, `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`.

### 37cf04d — 2026-09-25 — test: real-playback harness (local HTTP server, HLS fixture); build 28

**Current test harness.** Real AVPlayer HLS fixture coverage added; no real provider/device evidence implied.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTVTests/Fixtures/HLS/fixture-README.txt`, `PigTVTests/Fixtures/HLS/fixture-init.mp4`, `PigTVTests/Fixtures/HLS/fixture-seg0.m4s`, `PigTVTests/Fixtures/HLS/fixture-seg1.m4s`, `PigTVTests/Fixtures/HLS/fixture-seg2.m4s`, `PigTVTests/Fixtures/HLS/master.m3u8`, `PigTVTests/Fixtures/HLS/stream.m3u8`, `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `PigTVTests/Support/LocalHTTPServer.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/Fixtures/HLS/fixture-README.txt`, `PigTVTests/Fixtures/HLS/fixture-init.mp4`, `PigTVTests/Fixtures/HLS/fixture-seg0.m4s`, `PigTVTests/Fixtures/HLS/fixture-seg1.m4s`, `PigTVTests/Fixtures/HLS/fixture-seg2.m4s`, `PigTVTests/Fixtures/HLS/master.m3u8`, `PigTVTests/Fixtures/HLS/stream.m3u8`, `PigTVTests/RealPlaybackTests.swift`, `PigTVTests/Support/FakePigTVServer.swift`, `PigTVTests/Support/LocalHTTPServer.swift`.

### c2156fe — 2026-09-25 — fix: Top Shelf extension can load http logos; os_log diagnostics end to end

**Current historical fix.** Top Shelf allows HTTP artwork and logs diagnostics; current cards usually use local rendered images.

Changed: `PigTV/TopShelfExport.swift`, `PigTVTests/TopShelfTests.swift`, `PigTVTopShelf/ContentProvider.swift`, `PigTVTopShelf/Info.plist`, `Shared/TopShelfSnapshot.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/TopShelfTests.swift`.

### e7a5d88 — 2026-09-25 — fix: legible tvOS tab bar: solid pink focused pill, pink-on-faint-pink selection

**Current styling intent.** Selected/focused tab semantic colors retained under newer brand tokens.

Changed: `PigTV/PigTVApp.swift`, `PigTV/TabBarStyle.swift`, `blueprint.md`.

### 0315994 — 2026-09-24 — refactor: the UIKit guide is the only tvOS grid; old SwiftUI tvOS grid removed

**Current replacement.** UIKit is the sole TV grid; earlier SwiftUI-grid edge-target fixes no longer govern current grid.

Changed: `PigTV/DVRModels.swift`, `PigTV/GuideGridView.swift`, `PigTV/GuideView.swift`, `PigTV/Labs.swift`, `PigTVTests/ContractChecks.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`, `PigTVUITests/GuideNavigationUITests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`, `PigTVUITests/GuideNavigationUITests.swift`.

### 78aae69 — 2026-09-24 — feat: HE-AAC passthrough on for every play; Labs switch removed

**Current.** HE-AAC sent for every play, fallback forces audio encode when needed; old Labs switch removed.

Changed: `PigTV/Labs.swift`, `PigTV/PlaybackCapabilities.swift`, `PigTVTests/ContractChecks.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`.

### b95fe6b — 2026-09-24 — fix: one-off fallbacks for -11868 (stream playlist) and 'fmt?' (audioEncode)

**Current.** One-off master-to-media and unsupported-audio fallbacks retained with release/identity guards; hardware coverage still needed across formats.

Changed: `PigTV/Models.swift`, `PigTV/PlaybackModel.swift`, `PigTVTests/PlaybackLifecycleTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/PlaybackLifecycleTests.swift`.

### cd362ab — 2026-09-24 — fix: channel start no longer waits ~3 s for display criteria (build 27)

**Current.** Resolve metadata drives display mode; preferredDisplayCriteria asset wait moved out of start path.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/DisplayMode.swift`, `PigTV/Models.swift`, `PigTV/PlaybackModel.swift`, `PigTV/RecordingPlayback.swift`, `PigTVTests/DisplayModeTests.swift`, `PigTVTests/PlaybackLifecycleTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/DisplayModeTests.swift`, `PigTVTests/PlaybackLifecycleTests.swift`.

### 6c63acd — 2026-09-24 — fix: guide Details icon missing on tvOS (build 26)

**Current.** Details control visible on TV; later shared header retains action.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/GuideView.swift`.

### 58406a7 — 2026-09-24 — fix: link AVKit on tvOS so display-mode switching can't crash (build 25)

**Current crash fix.** Explicit AVKit link addresses category availability; the language rollback did not solve this root cause.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/PigTVApp.swift`, `PigTVTests/PlaybackLifecycleTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/PlaybackLifecycleTests.swift`.

### c59ff41 — 2026-09-24 — fix: channel start crashed on AVPlayerItem.externalMetadata (build 24)

**Current crash fix.** External metadata selector guard retained; prevents unavailable category call.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/PlaybackModel.swift`, `PigTVTests/PlaybackLifecycleTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/PlaybackLifecycleTests.swift`.

### cb161e6 — 2026-09-24 — fix: crash on channel load; back to Swift 5 language mode (build 23)

**Superseded incorrect diagnosis.** Swift 5 rollback replaced by 3acdad7; AVKit selector/link fix is the actual root-cause remedy.

Changed: `AppConfiguration.plist`, `PigTV.xcodeproj/project.pbxproj`, `blueprint.md`.

### e95a83f — 2026-09-24 — A4.5: app target in the Swift 6 language mode

**Superseded, then restored correctly.** Initial Swift 6 switch rolled back; 3acdad7 supplies explicit callback handling and is current baseline.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/APIClient.swift`, `PigTV/GuideGridLayout.swift`, `PigTV/Labs.swift`, `PigTV/Models.swift`, `PigTV/PlaybackModel.swift`, `PigTV/StreamInfo.swift`, `PigTV/Timeshift.swift`, `blueprint.md`.

### 10fb951 — 2026-09-24 — A4.5: Siri Play channel intent with a channel entity query and App Shortcut

**Superseded by removal.** Siri entity/shortcut work removed in f897ad6.

Changed: `PigTV/BrowseModel.swift`, `PigTV/ContentView.swift`, `PigTV/PlayChannelIntent.swift`, `PigTV/TopShelfExport.swift`, `PigTVTests/ChannelQueryTests.swift`, `PigTVTests/TopShelfTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ChannelQueryTests.swift`, `PigTVTests/TopShelfTests.swift`.

### ddbef96 — 2026-09-24 — A4.4: iPhone On now list; iOS player Last channel and control layout

**Current, later refined.** Phone On-now list and Last channel retained; filter observer relocated in 42 fixes a later layout-specific gap.

Changed: `PigTV/ContentView.swift`, `PigTV/GuideView.swift`, `PigTV/OnNowList.swift`, `PigTVTests/OnNowRowTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/OnNowRowTests.swift`.

### 34ca576 — 2026-09-24 — A4.1: Top Shelf extension, App Group snapshot and pigtv://play deep links

**Current with defect A2.** App Group snapshot/deep links retained; entry-point/path/rendering fixed later. Logout publication lacks generation retirement.

Changed: `AppConfiguration.plist`, `PigTV.xcodeproj/project.pbxproj`, `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/ContentView.swift`, `PigTV/PigTV.entitlements`, `PigTV/TopShelfExport.swift`, `PigTVTests/TopShelfTests.swift`, `PigTVTopShelf/ContentProvider.swift`, `PigTVTopShelf/Info.plist`, `PigTVTopShelf/PigTVTopShelf.entitlements`, `Shared/TopShelfSnapshot.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/TopShelfTests.swift`.

### e657712 — 2026-09-24 — A2.1: new guide Now in the header, Up from the grid lands on it; Earlier/Later keep focus

**Current.** Now/up focus and Earlier/Later header ownership retained in UIKit guide.

Changed: `PigTV/GuideGridView.swift`, `PigTV/GuideView.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`, `blueprint.md`.

Test evidence changed: `PigTVUITests/GuideGridNavigationUITests.swift`.

### 851f4ad — 2026-09-24 — A4.2: stream info overlay behind Labs; play-end dropped frames and bitrate (build 22)

**Current.** Stream info opt-in and safe telemetry retained; killed apps still cannot report play-end.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/CustomPlayer.swift`, `PigTV/Models.swift`, `PigTV/PlaybackModel.swift`, `PigTV/StreamInfo.swift`, `PigTVTests/StreamInfoTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/StreamInfoTests.swift`.

### 479d08f — 2026-09-24 — A2.1: UIKit guide focus restore, focus-following header moves, cell rendering

**Current, later corrected.** UIKit identity focus restoration and clipped cell rendering retained; 46 clears stale fast-scroll plan.

Changed: `PigTV/GuideGridCells.swift`, `PigTV/GuideGridMath.swift`, `PigTV/GuideGridView.swift`, `PigTV/GuideView.swift`, `PigTVTests/GuideGridMathTests.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/GuideGridMathTests.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`.

### a210fae — 2026-09-24 — A4.3/C-E: tvOS recordings in the custom player; HLS recordings

**Partial current; partial removed.** Custom TV recording player remains; old C-E growing-recording branch removed in 39 and replaced by C-L in 44.

Changed: `PigTV/CustomPlayer.swift`, `PigTV/DVRModels.swift`, `PigTV/PlaybackModel.swift`, `PigTV/RecordingPlayback.swift`, `PigTV/RecordingPlayer.swift`, `PigTV/RecordingsView.swift`, `PigTVTests/ContractChecks.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`.

### 0228b2e — 2026-09-24 — C-E: timeshift Start over and programme timeline (build 21)

**Superseded by removal.** Old live-timeshift Start-over UI removed in 39; not current functionality.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/CustomPlayer.swift`, `PigTV/Models.swift`, `PigTV/PlaybackModel.swift`, `PigTV/Timeshift.swift`, `PigTVTests/ContractChecks.swift`, `PigTVTests/TimeshiftMathTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVTests/TimeshiftMathTests.swift`.

### f46e4f5 — 2026-09-24 — A2.1: UIKit TV-guide grid behind Labs → New guide (build 20)

**Current foundation.** UIKit grid graduated from Labs in 0315994; later horizon/reveal/focus revisions apply.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/GuideGridCells.swift`, `PigTV/GuideGridLayout.swift`, `PigTV/GuideGridMath.swift`, `PigTV/GuideGridView.swift`, `PigTV/GuideView.swift`, `PigTVTests/GuideGridMathTests.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`, `PigTVUITests/GuideNavigationUITests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/GuideGridMathTests.swift`, `PigTVUITests/GuideGridNavigationUITests.swift`, `PigTVUITests/GuideNavigationUITests.swift`.

### cd669dc — 2026-09-24 — C-G: mark flaky channels in the guide

**Current.** Optional flaky health hint rendered when flag permits; reliability depends on server/client-event data.

Changed: `PigTV/BrowseModel.swift`, `PigTV/DVRModels.swift`, `PigTV/GuideView.swift`, `PigTVTests/ChannelNumberTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ChannelNumberTests.swift`.

### 6870017 — 2026-09-24 — C-A: decode and show channel numbers; iOS Go to number

**Current, later restyled.** Number decode and phone number navigation retained; numbers moved after names by 6e6728a.

Changed: `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/ContentView.swift`, `PigTV/CustomPlayer.swift`, `PigTV/DVRModels.swift`, `PigTV/GuideView.swift`, `PigTV/Models.swift`, `PigTV/PlayerExtras.swift`, `PigTVTests/ChannelNumberTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ChannelNumberTests.swift`.

### 90f76fc — 2026-09-24 — C-B: show allow-listed resolve error messages

**Current.** Resolve text prefix/URL checks retained; other server errors remain generic.

Changed: `PigTV/APIClient.swift`, `PigTVTests/ContractChecks.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`.

### 344e50e — 2026-09-24 — C-F/C-C: Settings Labs section and HE-AAC passthrough capability (build 19)

**Partly superseded.** Stream-info Labs retained; HE-AAC switch superseded by always-on capability.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/Labs.swift`, `PigTV/LibraryView.swift`, `PigTV/PlaybackCapabilities.swift`, `PigTVTests/ContractChecks.swift`, `Tools/test-contracts.sh`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `Tools/test-contracts.sh`.

### 3952a45 — 2026-09-23 — A1.2 (2/2): "Last channel" memory

**Current.** Previous-channel memory retained and cleared when no valid target; cross-session state should be reviewed with A1 session cleanup.

Changed: `PigTV/AppModel.swift`, `PigTV/CustomPlayer.swift`, `PigTVTests/PlaybackLifecycleTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/PlaybackLifecycleTests.swift`.

### 656daf6 — 2026-09-23 — A1.2 (1/2): tvOS tuning/reconnecting card

**Current, later extended.** Tuning/reconnecting presentation retained; 42 adds slow hint without fixing server contention.

Changed: `PigTV/ContentView.swift`, `PigTV/CustomPlayer.swift`, `blueprint.md`.

### 25d843a — 2026-09-23 — A1.1: cursor-paged, version-gated guide refresh (build 18)

**Current.** Cursor paging and build/version refresh retained; later scoped cache and programme revisions refine invalidation.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/APIClient.swift`, `PigTV/BrowseModel.swift`, `PigTV/DVRModels.swift`, `PigTV/Models.swift`, `PigTVTests/ContractChecks.swift`, `PigTVTests/GuideModelTests.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVTests/GuideModelTests.swift`.

### 78c7376 — 2026-09-23 — A0.3: add Swift CI workflow (iOS build + tvOS tests)

**Current, later amended.** CI builds iOS and tests TV; ad-hoc signing and tiered runner later correct harness behavior.

Changed: `.github/workflows/ci.yml`, `blueprint.md`.

### 6e81521 — 2026-09-23 — A0.1: delete unused live-channels/favourites code and retire /api/remux

**Current cleanup.** Unused live/favourite code and remux path removed; resolve is the live entry point.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/APIClient.swift`, `PigTV/AppModel.swift`, `PigTV/FavouritesView.swift`, `PigTV/LibraryView.swift`, `PigTV/PlaybackModel.swift`, `PigTVTests/ContractChecks.swift`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`.

### 6ecbab4 — 2026-09-23 — docs: archive the old blueprint; new blueprint points at the joint roadmap

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `README.md`, `blueprint.md`, `docs/archive/README.md`, `docs/archive/blueprint-2026-09-23.md`.

### b624c40 — 2026-09-23 — docs: push-to-main workflow; stop tracking Xcode/Finder user state

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `.DS_Store`, `.gitignore`, `PigTV.xcodeproj/project.xcworkspace/xcuserdata/markrogers.xcuserdatad/UserInterfaceState.xcuserstate`, `PigTV.xcodeproj/xcuserdata/markrogers.xcuserdatad/xcschemes/xcschememanagement.plist`, `README.md`, `blueprint.md`, `docs/SERVER-REQUESTS.md`.

### fd19292 — 2026-09-23 — fix: guide horizontal navigation works with remote swipes via edge focus targets (R19, build 16)

**Superseded grid implementation.** Old SwiftUI edge focus targets retired with UIKit-only grid; not a current fix to assess independently.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/DVRModels.swift`, `PigTV/GuideView.swift`, `PigTVTests/ContractChecks.swift`, `PigTVUITests/GuideNavigationUITests.swift`, `TESTING.md`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVUITests/GuideNavigationUITests.swift`, `TESTING.md`.

### 8fb7800 — 2026-09-23 — fix: guide Right navigation stuck at the screen edge on duplicate EPG entries (R19, build 15)

**Superseded grid implementation.** Duplicate-programme edge navigation fix belongs to retired SwiftUI grid; current UIKit math/dedupe tests carry behavior.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/DVRModels.swift`, `PigTV/GuideFixtures.swift`, `PigTV/GuideView.swift`, `PigTVTests/ContractChecks.swift`, `PigTVUITests/GuideNavigationUITests.swift`, `TESTING.md`, `blueprint.md`.

Test evidence changed: `PigTVTests/ContractChecks.swift`, `PigTVUITests/GuideNavigationUITests.swift`, `TESTING.md`.

### 7d2ed2f — 2026-09-23 — feat: HDR display switching for the custom player; fix light-mode clash after playback (build 14)

**Current, later hardened.** HDR display switching remains; explicit AVKit linkage/selector guards and nonblocking criteria supersede early risk.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/ContentView.swift`, `PigTV/CustomPlayer.swift`, `PigTV/GuideFixtures.swift`, `PigTV/PlaybackModel.swift`, `PigTVUITests/GuideNavigationUITests.swift`, `TESTING.md`, `blueprint.md`.

Test evidence changed: `PigTVUITests/GuideNavigationUITests.swift`, `TESTING.md`.

### 5f1cc07 — 2026-09-23 — feat: category-switch hang fix, uniform guide spacing, scrub bar, wide guide slide; retire AVKit fallback (build 13)

**Partly superseded.** Filtering/coalescing intent retained; old SwiftUI-grid layout changes replaced by UIKit. AVKit fallback remains retired.

Changed: `PigTV.xcodeproj/project.pbxproj`, `PigTV/AppModel.swift`, `PigTV/BrowseModel.swift`, `PigTV/ContentView.swift`, `PigTV/CustomPlayer.swift`, `PigTV/DVRModels.swift`, `PigTV/GuideView.swift`, `PigTV/LibraryView.swift`, `PigTV/Models.swift`, `PigTV/PlaybackModel.swift`, `PigTV/PlayerExtras.swift`, `PigTVTests/GuideModelTests.swift`, `README.md`, `TESTING.md`, `blueprint.md`.

Test evidence changed: `PigTVTests/GuideModelTests.swift`, `TESTING.md`.

### 9e62caf — 2026-09-23 — docs: round-3 device feedback handover — R07/R08/U02 accepted; open R14/R16/R17/R18

**Documentation/history.** No independent runtime outcome. Read as history, not evidence that acceptance passed.

Changed: `blueprint.md`.

## Merge commits

- `441ba2a` Merge branch 'p3/observation' into p3/app-integration
- `82edd0a` Merge branch 'p3/guide-stall' into p3/app-integration
- `09ed009` Merge branch 'audit/sw-r03' into audit/sw-integration
- `5592332` Merge branch 'audit/sw-sport' into audit/sw-integration
- `1e84c5b` Merge branch 'audit/sw-r07' into audit/sw-integration
- `e49fee5` Merge branch 'audit/r10-ci-fix' into audit/sw-integration

## Validation and continuation, 22 October

The earlier sandboxed push tier failed before execution because the configured tvOS simulator was not visible. An earlier permitted retry was recorded as having built for testing and passed 243 synthetic contracts, with its unit phase still running when interrupted. Its final result is **unconfirmed**: the prior `/tmp` logs are no longer present, and sandboxed process enumeration was denied. No completed push-tier or fresh iOS build result is claimed. The next implementation agent must run those required checks and retain their final summaries.

A fresh `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer sh Tools/test-contracts.sh` run completed with exit 0 and **243 API/model checks passed**, using synthetic data and no server/provider. Log: `/tmp/pigtv-apple-finish-contracts.log`. These pure contracts do not cover the UI/publication races below. No heavy simulator workload was launched in this continuation.

The exact-window inventory contains **115 commits including six merges**. The follow-up independently rechecked A1–A3 against current source and re-read focused functional diffs for builds 46, 44 and 42, the cache scoping/coalescing changes, recording marker startup, Guide first-fill/revision changes, Sport clock correction and AVKit crash follow-ups. The earlier broad historical diff truncation caveat remains: this is complete commit classification plus focused source/intent review, not a claim that every historical line and binary was independently examined.

### A4 — P2: Same-shape guide corrections update the store without refreshing visible cells

Evidence: [append-only branch](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/GuideGridView.swift:355), [update triggers](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/GuideGridView.swift:184), [store invalidation](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTV/GuideGridLayout.swift:25), [store-only regression](../../../../../../../../../../../Users/markrogers/Documents/GitHub/PigTV-Swift/PigTVTests/GuideGridStoreTests.swift:14).

The R14 correction clears cached programme lists by revision, but `applyNow` still classifies rows as append-only using channel ID, programme count and first start. A title/end correction with the same shape calls `store.setRows` and returns without reconfiguring cells or invalidating layout. If clock, origin, duration and recording marks are unchanged, the surrounding update supplies no redraw. An already visible cell therefore retains the previous presentation until another event refreshes it; the visible-guide clock runs every 30 seconds, so this is a stale interval rather than a permanent cache failure. An end-time correction also needs layout invalidation. The existing test checks the store's new value, not the visible cell or its geometry.

This is a source-confirmed missing controller update, not a simulator visual reproduction. Add a controller/UI test that keeps channel count, programme count, first start and clock constant, changes title/end and revision, and immediately asserts the displayed text and frame while preserving focus. Treat changed revisions/content separately from genuine paging appends and reconfigure only affected rows. Do not erase the successful store-cache correction in `f83295e`/`ba10988`; complete its propagation to the view.

## Acceptance still required

Physical iPhone/iPad auto-PiP, failed PiP start and restoration; background/foreground recording lifecycle; real HEVC/audio/discontinuity playback and growing-recording restart/finalization; tvOS remote fast-scroll/focus; current icon/header visual fit; App Group Top Shelf on a signed device. These cannot be marked verified by source inspection or synthetic simulator checks.

## Cross-cutting conclusions and efficiency opportunities

- Playback generation/identity checks and release-before-switch ownership remain in the live model and fallback path. The iPhone “Tuning” hint in build 42 is presentation, not proof that server admission/connection contention was fixed. Swift 5 rollback was superseded by explicit AVKit availability/linkage and correctly handled Swift 6 callbacks.
- Build 39 deliberately removed old timeshift/growing-HLS paths. Build 44 adds a distinct flag-gated recording-watch protocol with bounded polling and file fallback. Old C-E test results are not acceptance of the new C-L protocol.
- Marker fetching no longer blocks recording start. Build 41 later adds a bounded resume-position request after item installation and before starting playback; measure that separate delay if startup remains slow.
- Scoped guide-cache retirement, decode away from the main actor, canonical artwork fetch coalescing, lazy Sport rendering, freshness windows and narrow observable stores are real retained efficiency work. Their benefit should be measured on devices before assigning numerical savings.
- Maintain the artwork disk bound during long sessions, coalesce pruning, and make generation-safe Top Shelf publication suppress obsolete renders/writes. These improve correctness and avoid wasted work.
- Optional next-channel warming is explicitly gated by the server setting and app dwell/visibility/start state. It should remain off until measured provider-connection headroom and adoption benefit justify enabling it.
- Credential/error paths use client-facing safe messages and opaque server handles; no provider/deployed endpoint was used during this review. This is scoped source review, not a penetration-test claim.
