# PigTV consistency, responsiveness and Dispatcharr adoption review

15 October 2026. Review and action plan only; no application changes, commits, pushes or deployment.

Reviewed local snapshots: server/web `3449719` (0207), Swift `63f9a43` (40), Pig-Branding `b40c958` (kit 1.7.0). All three working trees were clean at the start. No pull was performed, so these findings describe the local snapshots, not an independently checked remote HEAD. Platform priority: tvOS, iPad, iPhone. The web remains an admin/light-viewing client; matching its feature set to the TV app is not a goal.

The branding foundation is consistent. The highest-value immediate work is to correct navigation and refresh behaviour, make web viewing actions keyboard-accessible, and add tests for those interactions. There is no evidence here that a framework rewrite or a broad SwiftUI refactor would make the app faster. Keep the current playback path until a separately measured shared-ingest project justifies replacing it.

## Evidence and limits

This is a source, asset and automated-check review. No deployed server, provider connection, physical device, interactive simulator session or external Dispatcharr service was accessed. No fresh UI screenshots or device timings were collected. Source findings are not device verification, and old fixture screenshots cannot establish the appearance of build 40.

| Check | Result |
|---|---|
| Approved web artwork | All 17 files under `public/img/brand` have exact SHA-256 matches in the branding kit |
| Swift artwork | 13 catalog images and all 6 Icon Composer artwork files match the kit exactly; the 6 LaunchBrand images are app-generated launch assets, not failed kit copies |
| Swift semantic colours | All 14 mapped colour sets match within 0.000001 per component; JSON differences are precision and author metadata |
| Web glass/radiance | Content matches kit apart from 1.6.0 versus 1.7.0 header comments; 1.7 adds PigMenu and does not introduce a new base palette |
| `verify-build.sh` | Passed |
| Swift standalone contract checks | 219 passed using synthetic data |
| First permitted `npm test` | 907/909 passed, no skips, about 32 seconds; the two health checks failed because their local server port was already in use |
| Isolated health rerun | Both passed |
| Full server rerun | 883/909 passed, 26 failed during extreme slowdowns; includes startup timeouts, performance budgets and provider-failover assertions. This is not a green run, and the failures must be rechecked in a stable environment before shipping |
| Swift fast tier | Build-for-testing completed and contracts passed; unit execution did not complete reliably. Xcode reported simulator launch failure, Mach error -308; the stalled run was terminated |
| Web reproductions | Three passed against the current page code; see `web-reproductions.cjs` alongside this report |

The initial sandbox denied localhost listening and CoreSimulator access; permitted retries were used. Neither that sandbox failure nor the later slow run proves a product regression. Equally, isolated passes do not substitute for a full green release gate. No iPad/iPhone build, visual tier or hardware run is claimed.

Run the review reproductions from any directory with Node 24:

```sh
node docs/reviews/2026-10-15/web-reproductions.cjs
```

The script asserts the current faulty behaviour to preserve review evidence. When implementing fixes, replace these demonstrations with regression tests that expect correct behaviour in the normal test suite.

## Prioritised findings

P2 means fix in the next usability pass, not an emergency. P3 is a follow-up improvement. “Reproduced” means a local synthetic reproduction; “source-confirmed” describes the implementation without claiming a device test.

### F1 · P2 · Web guide requests can publish out of order — reproduced

**Evidence:** `public/js/components/EpgGuide.js:131` (`navigate`), `:252` (`fetchEpgData`). Each request captures its time window, fetches pages, then unconditionally replaces the shared rows, window and indexes. There is no request generation or cancellation check.

**Trigger/impact:** click Later twice with the first response slower than the second, or overlap navigation with background refresh. The older request can replace the newer window, leaving the selected time and programme data inconsistent. The reproduction completes window 2000 first, then window 1000; the stored window regresses to 1000.

**Action:** one guide load coordinator: share identical in-flight requests, publish only the latest generation, and retain visible data while fetching. Reuse the loaded interval when it covers the requested viewport; request missing time ranges instead of every overlapping 24-hour window.

