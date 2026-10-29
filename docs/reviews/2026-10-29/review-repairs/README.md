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
Production package inspection confirms `libmfx1` absent, `libvpl2=2023.3.0-1build1`, `libmfx-gen1.2=23.2.3-1`.
**0312** restores `libmfx1` explicitly alongside dispatcher and modern runtime. Actual Linux image/QSV encode acceptance
remains pending; no local Docker or Intel GPU is available. The runtime package regression fails before and passes after.

## 0311 relay repairs: M3 / M4 / L2; L3 answered

- M3: ordinary cold legs resolve with relayTimeline off, enabling it only after readiness. Planned replacements retain
  the pre-ready EOF behavior their caller handles. Regression simulates a pre-ready reconnect and fails before.
- M4: three renewal starts within a rolling minute exhaust the relay budget. Further renewal is disabled for the rest
  of that play; normal provider failover runs, quarantines the flapping candidate, and records `renewal-budget`. If no
  candidate can take over, existing normal failure closes the relay. The repeated-epoch regression fails before.
- L2: the switching/closed early return releases the supplied pin. Both paths are checked; the regression fails before.
- L3: no production change required. The existing resolve deadline removes a planned epoch that never becomes ready.
  The added integration test starts a real hung Node child, closes its stdin through the reconnect handler, waits out
  a 1.2 s resolve deadline, and checks the registry, subscription and saved child handle: all released/terminated.

A 45 s real-FFmpeg baseline flap rig published eight renewals. A 70 s budget run now reaches healthy ProvB after
three renewals plus one ordinary failover and remains at four switches beyond the one-minute window, with advancing
segments. `node scripts/relay-rig.js reconnect flap budget` asserts the final provider/maximum switch count; its fake
routing plan now respects real quarantine, matching production. Raw logs remain under ignored
`data/samples/2026-10-29-review/`; a compact after record is `relay-rig-after.txt`. The synthetic rig also emits a blank
observation on test-pattern playback; this does not establish device picture/sound acceptance.

0311 clean-snapshot gate: 1,279 tests pass, no skips/failures; build verification passes.
## 0312 tooling repair: L4

The validator now requires explicit flag/value pairs and rejects missing values or a following flag where a value is
expected. Negative numeric values and hyphenated option names are supported. It no longer silently skips later flags
by assuming every even index must be an option. The missing-value regression fails before (old validator accepts it)
and passes after. All media-toolchain unit tests and three real software quality encodes pass.

## Final dispositions

| Finding | Disposition |
|---|---|
| M1 | Fixed for watch audio in 0310; known AAC in finished MP4 already encoded. Profile-0 watch/final tests plus AVPlayer evidence. |
| L1 | Fixed in 0310: unknown audio also encodes; no skipped-bsf copy path. |
| M2 | Fixed recipe in 0312; actual image/legacy-QSV encode acceptance remains FR-26. Production currently selects VAAPI. |
| M3 | Fixed in 0311: cold failover enables renewal only after readiness. |
| M4 | Fixed in 0311: cumulative per-relay budget and normal failover; real 70 s flap rig passes. |
| L2 | Fixed in 0311: early-return pin release, switching and closed regressions. |
| L3 | Answered: existing resolve cleanup passes the added real hung-child integration test. |
| L4 | Fixed in 0312: malformed option pairs fail closed, regression fails before. |

## Validation / review / device steps

Full clean committed snapshots plus only each repair were used because another chat is modifying the shared dashboard
code/tests. The shared-tree first run had six in-progress dashboard failures; those changes were neither modified nor
committed here. Repair gates:

| Batch | Full server tests | Build verification |
|---|---:|---|
| 0310 recording | 1,275 passed | Passed |
| 0311 relay | 1,279 passed | Passed |
| 0312 toolchain | 1,281 passed | Passed |

No skips/failures in these snapshots. Profile-0 watch/final playback checks pass in macOS AVPlayer; this is not physical
Apple TV acceptance. Toolchain checks run three real software encodes. No Linux image was built and no production GPU
encode, setting change, provider connection, deploy or push was performed. Temporary loopback servers are stopped.
The optional runtime package must still pass Linux candidate CI, and host QSV execution is not proven by names/help.

Required Codex adversarial review remains pending (Claude's supplied review does not establish a completed Codex round).
The slash command is Mark's to type, per AGENTS.md. Limit this batch to two Codex rounds. In PigTV:

```text
/codex:adversarial-review --background --base 4d95f10 Review only the committed 0310–0312 repairs for Claude's 0307/0308 M1–M4 and L1–L4. Focus on AAC/unknown-probe audio safety, cold-leg readiness, cumulative renewal budgets and provider failover, pin/lease teardown, hung startup cleanup, legacy Intel runtime packaging and strict encoder option parsing. Read docs/reviews/2026-10-29/review-repairs/README.md. Exclude unrelated uncommitted sports-dashboard work. Report each original finding's disposition and any remaining high issue.
```

Return-to-reviewer prompt: [REVIEWER-PROMPT.txt](REVIEWER-PROMPT.txt).

After reviewer approval and Linux candidate CI:

1. Install the reviewed server build. On Apple TV, make a FOX segmented recording and watch it early/midway/near end;
   confirm picture/sound/advancing time, seek, and watch across final-MP4 completion. Record build/channel/time; device
   acceptance remains open even though synthetic profile-0 watch/final MP4 play on macOS.
2. On PassyFlix, inspect the new container for the legacy runtime (`dpkg-query -L libmfx1`). Run a synthetic two-second
   QSV encode without a provider or settings change: `docker exec PigTV ffmpeg -hide_banner -v error -f lavfi -i
   testsrc2=size=640x360:rate=25 -t 2 -c:v h264_qsv -f null -`. Capture success/failure; current auto recommendation
   remains VAAPI. A failed QSV check stays in FR-26; do not claim hardware acceptance from package/help checks.
3. Run the offline flap acceptance: `RIG_SECONDS=70 node scripts/relay-rig.js reconnect flap budget`. Expect three
   renewals then ordinary failover, at most four switches, and `RENEWAL BUDGET PASS` on healthy ProvB. For a controlled
   renewal-on device check, record reconnects, Status's renewal-budget event, provider transition and continuing playback;
   end/restart the play to reset the exhausted renewal budget. No device desync fix is claimed.
