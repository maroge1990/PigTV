# Apple 91–94: Settings › Sport, clash choices, card recordings (#200, #12, D-41)

PigTV-Swift, 1 Nov 2026. Base `2e51b90` (Apple 90). Server: the Apple routes added to `test/api-404.test.js`.

**91:** Recordings: a schedule that lost its clash (`beatenBy`) says why and offers "Record this one instead"
(`POST /recordings/scheduled/:id/choose`, confirmed first); `team` rules read "Every <team> game (<sport>)", "Set by …";
a front page card shows "Recording" / "Set to record" and "Clashes with …" (C-R `recording`). **92:** Settings › Sport
(C-U), the web's "Your sport" ported: suggestions, Hide scores, sports, leagues, teams, Record every game, offline copy.

**Tests (T1–T3, tvOS 27 simulator):** `RecordingClashWinnerTests`, `RecordingChooseTests`, `SportFollowTests` (ported
logic; the model against a local fake server), `SportSettingsUITests`, new cases in `RecordingsUITests` and
`SportFrontUITests`, contract checks (280). Each fails on the build before it. `Tools/test.sh push` and the iOS build pass.

**Screenshots (offline fixtures):** `tv-settings-sport.jpg` (the section, a suggestion, Hide scores, two sports),
`tv-sport-football.jpg` (a sport's screen), `tv-recordings-clash-confirm.jpg` (the loser's line and the confirmation).

**Codex adversarial review, round 1:** one *high*, fixed in 93: a save the server kept but whose answer was lost, with the
re-read failing, let the next queued change replace the list from the old copy (now read-only until a load answers).
The web panel has the same flaw: #208. **Round 2:** one *high*, fixed in 94: a reload overlapping such a save made the
old list editable again (only a shown answer reopens changes). Each with a failing-before test.

Not exercised: a real server (T3 on the rig) and the devices (T5); both are in the combined test (D-42).
