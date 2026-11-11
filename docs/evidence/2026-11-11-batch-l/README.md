# Batch L (#280): one set of loading, empty and error states, words, launch and accessibility, Apple 204 to 208 (11 Nov 2026)

DRAFT. All in `PigTV-Swift` (base `b615a74`, build 203). Simulator only (tvOS 27, Apple TV 4K; iPad Pro 13-inch; iPhone 17): nothing here is a device check.
Every screen that waits, has nothing to show or fails now draws the same three states on Apple TV, iPad and iPhone: page-shaped placeholders that
pulse, a small pig with one button, and the pig in a retry ring. The batch also settles the words, launch, figure and accessibility items from the
audit and fixes the iPhone follow card from Mark's own bug report.

## Mark's picks (11 Nov 2026, on the issue)

- **Loading: L1.** Page-shaped placeholders that pulse gently, no fake text; they hold still under Reduce Motion. Not chosen: L2, L3, L4.
- **Empty: E1.** The small pig mark, a title, one sentence and the screen's one button, centred. Not chosen: E2, E3.
- **Error: R1.** The Offline screen's family: the pig in a retry ring, what happened, what still works, "Try again". With content on screen the
  content stays and a slim notice says it may be out of date. Not chosen: R2, R3.

## What each build did

| Build | What changed |
|---|---|
| 204 | The Sport front, sport pages, league pages (fixture, events, Formula 1, motorsport, cricket) and the iPhone league page use three shared components and a `PageState`. A league that "isn't available right now" says so with "Try again" and never spins. One retry clock. |
| 205 | The same states on the TV Guide, search and Jump to, Recordings, Scheduled, Settings › Sport and sign-in. Sign-in errors are written on the form (what was typed is kept; the "PigTV / OK" alert is gone). Apple TV: a state's button does not take focus from the tab bar. |
| 206 | One name per thing and no codes on screen ("Try again", "Hide scores" / "Scores hidden"); no splash without a saved sign-in; rounded figures; iPhone minimum sizes and a follow card that sizes by its content (buttons stack at the largest text); Increase Contrast, Reduce Transparency, Reduce Motion; league colours with readable letters; guide status marks with words; haptics on record, follow and delete; Settings › Sport reordered with Score delay on its own page. |
| 207 | Review fixes (below): a refused sign-in no longer leaves the app on Offline for ever; a retry no longer flashes placeholders; an empty answer followed by a failed refresh keeps the empty layout under the notice; the sign-in note's "Try again" retries what failed; Apple TV focus is taken only when nothing has it. |
| 208 | Found while assembling this folder: on an iPad held upright the Sport front's loading placeholders were wider than the screen and clipped the header. Every placeholder now fits the width it is given (PlaceholderWidthTests, failing on 207); every loading layout was re-shot on iPad and iPhone in both orientations. |

## Reviews and findings

**Opus (204 to 206): 2 high, 6 medium, 9 low.** Fixed in 207 unless noted.
- High 1: from the Offline screen, a refused saved sign-in, a server too old, 403 or 429 was never shown, so Offline retried for ever. 207 leaves Offline for Sign in with the reason; a 5xx stays on Offline under its own words and keeps retrying.
- High 2: a failed TV Guide or Recordings page turned into placeholders on every retry, and the stale notice blinked. 207 clears the failure only when an answer succeeds.
- Medium 1: "Optional(...)" could be printed on the live player and Settings › Sport. Fixed, with a source scan.
- Medium 2: the sign-in note's "Try again" always retried the saved sign-in. It now retries the attempt that failed, and is not offered after a wrong password or an expired pairing code.
- Medium 3: the note outlived the session. Cleared on success, on sign-out and when the form is edited.
- Medium 4: leaving a sport page mid-refresh showed "couldn't update" on return. A cancellation is no longer a failure.
- Medium 5: on Apple TV a state appearing inside a page took focus from the list. Focus is taken only when nothing has it.
- Medium 6: sign-in focus moved from a timer to an event with nothing proving it. A UI test now covers each step change.
- Lows taken: the Sport front's "scores feed isn't available" note is drawn above the empty state again; a 403 says the account can't do this.
- Lows left: Settings › Sport's own 20 s retry (a decision, not a defect); two cases that send one extra request (the retry clock chosen once; a quick double press); the Keychain read on every `ContentView.init`; SF Rounded now also on mixed lines such as the Apple TV Settings summary (needs Mark's confirmation); eager follow cards; the 5:48pm / 7:43 am time format difference (simulator region).

**Codex (one round on 204 to 206): no high, one medium.** An empty answer followed by a failed refresh kept showing "No recordings yet" with no notice, hiding a recording scheduled elsewhere. Fixed in 207 as `PageState.emptyStale`. **Sign-off on 207: approve, no material findings** (static review; Apple builds and simulator tests not run by Codex).

## Gates

