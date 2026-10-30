# Repair status after the 23 Oct fix review

Local work on 23–24 Oct, from server 0241 (`f026c63`) and Apple build 47 (`ac7f186`). Nothing pushed or deployed; no
deployed server or provider contacted. "Fixed" below means: implemented, with a regression test that fails on the code
before it (or, for the Apple builds, on a mutation restoring build 47's behaviour where the new API cannot compile against
build 47), and the repository checks passing. It is not device or real-feed acceptance.

## Findings of the fix review (F1–F5)

| ID | Original | Commit | Disposition |
|---|---|---|---|
| F1 (P1) | DVR-1 | 0242 | Fixed. A kept original is published under its own exclusive name (link, never replace); an existing file is accepted only by its bytes; delete removes only what the recording published. |
| F2 (P2) | DVR-1 | 0243 | Fixed. The row stays `moving` until the original is published; a restart retries it. **DVR-1 closed in local scope.** |
| F3 (P2) | DVR-4 | 0244 | Fixed. The immediate start failover is owned (`failingOver`); cancel/shutdown during its awaits start nothing and release a late feed. **DVR-4 closed in local scope.** |
| F4 (P2) | DVR-3 | 0245 | Fixed with a stated policy: identity by instance (present / moved / new), no time window. **Needs Mark's acceptance:** without a provider event id, a slot vanishing while a same-title event appears in the same evaluation is treated as a move (the review script models exactly that). |
| F5 (P2) | W2 | 0246 | Fixed; verified in a real browser (205 groups). **W2 closed in local scope.** |

## Original findings left untouched in 0227–0241

| ID | Commit / build | Disposition |
|---|---|---|
| S4 | 0247 | Fixed: a name-derived programme joins only its own slot; real simulcasts unchanged. |
| S5 | 0248 | Fixed: partial ESPN refreshes keep the last snapshot's games and never renew coverage. |
| S6 | 0249 | Fixed: the download deadline covers the body; the conversion ffmpeg is killed at its deadline. |
| S7 | 0250 | Fixed: sibling-link decisions bump the guide version (and number newly listed channels) when membership changes. |
| A2 | Apple 48 | Fixed: one generation-gated, serialized owner of Top Shelf files. |
| A3 | Apple 49 | Fixed: failed rule changes are shown; one change at a time. |
| A4 | Apple 50 | Fixed: same-shape corrections reconfigure visible cells and redo layout at once, keeping the cell (focus). |
| A5 | Apple 51 | Fixed: a running byte count and one coalesced prune keep the 50 MB cap during use. |

The other original findings keep the dispositions in [FIX-REVIEW.md](FIX-REVIEW.md) (addressed: I1, PB1–PB5, DVR-2, DVR-5,
A1, W1, S1–S3). A1 gained a behavioural before/after proof in this pass (see the Apple status in its blueprint).

## Still open, deliberately

- **Device and feed acceptance** for everything above (steps below). Nothing is *Verified*.
- **Original iPhone "Tuning" (bug 8)** and **AUS v SA cricket grouping (bug 5)**: no root cause established; need evidence.
- **Efficiency work** from the 22 Oct register (archive accounting, media-job deadlines, rule input batching, concurrent
  Apple recording lists, guide window reuse, logo coalescing, interval ingest throughput, warming/standby sharing): not
  started in this pass, and no measurements were taken. A5 and S6 are the resource bounds that were defects.
- **F4 policy** above needs an explicit yes from Mark (or a provider event id to key on).

## Device and data steps for Mark

1. **Installed versions:** Settings → Version on each Apple device, and `curl -s http://192.168.1.235:3000/api/version`.
2. **iPhone Tuning during recording (bug 8):** with a recording running, play on the iPhone (a) the same channel and
   (b) a different channel, once with Settings → Playback → Shared provider connection on and once off. For each, note the
   provider, the time shown "Tuning", and send the server log lines around it (`[Playback]`, `[Coordinator]`, `[Ingest`).
3. **AUS v SA (bug 5):** the exact guide titles, channel names and times of the airings that were not grouped.
4. **Apple 46 layout:** iPhone and iPad - header positions on every tab and the Guide's search icon; Apple TV - fast swipes
   in the guide do not snap back.
5. **PiP (iPhone/iPad):** start PiP from live and from a recording, background the app, return; PiP that fails to start.
6. **Top Shelf after logout (Apple 48):** with favourites on the Top Shelf, sign out while the app is open; the Top Shelf
   must show no channels of that account after it refreshes; sign in again, it repopulates.
7. **Icon and Unraid:** the tvOS icon on the home screen; the container icon in Unraid's Docker page after Force Update.
8. **Growing segmented recordings:** watch from the start while recording; seek across a failover epoch; restart the
   container mid-recording; pull the share during the MP4 publish and during a kept-original copy (0242/0243) - segments
   must stay in appdata and the row show as waiting to move until the share is back.
9. **Recording rules:** turn a rule off with the server stopped (Apple 49 shows the error); a guide correction of a followed
   game by more than 15 minutes leaves one schedule that moves with it (0245).
