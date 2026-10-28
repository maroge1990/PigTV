# Handover: a fresh leg after a shared-ingest reconnect (FR-22), 28 Oct 2026

The prompt below is for the next agent session. Paste it as the first message.

---

## Prompt for the next agent

You are working on PigTV, a self-hosted IPTV server (Node 24, Express 5, SQLite, ffmpeg; this repo) with an Apple client
in `../PigTV-Swift`. Mark owns both and tests on his iPhone and Apple TV against his Unraid server.

**Your task:** make a shared-ingest reconnect give the player a clean timeline, the way a relay switch does: a fresh
ffmpeg leg behind an `EXT-X-DISCONTINUITY`, on the same provider. Build it offline-first, as one or two numbered server
commits starting at the next build number in `blueprint.md` §1 (it is **0305** at the time of writing; check). Mark
approved designing and building this. He did not approve deploying it, and he did not approve changing ffmpeg flags or
the Apple client's 30 s live hold.

**Read first, in this order:**
- `AGENTS.md`: its rules override your defaults.
- `blueprint.md`: the state line, §3 "Stall watchdog" and "Shared ingest", §6.
- `docs/SHARED-INGEST.md`: the Upstream loss and Stall rows.
- `docs/FINDINGS.md` FR-22, all of it. It is the evidence for this task.
- `docs/reviews/2026-10-27/avsync-repro/README.md`: the offline harness and its results.
- `docs/CLIENT-CONTRACT.md` before changing anything the Apple client can see. A discontinuity in the live playlist is
  already part of the relay's behaviour.

**What is known (evidence, 28 Oct, on 0304):**
- A FOX [Birmingham] iPhone play stayed in sync for about 18 min. Then the shared reader reconnected for lag (02:47:31,
  27 s behind; the learned limit was 26 s), and the provider ended the stream (02:47:49; back after 6 s). The play had
  `stalls=1`, and its sound was 1–2 s behind the picture from then on. The web player has never shown this problem.
- **How a reconnect differs from a start.** An initial connect starts a fresh ffmpeg session (keyframe start, timeline
  from zero). A relay switch starts a fresh leg behind `EXT-X-DISCONTINUITY` (`services/streamRelay.js`, leg naming
  `L<n>-seg…`). A shared-ingest reconnect (`services/ingest.js`, `onUpstreamGone` → `connect` → `onConnected` in the
  `reconnecting` state) instead feeds the new connection's bytes into **the same running ffmpeg**, with no marker. The old
  connection may end partway through a TS packet. A lag reconnect resumes at live, so the media clock jumps forward by
  about the lag.
- **Offline splice** (`avsync-repro/`: the FOX capture cut mid-packet and resumed from a keyframe 11 s later, through the
  0300 session command): both output tracks jump together and stay within 0.02–0.05 s, with the sound re-encoded or
  copied. But one output segment is about 14.6 s long with an 11 s timestamp gap inside it, followed by three very short
  segments, and nothing marks the break. This is the most likely thing the iPhone player mishandles. It is **not proven**:
  the iPhone's sound timing can't be measured offline (no audio tap on HLS).
- **0191 already does this for the old direct-read path.** In `services/transcodeSession.js` (`TS_LOOP_*`,
  `handleTimestampLoop`): after ffmpeg's own reconnect (`Will reconnect at`), a burst of timestamp warnings ends the
  session as lost (`how: 'timestamps'`), and the relay starts a fresh leg behind a discontinuity. Under shared ingest
  (default on since 0290) ffmpeg reads stdin and never logs that line, so the protection never fires.

**The design to build (adjust it if the code shows a better seam, and say why):**
1. **The ingest says when it reconnected.** On `onConnected` from the `reconnecting` state, every subscriber is told: a
   `reconnected` event on each `Subscription`, carrying `{ forLag, gapSec }`. No URL in the event or its log line.
