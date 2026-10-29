# Findings register

Open findings that do not block a handoff (AGENTS.md, "Stopping rule"): medium and low review findings after a batch's
two Codex rounds, unreproduced test failures, and design debts. Each has what is known and how to reproduce it. Mark
prioritises; fixed entries move to the commit that fixed them and are deleted here. High findings never wait here.

| ID | Since | Area | What is known | Reproduce / next step |
|---|---|---|---|---|
| FR-1 | 26 Oct | Recording cleanup (design) | The cleanup journal (0273-0280: `recording_cleanup`, unique partial names, identity-checked sweep, adoption rules) is correct by its tests but complex: 12 Codex rounds each found a narrower edge. Simpler alternative: every in-progress file in one hidden folder per share, emptied at start; publication by link from there. Removes the sibling scan, most identity checks and the adoption rules; the publish-to-record window still needs the `published` journal. | A design change for the roadmap, not this batch. Decide whether it is worth a refactor once the current design has run on the real share. |
| FR-2 | 26 Oct | Server 0280 review | 0280 (exact inode comparison; bounded sweep wait with `adoptable`) has not had its own Codex round: the batch reached the stopping rule. | `/codex:adversarial-review --background --base bc3273b Challenge 0280` if wanted. |
| FR-3 | 26 Oct | Test: recording-segments "watch from the start" | Failed once in one combined run of four test files (load about 2); not reproduced in four combined and three solo runs; does not reach the sweep or adoption. Polls a live capture with an 8 s limit. Cause unknown. | If it recurs, keep its log; `node --test test/recording-segments.test.js test/recording-prepare.test.js test/native-playback.test.js test/recording-ffmpeg-stop.test.js`. |
| FR-4 | 25 Oct | Test: provider-failover deadline | Failed once in an independent review's full run (backup B started 0 times); not reproduced in many full runs since. Cause not established: A's cut overrunning its 1 s margin, or B's fake-ffprobe spawn over its 1 s probe budget. | The assertions print a timestamped timeline (0262): a recurrence's log names the cause. |
| FR-5 | 25 Oct | Apple test runs | A push run's unit tier stayed in `xcodebuild` for 56 min with no CPU; later, Xcode's post-test `simctl diagnose --timeout=600` was seen holding a run for minutes. Observed, not proven as the cause. | Try `-collect-test-diagnostics never` in `Tools/test.sh` if it recurs. |
| FR-8 | 27 Oct | Playback: bursty provider delivery (Chicago Sports Network Plus, NBC Sports Boston) | Strong8K and Trex both deliver this channel in bursts: an 11-min raw read of both at once (no playback) held both connections at ~5.1 Mbit/s but with a pause over 2 s every ~6 s, typically 3-9 s, up to 11.7 / 10.9 / 15.7 s (Strong8K) and 9.9 s (Trex). The long pauses line up on both providers within ~2 s: one upstream origin. Effects: (1) with Hot standby ready, the relay's 10 s "wrote nothing" check (`PIGTV_RELAY_SWITCH_MS`) switches on an ordinary pause, to a provider pausing at the same moment; it only runs while a standby is ready, and the provider left is quarantined 10 min, which is the ~11-min switch rhythm on 26 Oct (stutter, then A/V out of step after the join). (2) With no standby (NBC Sports Boston: the backups are 720p29.97 and cannot join) the Apple TV reported 5 stalls in 37 min with no server-side event: live HLS starts about 3 target durations (~12 s) from the edge, less than the longest pauses. The A/V offset after a resume is reported by Mark, not yet reproduced. **Server output ruled out for one provider:** the 15-min Chicago sample run through the session's exact arguments (Strong8K's, HE-AAC re-encoded to LC) keeps audio in step with video to the end: every video packet's time unchanged (the 22 'packet duration out of range' clamps move no timestamp by 1 ms), audio contiguous, a constant 21 ms encoder offset from start to finish (`av-drift-check.py`). The live session gets the same bytes, so pauses alone cannot shift sync on the server. Left: a relay join (Chicago) and the Apple TV's own resume after a stall (NBC Sports Boston had no switch; the client only counts stalls and lets AVPlayer recover). A 150 s survey of nine past problem channels on Strong8K (pauses counted after the first 45 s, the start-up burst): continuous delivery, no pause over 2 s - Sky Sports Main Event, Fox Footy 504; bursty with short pauses (max 3-6.5 s) - Sky Sports Football, Fox Sports 506, Sky Sports F1, TSN 4, Willow Cricket; bursty with long pauses - NBC [Scranton] 1080p (11.7 and 14.7 s; its three 21 Oct stalls came back on the same provider in ~5 s). 7 Mate Melbourne was closed by the provider after 6 s (separate). Past 0.0 s "stalled" switches on the short-pause channels (4-11 Oct) predate the logs and cannot be classified now. | Evidence: `docs/reviews/2026-10-27/` (logs and `dualcap.js`, run in the container as `node /tmp/dualcap.js 8 pos_90 660 60`, or `QUIET=1 node /tmp/dualcap.js 8 <pos_N> 150 solo` for one provider). Candidate fixes for Mark: a switch threshold above the feed's normal pauses (env first, no code); a deeper live start offset (server `EXT-X-START` or the client's `configuredTimeOffsetFromLive`), a contract change. |
| FR-14 | 27 Oct | Provider feed: TNT Sports 4 on Strong8K, sound 2-3 s out of step with the picture | Mark, 20:10 AEDT, Apple TV and the web player alike. The server copies both streams (`-c:v copy -c:a copy`) and its segments keep audio within 0.007-0.025 s of video (seg0019-0023, init+segment through ffprobe); no stall, reconnect or switch. So the offset is in the feed's content, not its timestamps. Strong8K's audio is AAC-LC **44.1 kHz** stereo (unusual for broadcast: likely their re-encode). The other carriers cannot stand by for it: Dream 4K is HEVC 50 fps with EAC3 5.1, Trex is 720p (relay: "cannot join this stream"), so this channel has no hot standby. Its keyframes are 10 s apart, so its segments are 10 s. | **Mark lives with it** (27 Oct, roadmap Q3): a known feed defect, no work planned. Kept here so it is not investigated again. |
| FR-10 | 27 Oct | Apple (build 57): player froze on close | NBC Sports Boston after ~35 min (session `b0dd6c4b…`, 04:42-05:2x UTC): Mark came back to the TV and found the player unresponsive (nothing he did brought it on; it was already frozen when he tried to close it); force-quit needed. He doubts it can be reproduced on demand. The server got neither the `play-end` (sent first, from `clearItem` -> `finishMeasurement`) nor the DELETE, while the frozen app kept fetching segments until the force-quit (the 5-min idle sweep then reaped it at 05:31:42). So the freeze was on the main thread before or in `finishMeasurement`, or before `stop()` was called. Suspects, unproven: `AVPlayerItem.accessLog()` on a long live item (read synchronously there), the item teardown. Unknown whether build 56/57 is involved. | If it recurs with Xcode attached to the Apple TV (Debug -> Attach to Process -> PigTV), on a freeze pause the debugger and save the main thread's backtrace. Without Xcode: note the time and whether the picture was still moving, so the server log can be matched. |
| FR-6 | 26 Oct | Apple tab-switch gate | The gate now fails a switch only when it stalls on both laps (`63809e4`). The budget stays 500 ms; the 250 ms Apple TV target is still checked by hand with Instruments. | Lower the simulator budget only after a clean device measurement shows headroom. |
| FR-15 | 28 Oct | P0 round 1 finding 5 (low): configured lag above the ceiling | With `PIGTV_INGEST_BEHIND_SEC=30`, measured PCR feeds use the fixed 28 s ceiling without a startup warning. No-PCR feeds still use 30 s but ingest `describe().limitSec` and Status advertise 28 s. No playback decision is changed by this display defect. | Local fake PCR/no-PCR feeds with tuning `behindMs=30000`: compare the reconnect decision at 29 s with `describe().limitSec`. Add a once-only clamp warning and report the effective per-ingest limit, or prioritise later. Recorded per Mark's round-1 disposition option; confirmed open at the final round 2 (974977f). |
| FR-16 | 28 Oct | P0 round 1 finding 6 (low): legacy lag history | Pre-0292 `feed_lag` rows have no stable channel key, so summary groups them separately and labels their limit with the default. A channel with a newer keyed row at 26 s can appear again with an old row saying 24 s for the 30-day retention period. | In a sandbox record one row with `channelKey=null` and one with a stable key, same channel/provider; raise the keyed limit to 26 s, call `feedLag.summary()`: two rows show 24/26 s. Display no current limit for legacy rows; do not infer identity by display name. Recorded per Mark's round-1 disposition option; confirmed open at the final round 2 (974977f). |
| FR-18 | 28 Oct | P0 round 2 (medium-low): nicknames shared across unfollowed sports | Demonstrated NFL inference from nickname-only titles; whether real guide rows are misclassified is a hypothesis. Ambiguity is checked only across followed rosters. An NRL game written as two shared nicknames can be inferred as NFL when NFL alone is followed, potentially becoming an ESPN replay or matching an NFL recording rule. | Reproduction below. Mark to prioritise stricter aliases for known cross-code nickname clashes; real guides have not been checked. |
| FR-22 | 28 Oct | Playback: iPhone plays pause, then A/V out of step; the web play of the same channel does not (Mark, 01:05–01:14 UTC) | Seven plays on 0300, from the server log. iPhone: Fox Cricket 501 (copy, 4 s); **FOX Birmingham** (`fmt?`, then re-encoded, `stalls=1`, 40 s); **FOX Philadelphia** (`fmt?`, then re-encoded, `stalls=1`, 20 s); Sportsnet Event (blank picture from Strong8K, ignore); **Sportsnet One** (LC copied, `stalls=0`, 57 s). Web (`user:1`): **FOX Birmingham** (re-encoded, `stalls=0`, 69 s, no A/V issue). iPhone again: **FOX Birmingham** (re-encoded from the start, A/V issue reported). Mark (01:20 UTC): plays **1, 2, 4 and 6** desynced: FOX Birmingham, FOX Philadelphia, Sportsnet One (ordinary AAC, copied: so re-encoding is not the common factor) and FOX Birmingham again. In each, **the sound was about 1–2 s behind the picture**, after **a pause within the first 10 s**. Only the web play (5) was clean. No relay switch, ingest reconnect or lag line during the first two. In the final play's server output, segment 0 starts audio at 0.000 s and video at 1.355 s; later segments are in step within 0.02–0.05 s. Reading the video logs `number of reference frames (0+5) exceeds max (4)` and `mmco: unref short failure` (High@4.2, 1080p59.94 progressive: an out-of-spec feed). At 01:13:34–55 that session's ffmpeg wrote nothing for 21 s while data arrived (`Packet duration: -41 ... out of range` on video), was released as stalled, and Strong8K then ended the stream 5 times in 30 s; the replacement relay leg was flagged a blank picture. Leading hypothesis, unproven: a new session's first segment holds sound from the session start but video only from the first keyframe (1.355 s later in play 6; anywhere from 0 to one GOP on another play), and after its early pause AVPlayer resumes with the sound behind by about that gap, which matches the reported 1–2 s. hls.js aligns the tracks. Other candidates: the out-of-spec reference frames, or the 30 s live hold on a playlist only a few seconds long (the likely trigger of the early pause). | **Offline run, 28 Oct (`docs/reviews/2026-10-27/avsync-repro/`):** a synthetic 1080p59.94 feed joined mid-GOP, through the exact session command into a local AVPlayer with the 30 s hold, reproduces the segment-0 gap (picture 1.563 s after sound). But macOS AVPlayer does **not** pause (0 stalls in 60 s, with 2 s and 12 s head starts), and the sound cannot be measured there (no audio tap on HLS). So the start gap alone does not explain the pause, at least on macOS. **28 Oct 02:29–02:54 UTC (0304 live):** a FOX [Birmingham] iPhone play stayed in sync for ~18 min, then lost it at the ingest's lag reconnect (02:47:31, 27 s behind with the learned limit at 26 s) followed by `the provider ended the stream` (02:47:49, back after 6 s); `stalls=1`. Mark then found later FOX plays out of sync too (Birmingham 02:48, re-encoded; Kansas City 02:50, AAC-LC label so copied; both `stalls=0`). Offline splice of the capture like a reconnect (old connection cut mid-packet, new one from a keyframe 11 s later), through the session command: both tracks jump together and stay within 0.02-0.05 s, re-encoded or copied; the output gets a ~14.6 s segment with an 11 s gap inside it and three short segments after. So the server output stays in step across a reconnect; what remains is the player's handling of that gap or a feed that came back out of step upstream (as FR-14). Also seen: the first play after the 0304 deploy came from a stored channel profile without the label, so it still copied and hit `fmt?` once, as expected. Still open: iOS-specific behaviour, the FOX feed's broken reference-frame count (not reproducible with x264), and real delivery bursts. **Real feed, 28 Oct:** the same 60 s FOX capture, re-encoded as on the iPhone retry and delivered in 6 s bursts like the measured Strong8K delivery, **stalls at 4.9 s**. With the 30 s hold it then waits 26 s; without the hold it waits 1.7 s and stalls again at 18.8 s. Cause of the pause: a new session's playlist is only seconds long, and the player starts at its very beginning and runs into the provider's 4–8 s delivery pauses. The 1–2 s sound lag after the pause is still not measured (no audio tap on HLS). Fix directions, unapproved and untested: answer the first playlist only after several segments exist, or start the player further back from the edge on a new session. Still open: the same channel on iPhone and on the web, with segment-0 timings and the session log read while each runs (read-only, Mark's own play holds the connection). Mark notes the lag each time: if it tracks the segment-0 gap over 2–3 plays, reproduce it offline (synthetic TS with sound starting before the first keyframe, through the session's exact arguments, played in the iOS Simulator) before any change. No ffmpeg or hold change before that.  **0305:** reconnect-boundary implementation and offline/live limits are recorded [below](#fr-22-reconnect-timeline-0305). |
| FR-19 | 28 Oct | Sports: cricket fixture matched to the wrong game (medium, demonstrated on production rows) | Fox Cricket 501's overnight "Test : South Africa v Australia" blocks at 01:00 and 04:00 UTC on 28 Oct (no live flag) are listed as **live events** on 0300 and 0301. `fixtureVerdict` picks the closest-starting fixture whose teams fuzzily match. The Sheffield Shield game *South Australia v Western Australia* (first ball 28 Oct 00:00) matches, because `teamMatch` accepts abbreviation "SOA" for "South Africa" (letters in order) and "Australia" inside "Western Australia" (or the location "Australia"). It starts nearer than the Test (27 Oct 08:30), and its daily window 00:00–08:00 then calls them live. Willow Cricket's Day 2 blocks are credited to the Shield game too (right outcome, wrong game). The outcome predates 0293 in kind (fuzzy fixture matching since 0161) but became visible once 0293 recognised Fox's titles. | `docs/reviews/2026-10-27/sports-replay/` (`replay.js` from 2026-10-27T22:10Z and 2026-10-28T00:30Z, RESULTS.md). Fix candidates: fixtures need both sides to match on an informative name (the 0295 rule for rosters), never abbreviation-by-letters or a subset; prefer an exact two-side match over a nearer fuzzy one. |
| FR-20 | 28 Oct | Sports: Fox Cricket Day 2 live sessions read as replays (medium, demonstrated on production rows) | Fox's Day 2 titles "Test : RSA v AUS 3rd Test D2 S1/S2/S3" (08:30, 11:10, 13:30 UTC on 28 Oct, **flag 8 = live**) come out as `replay: ESPN has no such game at this time` on 0300 and 0301. Three causes. (1) The 0293 stage-suffix strip handles "Day 2 Session 1" but not "D2 S1", so the second side is "AUS 3rd Test D2 S1". (2) "RSA" does not match South Africa ("SA"/"South Africa"). (3) The ESPN "no such game" branch runs before the guide's live flag and overrides it. Willow Cricket still lists Day 2 live, so Sports shows the Test, but not on Fox Cricket 501. | Same replay from 2026-10-28T07:00Z and T08:40Z. Fix candidates: strip `D\d+ S\d+` stage tags; alias RSA for South Africa; let an explicit live flag (or a "Live" title) beat "no such game" (an absence, not a presence). |
| FR-21 | 28 Oct | Sports: roster inference overrides a followed competition (medium, demonstrated on production rows; a regression from 0289) | "Live EFL Cup: Man City v Brighton" (Sky Sports +, 28 Oct 19:00 UTC) is inferred as EPL from the stored roster (0294/0295), matched to Saturday's EPL fixture between the same clubs, and listed as a **replay** ("68 h earlier"), even with "EFL Cup" followed first. On 0289 the same follow list gives a live EFL Cup event. The roster league is unshifted ahead of the keyword in `classify()`, so it becomes the item's league and drives the ESPN verdict. The same rule tagged an AFL replay "Round 21 CAR v BRI" (Fox Footy) as FA Cup (exact abbreviations of Cardiff/Brighton) and an Eredivisie game as UEFA. | `sports-replay/eflcup.js` (0289 vs 0300/0301), `inferred.js`. Fix candidates: skip roster inference when the title already matches a followed non-league keyword (or names another competition: "EFL Cup", "Eredivisie", "Round N" on an AFL channel); require both abbreviations to be unambiguous across all stored rosters, not just followed ones. |

## E2: ffmpeg release parity (0306)

Mark approved upgrading the production tools on 28 Oct. **0306** prepares checksum-pinned FFmpeg/ffprobe 9.0.2 and one
Ubuntu 24.04 amd64 recipe for the image and Linux CI. Exact version/capability checks reject drift and missing hardware
filters; the final candidate image runs the full suite before that same image can be published. Local 1234/1234 tests
pass. Six 6.1.1/9.0.2 sample commands yield 12/12 URL-versus-ingest SAME verdicts across FOX, synthetic H.264/59.94/AAC-LC
and HEVC Main10/HDR-tagged/50/HE-AAC; all reported segment/frame metrics match across versions except a 3.311 ms FOX TS
start difference. The 6.1.1 baseline is an isolated native software build, not the old production binary. Existing FOX
copy warnings remain on both. The recording test now uses a synthetic HE-AAC fixture on every OS (Linux formerly fell
back to AAC-LC). New 10 safety tests fail with source stashed and pass restored; structural image/publication checks fail
with the old recipe or a push-before-test mutation. No session flags/Apple hold changes, provider connection or deploy.

**Still open:** Linux source/image build and runtime tests cannot run locally (no Docker); CI must pass them before
publication. Actual GPU execution and device/reference-feed acceptance are pending. The current npm fallback binaries
on this Mac are ffmpeg 6.0/ffprobe 4.4.1; they were not used for acceptance. macOS 9.0.2 real FOX/AVPlayer replay retains
one marked reconnect and clean segments, but also the startup stall; no HLS sound timing is measured. **Not an FR-22
sound fix or Verified deployment.** Commands, evidence and exact limits: [MEDIA-TOOLCHAIN.md](MEDIA-TOOLCHAIN.md).
Adversarial review remains required for 0306 (base `806c1d6`) and 0305 (base `da00a7c`), or jointly from `da00a7c`.

## FR-22 reconnect timeline (0305)

**Latest device report, 28 Oct (Mark, during 0306 finalisation):** some channels are intermittently out of A/V sync
**from the beginning** of a play; another start can be in sync. These plays do not show the earlier pause followed by
loss of sync. The reported current build number, channels, offset direction/magnitude and per-play logs were not supplied.
This is user-observed evidence, not an instrumented timing measurement. Do not require a pause or reconnect to reproduce
FR-22 or treat the initial offset as fixed by 0305. Repeat cold and warm starts of the same channel after 0306, correlating
sync outcome with first-segment track starts, copy/encode mode and session/probe version before changing flags or the hold.
Mark asked to finish 0306 first; the upgrade may change behaviour or narrow diagnosis, but no sound fix is established.

**Implemented locally, not deployed or device-accepted; adversarial review pending.** Only relay viewer legs renew on a
successful shared-ingest reconnect. The subscription emits URL-free `{ forLag, gapSec }` before new bytes, the old join
buffer is discarded, and the old ffmpeg stops as planned (never `lost`). The relay waits 6 live seconds after the latest
reconnect, keeps the exact candidate, and starts a fresh leg behind a discontinuity. Reconnects during startup discard
unpublished attempts; a burst publishes one renewal. A draining subscription pins the original ingest and the old leg
remains registered until handoff, so admission owns that connection throughout (including zero linger); session summaries
now carry their existing `ingestKey` for coordinator grouping. A ready standby stays standby. Planned renewals appear as
relay reason `reconnected` and are omitted from lost **and recovered** interruption counts. Recordings, probes, warm and
standby subscriptions, sessions without a relay and the 0191 direct-read guard continue as before. Recommendation:
leave non-relay sessions unchanged; ending them would introduce client re-resolves outside this approved relay fix.
No session ffmpeg argument or Apple 30 s hold changed.

**Evidence:** existing 48.4 MB FOX capture, no new capture. The real server path's offline splice now has one same-provider
discontinuity, maximum segment 4.004 s, maximum audio step 0.021667 s, and no consecutive tiny segments. Old code: no
marker, 14.014 s segment containing a 12.224 s audio gap, followed by 0.167/0.634 s segments. Both use exactly two provider
connections. Real macOS AVPlayer recovers and plays across the join; picture/clock offset ≤15 ms after, ≤41 ms before.
Both runs have one **startup** stall (6.49 s after / 2.55 s before); recovery 29.92 s after / 4.59 s before with the unchanged
30 s hold. This is not a claim to fix startup stalls or iPhone sound timing: `tapCalls=0` for HLS. The new leg's first segment
still has a 1.979 s audio/video start gap while waiting for a keyframe; later starts are within 0.05 s. The iPhone sound
lag, real delivery variation and production ffmpeg 6.1.1 remain unproven. No iOS Simulator run: no Apple code changed;
macOS AVPlayer provides this offline player check, and Mark's iPhone acceptance is still required. Timings, player logs,
reproduction commands and fixture corrections are in [the harness README](reviews/2026-10-27/avsync-repro/README.md#reconnect-through-the-real-server-path-0305).

**Runs, 28 Oct (Node 24.21.0, ffmpeg 9.0.2, local HTTP only):** `PATH=/opt/homebrew/opt/node@24/bin:$PATH` for every Node command.
`FOX_SAMPLE` is the absolute capture path in the harness README; `SPLICE=/private/tmp/pigtv-fr22-after/splice.ts`.

| Command | Result |
|---|---|
| `node --test --test-name-pattern=FR-22 test/ingest-playback.test.js test/stream-relay.test.js test/ingest-pace.test.js` | Initial five regressions pass with source; all five fail with the three source files stashed (`git stash push -- server/services/ingest.js server/services/streamRelay.js server/services/transcodeSession.js`, then `git stash pop`). |
| `node --test --test-name-pattern='FR-22: a reconnect while\|FR-22: bare' test/ingest-playback.test.js` | Two further startup/exclusion regressions fail with source stashed; both pass restored. All eight pass in the final full suite. |
| `node --test --test-name-pattern='FR-22: zero-linger renewal' test/ingest-playback.test.js` | Fails original source (source stashed), also caught a false failed-relay status in the implementation; passes after cancellation uses the ingest's provider-reason flag. Proves no-recording renewal, slot protection, forced takeover and no resurrection. |
| `node --test --test-name-pattern='FR-22: 3 HTTP' test/ingest-playback.test.js` | Strengthened to 3.5 s between reconnects: fails original source with implementation stashed, and the 3 s prototype (three renewals); **one renewal** with final 6 s settle. |
| `node --test test/ingest-playback.test.js test/stream-relay.test.js` | Pass, including routes, recordings and coordinator admission; the later complete suite also covers ingest-recordings, provider-pools and coordinator-own-stream. |
| `npm test` | First run 1222/1223: only a new test's assumption that a complete HTTP burst had arrived at its first event failed. Replaced that assumption with bounded polling for the bytes. A restored run passed 1223/1223 (51.65 s); after adding the takeover correction another passed 1224/1224 (53.87 s). The final run, including takeover and spaced flaps, is **1224/1224 pass**, no skips (61.85 s). |
| `node scripts/relay-rig.js reconnect` | New shared-ingest variant, copied A/V into fMP4: same provider, one discontinuity, replacement segment HTTP 200; ffmpeg reader exits 0. |
| `node scripts/relay-rig.js stall` | Final run: cold recovery, one discontinuity, replacement segment HTTP 200; ffmpeg reader exits 0. |
| `node scripts/relay-rig.js standby stall` | Corrected real-directory/lease fixture: standby ready, immediate promotion (0.0 s), one discontinuity, segment HTTP 200; ffmpeg reader exits 0. |
| `node scripts/relay-rig.js ts` | Cold TS recovery, one discontinuity, segment HTTP 200; ffmpeg reader exits 0. TS has no init segment (the rig's legacy init fetch reports 404). |
| `node scripts/relay-rig.js long` | 110 s media reader: cold recovery, one discontinuity, segment HTTP 200; ffmpeg reader exits 0. |
| `node docs/reviews/2026-10-27/avsync-repro/reconnect.js "$FOX_SAMPLE" /private/tmp/pigtv-fr22-before2 --baseline` (source stashed) | Old playlist and gap reproduced, real ffmpeg reader and 48 s AVPlayer log saved. |
| `node docs/reviews/2026-10-27/avsync-repro/reconnect.js "$FOX_SAMPLE" /private/tmp/pigtv-fr22-final` (source restored) | New boundary criteria pass, both real players exercised. Finite after reader deliberately killed at 48 s; AVPlayer completes 48 s. |
| `node scripts/stream-doctor.js classify "$FOX_SAMPLE"` and `node scripts/stream-doctor.js classify "$SPLICE"` | Original EVEN/no jumps; splice EVEN with ~12.08 s video / ~12.25 s audio forward jumps. |
| `node scripts/stream-doctor.js bench "$FOX_SAMPLE"` and `node scripts/stream-doctor.js bench "$SPLICE"` | Production argument builders exercised: original even 16.683 ms frames, splice retains a ~12.08 s jump in the bare session command. Existing copied-fMP4 packet-duration warnings (20 original / 17 splice); TS branch none. No flags changed. |
| `node scripts/stream-doctor.js bench --via-ingest "$FOX_SAMPLE"` | **SAME** for both session shapes (direct URL vs local ingest). |
| `bash scripts/verify-build.sh .` and `git diff --check` | Pass. No new verifier checks (all new behaviour is testable). |

The final synthetic reconnect rig renews on ProvA in 11.6 s (6 s settle plus ffmpeg startup), with reader exit 0.
Initial local test attempts hit sandbox loopback EPERM (rerun with loopback permission), a cold-probe zero-linger
connection-count assumption, and a stand-in standby carrying the viewer owner; these were fixture issues corrected
before the successful runs. The first standalone relay unit run passed before new tests were added.

First rig attempts were rejected for fixture-control issues (documented in the README), then rerun; nothing was hidden.
No deployed server, provider connection, new capture or Apple source change. Review required before this is called ready:
`/codex:adversarial-review --background --base da00a7c Review 0305: shared-ingest reconnect metadata, planned same-provider relay timeline renewal, coalescing/in-flight reconnects, pin and slot ownership through cancellation/takeover, standby/recording isolation, quarantine/redaction and client playlist continuity.`
After Mark's deployment: watch FOX on iPhone through an ingest reconnect, correlate `lost the stream` / `reconnected` with
one new relay leg, and report whether sound and picture stay in step. This finding stays open until that report.

## FR-18 reproduction and scope

Reviewed at `974977f`, `server/services/sportsEvents.js`, `rosterAliases` and the roster-inference loop. In a local Node session:

```js
const sports = require('./server/services/sportsEvents');
const team = (displayName, name, location, abbreviation) =>
    ({ displayName, shortDisplayName: name, name, location, abbreviation });
const roster = [
    team('Carolina Panthers', 'Panthers', 'Carolina', 'CAR'),
    team('Denver Broncos', 'Broncos', 'Denver', 'DEN'),
    team('Detroit Lions', 'Lions', 'Detroit', 'DET'),
    team('Philadelphia Eagles', 'Eagles', 'Philadelphia', 'PHI'),
    team('New York Giants', 'Giants', 'New York', 'NYG'),
    team('Arizona Cardinals', 'Cardinals', 'Arizona', 'ARI')
];
const follow = sports.compileFollow(['NFL'], new Map([['NFL', roster]]));
for (const title of ['Panthers v Broncos', 'Lions v Eagles', 'Giants v Cardinals',
    'Penrith Panthers v Brisbane Broncos']) {
    console.log(title, sports.classify({ title }, follow)?.league ?? null);
}
```

The first three infer NFL; the full NRL pairing correctly gives null. NRL and NFL share Panthers, Broncos, Cowboys,
Titans, Raiders and Dolphins. Without NRL in the followed rosters, a nickname-only NRL title can infer NFL. Following
both matching rosters can prevent some clashes (for example AFL/NFL Lions v Eagles; Mark follows AFL). Most NRL titles
name NRL explicitly, which is detected first; **real guide occurrence and frequency are unconfirmed**.

Possible follow-up for Mark: require a full display name or stored abbreviation when a nickname is shared with a known
other code, or maintain known nickname clashes. No implementation or provider/guide capture was authorised here.

Also open, tracked in `blueprint.md`: bug 8 (iPhone tuning) without a root cause; the deferred
and unmeasured efficiency register, physical device and real-feed acceptance, and the recorded review findings awaiting
Mark's prioritisation of the remaining findings. R8's sync measurement and the E3 samples were closed on 27 Oct;
B4 was re-scoped to dead-code removal.

## 0305/0306 adversarial review follow-ups (28 Oct)

Full review dispositions and reproduction notes: [`docs/reviews/2026-10-28/round1-repairs/README.md`](reviews/2026-10-28/round1-repairs/README.md).

| ID | Finding | Current disposition / reproduction |
|---|---|---|
| FR-23 | Intermittent A/V offset from playback start, sometimes in sync and sometimes out, without the former pause (Mark report, 28 Oct) | Open. Four offline FOX loop-capture comparisons had join stalls with baseline and 0305, at both 30 s and 0 s hold. Loop fixture had earlier stalls and AVPlayer tap calls were zero, so audio timing is unknown and no root cause/fix is claimed. Reproduce on deployed 0305 through repeated cold and warm starts; record first audio/video timestamps and offset direction/magnitude before changing/deploying. |
| FR-24 | M2: zero-linger cold probe can be followed by a second provider connection | Open. Old fixture reproduced a serial double connection in 1/6 isolated runs; corrected test passes 20/20 after restoring normal linger before the target cold play. Test a real cold channel at `PIGTV_INGEST_LINGER_MS=0` and decide whether to enforce a minimum. |
| FR-25 | M3: optional external-library differences between deployed FFmpeg 6.1.1 and intended 9.0.2 Linux profile | Open for review after actual candidate inventory. VPL/dav1d/XML2/iconv and required decoder/demuxer checks are added. The 9.0.2 Linux image has not been built; no full optional-library parity claim. Compare its actual buildconf against deployed `/tmp/pigtv-review-deployed-tools.txt`, then explicitly add or document each omitted library, including platform-specific AMF. |
| FR-26 | M4: encoder-help checks do not prove actual GPU execution | Open. `check-encoder-options.js` validates private flags against encoder-specific help; software lavfi encodes run locally. On the production host, execute actual VAAPI/QSV/NVENC paths available and verify a real frame encode/decode. |
| FR-27 | L2: incompatible media during same-provider renewal ends the relay | Answered, no code change. The candidate is marked unusable for that relay because splicing changed media contracts is unsafe; the relay ends without provider-wide quarantine or a `providerReason` event. Reproduce with a new epoch that changes codec/resolution/audio layout and verify relay-local teardown. |
| FR-28 | L4: smoke/cache/signature descriptions overstated validation | Fixed in `docs/MEDIA-TOOLCHAIN.md`. The workflow tests the candidate image, not the server main process; compiled-binary cache hits skip a source rebuild; source archives are hash-checked when the builder consumes them; PGP signature verification was not done. |

## 0307 / 0308 follow-up review (29 Oct)

M1/L1 recording audio, M3 cold-start readiness, M4 cumulative renewal budgeting, L2 transferred-pin release and L4
encoder-option parsing are repaired in 0310–0312 with failing-before tests. L3 is answered by the existing deadline
cleanup and a new hung-child integration test. Full dispositions: [repair record](reviews/2026-10-29/review-repairs/README.md).

**M2 / FR-26 hardware acceptance remains open.** Mark identifies the host as an i5-9500T (no dedicated GPU).
Authorized read-only inspection shows `hwEncoder=auto`, recommended VAAPI, QSV unavailable; `libmfx1` is absent,
while `libvpl2` and `libmfx-gen1.2` are installed. 0312 restores explicit legacy runtime packaging. A real Linux image
and legacy-QSV encode have not been tested here. Reproduce/accept after candidate CI: inspect the installed legacy
runtime library and run a two-second `h264_qsv` lavfi encode on that host, without changing PigTV's encoder setting or
opening a feed. Name/help checks do not establish hardware operation. Failure remains a compatibility acceptance issue;
current production is using VAAPI, so no QSV outage is claimed.

## Sports dashboard 0309 own review (29 Oct)

Reviewer: Claude (own review supplied by Mark); reviewed `4d95f10` against `a6e86e1`. These repairs are in **0313**.
This is not the mandatory Codex adversarial review: round count remains **0 of 2**. Full evidence/dispositions:
[own-review record](reviews/2026-10-29/sports-dashboard-own-review/README.md).

| ID | Disposition and reproduction |
|---|---|
| SD-0309-H1 | Fixed: use cached C-I events and a read-only projection worker, parse/index once, hoist statements/formatters, read snapshots in bulk. Reproduce original by making `eventsFor` or main-thread projection throw: route fails; 300-game original projection prepares hundreds of statements. New route guard, real join and perf tests pass. |
| SD-0309-M1 | Fixed: with delay 300s and spoilers hidden, ingest live then a newer finished state while keeping the airing valid. Original loses channels/Watch before delayed final; repair preserves every score-derived broadcast field until eligibility. Also test a newer correction after an eligible final: retention now belongs to the historical snapshot, with 0309 history upgrade. |
| SD-0309-M2 | Fixed with bounded collection; live acceptance remains: original mocked worst-case tick makes 319 cold / 126 next-tick requests; repair never exceeds 12, including discovery. Inactive sources use 15min, active/near-start dates 30s; a 429/5xx pauses score and fixture clients. Cold/partial catalog coverage under the budget and resumed cricket without a known restart time still need real-service acceptance; no guaranteed ESPN allowance or delivery lag is claimed. |
| SD-0309-M3 | Fixed: three same-team T20/ODI games two days apart no longer overlap a default five-day window. Ignore cricket endDate envelopes, bound by format and prefer clearly nearest starts; ties stay unmatched. Women's T20 labels are normalized. Captured ODI/T20 end hints exceed a day and are not trustworthy match ends. |
| SD-0309-L1 | Fixed: a marked category/whole-league selection remains broad when a team is followed. Reproduce with category NFL + a different NFL team followed: original hides a catalog game, repaired union retains it; team-only selection still narrows. |
| SD-0309-L2 | Answered, no behavior change: ingest a first-seen final with no previously observed live/scheduled state. At 1s it buffers as unknown, at the default 90s it disappears; no completion transition means no invented one-hour recent result. Existing observed transitions persist across restart. Regression intentionally passes on 0309 and repair; C-O documents the decision. |
| SD-0309-L3 | Fixed by one transaction per tick, preserving each response's observation time. Original 20-game probe invokes ingest 20 times; repair calls one batch. Identical newly received states may still have history rows, because receipt/freshness and delay boundaries must remain truthful. |
| SD-0309-L4 | Fixed: nonempty cached event response exercises actual worker-backed joins and channel projection; sentinel failures prohibit both slow/reference paths. 300 games / 1,200 airings have a perf budget using the standard PIGTV_SKIP_PERF helper. |

## 0310–0312 approved review, round-1 follow-ups (29 Oct)

Mark reports round **1 of 2 APPROVED, no high findings**. **0314** fixes N1 (one non-renewed primary restart if backup
admission/start fails after budget exhaustion) and N2 (Mark chooses channel-only quarantine; no provider-wide breaker
count or providerReason=true from budget exhaustion). Both have failing-before regressions. Follow-on short epochs
count toward the same three-per-minute budget. [Evidence/dispositions](reviews/2026-10-29/review-repairs/round1-followups/README.md).

| ID | Priority / status | Reproduction and remaining work |
|---|---|---|
| FR-29 (N3) | Medium, investigation open; no timestamp patch | Run `node docs/reviews/2026-10-29/review-repairs/round1-followups/watch-gap.cjs /private/tmp/pigtv-n3-watch-gap`. One epoch has a +5 s A/V timestamp step at t=6; stream-doctor confirms gaps. Existing follower exits 0 and AVPlayer crosses the gap. Watch start/post-jump/end packet skew is -42.667/-2.667/+10.666 ms; no cumulative five-second drift. Does not reproduce the feared failure in this fixture. Capture a real in-epoch reconnect with backward/reset or unequal track jumps, measure packet/content alignment and follower behavior before any aresample change; do not use first_pts=0 while video retains source timestamps. Audible hardware sync remains unmeasured. |
| FR-30 (low note b) | Low, detection issue open; part of FR-26 acceptance | On PassyFlix, lspci spawn returns ENOENT but /dev/dri/renderD128 exists; hw-info auto currently selects VAAPI and QSV says No Intel GPU found. detectQuickSync() treats failed lspci pipeline as GPU absence. Confirm utility/device access and a real QSV lavfi encode after the reviewed image/runtime is available, then assess detector changes and resulting auto recommendation. Do not equate this string with absence of the i5-9500T/UHD 630, or claim QSV tested from package/help checks. |

## Sports dashboard 0313 own-review follow-ups (29 Oct)

Original H1/M1–M3/L1/L3/L4 repairs and the L2 answer were accepted by the own reviewer. N1/N2 follow-ups are repaired
in **0315**; Codex adversarial review remains **0 of 2**. [Latest evidence/handoff](reviews/2026-10-29/sports-dashboard-followups/README.md).

| ID | Disposition and reproduction |
|---|---|
| SD-0313-N1 (medium) | Fixed. On 72fa3b9, dashboard off + first league HTTP 503 causes later leagues in sequential refreshAll to skip fetches and record cooldown failures. Legacy fixture requests now consult/observe shared cooldown only with dashboard enabled. Enabled passes defer unattempted leagues without marking failures and retry after cooldown; another successful pass cancels an obsolete retry. Tests cover disabled, enabled retry and coalescing. |
| SD-0313-N2 (medium) | Fixed. On 72fa3b9, 14 live leagues over 40 ticks fetch only 14 hot URLs, zero future URLs. Three of the 12 request slots now protect eligible least-recent non-hot work (discovery counts); spare capacity is borrowed. The same probe reaches all 70 requested URLs, including 42 future URLs, without exceeding 12/tick. |
| SD-0313-L1 (low) | Fixed. A hung active projection previously had no timer and exhausted the eight-request queue. A 10s per-job deadline now rejects the hung job, terminates the old worker and dispatches queued work on a replacement; timers clear on completion/error/close. Deterministic worker/timer regression fails on 72fa3b9 and passes after. |
| SD-0313-L2 (low) | Open, deferred. An unknown-format Cricket game started 48h ago falls outside the 12h join/hot-poll fallback even if it is multi-day: same teams + current airing remains unmatched, source uses slow cadence. Reproduce with format=null, start=now-48h and current status=live; matchBroadcasts rejects a current same-team airing. Do not widen solely from endDate envelopes: captured ODI/T20 hints also span multiple dates. Obtain an authoritative format or validated multi-day/day-session signal, then add a failing regression and consider a five-day bound without reviving short-format ambiguity. The card remains available with honest missing data; no complete cricket-coverage claim. |
| SD-0313-L3 (low) | Open, pilot measurement required. fetchJson JSON.parse and normalize still run on the main thread: at most 12 fresh payloads x 2 MiB/tick, plus cached normalization. On a Mark-authorized pilot, compare flag-off/on event-loop delay, parse/normalize/ingest durations and bytes per tick while HLS is served. Use timing/size-only instrumentation (no URLs, payloads, tokens), record p95/p99/max HLS latency and CPU/heap, then decide whether collection parsing also needs a worker. No pilot or provider-consuming play was run here. |
