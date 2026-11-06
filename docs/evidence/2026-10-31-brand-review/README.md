# Cross-platform brand review against Pig kit 1.7.0 (#127, #116)

31 Oct 2026. Web: the staging rig (server 0379, fake providers), headless Chromium at 1280 and 390 px, every page and
settings tab in light and dark (`pigtv_theme`), hover and keyboard focus by real Tab presses. Apple: a read-only source
audit of `PigTV-Swift` only, because the Mac was running another session's Xcode tests all day, so no simulator
screenshots (to-do below). The kit's rules are `docs/pig-family-brand-guide.md` (sections cited as §n) and
`docs/integration.md`; PigTV's own are `docs/DESIGN.md` › Brand. Review only: no brand file or app code changed.

**Kit 1.6.0 → 1.7.0.** The change record says the palette, halo, bloom, lockups and wordmarks are unchanged; the diff
confirms it: 1.7.0 adds PigMenu (`products.pig-menu`, approval and `ios.appearances` text) and bumps `version`, `date`,
`status` and the comment line of `pig-radiance.css` and `pig-glass.css`. Every file PigTV vendors is byte-identical to
1.7.0 apart from those strings, and the manifest matches the template. Nothing changes on screen; the batch only
re-copies the four files and writes 1.7.0 in `DESIGN.md`. The Apple repo also says 1.6.0 and its `sync-brand.sh`
default points at `../Pig-Branding`, which is a stray clone of the Apple repo, not the kit.

**What passes on the web** (`page-login.png`, `page-home.png`): the stacked lockup with the halo behind the pig only,
the horizontal lockup at 120 px, the corner bloom with opaque cards above it, glass on the navbar only, the rose primary
action once per screen, selection as 14 % accent plus a bar, keyboard focus rings on links, tabs, inputs and rows,
`.pig-amount` on figures, and all `--color-*` tokens equal to the kit's roles in both themes.

