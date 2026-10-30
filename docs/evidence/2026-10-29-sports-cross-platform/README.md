# Cross-platform sports continuation — 29 October 2026

Local implementation from server 0316 (`cba8019`) and Apple 59 (`b91e4de`). Mark asked to complete the phone/tablet/web
requirements before one consolidated manual acceptance pass. No push/deploy, deployed-server access, ESPN request,
provider-consuming playback or pilot was authorized or performed. The separate FOX Kansas City media incident is excluded.

## Evidence and current status

- Mark reported no visible web/server/iPad issues, with tested builds/dashboard flag unspecified. This is not acceptance
  of the newly built dashboard. Last baseline evidence remains 0316: 1,316 server tests/build checks, Apple 59: 244
  contracts, 243 unit/playback, 20 UI and iOS build. These passed locally; required sports reviews remain 0 of 2 per repo.
- Web 0317 implements the separate Sport page, C-O shelves/settings, C-I 72h fallback, seven sport families, visible
  options/context menu, keyboard focus retention, neutral expiry placeholders, cached logos/name fallback and explicit
  availability/recording labels. Watch/record/series/sport rules use existing endpoints and revalidate channel/airing association.
- Web focused synthetic tests: 23 pass (55 with existing web/status tests). Installed Chromium checks pass at 390/1024/1440 widths (fully intercepted
  synthetic requests): hidden first render/details, equal card dimensions, visible options, Escape/focus return,
  settings save, focused expiry, removed sport shelves, background clearing and actual one-off/sport-rule confirmation
  payloads (current channel ID and neutral match/title). Build verification passes. The first full server
  run had 1,336 passes and one obsolete six-navigation-link assertion; the page now has seven links, and the test
  checks the exact page identities rather than the old count. A second run passed 1,338/1,339 but missed the existing
  cold projection speed budget under concurrent iOS startup (164.6ms / 100ms); the budget is unchanged. The isolated
  complete final run passes all **1,339 tests**, zero failures/skips, including the unchanged speed budget; build
  verification passes. Final mobile UI checks pass as listed below. Apple 60 required push gate passes: 244 contracts, 243 unit/playback and
  20 regression UI tests, zero failures/skips. There is no real-browser-on-production or device acceptance claim.
- **Apple 60 final local gates:** 244 contracts, 243 unit/playback, 20 tvOS regression UI, generic iOS Simulator build,
  **2 iPhone UI and 2 iPad UI pass**, zero failures/skips. The old iPad width regression fails at 264pt on 59
  (`apple-mobile-before.json`); both final mobile runs verify responsive width/options/privacy and accessibility-size
  equal cards. All simulators were shut down afterward. Exact result summaries are committed alongside this record.
