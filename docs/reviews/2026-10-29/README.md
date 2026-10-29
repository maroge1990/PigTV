# 29 Oct: exit flash and watch-while-recording

**Follow-up:** 0310–0312 repair the subsequent 0307/0308 review. The watch copy now encodes AAC rather than copying
its ADTS label; [current dispositions and reviewer prompt](review-repairs/README.md). The evidence below records 0308.

## Scope and evidence

Mark reports tvOS briefly showing “Tuning…” while exiting a live stream, and all attempts to watch an in-progress
recording failing on tvOS or remaining on “Loading recording…” on iOS. On 28 Oct he tested multiple live channels on
tvOS with timeline renewal **off** and found no A/V desync. Renewal-on testing is starting; no acceptance is claimed
for that configuration.

Read-only SSH confirmed server **0307 / f015373**. Recording #202 (Sky Sports Main Event, title Sky Sports News) had
already completed and its work folder was removed. A 32 s excerpt of its completed MP4 was used for initial
reproduction (preserved in ignored `data/samples/2026-10-29-rec202-first32s.ts`); it is processed evidence, not raw provider input. Stream doctor classified it EVEN, no packet jumps,
A/V start skew -13 ms. [Classification](recording-202-classify.txt).
SHA-256 of the excerpt: f3ab8ed5126e42947531de194ff780256213af35bb7c0d080140c2c18e809d72.

Mark then explicitly authorized a short new recording. Diagnostic schedule #18 / recording #203 used Sky Sports Main
Event on source 8, without force or takeover; no live viewer was active. It was bounded to 150 s, with no pre/post
buffer, and completed on its timer (157 s captured). Requesting its watch endpoint on deployed 0307 returned 200 with recording=true while its archive remained
open, but the watch follower had already emitted ENDLIST after **0.14 s**. The first three raw archive segments,
archive playlist and failed watch output are preserved locally in ignored
`data/samples/2026-10-29-rec203/e1/`. They remain separate from application source; the diagnostic recording also remains
on the server. Original archive segment hashes:

- a000000.ts: 15b1e8b2983270695df9d2f67ba97644ec66418e68c6d14a673bd5a4317bbd70
- a000001.ts: 8a4953d0297aecb96b4c0b749001258645063adc020fe934742f0788c870d4ba
- a000002.ts: 0dfe2c7983f4eaf7d2c0c7587c83269405f69d92bd3148a02ec3f9ee031cb2c8

Offline replay of the existing watch-copy arguments against recording #202 fails with:
`Malformed AAC bitstream detected: use the audio bitstream filter 'aac_adtstoasc'`.
It produces only 0.08 s. The error is emitted by the nested MP4 muxer: AAC from the TS archive still has ADTS headers.
The existing real-media regression uses HE-AAC and passes, so it did not cover this AAC-LC failure. A follower's aborted
output can contain ENDLIST; its presence alone therefore does not establish success.

## Repairs

Server **0308** explicitly applies `aac_adtstoasc` when copying AAC into the watch copy's fMP4. Video and audio remain
stream copies. The raw #203 segments replay successfully with HEVC hvc1 and AAC mp4a, all **12.5 s** represented:
[replay output](recording-203-fixed.txt). No timestamp/reconnect policy change.
At historical commit `a6e86e1` (0308), repeat with `node docs/reviews/2026-10-29/replay-recording.cjs` from the server root;
[before/after on the raw archive](raw-replay-before-after.txt).
The repaired raw excerpt also actually plays in macOS AVPlayer with an advancing clock over loopback HTTP:
[check](watch-avplayer.swift), [result](watch-avplayer.txt). This is not a tvOS/iOS device pass.

The new real-FFmpeg regression generates AAC-LC in TS, publishes an open archive in two stages, and verifies that the
follower remains alive, emits multiple segments, follows newly appended segments, and finishes at full length only
after the archive is sealed. [Fails before](aac-lc-before.txt); [passes after, including the existing HE-AAC test](aac-lc-after.txt).

Apple **58**: stopping previously cleared `ready` before the awaited server release, while AppModel keeps the player screen
presented until release completes. That makes PlayerScreen render its initial tuning branch again. The repair gives
the model an explicit published closing state and renders a black background throughout that state on both platforms.
The real-playback regression observes the transition while stopping a stream and verifies release still occurs.

## Validation and handoff

Both regressions fail before their repairs and pass after. Required gates pass:

| Check | Result |
|---|---|
| Node 24 full server suite | 1,245 passed, no failures/skips |
| `bash scripts/verify-build.sh .` | Passed |
| `sh Tools/test.sh push` | Exit 0: 243 contracts, 231 unit/playback tests, 17 UI regressions; no failures/skips |
| iOS simulator build | BUILD SUCCEEDED |
| Raw recording #203 replay in macOS AVPlayer | Advancing playback |

The initial Xcode launch stalled. Its delayed diagnostic cleanup interrupted the first UI run; all stale runners and
collectors were stopped before rerunning the complete gate. After all tests passed on the retry, Xcode's `simctl diagnose`
log collector also stalled; only that collector was terminated, then Xcode and `Tools/test.sh push` exited 0 with finalized
Passed result bundles. The simulator was shut down. [Apple validation record](apple-validation.txt).

Server **0308** and Apple **58** are local changes for Mark to review and push. Physical-device acceptance and required
adversarial reviews are pending. Production remains **0307**: no application patch, deployment, push or device install.
The authorized diagnostic recording #203 remains completed in the library.

Required adversarial review is pending. AGENTS.md specifies that Mark types these commands, once in each repo:

Server:
```text
/codex:adversarial-review --background --base f015373 Focus on 0308 watch-while-recording: AAC ADTS-to-ASC copying, growing and completed archives, HE-AAC compatibility, and the new real-media regression. Read docs/reviews/2026-10-29/README.md.
```

Apple (baseline `ee3a0fb`):
```text
/codex:adversarial-review --background --base ee3a0fb Focus on the live-player exit flash repair: closing-state publication before item teardown, tvOS/iOS screen rendering, release-before-switch, repeated stop and dismissal, and RealPlaybackTests.
```

After review and installation:

1. Confirm server build 0308 and the Apple build **58**.
2. Exit a playing live channel on tvOS and iOS, and cancel a tuning attempt: no “Tuning…” flash during exit; next play works.
3. Start a segmented recording; watch from start early, halfway through and near its end on tvOS and iOS. Confirm picture,
   sound and advancing playback, and seek within recorded content. The recording must continue.
4. Continue watching across recording completion, then reopen the finished recording.
5. Keep renewal-on A/V testing separate and report channel, approximate time, device/app build and whether a reconnect occurred.
