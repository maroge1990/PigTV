# Apple recording batch 5b (Apple 119–127): Recordings, Scheduled, View recording, Undo

Simulator screenshots (T3) of the offline fixtures, dark, JPEG at most 1400 px. Apple TV 4K (3rd generation),
iPad Pro 13-inch (M5), iPhone 17; tvOS/iOS 27.0. The record page was covered in 5a (`2026-11-03-schedule-edit`).

- `before-*`: Apple 118 (b173469). `after-*`: Apple 123 (5c62685).
- `*-recordings-tab` (`tab-recordings`): before, the library (Library/Scheduled picker, search, poster grid); after,
  the featured recording, the cards and the Coming up strip (iPhone: the card stack and the fixed Coming up card).
- `*-scheduled` (`recordings`, `PIGTV_UI_TEST_RECORDINGS_SECTION=scheduled`, `PIGTV_UI_TEST_CLASH=1`): before, the
  old list; after, Coming up with the rule chips and the clash choice, the rules (on/off, Remove) and Needs attention
  (iPhone: tiles for the rules and Needs attention).
- `*-recording` and `after-*-recording-game` (`recording`, `recording-game`): before, the detail hero; after, View
  recording (art, state, info bar, facts); the game draws its two teams (monogram discs: the fixture has no Sport card
  for it).
- `after-*-undo` (`tab-recordings`, `PIGTV_UI_TEST_UNDO=1`): a recording deleted at once with the 10 s Undo toast.
  There is no before: on 118 Delete asked in a system confirmation dialog, which a launch fixture cannot open.

Failing before (each new test run on the build before it): `testFeaturedRecordingCardsAndComingUpOpenScheduled` on
118 ("no featured recording"); `testScheduledListsRulesAndNeedsAttentionBesideComingUp` on 119;
`testACardOpensViewRecordingAndMenuGoesBack` on 120 ("View recording did not open");
`testRemovingARuleActsAtOnceAndUndoBringsItBack` on 121 (Remove asked first); `testAFailedOnNowMenuActionSaysWhy`
(iPhone 17) on 122 ("the failure was not shown").

Codex round 1 (base b173469), fixed in the batch: high, a committed Undo lived only in memory and was lost if the
process died first: 124 logs it (UserDefaults) before sending and replays it at launch and on foreground until
confirmed or gone (`testACommittedRemovalSurvivesAKilledProcessAndIsSentOnce`, `testAReplayedRemoval…AlreadyGone…`);
medium, a stale or failed refresh brought a confirmed removal back: 125 keeps a tombstone until a later refresh loads
(`testADeletedRecordingStaysGoneThroughAStaleRefreshAndAFailedOne`, fails on 124).

Codex round 2, fixed in the batch: high, a failed removal stayed logged and a later Undo did not cancel it: 126 drops
a failed one from the log, Undo clears its item's, replay skips an open Undo (`testUndoAfterAFailedRemoval…`, fails
on 125); medium, an older overlapping rules answer resurrected a removed rule: 127 drops answers older than the last
published (`testAStaleRulesAnswer…`, fails on 126).

Gates: `Tools/test.sh push` passed on 127; the iOS build passed at every build; `BrandDepthUITests` and
`TabFlashUITests` (visual tier) passed on 127 (the player checks skip without the review movie); `RecordPageUITests`
passed on 122. Not run: Codex review (the lead runs it), device checks (T5).