- Each commit: `Tools/test.sh fast` and the iOS build (generic iOS Simulator) passed. 204: PageStateTests; 205: PageStatesTests (17); 206: the three changed UI suites; 207: five tvOS UI suites (16 of 16).
- Failing before: new tests fail on the old code, by assertion for the review fixes and by compile failure where the API did not exist (204, 205, 206's `LaunchStep`).
- `Tools/test.sh push` on 206: contract checks 314, unit tests 557, regression UI tests 61 passed and 1 skipped (staging server not given). On **207**: contract checks 314, unit tests 573, regression UI tests 62 passed and 1 skipped, no failures, no reruns (about 17.5 minutes).
- CI (the Apple repo): green on `7bd18b6` (207, run 43000771292) and on `abb33c8` (208, run 43010092604).

## Simulator evidence

About 370 screenshots were taken and looked at by the builders on tvOS 27 (Apple TV 4K), the iPad Pro 13-inch and the iPhone 17: 128 for the Sport pages (204), 129 for the other screens (205, with 18 more after the lead's review), 97 for 206 and 16 for the 207 fixes. The 40 images here are the selection; the rest were not kept.
States were forced by DEBUG-only fixture switches in the test app, not by switching a server off: `PIGTV_UI_TEST_SPORT_STATE` and `_LEAGUE_STATE` (loading, empty, failed, stale, unavailable), `_GUIDE_STATE`, `_RECORDINGS_STATE` (also `empty-stale`), `_SETTINGS_SPORT_STATE`, `_SIGNIN_ERROR`, `_SIGNIN_STEP`, `_ACTION_ERROR`, `_LAUNCH` (saved, none). Increase Contrast and Reduce Transparency were set with `simctl`. Release builds contain none of these switches.
The 207 fixes were also seen by sampling a stub server's guide every 2 s for 100 s: 0 flashes of placeholders.
Images are 1280 px JPEGs named `<screen>-<state>-<tv|ipad|iphone>-<dark|light>.jpg`. The three sign-in images have the server address painted over; shots that show an address or account were left out.

## What is not verified

- No real device. Everything above is a simulator; haptics, remote feel, real pulse and Reduce Motion behaviour, and Increase Contrast on glass are device checks (T5-steps).
- Three timers remain by design: the play-start path, the iPhone system menu and tvOS focus give no event to wait for.
- At the largest text size the iPhone Sport header ("S... We...") and section titles break badly (seen in `follow-card-largest-text-iphone-dark`). The follow card itself is right; the header is not fixed.
- On Apple TV a league state inside the sport page's scroll view moves a little when "Try again" takes focus (`league-unavailable-tv-dark` is shot after it moved).
- Real pages, not this batch's states (filed as #298): on an 11-inch iPad in landscape the Formula 1 page is wider than the screen; in iPad portrait the Sport banner's buttons break mid-word. The image `sport-front-loading-ipad-dark` is from build 208, after the placeholder fix.
- The Offline-to-sign-in move (207, High 1) has screenshots, but they show the stub's loopback address, so none is included. The sign-in "Try again" note on a refused saved sign-in is likewise not shown (fixture host).
- Settings shots show the saved server address on iPad and the account name on Apple TV, so only the iPhone Settings › Sport and the Apple TV Score delay page are included.
- The Sport front images from 204 predate 205's focus rule; the "Choose your sport" ring in `sport-front-empty-tv-*` is the 204 behaviour.
- Builders listed as left: Settings › Sport's 20 s retry; the iPhone simulator keeps a saved "News" chip (no marked channel in its guide-marks shot); the iPad Increase Contrast reaches Settings rows through colours, not a card border; "Also in your sports" and the "YOUR SPORTS" kicker keep their wording; tvOS fixtures on another tab show "Sport" selected once focus leaves the tab bar (fixture artefact).

## Images

- `content-guide-ipad-dark.jpg`
- `content-recordings-iphone-dark.jpg`
- `content-sport-home-tv-dark.jpg`
- `follow-card-default-iphone-dark.jpg`
- `follow-card-default-iphone-light.jpg`
- `follow-card-largest-text-iphone-dark.jpg`
- `guide-empty-ipad-dark.jpg`
- `guide-failed-tv-dark.jpg`
- `guide-loading-tv-dark.jpg`
- `guide-marks-tv-dark.jpg`
- `guide-stale-iphone-dark.jpg`
- `launch-signed-in-splash-iphone-dark.jpg`
- `league-loading-tv-dark.jpg`
- `league-stale-iphone-dark.jpg`
- `league-unavailable-ipad-dark.jpg`
- `league-unavailable-iphone-dark.jpg`
- `league-unavailable-tv-dark.jpg`
- `recording-increase-contrast-iphone-dark.jpg`
- `recordings-empty-stale-iphone-dark.jpg`
- `recordings-empty-tv-dark.jpg`
- `recordings-failed-ipad-dark.jpg`
- `recordings-loading-iphone-dark.jpg`
- `recordings-stale-tv-dark.jpg`
- `settings-sport-delay-iphone-dark.jpg`
- `settings-sport-delaypage-tv-light.jpg`
- `signin-wrong-password-ipad-dark.jpg`
- `signin-wrong-password-iphone-dark.jpg`
- `signin-wrong-password-tv-dark.jpg`
- `sport-front-empty-ipad-dark.jpg`
- `sport-front-empty-iphone-dark.jpg`
- `sport-front-empty-tv-dark.jpg`
- `sport-front-empty-tv-light.jpg`
- `sport-front-failed-ipad-light.jpg`
- `sport-front-failed-iphone-dark.jpg`
- `sport-front-failed-tv-dark.jpg`
- `sport-front-loading-ipad-dark.jpg`
- `sport-front-loading-iphone-dark.jpg`
- `sport-front-loading-tv-dark.jpg`
- `sport-front-stale-iphone-light.jpg`
- `sport-front-stale-tv-dark.jpg`
