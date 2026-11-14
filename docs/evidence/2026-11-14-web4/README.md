# Web 4 (server 0665 to 0676): the web player, the Guide's programme menu and search, recordings playback (#321, #62)

| build | issue | change |
|---|---|---|
| 0665 | #321 | the player reconnects as the Apple one does: a fatal error, the end of a live stream or a 35 s frozen picture counts; up to 3 tries in 10 min (0, 3, 10 s) with "Reconnecting…"; "Playback moved to another device." on a takeover; then Try again |
| 0666 | #321 | Favourite, Record, Audio (two or more tracks) and Last channel (also the `l` key) in the player, in Apple's order |
| 0667 | #321 | a Now playing bar on every other page while a stream plays, with Back to Live TV and Stop |
| 0668 | #321 | the Guide's programme menu on the Apple model: Watch now, Record or Cancel recording, Record every episode, buffers under Options |
| 0669 | #321 | Guide search also finds programmes by title in the next 24 hours |
| 0670 | #62 | a programme set to record has a record mark in the Guide |
| 0671 | #62 | Play on Recordings prepares the recording (`/playback?async=1`) with "Preparing…" and says why when it cannot play |
| 0672 | #62 | a recording in progress can be watched from its start (`/watch`) |
| 0673 | #62 | Find breaks (and again, or retry) from a recording's menu, with its progress on the card |
| 0674 | #321 | merge fix: the Guide, its page and the main stylesheet have new cache versions |
| 0675 | #321 | review low: a recording in progress is stopped from the Guide with "Stop recording" and a 10 s Undo |
| 0676 | #321 | Codex high: a reconnect's takeover check belongs to its own play, so a newer channel's failure still recovers; Ctrl/Cmd/Alt+L stay the browser's |

Each has a test that failed before it (the cache-version merge fix excepted).

## Reviews

Codex 1 high (a pending reconnect for one channel blocked recovery on the next: fixed in 0676). Opus no high; mediums: the
same reconnect race, cache versions missed in the merge (0674); lows taken: Stop recording with Undo (0675), modified L.
Sign-off: Codex approve. Lows left (web rule), on #321: the recordings Try again adds listeners again and resumes from the
first position; a 409 during an automatic reconnect off Live TV falls back to `confirm()`; a stall isn't watched while the
tab is hidden (Picture-in-Picture). The programme menu has no "Record every game" (the web Guide has no sport context).

## Gates

`npm test` on the tree rebased onto Web 3: only the four AAC-LC tests that fail on the WSL machine fail.
`verify-build.sh`: all checks passed.

## The rig (fake providers only), 0649 against the batch

| check | result |
|---|---|
| player buttons | Favourite adds the Favourites group; Record schedules the programme on air; Last channel and `l` go back; Audio hidden with one track ([`player-before.png`](player-before.png), [`player-after.png`](player-after.png)) |
| reconnect | fake provider A paused mid-play: "Reconnecting…" at 43 s, playing again from provider B by 48 s ([`reconnecting.png`](reconnecting.png)) |
| Now playing bar | on the Guide and Recordings, desktop and phone, not covering their controls; Stop leaves no session within 1 s ([`now-playing-bar-phone.png`](now-playing-bar-phone.png)) |
| programme menu | Watch now plays; Record adds the mark, then Cancel recording removes both ([`programme-menu-before.png`](programme-menu-before.png), [`programme-menu-after.png`](programme-menu-after.png), [`guide-record-mark.png`](guide-record-mark.png)) |
| Guide search | "Morning News" lists 11 programmes; a hit opens its menu ([`guide-search.png`](guide-search.png)) |
| recordings | Play: "Preparing…" then plays in 2 s; Watch from start on a recording in progress plays in 3 s ([`recording-preparing.png`](recording-preparing.png)) |

Not checked on the rig: a takeover (no clash with the default fakes); Find breaks (the rig's recordings stay "pending",
which hides the item); a real device. T5 steps are on #321.
