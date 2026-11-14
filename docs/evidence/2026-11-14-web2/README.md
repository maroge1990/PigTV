# Web 2 (server 0633 to 0649): the web player (#320) and settings (#322); reviews, gates and the rig

| build | issue | change |
|---|---|---|
| 0633 | #320 | Live TV and the TV Guide draw no station number (the line-up editor and number jump keep them) |
| 0634 | #320 | the player's keys act only while Live TV is showing |
| 0635 | #320 | one Safari-aware fullscreen (the plain copy had replaced it): iPhone and iPad fullscreen again |
| 0636 | #320 | Live TV opens on the last channel with a Resume (no autoplay); the tab title and Media Session name the channel |
| 0637 | #320 | closing the tab gives the session back at once (keepalive); a page back from the back/forward cache offers Resume |
| 0638 | #320 | the clash prompts are a banner inside the player, not `confirm()` (which stays when the player is hidden) |
| 0639 | #322 | a re-encode is fixed at 1080p, medium, audio mix auto; the three settings retired (D-63) |
| 0640 | #322 | web upscaling removed; a stored switch changes nothing |
| 0641 | #322 | the overlay shows 5 s and the last volume is always remembered; three settings retired |
| 0642 | #322 | encoder, GPU decode, CPU scale and User-Agent in an Advanced block only admins see |
| 0643 | #322 | Comskip always uses its bundled tuning; `comskipIniPath` retired |
| 0644 | #320 | Codex high: a pagehide while a play is still starting invalidates it, so a late answer plays nothing |
| 0645 | #320 | review medium: leaving Live TV takes a pending prompt away; a recording-due one is asked again, not declined |
| 0646 | #320 | review medium: signing out gives the stream back while the sign-in still works |
| 0647 | #320 | review low: restoring the last channel no longer collapses the groups that were open |
| 0648 | #320 | review low: the Media Session play key resumes the remembered channel when nothing is loaded |
| 0649 | #320 | rig: the controls overlay covered Resume on mouse hover; it stays hidden on the idle player |

Each has a test that failed on the code before it. Default installs keep byte-identical ffmpeg arguments
(`test/ffmpeg-args-golden.test.js`, restored; 106 cases match the 0632 code). Dead keys read and kept, with their
readers, in #322: `sharedIngestEnabled`, `maxProviderStreams`, `viewerIdleTimeoutSec`, `recordingPromptLeadMin`.

## Reviews

- Codex (0633 to 0643): 1 high (a pagehide during a starting play; the server already gives back a session whose client
  hung up, PB5, so only the back/forward-cache case was open), 1 medium (a recording-due banner stranded on leaving Live
  TV). Opus: no high; 2 mediums (the same banner; sign-out sent the release without the token), 4 lows.
- Fixed in 0644 to 0648 (two lows taken because they were regressions from this batch). Codex sign-off: approve, no
  findings. 0649 (found on the rig): Codex sign-off approve.
- Not fixed (lows, in #320): `upscale` is still passed around and ignored (`routes/playback.js`, `channelWarming.js`,
  `streamRelay.js`); the orphaned `#volume-value` CSS; on iPhone the player's fullscreen is the system's, where the
  banner can't show (the server's no-answer timeout decides).

## Gates

`npm test` on 0649: only the four AAC-LC tests that fail on the WSL machine fail (2395 pass). `verify-build.sh`: all
checks passed.

## The rig (fake providers only), 0625 against 0643 and 0649

| check | result |
|---|---|
| Guide and Live TV without numbers | pass ([`guide-before.png`](guide-before.png), [`guide-after.png`](guide-after.png), [`live-phone-before.png`](live-phone-before.png), [`live-phone-after.png`](live-phone-after.png)) |
| keys on the Guide | ←→↑↓, m, Space, k leave the hidden player's volume, mute and pause alone; `m` works on Live TV |
| close the tab while playing | Status shows no session within 1 s (an HLS session, video copy) |
| reload after a play | "Last watched" with Resume, nothing plays until clicked; the tab title names the channel; a real mouse click and a tap resume (0649; [`live-resume.png`](live-resume.png)) |
| Settings › Playback (admin) | no resolution, quality, audio mix, upscaling, overlay or volume; the Advanced block ([`settings-phone-before.png`](settings-phone-before.png), [`settings-phone-after.png`](settings-phone-after.png)); viewers can't open Settings |
| clash (fake provider limited to one stream) | the in-player banner, no browser dialog ([`clash-banner.png`](clash-banner.png), [`clash-banner-phone.png`](clash-banner-phone.png)); Cancel leaves the other stream alone; the action takes it over |

Not checked: Escape in a real browser's fullscreen (headless gives the key to the page); the device checks are T5.