| # | Gap (before image) | Where | Kit rule | Proposed fix |
|---|---|---|---|---|
| W1 | Sport's nav icon is the text glyph ◉ and Recordings' a plain filled circle, both out of step with the line icons beside them (`web-nav-glyphs.png`) | `index.html:66-71` | §5 one readable interface system; #127 plain style | SVG icons from `icons.js` (ball, record disc) |
| W2 | Emoji and tick labels: 💾 Save Changes, ✓ Saved!, ✓ Copied!, ✓ NVIDIA badges, "✓ Checked = Visible, ☐ Unchecked" (`web-emoji-save.png`) | `SourceManager.js:589-791`, `VideoPlayer.js:541`, `Settings.js:1133-1154`, `index.html:722` | #127; §6 labels are words | Plain words; icon from `icons.js` where one is needed |
| W3 | The mobile menu is translucent: the page heading and text show through the items in both themes (`web-mobile-menu.png`) | `main.css:2218-2228` (`.navbar-menu` on `--glass-bg` at 0.8 / 0.82) | §9 body text never on glass; DESIGN.md: dropdown is the opaque exception | Dropdown on `--color-bg-secondary` (solid), keep glass on the bar |
| W4 | Dark hover and active surfaces are blue-greys, not plum: the hover pill on the navbar (`web-nav-hover.png`) | `main.css:14,15,39` (`#22222f`, `#2a2a3a`, `#3f3f46`) | §4 colour by role | Hover = raised surface `#251E2E`, active = `#2E2634`, border-light = control boundary |
| W5 | Off-palette status colours: guide now-line and danger hover `#dc2626` (`web-guide-nowline.png`); stream badges red, orange, green, dark red, purple, grey (`web-player-badges.png`); admin badge amber→orange gradient (`web-admin-badge.png`); info tint blue; link-badge fallback green | `main.css:1557,1912,3307-3350,3522,4002,4374` | §4 status colours are success, warning, danger and need a label; no new base colours | Now-line and danger = `--color-error`; badges = success / warning / danger / accent-dim + text; admin = accent-dim with accent text; blue = accent-dim |
| W6 | Home's section heading is a second display font (Outfit 800) while every other page title is Inter 600 (`web-home-heading.png`) | `main.css:3571`, `index.html:24` | §5 rounded lettering is for identity only; hierarchy by size, weight and space | Page-title style; drop the Outfit download |
| W7 | Empty-state boxes use a white dashed border, so they vanish in light (`web-empty-state.png`) | `main.css:3667` | §4 decorative border token | `1px dashed var(--color-border)` |
| W8 | Radii off the 6 / 10 / 16 scale (2, 3, 4, 8, 12, 14, 18, 20, 99 px) | `main.css:260-4438` (16 sites) | §6 web radii 6 compact, 10 controls, 16 cards | `--radius-sm/md/lg/full` |
| W9 | The 0379 Sport page: 2 px `currentColor` card borders, orange focus fallback, unstyled chips (`web-sport-0379.png`) | `main.css:4527-4545` | §4, §6 | Superseded by the Sport front page (0381, D-39); re-check that page in the batch |
| A1 | tvOS fixed text below the 23 pt HIG minimum: Home 18–22, Recordings 18, Sport 18–19, Detail 20–21, Guide 20, Library 20, player 18 | `HomeView:34-39,433`, `RecordingsView:11-12`, `SportView:23,25`, `DetailComponents:19-20`, `GuideStyle:66`, `LibraryView:212`, `PlayerControls:23`, `CustomPlayer:270-518` | §5 native text styles; #116 | Raise to 22–23 pt, keep density by trimming lines (T5 sofa check) |
| A2 | Literal colours outside playback: system yellow/red on the sport dashboard, greys/whites/blacks on Top Shelf, black/white scrims, `Color.primary` borders, black shadows | `SportsDashboardView:472`, `TopShelfCards:150-222`, `DetailComponents:114-147`, `HomeView:348-499` | §4 roles from `PigColors` | `PigWarning` / `PigDanger`, `PigBorder`, canvas scrims |
| A3 | Playback: system `Color.red` live dots; panels at 45–70 % instead of 82 % | `PlayerExtras:326,261`, `CustomPlayer:417,450`, `RecordingTouchChrome:127`, `PlayerShared:151` | §7 rose `#EF7AAE` on protected dark, black panels from 82 % | `pigMediaAccent`; 0.82 |
| A4 | Lockups assembled by hand from mark + wordmark; the kit's lockup SVGs are not in the catalog | `BrandSplash:56-60`, `TVActionStyle:208-218`, `ContentView:234-240` | §3 use the supplied lockups, never reassemble | Import `lockup-*` from the kit |
| A5 | Radii: 14 on both platforms, iOS card 14, tvOS sport 20 and 36, player panels 22–24 | `RecordingsView:22`, `HomeView:57`, `SportView:20,305`, `PlayerShared:151`, `CustomPlayer:368` | §6 touch 16 / 22, TV 10 / 18 / 32 | Shared constants per platform |
| A6 | Figures without rounded tabular digits: scores and progress, "N min left" | `SportsDashboardView:486,503`, `DetailScreens:347,476` | §5 numbers | `.fontDesign(.rounded).monospacedDigit()` |
| A7 | tvOS focus is a 22 % accent fill plus a 3 pt stroke; the kit's selection tint is 14 % | `TVActionStyle:21`, `HomeView:495`, `GuideGridCells:44-45` | §6 selection 14 %, focus a ring | Verify on the TV before changing (T5) |

**Batch (after the Sport front page).** Server/web, one commit each with a failing-before test: W1–W2 (`verify-build.sh`
check for emoji and text glyphs in `public/`), W3, W4–W5 (a test that every colour literal in `main.css` is a token or
black/white), W6, W7, W8, the 1.7.0 re-copy. Apple, in `PigTV-Swift`: A1 with A5–A6 (one sizes-and-radii commit), A2–A3,
A4, the kit path and version in `Tools/sync-brand.sh` and `docs/ARCHITECTURE.md`; A7 only after the T5 check.

**Apple screenshots to-do** (when `ssh mac 'pgrep -fl "test.sh|xcodebuild"'` prints nothing; read-only from
`~/code/PigTV-Swift` main): 1. tvOS: splash, sign-in, Home, Guide, Sport, Recordings, Settings, a programme detail, the
player. 2. iPad and iPhone: the same nine, light and dark. 3. Compare each against this table and §3–§7; attach the
crops here and update A1–A7 with what is seen, not only what the source says.
