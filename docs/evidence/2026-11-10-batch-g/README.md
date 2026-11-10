# #275 batch G (build 0533, a1f5dba) on the rig: after screenshots and browser checks

Rig brought to 0533 with `unraid-rig.sh up`; `check` passed (30 channels, 116 programmes, 15 sport events, BBC ONE to HLS).
Same state as the before run (0523): staging with sport fixtures off, so the Sport page shows guide-derived events. Fakes only.
Shots: 70 of 70 after shots taken (none missing), same script and sizes (1440x900, 390x844, light and dark).
Selectors for opening the three dialogs still worked unchanged. Raw measurements: browser-checks.txt, timer-and-stop.txt.

## Browser checks (Playwright, headless Chromium)
- a PASS: 318 requests over login and the 7 pages, all to staging; foreign hosts: none.
- b PASS: Inter "loaded" from /css/fonts/Inter-latin-wght-normal.woff2 (the second face stays "unloaded", the latin-ext subset); body font-family starts "Inter".
- c PASS: Hls.version 1.5.7; video.currentTime 1.89 -> 11.93 over 10 s (+10.03); no console errors; Stop ended the session (listed while playing, gone within 2.5 s).
- d PASS (all six): dialogs centre (1440x900: edit user 496,245 448x410, centre 720,450; guide 496,301 448x297; sport 370,124 700x651; 390x844: centre x 195, y 422 for edit user and guide, sport 15,145 360x554). Escape and backdrop click close; focus returns to the opener; scroll positions unchanged under a wheel while open.
- e PASS, with a limit: the overlay opened, played (t 6.1 -> 9.2 s), Escape closed it, no video left playing. Headless fullscreen worked, but Playwright's Escape went to the page and closed both fullscreen and overlay: whether the browser keeps the overlay open is NOT CHECKABLE headless.
- f PASS: phone nav bar 48 px, menu top 48 px (gap 0). Sport cards light: bg rgb(255,255,255) text rgb(28,22,32); dark: bg rgb(30,25,37) text rgb(245,241,244); not Canvas/CanvasText.
- g PASS: the 60 s now/next redraw is armed on Live only (1), none on Guide's ChannelList (the Guide arms its own, different, timer), none on Settings, armed again on return.

## New shots (shots/new-*.jpg, all four device/theme combos)
Channel hidden notice with Undo: channels 30 -> 29 -> 30 after Undo, row back (hide-undo-notice.txt). Error notice: `UI.toast('Could not save the changes', {kind:'error'})` called in the page (no harmless real error exists). Notice over an open dialog: an info toast ("Recording scheduled") sits inside the open dialog.

## Visible differences, before vs after (shots/*.jpg, before left, after right)
Expected, seen: Email column and the Email field gone (settings-system-*, dialog-edit-user-*); phone menu opens flush under the bar (nav-menu-open-phone-*); dialogs centred with new look (dialog-*), the Sport dialog was top-left before.
Unexpected: (1) section headings and the content under them sit about 4 px lower, adding up to 12 px by the third section: settings-system-phone-*, settings-playback-phone-*, settings-recording-phone-*, settings-sports-phone-*, sports-phone-*. (2) Edit user now opens with the Username field focused (pink ring), dialog-edit-user-*. (3) Not UI: sport times moved an hour (06:00 -> 07:00 pm, fake fixture re-anchored by `up`) and the guide's clock; the version badge differs on every page.
Active subtab colour and sport page colours: no clear difference at this scale (before cards were already white/dark).
Not seen: no other page differs beyond the badge; login is identical.

Unexpected (1) is the phone block's `--space-xl` going from 20 px, which is off the spacing scale, to the scale's 24 px (0525).

## Reviews and gates
T1: 1887 of 1891 locally (the four known ffmpeg 8 failures); CI green on 0533. Opus on 0524-0532: no high; fixed in 0533, dialogs opened top-left (medium, reproduced in Chromium) and the Sport dialog's stretched Close button (low). Codex: no high; fixed in 0533, Undo after a hide restored the row into another provider's list (medium). Not fixed, filed as #292: the list loader ignores a selection made during a load (Codex medium, older than this batch) and the remaining lows.
