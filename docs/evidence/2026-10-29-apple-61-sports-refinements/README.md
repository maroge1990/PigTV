# Apple 61 sports refinements — 29 October 2026

Mark authorized these refinements before one consolidated Apple TV/iPhone/iPad/web device pass. Starting Apple build
60 (`2eb86af`), server/web 0317 (`0688196`). No provider/deployed access, push or deployment. Separate media incident
work remains excluded. Mandatory sports reviews remain documented at 0 of 2 per repo; no review/device acceptance.

## Implemented and locally tested (review/device acceptance pending)

- Dashboard recording badges use source + stable channel identity. The existing scheduled response already supplies
  `source_id`, `channel_item_id`, `channel_stable_id`; Apple decodes them optionally. Missing identity never falls back
  to the name, and a missing stable match never falls back to a position. Existing ordinary Guide marks stay separate.
  This describes current channel recording activity; no recording writer, ownership or scheduling semantics changed.
- tvOS card heights are fixed by league family through status/privacy/availability updates: AFL/NBA/football 320pt,
  NFL/MLB 372pt, Cricket/F1 352pt, other guide categories 304pt (previously all 380pt). Heights scale with text settings;
  cards within each sport stay equal. Compact spacing and a combined channel/recording footer preserve room for fields.
- Hold Select opens current event/channel/recording details directly, removing the single-item intermediate menu.
  A reserved hint is visible on the focused card. Existing explicit actions still revalidate the whole delayed state
  and airing/selected channel before Watch/record. A watchable synthetic card tests that holding does not also Watch.
- Delay presets: 0/30/60/90/120/180/300 seconds, plus existing +/-10 adjustments. Pending save keeps only the user's
  preference draft and mounted focusable controls, with a Saving label; scores stay hidden and repeated writes are
  suppressed. Unknown/offline preferences do not use that draft. The visible revision is checked before writing;
  a newer polled revision asks for another choice, while server 409 still rereads without blind retry.

## Failing-before and focused evidence

`apple-60-before.json`: 5 failed / 1 passed. Old name-only marks fail both identity tests; 380pt card fails the shorter
height assertion; old single-item hold menu lacks direct actions; presets do not exist. For lasting unit coverage,
the exact old badge expression was extracted unchanged into `ScheduleMarks.isRecording` before that run.

`revision-before.json`: a visible stale choice writes once instead of zero, using the newer polled revision. The new
optional revision parameter initially delegated unchanged to old behavior for this proof, then received the guard.

`save-reread-before.json` proves the real model cleared Saving before the authoritative GET completed. Saving now
remains active through a private final reread, with ordinary polls/actions blocked; controls stay mounted until that
validation succeeds or fails. The synthetic delayed-save UI alone had not covered this network phase.

Intermediate UI failures are retained separately. An initial test focus helper bounced between rows while trying to
reach Settings. Focus targeting now accounts for the explicit Today -> Settings row and captured remote geometry. Down from the Sport tab currently lands on a central league chip; the helper aligns
horizontally before moving up to Settings. This existing entry behavior remains part of physical remote acceptance.
Do not interpret test-helper failures as product behavior or claim device acceptance from these synthetic tests.

The preset/save-focus check now passes (`preset-focus-after.json`); shorter family/content and direct-hold checks
also pass in the focused run. Short Select independently passes (`short-select-after.json`); it still reaches the existing Watch action. The required Apple gate passes: **244 contracts, 247 unit/playback, 23 tvOS UI tests**, zero failures/skips. The generic
iOS Simulator build passes. **2 iPhone and 2 iPad UI tests also pass**, zero failures/skips. Server documentation gates pass: **1,339 tests** and build verification, zero failures/skips.
Server/web functional code remains at 0317. All simulators were shut down after the final runs. All data is synthetic. The
DEBUG league/watchability/save-delay fixture options obtain no provider stream and cannot execute real actions.

## Consolidated device acceptance — Mark, after review/authorized deployment

