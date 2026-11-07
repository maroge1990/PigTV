# Apple pages onto one design (#243 part 2, #239 Apple side), Apple 167–173, 7 Nov 2026

**What changed:** the Sport tab's pig-and-title header on Apple TV and iPad, one header date format (167); NFL and F1 only
on the D-43/D-44 pages, the old `NFLPageView`/`F1PageView` retired (168); the event page on the D-43 banner (TV, iPad) or
a plain card (iPhone), never tinted by the logo (169); one `ProgrammeHero` and one row style for the programme and
channel pages (170); one tagline, the television's field on touch, the empty Sport page's text (171); recordings through
`AppFreshness`, the conflict poll resting while the app is not active (172); the legacy Sport tab's links kept (173).
#225–#229 were built in Apple 145–149 and wait only for Mark's device check.

**T1/T2:** each build's UI or unit test fails on the build before it; the fast, push and visual tiers pass on 172, and
the push tier again on 173.

**T3:** all 224 offline screens on Apple TV 4K, iPad Pro 13 and iPhone 17, compared with batch 3's set: the changes are
the intended pages plus the search field (the `.pigField()` change reaches it too).

| File | Shows |
|---|---|
| `tv-sport-header-167.jpg` | the Sport front page with the shared header and date |
| `sport-event-163.jpg`, `sport-event-169.jpg` | the event page before (logo-tinted hero) and after (banner, card) |
| `tv-programme-channel-hero-170.jpg`, `touch-…` | the programme and channel pages on one hero, Up next beside or below |
| `iphone-signin-empty-163-vs-171.jpg` | the sign-in field and tagline, before and after; the empty Sport page |

**Codex round 1:** one medium, fixed in 173: retiring the old pages left the legacy Sport tab (a server with the page
flags but no `sportFront`) with no way to F1, NFL or Cricket. No high; no round 2.