**Acceptance:** deliberately reorder responses and overlap a periodic refresh with navigation. Only the latest intent renders; failure retains the previous usable guide with a Retry action.

### F2 · P2 · Home can remain stuck loading after a quick revisit — reproduced

**Evidence:** `public/js/pages/HomePage.js:16`, `:110`, `:124`. `show()` replaces the DOM before `loadDashboardData()` checks `isLoading`; the pending request holds the previous list element.

**Trigger/impact:** Home → another tab → Home while favourites are loading. The second request is skipped, and the first writes into the detached list. The new Home remains on “Loading favorites…”.

**Action:** cache the data independently from the DOM and render it into the current page generation. A boolean busy guard should not drop the latest render request. Share the favourites request across consumers where appropriate.

**Acceptance:** slow favourites response, repeated visits, an error followed by Retry, and a response arriving after the page hides. The visible page always settles.

### F3 · P2 · Browser Back pushes a new history entry — reproduced

**Evidence:** `public/js/app.js:142` calls `navigateTo(page, false)` from `popstate`; `:321` treats false as `history.pushState`. The comment says the opposite of the implementation.

**Impact:** Back/Forward navigation rewrites the history it is traversing, preventing normal traversal and potentially discarding the forward route.

**Action:** replace the ambiguous boolean with explicit `push`, `replace`, and `none` modes; use `none` for `popstate`.

**Acceptance:** Home → Guide → Settings, Back twice, Forward twice. Location and visible page agree without extra entries.

### F4 · P2 · Main web viewing actions lack keyboard semantics — source-confirmed

**Evidence:** Home tiles (`HomePage.js:177`), live channel rows (`ChannelList.js:299`), group headers (`:491`), guide channel labels and programme cells (`EpgGuide.js:565`, `:736`) are clickable divs. Their handlers provide click behaviour without tab stops or equivalent Enter/Space handling. Live-page up/down shortcuts change an existing selection; they do not make these actions reachable from an initial keyboard visit.

**Impact:** a keyboard or assistive-technology user can reach a favourite button but cannot reliably choose the corresponding programme/channel or expand a group. This also breaches the kit's requirement to preserve keyboard order and targets.

**Action:** use native buttons for play, details and group expansion, with separate sibling favourite buttons; avoid nesting buttons. Preserve focus through virtual-row recycling and refresh. Add `aria-expanded` to groups and an explicit accessible favourite state.

**Acceptance:** keyboard-only Home → play, Guide → details → dismiss, group expand/collapse, favourite toggle, and scroll to offscreen rows. Focus remains visible and returns to its origin; screen readers announce action and state.

### F5 · P2 · Swift guide invalidation misses equal-count favourite changes — source-confirmed

**Evidence:** `PigTV-Swift/PigTV/GuideView.swift:245` observes `model.favourites.count`. Its cached rows depend on the identities (`:563` onwards). `BrowseModel.swift:494` can publish a new favourites array with the same count. An observed-store update redraws the view but does not itself recompute the stored `rows` array.

**Trigger/impact:** change A to B on another client, then return to Guide. `onAppear` can filter the old values before the async favourites refresh completes; if the count is unchanged, the Favourites rows remain stale until another invalidation. This affects tvOS and both iOS layouts.

**Action:** observe a membership revision or the stable identity set, not just count. Keep the existing equality checks and coalesced filtering.

**Acceptance:** publish equal-sized lists with different identities while the Favourites filter is visible and after returning to the tab. B replaces A without a tab/filter round-trip; unchanged membership causes no unnecessary grid rebuild.

### F6 · P2 · tvOS Recordings has no sustained freshness policy — source-confirmed

**Evidence:** `PigTV-Swift/PigTV/RecordingsView.swift:103–110` loads on appearance (10-second staleness threshold on TV). There is no visible-screen periodic refresh. Home's recording refresh stops when Home disappears (`HomeView.swift:180` onwards); Guide's loop is also visibility-scoped.