Use the [cross-platform checklist](../2026-10-29-sports-cross-platform/README.md#consolidated-manual-acceptance--mark-after-review-and-authorized-deployment)
for the single device pass, using Apple 61 / server 0317 or explicitly recording any different tested builds/flags.

1. On Apple TV, compare compact shelves in light/dark, long names, all seven families and all ten follows. Check optional
   NFL/MLB situations, cricket scores/breaks, F1 sessions, hidden/stale/buffering/final, unavailable and recording cases.
2. Focus a live/watchable card and hold Select: actions open immediately; playback does not start. Choose Watch explicitly,
   another channel or Record. Revalidate expiry/final/missing stable IDs and normal admission/conflict behavior.
3. Pick each delay preset and fine adjustment. Focus stays on the selected control during/after saving; repeated Select
   does not issue another write. Check concurrent saves and visible-online/resume sync across the four platforms.
4. Two identically named channels from different sources must not share a recording badge. A renamed/reordered stable
   channel retains its badge; stopping recording clears it. Older identity-less data has no guessed dashboard badge.
5. Run the remaining cross-platform privacy/offline, accessibility, midnight/final and action checks together. Physical
   remote feel, two-device timing and source-field acceptance remain unobserved until Mark reports them.

## Remaining findings / review

SD-0313-L2 conservative unknown-format cricket, SD-0313-L3 authorized collector/HLS pilot, SD-A59-L1 noncanonical
future categories and SD-A60-L1 maximum-text logo fallback clipping remain open. F1 is sessions only. AFL basic points
are intended; richer NFL/MLB situations remain optional. No normal-enable, pilot or device-performance claim.

AGENTS.md reserves the slash command for Mark. This environment cannot invoke it; the two-round stopping rule still
applies. Existing server sports command remains in the cross-platform handoff; this server batch is documentation only.
Apple command consolidates dashboard builds 59–61 from the pre-dashboard baseline:

```
/codex:adversarial-review --background --base 2f0df26 Review Apple sports dashboard 59–61: strict source/stable recording badge identity with optional legacy decoding; fixed per-sport compact card geometry and optional fields; direct remote hold versus primary Watch safety; stable preset/save focus through PUT and authoritative GET with ephemeral preference drafts, visible revisions, 409 and account/background/offline safety; delayed whole-state projection, current airing/selected-channel revalidation and spoiler-safe details/accessibility. Check failing-before evidence and C-O; include existing underlying dashboard model/action code. Exclude separate player-exit/media work except concrete interactions. Round 0 of 2; do not assume device acceptance or pilot results.
```

## Synthetic compact-family captures

These are XCTest previews, not real-feed/device acceptance. Optional data is invented to exercise available fields.

[AFL hidden](#files-kept-outside-the-repository), [AFL revealed](#files-kept-outside-the-repository), [basketball](#files-kept-outside-the-repository),
[football](#files-kept-outside-the-repository), [NFL](#files-kept-outside-the-repository), [MLB](#files-kept-outside-the-repository), [cricket](#files-kept-outside-the-repository), [F1](#files-kept-outside-the-repository).

Optional XCTest diagnostic collection was disabled with `-collect-test-diagnostics never`; all assertions remained
active. The initial complete run was interrupted to add the real deferred-reread regression, then rerun in full.
Only the final complete gate is counted as passing. All tests use synthetic data and no provider connection.

## Files kept outside the repository

Raw or oversized files from this folder are kept off GitHub (decision D-30): on Mark's disk, then the Unraid test
share. Each is still in git history at `665e02e` under its old path. Identify a copy by its SHA-256.

| File (old path under `docs/reviews/`) | Bytes | SHA-256 |
|---|---|---|
| `2026-10-29/sports-tvos-refinements/compact-Cricket.png` | 1,328,044 | `7e8d96483ce3a1c179278515711931319de00b0bb5858679f8ae559728fb9c54` |
| `2026-10-29/sports-tvos-refinements/compact-EPL.png` | 1,498,414 | `317f34a65df52c8d1945547ba9376d5ec9df826251180b098cea6331720688a8` |
| `2026-10-29/sports-tvos-refinements/compact-F1.png` | 1,249,779 | `e7fb5e00102d5ad262ac00c509131f574d27f7214c2d7c4c9c611d4628124553` |
| `2026-10-29/sports-tvos-refinements/compact-MLB.png` | 1,364,115 | `81eeaa2fe4da09bfbb9ec56a60175a117b6a79aa29da147a4ef8017a150aa025` |
| `2026-10-29/sports-tvos-refinements/compact-NBA.png` | 1,499,719 | `1dae48909e21ad9cf39826268ae49cc37a24077df1be77b99738011de1356aee` |
| `2026-10-29/sports-tvos-refinements/compact-NFL.png` | 1,492,147 | `6a975829048289de01e068971d73693389fed3d67f54f0dde7eaabe9f5fdc9ae` |
| `2026-10-29/sports-tvos-refinements/dashboard-hidden-dark.png` | 1,345,530 | `021721740d11ef065ac14060782ef0b9d11cace8731f293cec5d69c57dbef599` |
| `2026-10-29/sports-tvos-refinements/dashboard-revealed-light.png` | 2,930,942 | `4feb0e394c65d5b08487d2485fafd7b1e8b32e08b9a94ae4034f58eea1c69a4b` |
