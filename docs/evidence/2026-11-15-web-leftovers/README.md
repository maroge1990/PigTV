# Web leftovers (server 0735 to 0757): Recordings, Settings, sign-out, first run, layout and brand 1.9.1

Issues: #62 (Recordings), #64 and #130 (Settings, signed-in fetch, sign-out), #63 (first run), #292 (review leftovers),
#295 (brand leftovers). Mark's choices on 15 Nov 2026: the first-run steps live on Live TV as a checklist, and after the
first sync the last two stay as a slim banner until done; the light theme's status words take darker text shades added
to the brand kit (PigBrand 1.9.1: success #0B6948, warning #884F0B, danger #A42E25; dark #10B981, #F59E0B, #F37171).

| build | change |
|---|---|
| 0735 to 0738 | Guide: Record every new episode / every episode (`newOnly` as the Apple app); Rules switch; Recordings search, sort, bulk delete with one Undo (#62) |
| 0739 | the select tick's CSS without a second rule |
| 0740 to 0742 | notices, a dialog removed without close(), the channel list draws the latest selection (#292) |
| 0743 to 0747 | top bar padding, phone tables, 44 px touch targets, Sport bar icon, phone guide names, brand 1.9.1 status text (#295) |
| refactor | Settings.js split into `public/js/pages/settings/` |
| 0748 | one save model: a failed switch or list goes back and says why (#64) |
| 0749 | one signed-in fetch, `API.authFetch` (#64) |
| 0750 | sign-out always signs out, waiting at most 3 s (#130) |
| 0751 | review (Codex medium): one save of a setting at a time; roll back only to what the server confirmed |
| 0752 to 0754 | Manage content opens on the primary; Providers follows a sync to its end; the Live TV checklist (#63) |
| 0755 | integration: Delete selected uses the status text red |
| 0756 | the banner for guide matching and pairing after the first sync (Mark) |
| 0757 | rig: Delete selected neutral with red text; build label leaves the bar below 768 px; Settings fields 44 px on touch |

Reviews: Codex approved #62; Codex on the batch found one medium (0751, signed off); Codex on #63 found one medium, left
on #63 (a pending connection test can redraw the checklist over channels). Test before saving needs a server route: #330.

Rig T3 (fake providers, 15 Nov): every Settings tab loads with no console errors (a 404 on /api/sports/preferences on
the Sport tab, gated by its feature flag); a forced 500 puts a switch and the encoder list back with the reason
(`fail-toggle.png`); overlapping saves end on the second value; sign-out lands on the login page and clears the token
with the server answering (57 ms), refused (87 ms) and hanging (3.07 s); the channel list shows the last provider chosen
with the first answer delayed; Recordings search, sorts, bulk delete with Undo and expiry, in-progress recordings not
selectable (`rec-select-mode.png`); `newOnly` rules both ways; light-theme status words measure the 1.9.1 shades; first
run with no provider: the admin's checklist (`firstrun-admin.png`), the viewer's line, Test connection, "Syncing… started
4 minutes ago" after 130 s, then the banner (`banner.png`), dismissed for good. The three defects it found are 0757.
