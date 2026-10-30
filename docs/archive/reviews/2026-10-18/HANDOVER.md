# Handover, 18 October 2026

For the next agent session. Read, in order: `AGENTS.md`, `blueprint.md` (state line, §3 "Shared ingest", §4, §5),
[`docs/SHARED-INGEST.md`](../../SHARED-INGEST.md) (the Wave 5 design, §8 status), then
[`../2026-10-16/ROADMAP.md`](../2026-10-16/ROADMAP.md) (Wave 4 and 5 progress and Mark's checks). The 16 Oct handover in that
folder is superseded by this one.

## Workflow

**Commit to `main`, never push.** Mark reviews and pushes; CI builds `ghcr.io/maroge1990/pigtv` only if the tests pass.
Every functional server commit bumps `server/version.js` and blueprint §1 "Next build number" (now **0226**); every Swift
app change runs `sh Tools/bump-build.sh` (now **46**). Each change comes with a test that fails on the old code, plus
`npm test` and `scripts/verify-build.sh` (Swift: `sh Tools/test.sh push` and the iOS build) before the commit. Anything on
the playback path is captured/benched first (`scripts/stream-doctor.js`). Give Mark numbered device steps.

## Where things stand

| | |
|---|---|
| Deployed | Server **0225** (`4de6d72`), with Waves 1–5a/5b. The Apple app's builds 42–45 are pushed (`4e3046b`); which build is on Mark's devices is his to say. |
| Waiting to be pushed | Server: four docs-only commits (`e1d56bb`…`5aa6488`: the server bench results, the sample list, the device test, bug 9). Swift: nothing. |
| Waves 1–4 | Done in code. Mark was testing Wave 4 on 16–17 Oct; its results have not been reported back yet (checklist: ROADMAP "Wave 4 device and feed checks"). |
| Wave 5 | Design written; phases **5a** (shared ingest, recordings) and **5b** (live plays and their probe) shipped in 0223–0225, behind Settings → Playback → **Shared provider connection**, off by default. Benched SAME on seven real samples with production ffmpeg, and Mark's device test passed (18 Oct): several devices and a recording on one Strong8K connection, no prompt, a different channel on its own backup connection, clean logs, ingests close after their linger. Whether he leaves the switch on is his call. |

## Open items

### 1. Bug 9: Status page and banner count a shared connection twice (server/web, display only)

**Done in 0226** (committed 18 Oct, not pushed): `connectionsUsed()` in `routes/status.js`, "· shared" on Status, and the
banner's warning only for a recording on its own connection. Tests in `status.test.js` and `status-page.test.js`.

- **Seen:** 18 Oct, 0225, switch on. The TV watched Sky Sports Main Event on Strong8K and a recording of it joined the
  same ingest. Status → Providers showed Strong8K at **2/1** with "viewer" and "recording" as separate connections. The
  top banner said "Live playback may fail while this runs if your provider allows only one stream."
- **Truth:** one provider connection, one ingest, both reading it. The recording started with no prompt.
- **Cause:** `server/routes/status.js` `providersStatus()` (`used = streamCount + recCount`) and `connectionUse()` count every
  session and recording. They don't group by `ingestKey` the way the coordinator's `streamsInPool()` / `recordingsInPool()`
  do (0223/0225). `public/js/app.js` (around line 206) shows its warning for any active recording.
- **Fix:**
  - `used` counts distinct connections: `ingestKey`, else one per session or recording. Sessions carry `ingestKey` in
    `activeStreams()`; recordings carry it in `listActive()`.
  - Each "In use for" entry gets `shared: true` when it is on an ingest; StatusPage renders it as "· shared".
  - The banner drops its warning sentence when the active recording has an `ingestKey`.
- **Test:** a viewer session and a recording on one ingest report `connections.used === 1`. It must fail on 0225. Mind the
  web page tests (`test/status-page.test.js`) and the 2/1 rendering.
- **Size:** small; one functional commit (0226).

### 2. Wave 5 phase 5c: R7 inside the ingest (don't start until there is data)

- **What:** health from the reader's **byte rate** instead of "no file for 20 s". Below the feed's own rate for 15 s while
  connected counts as buffering. Then reconnect the same URL if it had been stable for at least 30 s, else switch the
  ingest to the next candidate in `providerRouting`'s order. A source swap keeps the subscribers; they see a
  discontinuity.
- **Compatibility (review correction 4):** swap only when the new feed's codec, resolution, frame rate, audio and HDR
  match the session's fingerprint. Reuse the relay's `unusable` idea (`streamRelay.js`). Otherwise end the subscribers
  with `upstream-lost` and let today's failover run.
- **Gate:** the thresholds come from **real** rates, not guesses (AGENTS.md: no flag on a hypothesis). The ingest already
  reports kb/s and reconnects per ingest on Status → "Shared provider connections". Collect several days with the switch
  on: per-ingest rate over time, and what a provider stall looks like in those numbers. Consider adding a once-a-minute
  rate log line in `ingest.js` first, as a small observation-only commit. Then design the thresholds from the data and
  write them into `docs/SHARED-INGEST.md` before any code.
- **Tests:** a fake TS provider that slows below rate (reconnects), drops after being stable (reconnects), drops
  repeatedly (switches), and switches to an incompatible feed (ends with `upstream-lost` instead).

### 3. Standbys and warm channels onto the ingest (Wave 5, after 5c or alongside it)

- **Today:** a relay's hot standby (`streamRelay.js`, `standby:<relay id>`) and a warm channel (`channelWarming.js`)
  start their sessions through `playbackStrategy.resolve` **without** `ingestSource`, so each opens its own provider
  connection. On 18 Oct they showed up as extra connections on Dream 4K and Trex. Relay legs after a switch are the same.
- **Change:** pass `ingestSource` (as the resolve route's `ingestFor()` builds it) for those starts.
  - A warm channel on an ingest then *becomes* the viewer's ingest when the viewer arrives: the join is free.
  - A standby only makes sense on a *different* provider. It reads that provider's stream through its own ingest, and a
    switch then joins that ingest, so the provider sees the same connection continue.
  - Check the coordinator's reclaim order still holds: warm first, then standby, then idle, now as ingest entries.
- **Gate:** the via-ingest bench already covers the session arguments. Device-test a relay switch with the standby on an
  ingest, and a warm channel being adopted.

### 4. B4: retire the old recovery code (only on evidence)

- **Candidates:** `streamRelay.js` leg-stitching and standby (if 5c's in-ingest failover replaces them), 0143's
  refused-connection retries in `transcodeSession.js` (if no consumer opens the provider directly any more), and
  per-session warm leases. Roughly 800–1,000 lines.
- **Gate (review correction 5, `docs/SHARED-INGEST.md` §6):** the switch on for about a week. Check:
  - no leaked leases or connections on Status;
  - viewer/recording arbitration still right;
  - cancellation and supersession safe;
  - crash cleanup;
  - memory bounded;
  - HDR, 50 Hz and HE-AAC unchanged on the Apple TV;
  - a working rollback (the switch off).
- **Order:** the switch becomes the default before anything is removed. Then one retirement per commit, each with its
  tests moved or rewritten.

## Also waiting on Mark (don't start these)

- **Wave 4 device results:** R3 segmented recordings (still off; its reference-feed recording capture and the restart and
  takeover test day), R5 rules, R6 artwork, R9 event-slot names, R10 auto-map.
- **Cricket (bug 5):** the real guide titles of the AUS v SA Test (findings in ROADMAP Wave 2).
- **iPhone tuning hang (bug 8):** the server log from when it happens. With the shared connection on, the probe-then-session
  refusal behind it may be gone; ask Mark whether it has recurred.
- **Decisions:** web break markers on the scrub bar (keep?), backup retention 7 vs 14.

## Facts learnt this session (also in the blueprint)

- **`pos_N` is a playlist position, not an identity:** the provider reorders. By 18 Oct `pos_1187` was beIN Sports 3 and Fox
  Sports 505 was `pos_1182`. Find a channel with `stream-doctor list <name>` before a capture.
- **Fox Sports 505 now measures even** (it was the uneven sample in September). No current sample exercises the
  uneven-timestamp path (`igndts`); the unit tests cover it.
- **The bench:** `docker exec PigTV node scripts/stream-doctor.js bench --via-ingest /app/data/samples/<file>.ts` compares
  a session's output reading the URL against the same session fed by the ingest. Skip the ~700 MB `pos_1178` captures:
  the bench keeps every run's output in the container's `/tmp`.
- **Reading the log:** `[Ingest n] reading <hash> for pool <p>` means a shared connection opened. A play that joins one
  logs no new `[Ingest]` line. Problem lines are anything else from `[Ingest]` except `closed (nobody is watching)`.
- **Cold starts:** one cold start through the ingest had its first segment 1.2 s after a 3.6 s probe, because the session
  started from what the probe had already received. It's one measurement; measure more before claiming a speed-up.

## Gotchas

- The MacBook is often busy with other apps (load 40–70 on 17–18 Oct). Under that load the server suite's speed budgets
  and a few timing tests fail. Rerun them alone, and use `PIGTV_SKIP_PERF=1` (CI's own gate) for full runs.
- Don't run the server suite and the Swift UI tier at the same time.
- CI takes about 6 minutes after a push before `:latest` exists. `docker pull` before then gets the old image, and a pull
  never changes the running container: Force Update does.
- When giving Mark shell commands, never use `<placeholder>` syntax: bash reads `<` as a redirection. Give a loop or a
  literal path.
- This session couldn't SSH to the server (refused by the permission check). Mark runs server-side commands and pastes
  the output.
