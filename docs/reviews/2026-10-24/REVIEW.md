# Independent repair review — 24 October 2026

**The repairs improve their direct cases, but completion is overstated: seven reproducible defects remain across six original findings.** One is P1 data loss; six are P2. Required local suites pass. Passing suites do not establish device/feed acceptance.

Scope: newest repairs first, server 0242–0250 and documentation through `bc92dfc`, against 0241 `f026c63`; Apple 48–51, test/documentation corrections through `64f1258`, against 47 `ac7f186`. A1 also receives independent mutation evidence. This supplements the prior four-week review; unchanged earlier findings retain their previous dispositions rather than claiming a fresh exhaustive audit of every unchanged line. No application code changed, commits created, pushes, deployment, or provider/deployed-server contact.

## Finding-by-finding verdict

“Fixed locally” applies to the examined intent and local evidence, never physical-device acceptance.

| Item | Verdict | Outcome |
|---|---|---|
| F1 / DVR-1 original ownership | Partial | Exclusive publication and byte comparison fixed; deletion of a pending original can still remove foreign TS bytes. |
| F2 / DVR-1 restart recovery | Fixed locally | Moving state survives until retained original publication; restart retries. |
| F3 / DVR-4 failover ownership | Partial | Cancel/shutdown repaired; deletion during the same await can restart the deleted recording. |
| F4 / DVR-3 identity | Partial | Coexisting games and one-way moves improved; repeated correction and active prebuffer cases fail. Policy acceptance still outstanding. |
| F5 / W2 large-list focus | Fixed locally | Real browser retains late-group focus and uses adjacent header after removal; pre-0246 loses both to BODY. |
| S4 slot-derived programmes | Fixed locally | Slot provenance prevents cross-linking while ordinary simulcasts remain. |
| S5 incomplete fixture refresh | Partial | Scoreboard/day/path/series failure handling improved; malformed cricket discovery still erases fixtures and renews coverage. |
| S6 artwork deadlines | Fixed locally | Deadline covers response body; hung conversion child is killed. |
| S7 sibling invalidation | Fixed locally | Status/manual/bulk membership changes invalidate guide revision. |
| A1 scoped resume | Fixed locally | Scoped-key mutation fails; current tests pass. |
| A2 Top Shelf | Partial; new ordering defect | Retired saves rejected, but delayed unconditional clear can erase next session's publication. |
| A3 rule errors | Fixed locally | Observed error display, mutation serialization and stale-message clearing implemented; mutations fail. |
| A4 visible guide correction | Fixed locally | Same-shape cell refresh/layout works; no-refresh mutation fails. |
| A5 artwork disk cap | Partial; concurrency defect | Ordinary write pruning works; replacement/prune overlap undercounts disk use persistently. |

Other original IDs retain their locally addressed disposition from 23 October: I1, PB1–PB5, DVR-2, DVR-5, W1, S1–S3. Across the original 25-item register, this leaves **19 locally addressed and six partial** (DVR-1, DVR-3, DVR-4, S5, A2, A5), with physical acceptance separate. This tally includes earlier evidence, not 25 newly rerun investigations.

## Remaining defects, in repair order

| ID | Priority | Reproduction and consequence |
|---|---|---|
| D1 | P1 | Fail retained-original publication with a foreign conventional TS already present, then delete recording: foreign TS is deleted. Null `segment_original` does not prove legacy ownership. |
| D2 | P2 | Hold backup feed during immediate failover, delete recording, release feed: deleted recording starts again and late feed is retained. |
| D3 | P2 | Guide corrects A→B→A: previously hit identity bypasses reconciliation and schedule remains at B. |
| D4 | P2 | Already-recording prebuffer row with future nominal start absorbs later same-title event; no new recording is scheduled. |
| R-S5 | P2 | Cricket discovery returns HTTP 200 `{}`: existing game count drops 1→0 and complete coverage advances. |
| A2-R | P2 | Delay clear before queue enqueue, publish next session, then enqueue clear: current snapshot is erased, while `lastWritten` suppresses an identical repair export. |
| A5-R | P2 | Pause equal-size replacement after old-size read; prune removes old file; resume replacement: actual disk 2000 bytes, counted 1000, cap 1500, prune idle. |

