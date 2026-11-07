# Web shell (#241, #239 web side), builds 0481–0486, 7 Nov 2026

**What changed:** each top-level selector in `main.css` defined once (16 were twice; 0481); six `--text-*` sizes, spacing
only from `--space-*`, breakpoints 480/768/1024 (0482); the kit's status roles instead of Tailwind/Material literals
(0483); one `.page-header` (an `h2`, no bar) on every page (0484); one recordings-in-progress feed for every page, nothing
polled in a hidden tab (0485, 0486).

**T1:** `verify-build.sh` fails on a duplicated selector, an off-scale size or breakpoint, an inline raw size, or a status
literal (each proven by reintroducing one); `test/web-page-header.test.js`, `test/web-recordings-feed.test.js` fail on
the build before theirs. Full suite: 1,752 pass; 4 fail only on WSL's ffmpeg 8 (HE-AAC fixture), as before.

**T3, the rig:** staging (fake providers) shot through headless Chromium, every page at 1440×900 and 390×844, light and
dark, before (0480) and after (0484). Headers line up; Sport's title is the same `h2` as the others; nothing clipped. The
sport cards differ by the rig's clock, not the change.

| File | Shows |
|---|---|
| `guide-desktop-dark-…`, `settings-…`, `status-…`, `sports-…` | each page, 0480 left, 0484 right |
| `phone-guide-settings-0480-vs-0484.jpg` | the guide (dark) and Settings (light) at phone width |

**Codex round 1:** one medium, fixed in 0486: the Sport page guarded the feed's callback with the dashboard's request
serial, which moves on every 20 s reload, so its recording marks went stale. No high; no round 2.