**Impact:** leave Recordings open while a scheduled programme starts, finishes or fails: its displayed state can remain stale until navigation or another action triggers a load. TV has no pull-to-refresh, so freshness costs unnecessary remote actions.

**Action:** a cancellable visible-only refresh, more frequent when a recording is pending/active, plus an explicit Refresh action if useful. Preserve unchanged rows, focus and scroll position. Do not restore background polling on every hidden tab.

**Acceptance:** transition scheduled → recording → completed/failed with the page open. State updates within a documented bound, no spinner replaces content, and no polling continues after leaving the screen.

### F7 · P3 · Web guide does unnecessary hidden-page work — source-confirmed

**Evidence:** `app.js:150` eagerly loads the complete guide on Home startup. `EpgGuide.js:160` refetches all pages every five minutes; `GuidePage.hide()` does nothing. The minute indicator is scheduled in both `init()` (`:82`) and `render()` (`:474`). The browser API has no guide-version client helper, although the server and Swift already support it.

**Impact:** duplicated indicator work and repeated guide downloads even when the user stays in Settings or Home. This is a bounded inefficiency, not evidence of noticeable slowness at the current lineup size.

**Action:** one visibility-aware guide owner; fetch version before reloading unchanged data; retain now/next needed by active live playback and refresh on return. Remove the redundant timer. Combine this with F1 rather than introducing another cache.

**Acceptance:** count requests during ten minutes on each page and with the browser hidden. Unchanged data does not trigger full downloads; returning to Guide immediately shows cached content and refreshes if needed.

### F8 · P3 · Brand drift is in state styling and maintenance, not artwork

**Evidence:** `public/css/main.css:2623` hard-codes active favourites to `#ef4444`, whereas Swift uses the Pig accent for favourites. The red also bypasses the light-theme danger token. Web UI copy uses “Favorites” and “program”; Swift uses “Favourites” and “programme”. Brand tests check presence and markup, but do not pin asset provenance or semantic token equivalence.

**Action:** use the accent role for favourites and reserve danger for destructive/error states; standardise user-facing terminology, preferably the existing Australian-English Swift wording. Do not rename API paths or identifiers. Record the kit version and source checksums, with explicit aliases for `PigAccent` → `AccentColor` and `PigTextAccent` → `PigAccentText`. Test semantic colour equality, not JSON byte equality. Keep generated launch assets as documented derivatives.

**Acceptance:** same favourite meaning and appearance across light/dark web and Swift; kit comparison recognises intentional derivatives and catches an actual changed master/token. No branding-driven change to player timing or layout density.

## What to preserve and simplify

Keep Swift's separate observable stores, memoised Home/Sport snapshots, off-main guide decoding/filtering, server-qualified logo cache (32 MB decoded budget, shared in-flight fetches), UIKit guide reuse, graphical selection separate from focus, and the splash that ends as soon as startup completes. These are appropriate existing solutions. Preserve iPhone's On now layout and iPad's larger guide; identical layouts across devices would reduce usability.

Keep the server's paged library, batched now/next lookup, bounded EPG time queries, channel identity rules, copy-first playback, per-feed timestamp classification, capability flags, redaction and capture-first discipline. Avoid “simplifying” them away because they contain more branches than a generic player.

The useful simplification unit is ownership: one owner of each request, refresh timer and derived list. Start with web guide/favourites and the two Swift invalidation gaps. The 4,508-line web stylesheet, 1,331-line Settings controller and 1,637-line player are maintenance candidates, but splitting files alone does not improve UI latency. Extract page-specific CSS/settings sections when touching those areas; protect computed styles and behaviour. Do not refactor the player during this usability pass.

The test harness also merits a small reliability task: `test/helpers/server.js` obtains an unused port by opening and closing a socket, then starts the server on it. That reservation gap permits the collision observed here. Prefer a child-bound ephemeral port reported back to the test, or retry only confirmed address-in-use failures. Do not simply widen every timeout to hide regressions.

## Dispatcharr plan validation