- Intermediate iOS launches stalled in UIKit initialization before dashboard rendering (`ios-launch-stack-excerpt.txt`).
  A temporary control-layout simplification was reverted; final tests pass on the original required-gate source.
  Interrupted launches count neither as passes nor product failures. [iPhone max text](#files-kept-outside-the-repository) and
  [iPad max text](#files-kept-outside-the-repository) are synthetic XCTest captures, not device acceptance. The phone's maximum-text
  header requires vertical scrolling to cards. The iPad capture exposes cosmetic fallback-initial clipping (SD-A60-L1).

## Regressions found in the web draft

| ID | Reproduction and disposition |
|---|---|
| SD-W0317-C6 | Polling could republish old revealed scores while a preference write was pending. Deferred-write test fails before; reads/actions now wait for write settlement and revalidation. `web-pending-write-before.txt`. |
| SD-W0317-C7 | Same-window 401 token removal could retain the old revealed snapshot. Current-request identity invalidation clears it; superseded requests cannot clear a new account. `web-auth-before.txt`. |
| SD-W0317-C8 | A redundant asynchronous dialog-close focus callback could override a new card focus after saving settings. The 1440px retained-focus assertion failed (`web-dialog-focus-before.txt`). Removed callback; native dialog focus restoration is used. Final three-width run passes. |
| SD-W0317-C1 | Recording matched stable identity but sent its old positional ID after channel reorder. `web-channel-reorder-before.txt`: pos_1 instead of pos_8. Fixed: take channel metadata from the current C-I airing. |
| SD-W0317-C2 | Keyboard focus moved away from an expired card but its placeholder survived. Chromium timeout reproduced this: `onfocusout` property did not register an event listener. Fixed with native `addEventListener('focusout', ...)`; the checked-in browser test asserts removal. |
| SD-W0317-C3 | Removing a whole followed sport left its old scores visible. `web-removed-shelf-before.txt` contains the actual stale DOM assertion. Fixed: prune removed shelves; retain only a neutral focused placeholder until focus moves. |
| SD-W0317-C5 | Shared recording banner exposed raw guide/result titles over the dashboard. Two failing-before tests (`web-banner-before.txt`) cover entering Sport and an active-recording refresh. Fixed: synchronous neutral mask and title-free Sport wording. |
| SD-W0317-C4 | A settings form captured at an older revision could submit with the latest polled revision. `web-form-revision-before.txt`: one write instead of zero. Fixed: preserve the form revision and require explicit user retry. |

`web-missing-before.txt` proves the initial new feature tests fail before the web implementation exists. These are
feature-absence failures, distinct from the reproduced functional defects above. `web-focused-after.txt` is the final
focused run; browser script: `scripts/test-web-sports.cjs` (requires an already installed Playwright/Chromium, no
installation step). Set `PIGTV_WEB_CHROMIUM` to an installed binary and `PIGTV_WEB_TEST_WIDTH` to 390, 1024 or 1440;
make the installed Playwright module available via NODE_PATH. Requests are intercepted; this never starts PigTV.

## Consolidated manual acceptance — Mark, after review and authorized deployment

Record server build/commit, Apple build, browser/device/OS and `PIGTV_SPORTS_DASHBOARD` for each result. Use the same
account on Apple TV, iPhone, iPad and web. A synthetic fixture pass is not a live transition or device pass.

1. **Capability off/on:** off retains ordinary Sport and rolling 72h schedules; on shows dashboard shelves. Check all ten
   follows: AFL, F1, EPL, Cricket, MLB, NFL, FA Cup, UEFA, Championship, NBA. Empty/unmatched/scoreless games stay visible.
2. **Cards and input:** same sizes within each sport; shelf-only sport name, no Total points; one start/progress row.
   Yellow ! = no channel found, red × = channel unavailable, recording separately labelled. Check long names, missing
   logos, light/dark, phone rotation, tablet split view, large text, VoiceOver, remote and keyboard focus. Visible options
   and touch-and-hold/long press open safe channel/event/recording choices.
3. **Account sync:** toggle spoilers and set delay 0/90/300 on each platform in turn. Other visible devices should update
   after refresh (target <=30s online; measure actual time). Resume must hide old scores before revalidation. Sign in as
   another user: values isolated. Concurrent saves must ask for review/retry on conflict; no silent overwrite.
4. **Lifecycle/privacy:** background, lose connectivity, sign out/in, change scope and resume with scores previously
   revealed. No old scores or result prose in cards, details, accessibility, menus or captured recording confirmations.
5. **Time/status:** upcoming → on TV → confirmed LIVE → break → final; cross-midnight continuation and retained recent
   final. Compare delayed whole states; game clocks do not tick locally. A current raw final cannot override the delayed
   card. Expired/final cards never tune unrelated TV. Focus/order remain stable while cards update/expire.
6. **Actions:** select preferred channel; explicitly choose another; schedule/cancel Watch when it starts; deny an
   expired/missing stable channel. Record the selected channel/window, add the existing series/sport rule, confirm normal
   conflict/takeover prompts. Check indicators on return. Only this explicitly authorized pass may consume a provider.
7. **Sport edges:** football stoppage/extra time/penalties; basketball/NFL overtime; MLB extras/suspension; cricket
   innings/stumps/rain and unknown format; separate F1 sessions. F1 has no timing/positions. Basic AFL points are intended;
   optional NFL/MLB situation fields may be absent. Show missing data honestly rather than fabricated zeroes.
8. **Pilot gate (separate authorization):** measure SD-0313-L3 collector bytes/parse/normalize/ingest, event-loop delay,
   CPU/heap and HLS p95/p99/max against flag-off baseline before normal enablement. SD-0313-L2 unknown-format multi-day
   cricket stays conservative at 12h for joins/hot polling; never widen from endDate envelopes alone. Possible duplicate
   unmatched guide listings are intentional uncertainty. Noncanonical future category views remain SD-A59-L1.

## Remaining limitations

- No deployed dashboard or physical platform accepted. The flag remains opt-in (`PIGTV_SPORTS_DASHBOARD=1`); synthetic
  Apple fixtures bypass server capability for UI tests and have real actions disabled. Browser tests intercept all API
  responses and never start a server. Full Node API tests explicitly cover flag off/on and paired-account isolation.
- SD-0313-L2 unknown-format cricket joins/hot polling remain bounded at 12h; no widening from endDate envelopes.
  SD-0313-L3 collector/HLS pilot requires separate Mark authorization before normal enablement. SD-A59-L1 future
  noncanonical-category navigation stays open; all ten current essential follows are canonical and retain league views.
- F1 is sessions only, with no timing/positions. AFL basic points are intentional; goals/behinds enrichment, richer
  NFL/MLB situations and football aggregate/shootout totals are optional/absent rather than fabricated.
- SD-A60-L1: at maximum Dynamic Type, the existing generic logo tile clips its fallback initials in the iPad capture.
  Adjacent full team names remain visible/accessibly labelled; cached logos and score/privacy behavior are unaffected.
  Cosmetic follow-up remains for Mark to prioritize/accept.
- Team logos use cached free ESPN graphics with name fallback. Attribution/permitted-use assessment remains a release
  follow-up. No new graphic/provider source was contacted in this batch.
- Existing GATE-20261029-REC1 intermittent recording master-response gate is separate, as are all media incident files.

## Required review — remains 0 of 2

AGENTS.md assigns the slash command to Mark; this environment cannot invoke it. Consolidate the sports foundation and
client adaptations, excluding unrelated media work, with at most two review rounds per repo. Register every finding and
disposition. After round two only highs block; medium/low findings remain in FINDINGS.md.

Server (from the sports foundation baseline):

```
/codex:adversarial-review --background --base a6e86e1 Review sports dashboard foundation/coverage and web 0317 only: C-O delayed whole state and retention, worker/cooldown/budgets, all follows and cricket limits; web identity/preferences/revision and offline/resume safety, spoiler-safe card/details/accessibility, capability/404 fallback, stable focus/order/expiry, stable-channel revalidation and recording association. Check failing-before evidence and CLIENT-CONTRACT. Exclude separate recording/relay/media work except concrete interactions. SD-0313-L2/L3 remain open. Round 0 of 2.
```

Apple (sports UI/model changes from the pre-dashboard baseline):

```
/codex:adversarial-review --background --base 2f0df26 Review Apple sports dashboard 59/60 only: capability/404 fallback, seven card families and missing fields, whole server-delayed snapshots, account identity/revision conflicts and first render/resume/offline hiding, spoiler-safe details/accessibility/captured sheets, stable focus/order/expiry, strict current-airing and selected stable-channel association, existing recording/rule/preferred-channel flows, mobile viewport/large-text/touch options. Check contract and synthetic failing-before evidence; device acceptance is pending. Exclude separate player-exit/media work except concrete interactions. Round 0 of 2.
```

Do not count this agent’s own inspection as a Codex round or an approval.

Local Xcode 27 checks disabled optional diagnostic collection (`-collect-test-diagnostics never`), preserving all test
assertions. The tvOS UI result repeats the same two `_UIReplicantView` framework warnings as the Apple 59 baseline;
there are no new test failures attributed to them. Intermediate mobile-launch interruptions are retained as unconfirmed attempts,
never treated as a product regression pass; final original-source runs pass. No SDK/dependency was installed or simulator UI driven manually.

## Files kept outside the repository

Raw or oversized files from this folder are kept off GitHub (decision D-30): on Mark's disk, then the Unraid test
share. Each is still in git history at `665e02e` under its old path. Identify a copy by its SHA-256.

| File (old path under `docs/reviews/`) | Bytes | SHA-256 |
|---|---|---|
| `2026-10-29/sports-cross-platform/ipad-max-text.png` | 2,140,695 | `a2a62490b76124f08beb56417286c7b0efc488601af360f5f2a2cc2ed2b3137b` |
| `2026-10-29/sports-cross-platform/iphone-max-text.png` | 1,677,750 | `45c6abee3ce7fe0493fd63edcc01e68b52274ea62be2e25e3ed21fe71694ec5d` |
