# Apple: one spacing and type scale, one secondary button (#243 part 1), Apple 164–166, 7 Nov 2026

**What changed:** `PigSpacing` (six steps; television 1.5×) and `PigType` (the television's 20 font sizes merged
within 2 pt into nine roles, plus `micro` and `jumbo`) in `PigBrandRoles.swift`; 829 literal paddings and spacings and 204
literal font sizes moved onto them (164). `PigSecondaryButtonStyle` on every secondary action; on touch a neutral capsule,
never the accent (165). The Sport front page's gap under the D-43 banner restored (166).

**T1:** `BrandRulesTests` fails on a literal padding, spacing or font size, or the system bordered style on an action,
anywhere outside `PigBrandRoles.swift` (whole files, over line breaks and ternary arms). Proven: the final test file
on 163 fails the spacing, font and button checks; on 164 only the button check.

**T2/T3:** every offline UI-test screen shot on Apple TV 4K, iPad Pro 13 and iPhone 17 (224 screens) and compared
with the 6 Nov audit's set from 163 by SSIM, then side by side. Differences are spacing steps and the clock (the
fixtures follow the time of day: the front page's Watch button appears only while its airing is on, the same on 163).

| File | Shows |
|---|---|
| `iphone-programme-163-vs-166.jpg` | Watch live the one pink control; Record, Channel schedule, In favourites neutral |
| `ipad-recordings-163-vs-166.jpg` | Details and Delete as secondary capsules beside Resume |
| `ipad-guide-163-vs-164.jpg` | the iPad guide's filters now fit (News was cut to "Ne") |
| `tv-front-163-vs-164.jpg`, `tv-programme-163-vs-164.jpg` | Apple TV: cards and rows a step roomier, same layout |

**Push tier:** `SportBannerUITests` caught the front page's rails 7 pt lower under the 250 pt banner (305 against
270 ± 30); fixed in 166.

**Codex round 1:** one medium (the checks read one line at a time: a literal over several lines, or in a font's
second ternary arm, passed); fixed in the batch, with a parser test per bypass. No high; no round 2.

**T5 for Mark:** text size and spacing from the sofa on the Apple TV; the touch buttons on the iPad and iPhone.