The controlling decision is Plan B in `blueprint.md` §4: stay standalone and adopt ideas natively. `docs/DISPATCHARR-REVIEW.md` §1 still recommends a Plan A spike, so its opening should be labelled superseded by the 13 October decision. The source review is pinned to Dispatcharr v0.32.0 / `eab4b4f`; this review validates PigTV's local adoption state and the plan's engineering completeness, not current upstream behaviour or a line-by-line comparison with an independently fetched Dispatcharr checkout. No runtime Dispatcharr integration was found in the searched application code.

| Recommendation | Local adoption state | Recommendation now |
|---|---|---|
| R1 upstream spike | Explicitly not pursued | Keep out of the implementation queue; reconcile the old document introduction |
| R2 shared ingest / B3 | Not implemented; HLS still opens `this.url` in `transcodeSession.js:547` | Separate design and measurement gate; not a prerequisite for UI fixes |
| R3 segmented DVR / B2 | Not implemented; engine keeps parts and fails interrupted schedules at restart | Remains a decision gate: Mark previously skipped R13. Do not treat its presence in Plan B as renewed implementation approval |
| R4 guide-following end time | Not implemented; stored end plus a fixed hard-stop timer | High-value sport improvement, with the timer correction below |
| R5 recording rules | No series/follow-rule scheduler found | Native rules using stable episode/event identity; preserve one-off scheduling and explicit conflict policy |
| R6 programme artwork | Channel-logo fallback exists; planned recording programme artwork is separate | Additive contract and caching work; lower priority than navigation/freshness |
| R7 speed-based recovery | No planned speed-threshold recovery implementation found | Collect telemetry first; don't blindly copy 1.0×/15-second thresholds |
| R8 ingest filters | Still planned; UI visibility is not import exclusion | Pilot reversible whole-group filters; benchmark sync, linking and DB effects before promising UI gains |
| R9 event-channel EPG | Still planned | Explicit timezone/DST handling, provenance, expiry and real-EPG precedence; feed Sport only with trustworthy event times |
| R10 EPG tune-ups | Existing mapping/suggestions, not the proposed region/bulk-review additions | Preview/review and undo; preserve manual mappings and tune thresholds on local labelled examples |
| R11 notifications/stats | Existing status/health/reminders, not the planned webhook/live-stat additions | Separate telemetry display from automatic recovery decisions |
| R12 scheduled backup | Manual online backup exists; no nightly/build-change invocation found | Reuse `scripts/backup-db.js`; add scheduling, restore check and pre-migration ordering |
| B4 retire old paths | Not started | Gate each deletion on observed replacement behaviour; one week elapsed alone is insufficient |
| Archive/audio discovery | Not established by this review | Check supplied samples/fixtures first; provider access and new captures still require Mark's approval |

### Plan corrections needed before implementation

1. **R4 must change the active timer, not just the database.** `recordingEngine.js:702–708` schedules a one-shot hard stop from the original end. Updating `program_end` during EPG sync would still leave that timer firing. Reschedule it or make it re-read the authoritative deadline. Test later guide corrections, restart, maximum extension, manual stop and adjacent programmes. An unchanged provider guide cannot detect a real-world sport overrun; retain a manual extension/padding option.
2. **R12 should extend the existing online backup, not add a second backup mechanism.** The script already uses SQLite's online backup and keeps seven copies; the old proposal says `VACUUM INTO` and fourteen. Resolve retention explicitly. A build-change backup must precede migrations, use collision-safe/atomic completion, and be restore-tested. The database is not a complete installation backup: preserve the auth secret and required configuration as described in Operations. Do not present a same-disk copy as protection against disk loss.
3. **Shared ingest needs a complete resource and identity design.** Key by durable provider/account/channel identity, with a logical subscriber group that survives provider failover. Specify byte-bounded buffers, slow-consumer eviction, backpressure, keyframe/PAT/PMT late joins, probe consumption, teardown and single-connection admission under concurrency. A 30–60-second buffer costs about 94–188 MB at 25 Mb/s per ingest, before overhead; define a byte cap as well as a duration.
4. **A new pipe does not guarantee compatible failover.** Codec, resolution, frame-rate, audio and HDR differences still matter even if one ffmpeg process stays alive. Preserve equivalent compatibility checks and test the published master playlist, timestamp classification and A/V continuity on all five reference samples. Prove watch+record and two viewers share one connection while a different channel still respects limits. Do not claim an improved cold-start time without measuring it.
5. **Make retirement evidence-based.** B4 should require no provider-slot leaks, correct viewer/recording arbitration, safe cancellation/supersession, crash cleanup, bounded memory, equivalent HDR/50 Hz/HE-AAC behaviour and a working rollback switch. Retire refusal retries only once probes no longer independently hit the provider. Keep legacy recovery until the replacement proves those cases.
6. **Name and contract the additions before touching clients.** R5/R6 and any changed recording playback state need feature flags, fixtures and web/Apple UX. Keep one home for milestone status in `blueprint.md`; preserve the existing K1–K15 capabilities as acceptance tests, not just prose. Use native implementations of the described ideas; do not treat this review as a provenance or licensing clearance for copied upstream code.

