# PigTV roadmap

Current state, then what comes next by issue. Open work lives in [GitHub Issues](https://github.com/maroge1990/PigTV/issues)
(both repos); this file says where things stand and in what order to pick them up. `docs/archive/` is history.

## Current state

*Overwritten at the end of every session. 24 Nov 2026, speed and efficiency programme: every batch that can be built
without a device readout or real plays is built and pushed; `tf/411` is tagged for the one TestFlight build.*

- **Running:** production runs **0886**; server main is **0909** (in `:latest`, reaches production at Mark's next Force
  Update). `:release` stays **v0579**. Apple main **411**, tagged `tf/411` on 24 Nov (Xcode Cloud numbers it itself;
  confirm the upload with Mark). Next builds: server **0910**, Apple **412**.
- **The Guide on Mark's Apple TV:** the "quarter-second press-to-focus gap" in his 382 readout was the readout's own
  fault (each move was timed from the previous press); Apple 402 pairs a move with its own press. On the simulator a
  press reaches focus in about 30 ms. The hang he sees on the device is still unexplained: **ask him for the Guide
  speed readout from the `tf/411` build**; D-80's targets are unproven on the device until then.
- **Batches 1 to 5 (done):** the MacBook gate and Guide measurements (#362); Guide quick wins and structure (#360, #361,
  server 0888 to 0895, Apple 383 to 391); `@Observable` stores and a clean session end (#50, #51, #54, Apple 392 to
  397); crash record and database backups (#43, #44, server 0896 to 0903; left over: #364, #365, #366).
- **Batch 6, first part (Apple 399 to 401, server 0908):** the Apple TV keeps its display mode between plays of the
  same kind (#35); a play reports `zapMs`, the press to the first picture (#36). #36's speed-ups wait on those figures
  from real plays; #30 is skipped (Mark, 23 Nov).
- **Batch 7, server part (0904 to 0907, 0909):** an A/V sync meter and relay rig cases; planned timeline renewal joins
  only the feed it holds and no longer ends when another tab of the same login is open (#371). Two mediums stay open
  on #371, and until they are fixed renewal stays off by default: Mark has said to turn it on (D-81 is drafted on the
  local branch `held/renewal-default`). #370 (−50 ms A/V after a renewal on the rig) needs a capture.
- **Also shipped 23 Nov:** Settings no longer re-reads sport follows on every visit (#368, Apple 398); the Sport front
  page is asked for alongside the preferences at launch, splash unchanged (#55, Apple 403); divider channels are drawn
  as a slim section heading the remote passes over (#372, Apple 404 and 405, three mediums recorded on the issue).
- **Player buttons, option B (#58, #308, #369, Apple 406 to 411):** time-moving buttons on the progress bar, the rest in
  one equal-width, always-named row on all three player kinds and devices; Start over on live TV when a recording of
  the programme is running; Auto-skip breaks on iPad and iPhone. Six review rounds; one medium recorded on #308.
- **Provider series for #3 (24 Nov):** ten cold starts of one channel began in step within 11 ms, so the offset is
  made after the first bytes: test the early pause, reconnect and standby cases on the relay rig (with #370).
- **Needs real plays or a device:** #36's speed-ups (read `zapMs` after some days of viewing; bench on the audit's
  saved samples) · #25 · #27 · #240 (more profiled plays in the log) · #331. #38 can be measured on the saved 4K sample.
- **Test bench:** the MacBook's iPad/iPhone tier fails a different unrelated test on most full runs (#362); the push
  tier is the gate.
- **Open issues:** see `gh issue list`; new on 22 and 23 Nov: #363 to #372.

## Now: finishing the speed and efficiency programme (#359, D-79)

Batches 1 to 7 are built as far as they can go without a device readout or real plays (22 to 24 Nov; the story is in
#359's handover comments and each issue). What is left, in the order Mark agreed on 24 Nov. Measure, change, measure:
no speed fix ships without before and after figures from the same test on the same machine.

1. **The Guide hang on Mark's Apple TV.** Get his Guide speed readout from the `tf/411` build (Settings, after a
   minute of single presses in the Guide). Slow frames or long stalls: fix what the readout points at (#360, #361).
   A quick app with the hang still there: the cause is outside what the readout measures (the remote, the TV, the
   focus engine), so test those one at a time. D-80's targets are judged on this readout.
2. **Faster channel change** (#36, with #240 and #38; playback path: bench first). Read `zapMs` and the start phases
   from Status after some days of Mark's viewing; bench the candidates (`-hls_init_time`, parallel leg close, audio
   during the resolve) on the channel audit's saved samples; measure #38's byte budget on the saved 4K sample.
3. **Renewal on by default** (#371, then D-81's parked change on the local branch `held/renewal-default`; with #370
   and #3). Fix #371's two mediums; find the -50 ms after a renewal on the relay rig (#370); run #3's remaining cases
   there (an early pause, a reconnect, a standby promotion): the provider's own start measured in step on 24 Nov.
   Released alone, with its own Codex round.
4. **Tidy-up batch:** the mediums recorded and not fixed (#372 three, #308 one, #55 one, #366 one) and the flaky
   MacBook tests (#362: the iPad/iPhone tier fails a different unrelated test on most full runs).
5. **Close the programme:** the closing handover on #359 and the issues whose builds Mark has on his devices (D-78).

Cannot be scheduled (they move when the fault happens again): #25 · #27. Set aside: #30 (Mark, 23 Nov) · #364 (until
Mark maps a second folder) · #365 · #331.

## Next: leftovers, folded into whichever batch touches the same files

- **Built, with a part or a review medium still open:** #49 (covers on recording players, follow settings, alerts) ·
  #63 (a first-run redraw medium) · #214 (reselecting Sport on tvOS) · #274 (share back-off) · #320 (iPhone clash
  banner) · #326 (hero strip, tennis draws, racing cards) · #345 · #347 · #348 · #357 · #358 (review mediums).
- **Built, missing a simulator or rig run Claude can do on the MacBook bench (then close, D-78):** #197 · #229 · #233
  (never reproduced) · #234 · #262 · #277 · #282 · #301 · #330 · #332 · #354.
- **Small review leftovers:** #290 · #291 · #292 · #295 · #313.

## Waiting on Mark

- **At a real event:** #259 (the next F1 race: is it marked live?).
- **The Guide speed readout** from the `tf/411` build on his Apple TV (step 1 under Now).
- **Two small choices on the Guide heading (#372):** should the iPhone's portrait On now list show section labels, and
  should the "N of M channels" count leave dividers out?
- **Review rounds:** Claude suggested stopping a batch's Codex rounds after two unless a high remains (the player
  batch took six); not yet agreed.
- **Decisions:** #294 (brand kit icons) · #21 (how to close the sport rebuild).
- **Only a device can tell** (`needs-device-test`): #28 (hardware encodes on PassyFlix) · #101 (audio and subtitle
  tracks).
- **Closed on trust on 22 Nov:** nothing to do. Reopen an issue, or file a new one, if the fault shows in daily use.

**Parked:** #356 (two design rounds each found highs) · #188 lists the P3 someday items
(`gh issue list --state closed --label parked`).

## How to pick work

1. `gh issue list --label P0`, then `--label P1`. A P0 always comes first.
2. Otherwise take the next batch under **Now**; fold in **Next** items that touch the same files.
3. Read the issue, its evidence folder and the area page in `docs/architecture/` before touching code; capture first on
   the playback path. On speed work, take the before figure first.
4. An issue closes when its build is in production or on TestFlight with T1 to T3 evidence, in a comment naming the
   build and the numbered device steps as a guide (D-78). Not fully built, or waiting on a read-only check: it stays open.
5. Keep a batch inside one theme so its one Codex round has one focus (AGENTS.md › Reviews).
6. New problems become issues with the template; security matters become private advisories; someday items get the
   `parked` label and a line in #188.
