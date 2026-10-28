# 0307 / 0308 review repairs (29 Oct)

Review supplied by Mark: Claude's M1–M4 and L1–L4; this does not count as a completed Codex round.
Baseline at pickup: 0309 `4d95f10` (the separate sports-dashboard foundation). No push/deployment.

## Recording audio: M1 / L1

The first retained archive segment of each existing FOX sample (`pos_1178.ts`, `.raw.ts`, `.long.ts`) was inspected
read-only with AdtsSniffer: PID 257, object type 2 (LC). These samples do not reproduce the Birmingham profile-0 label;
that older local capture path no longer exists. The prior real-feed diagnosis is documented in
`docs/reviews/2026-10-27/avsync-repro/README.md`.

A new regression changes only the ADTS profile bits of the existing synthetic HE-AAC fixture to 0, preserving payload.
It asserts object type 1 in the MPEG-TS archive. Before: the watch output copies object type 1 to ASC and macOS AVPlayer
refuses it with CoreMediaErrorDomain 1718449215 (`fmt?`). Unknown probe results also reproduce the mux abort.
See `before.txt` and `profile0-avplayer-before.txt`.

**0310 repair:** the watch copy follows the finished MP4 policy: only known AC-3/E-AC-3 is copied, other/unknown audio is encoded
as AAC-LC. This avoids trusting an AAC profile label and is safe for audio appearing after the probe. It also handles
profile/config changes during an epoch. Video remains copied, archives unchanged; no ADTS header rewriting. Unknown
finished-remux audio now uses the same safe encoding fallback. Known AAC in the finished remux already re-encoded
before this batch: that part of M1 is answered by code plus real-media coverage, not a newly discovered copy bug.

Both new regressions fail before and pass after. AAC-LC growing archive, HE-AAC/HEVC and native playback regressions
pass. The synthetic profile-0 watch copy and finished MP4 are checked with macOS AVPlayer; device acceptance remains open.

## Host evidence: M2

Mark identifies PassyFlix as an i5-9500T with no dedicated GPU and authorizes reading live settings. Read-only checks:
`hwEncoder=auto`, renewal=true, relay=true. The live hw-info endpoint reports recommended=vaapi, VAAPI available at
`/dev/dri/renderD128`, QSV unavailable (No Intel GPU found). No settings changed or encode/provider stream started.
Thus this is a compatibility defect, not an established active production QSV outage.

Intel's [dispatcher documentation](https://github.com/intel/libvpl) requires Media SDK for older graphics and lists the
newer GPU runtime for Iris Xe/newer. Retaining only VPL's dispatcher and modern GPU runtime loses the legacy path.
The runtime package repair and actual QSV encode acceptance remain pending in this record.

## Remaining findings

M3 (cold failover), M4 (cumulative renewal budget), L2 (queued pin), L3 (resolve cleanup), L4 (option parser) are being
reproduced/repaired. All require a disposition before handoff. `before.txt` captures failing-before tests for M3/M4/L2.
The real-FFmpeg baseline flap rig is preserved in `relay-rig-before.txt` (45 s, 8 published switches); no provider used.

## Validation / review / device steps

In progress. Concurrent dashboard modifications are kept outside this change. A shared-tree full run encountered six
in-progress dashboard failures; recording tests passed. Clean committed-snapshot validation is used for this repair.
Recording clean-snapshot validation: 1,275 tests pass (no skips/failures); build verification passes.
Required Codex adversarial review is pending; at most two rounds for this batch.