## Proposed implementation order

| Wave | Work | Exit condition |
|---|---|---|
| 1 · bounded usability fixes | F5/F6 on tvOS, then F1–F4 on web; verify shared fixes on iPad/iPhone | Focused old-code-failing regressions, full required gates, then device confirmation |
| 2 · consistency and less idle work | F7/F8, semantic asset manifest, copy consistency, test-port reliability | Reduced request counts, keyboard coverage, light/dark and accessibility checks |
| 3 · independent Dispatcharr benefits | R12 backups, R4 end adjustment, R11 telemetry; consider R8 filters early | Restore proof, corrected hard-stop tests, measured import/latency effects |
| 4 · recording/guide features | R5/R6, R9/R10; explicit decision on R3 | Additive API contracts, understandable TV actions, deduplication and timezone fixtures |
| 5 · playback architecture | R2/R7, then conditional B4 retirement | Capture/bench evidence, resource bounds, device/feed tests and rollback |

No credible speed estimate follows from source size alone. Establish baseline measurements before optimising further: tvOS remote-to-focus/selection response and tab-switch p50/p95; warm/cold first usable guide; iPad guide scrolling and rotation; iPhone Dynamic Type and compact layouts; web click-to-feedback, long tasks and request counts; server guide/status latency and event-loop delay during sync/linking. Use the normal 1,000-channel lineup plus stress fixtures. Keep UI latency separate from first-picture time. Existing tab-switch instrumentation targets p95 below 250 ms; record device/build/fixture and compare like-for-like rather than imposing that as an unmeasured guarantee.

## Device/visual acceptance block for the follow-up work

1. **tvOS first:** light/dark Home → Guide → Sport → Recordings → Settings; repeated remote movement, focus at scroll edges, close details/player and check focus restoration. Leave Recordings open across a schedule transition. Change favourite membership on another client without changing count and return to Guide.
2. **Branding:** focus versus selection, readable accent labels, no clipped rings, Top Shelf cropping/parallax, launch-to-splash continuity, Reduce Motion/Transparency. Check the approved masters rather than old screenshots.
3. **iPad:** portrait/landscape and narrow multitasking widths, touch targets, keyboard navigation, large Dynamic Type, guide scroll position and foreground refresh.
4. **iPhone:** On now list, schedule/info action, largest supported text sizes and VoiceOver. Check navigation in landscape: the current Guide deliberately hides the tab bar, so assess whether requiring portrait to switch sections is acceptable before changing that design.
5. **Web:** keyboard-only play/details/favourite flows; rapid Back/Forward and page switching with delayed responses; repeated guide navigation; theme and reduced-motion states; stable focus after data refresh.
6. **Playback changes only:** obtain approval for deployed-server/provider access, capture the reference feeds first, then test HDR/50 Hz/HE-AAC, same-channel sharing, different-channel conflicts, recording takeover, failover and cancellation. Mark's results are required before any item is called Verified.
