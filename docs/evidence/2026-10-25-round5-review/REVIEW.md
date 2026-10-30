# Independent review of round4 repairs and accepted F4 policy

25 October 2026. Server reviewed newest first at **0259 `230118c`**, against **0255 `93583f6`**; Apple **54 `79b67f9`** (functional `24d76e1`) against **53 `4585b14`**. Read both AGENTS and round4/REPAIR-STATUS before review. The status is an author claim; results below are independently obtained.

**The direct round4 regressions are repaired, but broader publication/cache intent and the accepted F4 policy remain incomplete. Five P2 findings are reproduced.** One F4 case is a new0259 regression. No remaining P1 is established in this pass. The accepted policy does not need approval again; its implementation needs correction.

## Findings

| ID | Priority | Reproduced outcome | Classification |
|---|---|---|---|
| R5-F1 | P2 | Cancel+2h, unambiguous move+6h, then guide+6h/+10h: historical hit suppresses+6h even though current pairing is ambiguous and policy requires recording it. | Missed policy path, pre-existing hit mechanism |
| R5-F2 | P2 | Episode1.4 remains+1h; new metadata-free airing+2h steals its schedule; only+2h remains recorded. | New0259 regression; passes0258 |
| R5-F3 | P2 | Stable channel moves pos_1→pos_2, airing moves20min: cancellation is recreated because pairing compares stored positions. | Uncovered input of new series-move policy |
| R5-D1 | P2 | Native preparation of fallbackTS, input opened before delete/output afterward: row deleted, late MP4 still published and left unlisted. | Missed downstream publication owner |
| R5-A1 | P2 | Prune lists2000B file, writer replaces with500B, removal subtracts cached2000B: count−1500. Next2000B write leaves actual2000/count500/cap1500, prune idle. | Remaining cached-file-size accounting defect |

Details, source locations, acceptance criteria and saved expected-correct/scheduling reproductions: [F4.md](F4.md), [DVR.md](DVR.md), [APPLE.md](APPLE.md). Local synthetic evidence only; none establishes a cause for original bugs5/8.

## Finding-by-finding disposition

| Change | Verdict | Independent result |
|---|---|---|
|0259 accepted F4 policy | **Partial / regressed in mixed episode case** |19 supplied tests pass; four changed-policy cases fail on parent, three controls pass both. Three additional regressions fail current; only mixed-episode case passes parent. |
|4e6cb33 sports-worker clock fix | **Analysis confirmed** | One-bucket-offset old test fails3≠2; corrected test passes with same offset. Test time/key mismatch, no product change. |
|4e6cb33 startup margin | **Reasonable improvement; original cause unproven** | Current targeted test passes; zero-extension mutation still fails. No independent reproduction of historical1.5s failure. CI 2-vCPU reliability not certified. |
|0258 R4-S1 | **Fixed locally in examined scope** | Four current regressions pass vs four parent behavioral failures; extra nested/mixed/valid-empty cases pass. |
|0257 R4-D2 | **Direct segmented paths fixed; overall partial** | Five current retirement/publication tests pass vs five parent failures; native-preparation owner remains outside retirement. |
|0256 R4-D1 | **Fixed locally** | Schema claim removed; reopening old interrupted row preserves foreign bytes. Recovery proves bytes/republishes or preserves ambiguity. Mark reports no pre0243 recordings. |
|Apple 54 A5-R2 | **Specific completion race fixed; overall A5 partial** | Current227unit tests pass; isolated old-condition mutation produces exactly one intended failure, guard passes. Fresh filesystem accounting still broken by prefetched URL size. |

## Independent required checks

- Node24 `PIGTV_SKIP_PERF=1 npm test` **run1:1103tests,1098pass,5skip,0fail**; **run2:1103tests,1096pass,5skip,2fail**. New failures: provider-failover deadline backup did not start; stream-relay directory still existed after50ms. Both files together subsequently **40/40pass**. The two repaired historical failing tests pass both full runs. One clean run does not make the gate repeatably clean.
- `bash scripts/verify-build.sh .`: **all checks pass**, exit0.
- Swift `sh Tools/test.sh push`: **243contracts pass;227unit tests pass;16regression UI tests,15pass/1fail**. Tab-switch budget577ms against500ms. Diagnostic collection later timed out; the assertion is real and remains a failed gate. No new regression attribution to cache changes is established.
- iOS simulator build: **pass**, exit0.
- Isolated Apple mutation: **2tests,1expectedfail/1pass**, exit65; locked-folder guard0.010394s versus current0.006752s. The reported92s guard duration is not reproduced. Native extracted-production guard is also fast on both conditions. A separate long simulator diagnostic collector was observed and stopped to finalize the result; that does not prove the cause of the author's92s measurement.

[CHECKS.md](CHECKS.md) has exact evidence, limitations and any focused UI retry outcome. Result JSON and focused parent/current logs are retained beside it. Old-code experiments used isolated copies with bounded runs; working application files were never replaced. No web focus code changed, so no fresh browser-focus run was needed or claimed.

## Contract, documentation and remaining scope

C-M now states the accepted intended heuristic and drops its former universal durable-cancellation claim. The documented “ambiguous games are recorded,” channel-scoped series identity and episode-key isolation are not yet achieved for R5-F1–F3. Fix code and extend regressions before treating the contract as fully implemented. Clarify eligible-edge ambiguity and stored-time movement limits in prose if needed; that clarification is not another policy approval request.

The repair status/blueprints correctly retain physical-device/feed acceptance, bug5 AUS v SA grouping, bug8 iPhone Tuning and the deferred/unmeasured efficiency register. Their closure claims for broad DVR-1/publication, A5 and F4 exceed this evidence. Updated blueprint review notes point here while preserving the dated author status as reviewed evidence.

No application changes, commits, pushes, deployment, provider connection or deployed-server access. Only review artifacts and blueprint status notes changed. Repair instructions: [HANDOFF-PROMPT.md](../../archive/reviews/2026-10-25/HANDOFF-PROMPT.md).
