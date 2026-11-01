# 0422–0426: the whole F1 grid, "on air" before play, a sharp circuit map (#202, #203, #201)

Server, 1 Nov 2026. Base `1e38be9`.

**0422 (#202):** C-P `drivers` (every car in the newest finished session, by team then name) and `/names?league=F1`.
**0423 (#203, D-42 point 5):** `onAir` on C-O/C-R cards and C-P sessions when a matched airing is on and play starts
within 30 min; it counts among live on the front page (tiles, hero, rails, a follow's state); `status` stays
`scheduled`. **0424 (#201):** `?size=3840` draws ESPN's circuit SVG to a transparent PNG (`@resvg/resvg-wasm` 2.6.2,
no native build, 2.5 MB); C-P `info.map` is that PNG and `info.mapDark` the dark one. ESPN's JPEG was 320×192 on white.

**Tests (T1):** sport-page-f1 › #202, #201; sport-page-prefs › #202; sport-on-air (fixed times); logo-sizes › #201,
0425, 0426. Each fails on the build before it. `npm test`: 1637 pass, 4 fail (the HE-AAC tests: this box's ffmpeg).

**Codex adversarial review, round 1:** one *high*, fixed in 0425: any registered SVG (a provider logo too) could be drawn
unbounded in height on the main thread; now a worker with a pixel bound, heap limit, deadline and a one-at-a-time queue.
**Round 2:** one *high*, fixed in 0426: an embedded bitmap is decoded outside those bounds; an SVG that embeds or links
anything, or is over 512 KB, is now refused before a worker starts.

Not exercised: a live ESPN weekend through the client (T3 on the rig and T5 are in the combined test, D-42).