Exact source locations, mechanism, acceptance criteria and evidence are in [DVR-REVIEW.md](DVR-REVIEW.md), [SERVICE-REVIEW.md](SERVICE-REVIEW.md), and [APPLE-REVIEW.md](APPLE-REVIEW.md). Reproductions are saved beside them. DVR/service scripts assert the current defective behavior; convert them into expected-correct regression tests. Apple race scripts use extracted production ownership/cache code with deterministic scheduling barriers, not a physical-device reproduction.

## Independent validation

- Server Node 24, `PIGTV_SKIP_PERF=1 npm test`: **1071 tests, 1066 passed, five skipped, zero failed**. `bash scripts/verify-build.sh .`: **all checks passed**. The request's trailing `..` was corrected to the actual repository root `.`. Summary: [server-check-results.txt](server-check-results.txt).
- Apple `sh Tools/test.sh push`: **243 contracts, 221 unit tests, 16 regression UI tests passed**. Inspected xcresult summaries. UI diagnostic collection timed out after tests; the results still show all 16 passed. iOS simulator build passed. Simulator shut down.
- Isolated Apple mutations: **six expected failures across A1–A5**; one old delete-error test still passed as expected. Current equivalents pass. [Mutation results](apple-mutation-results.json).
- Isolated DVR old-code sample: current **3/3 pass**, baseline **0/3** on behavioral assertions; focused F2/F3 current **4/4 pass**. Additional boundaries **8/8 assertions confirm described behavior**, including four defects and policy/guard cases.
- Services sampled against parents: current **63 passed / one perf skip**; old versions fail intended assertions or hit bounded S6 timeout. S7 has one cascading old-code failure, explicitly identified in the service report.
- Real-browser current/pre-0246 comparison: current late focus `late204` and removal fallback `header:Group203`; old both `BODY`. Earlier six harness checks unchanged. [Browser results](browser-focus-results.json).
- Restricted-run localhost/DerivedData permission errors were rerun with permitted access; they are not product defects. Old-code experiments used isolated copies and bounded execution, never replaced working checkout source.

## Policy, documentation and outstanding acceptance

F4 remains heuristic identity. Two vanished/two new instances pair one-to-one by nearest gap; this cannot prove they are the same real-world games. A cancelled slot outside the 72-hour candidate window can create a new recording. Series without episode metadata still recreates cancellation after a 20-minute correction. Explicit acceptance of the ambiguity policy or a stronger identity source is needed; approval would not excuse D3/D4. “No time window” is inaccurate.

The author's REPAIR-STATUS correctly keeps device/feed acceptance, bug 5 (AUS v SA), bug 8 (iPhone Tuning during recording), and efficiency work open. Its F1/DVR-1, F3/DVR-4, S5, A2/A5 closure claims exceed evidence. Both blueprints also overstate completion/cap guarantees. Current blueprint notes have been narrowed; the author's dated status remains preserved as the reviewed claim and is superseded by this report.

Neither original user-reported bug has a proven root cause. The cricket discovery defect is not proof of the AUS v SA cause. Local concurrency tests are not evidence that the iPhone Tuning report is resolved.

Unstarted efficiency work remains: archive accounting, media-job deadlines, rule input batching, concurrent Apple recording lists, guide window reuse, logo request coalescing, interval ingest throughput, warming/standby sharing. No new performance measurements or efficiency gains are claimed. A5 and S6 are correctness/resource-bound repairs, not proof that this backlog is complete.

Next: repair the seven defects, resolve/document identity policy boundaries, rerun regressions and required suites, then obtain device/feed evidence using the existing acceptance steps. [Prompt for the original agent](HANDOFF-PROMPT.md).
