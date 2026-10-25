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
| FR-6 | 26 Oct | Apple tab-switch gate | The gate now fails a switch only when it stalls on both laps (`63809e4`). The budget stays 500 ms; the 250 ms Apple TV target is still checked by hand with Instruments. | Lower the simulator budget only after a clean device measurement shows headroom. |

Also open, tracked in `blueprint.md`: bugs 5 (AUS v SA grouping) and 8 (iPhone tuning) without a root cause, the deferred
and unmeasured efficiency register, physical device and real-feed acceptance, and the roadmap items waiting on Mark (R8's
sync measurement, the E3 samples' location, B4 after a week of shared ingest).
