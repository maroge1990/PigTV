# Mark's bug list of 8 Nov 2026: server 0493, Apple 176–184

Issues #249–#258. Simulators: iPhone 17e, iPad Pro 11-inch (M5), Apple TV 4K (3rd generation), all OS 27.0. Fixtures only; no provider was contacted.

| Issue | Build | Before → after (T1–T3) |
|---|---|---|
| #249 star on a team followed as "ARI" | server 0493, Apple 176, 184 | The C-R card gains `followedSides`. `test/sport-front.test.js` 0493; `SportFrontLayoutTests` (abbreviation; both sides followed) |
| #250 "Removed …" lingers | 177 | The done line clears after 6 s, and "Not saved" stays. `SportFollowSettingsModelTests` |
| #251 "one provider stream" | 178 | Now reads "If every provider connection is in use…". `RecordPageTests` |
| #253 Start early / Finish late overflow | 179 | Chips ended at x 563 of 390; now one menu per row (Mark's pick). `TouchLayoutUITests` |
| #252, #254 sport hero card | 180, 184 | Before, "245/6 (48.…" and "9.6 (60)…" were cut off and names shrank on their own. Now a short score in the middle (Mark's pick), one name size, and the star on the badge. `SportPhoneLayoutTests` |
| #255 landscape guide menu | 181 | The last row ended at y 402 of 390; now capped and scrolls. `TouchLayoutUITests` |
| #258 iPad Settings header | 182 | The title was at y 104.75 on the first visit and 40.75 on later ones; it now stays at 104.75. `TouchLayoutUITests` and `PageHeaderPlacementUITests` |
| #256 reorder sports | 183 | Edit order shows drag handles; Cricket dragged above Football. `SportFollowLogicTests` and `TouchLayoutUITests` |

**Gates:**
- Server `npm test`: 1770 of 1774 pass. The 4 failures are the local ffmpeg 8.0.1 HE-AAC tests; CI uses 9.0.2.
- Server `verify-build.sh`: pass.
- Apple `Tools/test.sh push`: pass. The iOS build passes.

**Codex:**
- Server 0493: approve.
- Apple round 1: one high. Each follow resolved the same side when both teams were followed by abbreviation. Fixed in 184.
- Apple round 2 (narrow): approve.

**Later the same day:**
- #257 Watch on… (Mark's pick: the long-press menu, never the player): Apple 185. Its Codex round 1 found a high (a
  channel no longer airing the event was offered) and a medium (a reused channel position could match the wrong
  event); both were fixed in 186, and round 2 approved. Tests: `WatchOnTests` ×4; an iPhone UI test with a fixture event
  on three channels.
- Server 0494 makes segmented recording permanent (D-48). Its Codex round 1 found a high: a settings write could turn it
  off again. Fixed in 0495; round 2 approved. Test: `test/segmented-always.test.js`.
