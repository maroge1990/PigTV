# Round-1 approval follow-ups (29 Oct)

Mark reports **0310–0312 APPROVED, no high findings**, M1/L1/M2 recipe/M3/M4/L2/L4 fixed and L3 answered.
This is **round 1 of 2** per Mark's instruction. The supplied N1–N3 and low notes are live risks: production was
confirmed to have renewal=true and relay=true. Next is Mark's Codex round, base `4d95f10`; do not restart an unlimited
review cycle. After round two, only high findings block; keep medium/low reproductions in FINDINGS.md.

## 0314: N1 / N2

**N1 fixed:** if post-budget backup admission/start fails, attempt the pinned primary once, with renewal disabled,
through ordinary startCold admission, same-owner/takeover and resolve-deadline guards. An ended pin/closed relay does
not get this fallback. A successful restart records `renewal-primary-fallback`; normal failure still closes if the
primary cannot start. No force=true, extra automatic renewal, or provider connection outside existing shared ingest.
Both backup-admission refusal and backup-start failure regressions fail before and pass after.

Capture before patch: real-FFmpeg relay rig with `backup-full` (fixture admission refusal) closes on still-live ProvA,
three switches and 404 playlist, with exit 1 / RENEWAL BUDGET FAIL. After: 70 s on live ProvA, four switches (three
renewals plus one ordinary restart), renewal disabled, RENEWAL BUDGET PASS. Before/after records are in this folder;
full logs/media remain in ignored `data/samples/2026-10-29-followups/`. The rig now propagates its assertion exit code
instead of unconditionally exiting zero. This only corrects the diagnostic's status reporting.

**N2 fixed, Mark's explicit decision:** budget exhaustion quarantines the candidate channel only via quarantine(),
without noteFailure()/noteProviderFailure(). Its interruption record has providerReason=false. Two exhausted channels
on one provider no longer trip the provider-wide breaker; the regression fails before (provider down) and passes
after (provider up, both channels quarantined). Genuine start/provider failures still use existing failure policy.

**Low note (a) documented:** a follow-on operation after a short startup epoch counts toward the same three-per-minute
budget. The budget is per renewal operation; discard/retry work within an operation retains the existing 20 s bound.

## N3: captured, no timestamp patch; retained as FR-29 (medium)

The capture helper uses the real recordingSegments.viewArgs() unchanged to follow one archive epoch with a +5 s video
and audio timestamp jump at source content t=6. stream-doctor classify confirms one gap in each track. No discontinuity
or new epoch is inserted. FFmpeg completes successfully; macOS AVPlayer advances beyond the jump (media 12.07 s in
12.54 s wall time). Packet clocks (audio minus video):

| Measurement | Archive | Watch copy |
|---|---:|---:|
| Start skew | -21.333 ms | -42.667 ms |
| First post-jump packet skew | +16.000 ms | -2.667 ms |
| End skew | +10.667 ms | +10.666 ms |

Both tracks retain the five-second timestamp step. There is no five-second cumulative drift or follower abort in this
fixture. These are packet-clock measurements, not an audible hardware sync measurement. They do not establish safety
for backward/reset jumps, unequal track jumps, different discontinuity sizes or actual provider reconnect content.
No aresample, first_pts=0, or timestamp handling change is justified by this capture. FR-29 remains open with reproduction
and the next evidence needed, under the stopping rule; no silent dismissal or general A/V-sync claim.

Reproduce: `node docs/reviews/2026-10-29/review-repairs/round1-followups/watch-gap.cjs /private/tmp/pigtv-n3-watch-gap`.
Join its a*.ts pieces in numerical order, then `node scripts/stream-doctor.js classify <joined archive.ts>`.
`N3-clocks.json`, `N3-stream-doctor.txt` and `N3-avplayer.txt` hold results.

## Low note (b): FR-26 / FR-30

Authorized read-only check: /dev/dri/renderD128 exists; spawning lspci returns ENOENT. The current QSV detector runs
lspci through a shell pipeline, maps command failure to hasIntelGpu=false, and reports No Intel GPU found. This is not
proof that Mark's i5-9500T/UHD 630 lacks graphics. No detector/package/auto-selection change here: actual legacy-QSV
encode and detector behavior belong in FR-26 acceptance; the misleading detection is retained as low FR-30 with repro.

## Gates and next review

All **1,300** full server tests pass, no skips/failures; `bash scripts/verify-build.sh .` passes. These are current-main
checks including the separately committed sports review 0313. No Apple app code changed. No application deploy, push,
production encode, settings mutation or provider connection was performed. The only production call was the approved
read-only QSV-detection prerequisite check. Offline fixture HTTP server is stopped after the player check.

Next Codex command is in the parent README, updated through 0314. Review only playback/media commits 0310/0311/0312/0314,
excluding sports commits 0309/0313 and any uncommitted work. N3/FR-29 and FR-26/FR-30 remain explicitly open acceptance
or investigation items; medium/low findings do not silently disappear.