2. **Only viewer legs under the relay restart.** A viewer `TranscodeSession` whose feed is an ingest subscription, playing
   inside a relay (`relayEnabled`), ends its leg in a new, planned way: not as a failure. The relay then starts a fresh
   leg **on the same candidate** behind `EXT-X-DISCONTINUITY`. Reuse the switch-over machinery, but:
   - **Never quarantine** the provider or record a provider failure for a planned restart. Today `switchOver` calls
     `routing().noteFailure` for a leg the relay gave up on itself; quarantine lasts 10 min, and that must not happen here.
   - **Don't count it** as a lost play in `playbackInterruptions` as `lost`. Give it its own reason, or leave it out, and
     say which.
   - **Don't promote the standby.** It is another provider. The ingest has already reconnected to the same provider.
   - **The new leg joins the same live ingest:** no new provider connection, and admission and pool accounting unchanged.
     Check this explicitly (`streamCoordinator`, `ingest.subscribe`'s `fromStart`).
3. **Unchanged:**
   - **Recordings** (`purpose: 'recording'`) carry on reading through a reconnect as today. Never restart a recording leg.
   - **The probe, warm and standby subscriptions.**
   - **A session without the relay.** Decide and document: leave it as today, or end it so the player re-resolves.
     Recommend one.
   - **The 0191 direct-read path.**
4. **No restart storm.** A burst of reconnects, as on 28 Oct (6 in 30 s at 01:13), must not start a leg per reconnect.
   Coalesce them: one restart once the ingest has been live again for a short settle time, with the time in a tuning
   constant and its reason in a comment. A reconnect while a restart is in flight is absorbed.

**Tests (each must fail on the code before your change; prove it by stashing the source change):**
- Use a fake TS provider over HTTP that drops the connection and resumes later in the stream (copy the shape of
  `test/ingest-pace.test.js` and the existing relay tests):
  - a viewer under the relay gets a new leg and an `EXT-X-DISCONTINUITY` at the join, on the same provider;
  - no quarantine and no extra provider connection;
  - a recording on the same ingest is not restarted;
  - a burst of three reconnects in a few seconds gives one restart.
- **Offline A/V check:** extend `avsync-repro/` with a script that splices the capture as a reconnect does and runs it
  through the real session/relay path. It shows the output now has a discontinuity at the join, with no
  timestamp-gapped segment and no run of very short segments. The capture is in Mark's session scratchpad, not the repo.
  If you don't have it, make a synthetic equivalent with `avsync-repro`'s generator and say so.
- `npm test` and `bash scripts/verify-build.sh .` pass before each commit (Node 24:
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`).

**Rules that matter most here (all in `AGENTS.md`):**
- Commit to `main` and **never push**. Each functional commit bumps `server/version.js` and blueprint §1, and its
  subject starts with the build number.
- **Capture before changing the playback path.** The capture exists (FR-22, `avsync-repro/`). Don't change ffmpeg flags.
- **Don't contact the deployed server or take a provider connection** without Mark's approval for that specific step.
- This is a playback-path change, so it needs a **Codex adversarial review** before Mark is told it is ready. Mark types
  it: `/codex:adversarial-review --background --base <the commit before your first> <focus naming your commits>`. At most
  two rounds. After that, only high findings block, and the rest go into `docs/FINDINGS.md` with a reproduction.
- **Docs in the same commit:**
  - blueprint §3 (Shared ingest) and the state line;
  - `docs/SHARED-INGEST.md` (the Upstream loss row);
  - FR-22 in FINDINGS, updated with what was built and what is still unproven;
  - CLIENT-CONTRACT, if the playlist the Apple client sees changes in any way it can observe.

**When you hand back to Mark:**
- the commits waiting (`git log origin/main..main`) and the build numbers;
- the review command;
- the live check after his deploy: watch a FOX channel on the iPhone through a reconnect. The server log shows
  `[Ingest n] lost the stream … reconnected` followed by a new relay leg. Report whether sound and picture stay in step
  after it. Nothing is Verified until Mark reports back.

**State at handover:**
- Server **0304** (`6de2c5d`) is deployed (live 02:27 UTC, 28 Oct): FR-9's fix.
- Local and not pushed: docs `7dfa964`, plus this handover's commit. Check with `git log origin/main..main`.
- 0301 (the FR-17 sports fix) is deployed with 0304, but its own Codex review was never run.
- Apple build **57** is on the devices.
