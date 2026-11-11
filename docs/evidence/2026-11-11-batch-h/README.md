# #276 web batch H (server 0534 to 0541): reviews, the 12-point result, and the rig: before and after screenshots, keyboard pass, browser checks

Pushed 11 Nov 2026 as `31a858b..4dc075b`; CI green. Mark's picks (on the issue): no Home page (option C), compact Sport cards (A), picture-card Recordings (B), text at 16 px with the guide grid, the channel list and the admin tables as recorded exceptions.

## Reviews and findings
- **Gates:** `npm test` 2,036 tests, 2,024 pass, 8 skipped, 4 fail in `recording-segments-media` on the build machine only (its ffmpeg writes AAC-LC; the same four fail on 0533 there, and CI passes them). `verify-build.sh` passes.
- **Opus on 0534 to 0539:** no high, 4 medium, 10 low. Fixed in 0540: Back onto an old "home" history entry gave a blank app; an unfollowed team's recording rule waited 10 seconds to be removed and was lost if the page closed; signing out with a delete pending kept the item; Undo in Your sport restored a whole snapshot over newer edits. Also fixed from its lows: a scheduled recording that starts inside the Undo window is no longer stopped by the delayed cancel; `ui.js` and the stylesheets carry a `?v=`; the DESIGN.md line on destructive actions.
- **Codex round one on 0534 to 0539:** 1 high (changes waiting behind a Settings Undo were lost when the page closed), 1 medium (the snapshot Undo). Both fixed in 0540.
- **Codex sign-off on 0540:** the medium closed; 2 highs left (a lost reply to the unfollow save could switch the rule back on; sign-out could beat a change whose commit had just started). Mark chose to fix both. Fixed in 0541.
- **Codex sign-off on 0541:** approve, no material findings.
- **Rig pass on 0539** found, and 0540 fixed: focus fell to the page after Delete or Undo and Undo could not be reached by keyboard in time; Escape did not close the phone menu; provider cards wrapped short values; locked Settings controls looked enabled; "Copy stream URL" wrapped; the add-rule example was clipped on a phone.
- **Not fixed, filed:** the leftovers, and the one failing review point, are in [#295](https://github.com/maroge1990/PigTV/issues/295).

## 12-point product review (brand guide section 16), web, 11 Nov 2026, build 0541
| # | Point | Result 11 Nov 2026 (web, build 0541) | Was (10 Nov, 0502) |
|---|---|---|---|
| 1 | Identity | Pass | Fail (version only) |
| 2 | Colour | Fail: roles pass; light-theme success/warning small text and the status tags are under 4.5:1 | Fail |
| 3 | States | Pass with a leftover: Guide and Live TV loading is a spinner block under the real toolbar, not the grid's shape | Fail |
| 4 | Hierarchy | Pass | Fail |
| 5 | Words | Pass (player overlay time format differs) | Fail |
| 6 | Figures | Pass | Fail (partial) |
| 7 | Focus and selection | Pass | Fail |
| 8 | Glass and radiance | Pass | Fail (partial) |
| 9 | Launch and splash | Pass | Pass |
| 10 | Minimums | Pass with recorded exceptions (Guide grid, channel list and admin tables denser than 16 px, never under 12); leftovers: off-switch edge under 3:1, bare Settings fields under 28 px, small touch targets listed in the leftovers | Fail |
| 11 | Accessibility settings | Pass; 200% zoom, Increase Contrast and forced-colours renderings not checked | Fail |
| 12 | Icons | Pass (web part); 16/32 px not checked by eye | Pass |

Score: **8 pass, 3 pass with a note, 1 fail**, against 2 pass and 10 fail at 0502.


## What was shot and how
- Tool: Playwright (headless Chromium), full-page PNGs, desktop 1440x900 and phone 390x844, dark and light, reduced motion, time zone Australia/Sydney.
- Rig: staging server with the fake providers only (two fake providers, 30 channels, no real provider), reached through a tunnel. Before: build 0533 (270 shots). After: build 0540 (commit ce54864), 295 shots.
- States: content 126, empty 44, error 60, loading 60, plus 5 player shots (overlay, overflow and captions menus). Empty is not produced for 16 combinations (Status and Settings Playback/Recording/System have no empty state).
- How the states are made: content is the rig as it is; empty, error (HTTP 500) and loading (3 s delay) are made by answering the page's main GETs in Playwright, so the rig's data is not touched. Recordings and Sport "filled" shots serve invented fixtures. The rig itself has no rules, no favourites and the sport dashboard off.
- Extra after shots with no before: recordings card menu, the Undo notice after Delete, Sport with nothing followed, Sport with nothing on, the locked Playback panel, a focused switch and input, the first-load splash, /#home landing on Live TV.
- Not in the evidence: the four provider edit-form shots (they show a server address).

## Keyboard pass (keyboard.txt, build 0540)
Tab/Shift+Tab/Enter/Escape/arrows only, no mouse, desktop dark. All sixteen page walks end with "no visible ring: none" (every stop shows a ring) and no keyboard trap; focus returns to the opener after each dialog and menu closes. Delete by keyboard moves focus to the notice's Undo; Undo returns focus to the restored item (0539 left it on the page body). The Guide programme dialog still lets one Tab reach the page behind it (the version label) before wrapping, as in 0539.

## Browser checks (checks.txt)
- Titles per page and Settings tab (e.g. "Settings · Channels · Channel numbers · PigTV"), reload keeps the place, Back/Forward across Settings tabs: correct.
- Requests to any host other than the rig while browsing every page and playing a channel: none. Console and page errors: none.
- A fake-provider channel plays (currentTime advances, 480x270); overlay, captions menu and overflow menu open.
- 0540 changes (all PASS): focus after a keyboard Delete, Cancel and Undo; phone menu closes on Escape and on Tab out; provider cards do not wrap short values (desktop and phone); locked Settings controls are dimmed with dashed borders and a not-allowed cursor (enabled ones are not); "Copy stream URL" stays on one line (desktop and phone); the add-rule example fits at 390 px with no sideways scroll; an old or unknown page entry opens Live TV.
- Delete, then reload inside the 10 s: exactly one DELETE reached the server. Delete, then Undo: none. Controls: delete and wait sends one; delete then moving to another page inside the 10 s sends none yet (still waiting). Observed with a logging proxy that answers DELETE itself (nothing deleted on the rig), because Playwright's route misses requests from an unloading page.

## What could not be produced
- Empty shots for pages with no empty state (16).
- The "Settings playback disabled" shot is a viewport-sized crop of the unlocked top of the page; the full-page locked view is settings-playback-loading-phone-dark.
- The TV Guide grid scrolls inside its own box, so a full-page desktop shot shows about 11 rows (before: all 18).
- Native fullscreen behaviour, a real device and the real provider feed (T5) were not checked.
- Hand-edited address `#nonsense` keeps the text in the address bar while showing Live TV (only history entries are rewritten).

## Images (shots/, 47 files, `<page>-<state>-<device>-<theme>-<before|after>.jpg`; before = 0533, after = 0540)
- focus-input-content-desktop-dark-after.jpg
- focus-toggle-content-desktop-dark-after.jpg
- guide-content-desktop-dark-after.jpg
- guide-content-desktop-dark-before.jpg
- guide-content-phone-dark-after.jpg
- guide-content-phone-dark-before.jpg
- live-content-desktop-dark-after.jpg
- live-content-desktop-dark-before.jpg
- live-content-desktop-light-after.jpg
- live-content-phone-dark-after.jpg
- live-content-phone-dark-before.jpg
- login-content-phone-dark-after.jpg
- login-content-phone-dark-before.jpg
- nav-menu-open-content-phone-dark-after.jpg
- nav-menu-open-content-phone-dark-before.jpg
- recordings-empty-phone-dark-after.jpg
- recordings-empty-phone-dark-before.jpg
- recordings-error-phone-dark-after.jpg
- recordings-error-phone-dark-before.jpg
- recordings-filled-content-desktop-dark-after.jpg
- recordings-filled-content-desktop-dark-before.jpg
- recordings-filled-content-phone-dark-after.jpg
- recordings-filled-content-phone-dark-before.jpg
- recordings-filled-content-phone-light-after.jpg
- recordings-menu-open-content-phone-dark-after.jpg
- recordings-undo-content-phone-dark-after.jpg
- settings-channels-lineup-content-desktop-dark-after.jpg
- settings-channels-lineup-content-desktop-dark-before.jpg
- settings-playback-content-desktop-light-after.jpg
- settings-playback-content-phone-dark-after.jpg
- settings-playback-content-phone-dark-before.jpg
- settings-playback-loading-phone-dark-after.jpg
- settings-playback-loading-phone-dark-before.jpg
- settings-providers-content-phone-dark-after.jpg
- settings-providers-content-phone-dark-before.jpg
- settings-providers-empty-phone-dark-after.jpg
- sports-error-phone-dark-after.jpg
- sports-error-phone-dark-before.jpg
- sports-filled-content-desktop-light-after.jpg
- sports-filled-content-phone-dark-after.jpg
- sports-filled-content-phone-dark-before.jpg
- sports-loading-phone-dark-after.jpg
- sports-loading-phone-dark-before.jpg
- sports-nofollow-content-phone-dark-after.jpg
- sports-nothingon-content-phone-dark-after.jpg
- status-content-desktop-dark-after.jpg
- status-content-desktop-dark-before.jpg
