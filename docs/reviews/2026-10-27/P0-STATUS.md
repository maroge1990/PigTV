# P0 implementation and checks, 28 Oct 2026

The P0 changes **0290–0294** and round-1 fixes **0295–0300** are pushed: at session pickup local `main` and `origin/main` matched
`58745fe` (application `974977f`). On 28 Oct Mark reported the latest build live; approved read-only SSH confirmed
**0300 (`58745fe`)**, container running/healthy, started 00:43:59 UTC (11:43:59 AEDT). Apple 57 remains the last reported installed version. No Apple code or ffmpeg flags changed. Next server build is 0302 (0301 is the separate local FR-17 repair below); next Apple build remains 58.
**Round 2 is complete: both permitted rounds used, no high findings. Review no longer blocks handoff.**
FR-15/FR-16/FR-18 remain open. FR-17 is repaired in the separate local 0301 batch below. Mark's device/feed acceptance is outstanding.

| Build | Local commit | Change | Required checks |
|---|---|---|---|
| 0290 | `caf39eb` | Shared ingest defaults on; explicit stored false survives reload | 1187 tests; build verifier passed |
| 0291 | `24deba6` | Unreferenced web scripts and server helpers removed; active admission coverage retained | 1187 tests; build verifier passed |
| 0292 | `7dc5f2b` | Stored per-provider/channel limits: 24 s, up 2 s on lag, max 28 s; down after 3 clean reading hours | 1193 tests on full rerun; build verifier passed |
| 0293 | `d182128` | Fox Cricket format titles, stage suffixes, daily Test live window | 1197 tests; build verifier passed |
| 0294 | `a16eb11` | Roster match-ups and overlapping MLB broadcast channels | 1200 tests; build verifier passed |

All suites use Node 24 with performance checks enabled. Regression tests fail with the corresponding source changes
removed and pass after restoration. Restoring the retired web scripts and server functions makes every new retirement
guard fail. Cricket evidence covers all 14 captured Fox rows, including a Mini wrongly flagged live; the existing day-three
case and later-day pre-play boundaries are retained. MLB evidence preserves mixed flags and the RDS/MLB 01 time differences,
including the unrelated titles that must stay out; a database-backed build test exercises the persisted roster path.

0292's first full run failed the sports cache-count assertion (`served from the cache`, 33 versus 32); its full rerun was
clean. FR-13's cache-test boundary hazard is reproduced and mitigated by pinned clocks in 0300 (details below); it is removed from the
open register. The earlier individual runs did not capture their clock boundary, so that historical attribution is not
claimed as established.

## Capture before the reconnect change

Mark approved read-only SSH access. The explicitly read-only SQLite capture selected only channel/provider labels,
times, durations, lag and reconnect counts: [0289 snapshot](feed-lag-0289-2026-10-28.json). Eight completed reads reached
5.1–15 s with zero reconnects. Combined with the 27 Oct soaks and FR-12's 24.1 s Chicago result, this supports a 24 s default
with exceptions learned per stable channel key and provider source. No provider stream was opened for this capture.

Learning counts measured live reading time, excludes reconnect/offline/no-PCR time, and observes peaks before catch-up
bursts. It saves progress each minute and on close, saves level changes immediately, and resets clean progress on lag or
less than 4 s headroom. A changed display name does not change the identity. The current limit travels through cached
playback analyses and recording starts. Feed lag history before 0292 lacks stable keys and remains separate legacy history.
The fixed ceiling is 28 s even if the configured default is higher; no-PCR silence detection retains its configured default.
In 0298, concurrent ingest URLs of one provider/channel share their learning state and count overlapping intervals once;
the last ingest releases the state, and Status reads do not retain it. The low display limitations remain FR-15/FR-16.

## Round 1 dispositions (confirmed by final round 2)

Reviewed baseline: `a16eb11`; reviewer passed 1200 tests and the build verifier. No deployed-server/provider access is
used for repairs. Source fixes are separately proved against that baseline before restoration and full gates.

| Finding | Disposition | Regression proof |
|---|---|---|
| 1 HIGH: city-only roster inference / first league wins | Fixed locally in **0295**: exact informative names/nicknames/stored abbreviations; each team and inferred league must be unique across all followed rosters | Both new precision/order and ambiguity tests fail on a16eb11; World Series/Fox fixtures and full gates pass after restoration |
| 2: Test session blocks | Fixed locally in **0296**: overlap an inferred daily eight-hour playing window, including day one, with pre-play grace; explicit live flag still qualifies in-span | New unflagged lunch/tea/delay test and changed overlap cases fail with a16eb11 source; restored Fox evidence/day-three tests and full gates pass |
| 3: ambiguous generic broadcasts | Fixed locally in **0297**: join only one overlapping league/kind event; none or several stays a show | New unequal-overlap, two-game MLB case fails with a16eb11 source; removing either game permits the join. Existing AFL/NFL/World Series cases and full gates pass |
| 4: concurrent limit writes | Fixed locally in **0298**: one retained active state per provider/channel; last ingest releases it, Status reads do not retain; overlapping reading time counts once | Two-open-state and two-real-local-URL regressions both fail with a16eb11 source; restored tests and full gates pass. Progress reload still tested after release |
| 5: configured default above ceiling / no-PCR display | Recorded as **FR-15** (allowed low-item disposition) | Reproduction retained in FINDINGS; warning/effective-limit display remains open |
| 6: legacy lag-history current limits | Recorded as **FR-16** (allowed low-item disposition) | Reproduction retained in FINDINGS; suppressing the legacy current-limit label remains open |
| 7: anonymous multi-provider ownership coverage | Added in **0299**; no admission behavior changed. Numbered as requested for each review fix | New multi-provider request/admission test passes on a16eb11 (already-correct code), fails with only `!owner` removed, and passes after guard restoration. Full gates pass |
| FR-13: cache-count wall-clock boundary | Mitigated in **0300**: pin Date in the non-perf and both perf cache-identity tests; performance.now remains real. Production cache behavior unchanged | On a16eb11, controlled 2 ms rollover reproduces all three original assertions (2 builds versus 1); restored pinned tests and full gates pass |

The four production fixes each fail with their source stashed back to a16eb11, then pass after restoration. Finding 7
is a coverage gap, not a defect in a16eb11: its guard-removal mutation proof is stated explicitly above. FR-13 is a test
clock fix: start Date at `Math.floor(NOW / (5 * M)) * 5 * M + 5 * M - 1`, then advance it 2 ms immediately after capturing
`const builds = svc.stats.builds`. All three original tests fail their unchanged cache-count assertions. This reproduces
the wall-clock-key mechanism; pinning only Date removes it without weakening the performance budgets or changing production.

| Repair build | Commit | Full Node 24 suite / build verifier |
|---|---|---|
| 0295 | `8985882` | 1202/1202, passed |
| 0296 | `8b325f2` | 1203/1203, passed |
| 0297 | `49bca3c` | 1204/1204, passed |
| 0298 | `5a3d4ef` | 1206/1206, passed |
| 0299 | `08a0d64` | 1207/1207, passed |
| 0300 | `974977f` | 1207/1207, passed |

## Final round 2: complete (two of two rounds used)

Mark returned the final review of `a16eb11..974977f`: **no high findings**, 1207/1207 tests and the build verifier passed.
No deployed-server/provider access or application changes were made to record its outcome. Review no longer blocks
handoff; medium/low findings are retained for Mark to prioritise, as AGENTS.md requires. No further review round is
requested for this batch, and no push or deployment is authorised by this handoff.

| Original finding | Reviewer-confirmed disposition at 974977f |
|---|---|
| 1 | Fixed in 0295: all eight counterexamples infer no league; World Series still MLB |
| 2 | Fixed in 0296: unflagged day-one/day-two lunch, tea and delayed-start blocks are live; 22:00 remains replay |
| 3 | Fixed in 0297: with two overlapping MLB games, generic MLB/MLB Baseball stay shows; see the separate zero-candidate regression FR-17 |
| 4 | Fixed in 0298: second-reader close retains 26000; overlap counts once; near-limit reading resets the shared window; after last release Status reads stored state |
| 5, 6 | Still open as FR-15 and FR-16, with reproductions in FINDINGS |
| 7 | Covered in 0299 |
| FR-13 | Mitigated by pinned clocks in 0300; cause of the historical failures remains unproven |

| New finding | Stopping-rule disposition |
|---|---|
| FR-17 MEDIUM (demonstrated) | At final P0 review: regression relative to 0289, introduced in 0297; no-overlap category/sport-channel generics become shows and disappear from Sports/rules. Subsequently approved and repaired in the separate 0301 batch below. |
| FR-18 MEDIUM-LOW (classification demonstrated, real-guide frequency hypothetical) | Recorded with ESPN-shaped NFL roster and nickname-only reproductions in FINDINGS. Cross-code nicknames may infer NFL when another code is not followed. Mark to prioritise; **not applied**. |

FR-17's proposed guard restores the pre-0297 zero-candidate behavior for category/sport-channel recognition while keeping
several overlapping games ambiguous and keeping keyword-only/no-event titles as shows. Mark approved the separate repair batch below; both P0 rounds remain used. The final P0 build is **0300**.

## Device/feed checks after review and Mark's deployment

1. Force Update PigTV on Unraid, then confirm `/api/version` reports **0300**. Check Settings → Playback: a stored off
   choice remains off; shared ingest is on for a fresh install.
2. After a normal play lasting at least a minute closes, open Status → Show details → Feed lag. New identity-backed rows
   show the current limit beside worst lag, initially 24 s. Check the provider/channel labels and usual playback.
3. During normal viewing, if a channel has a lag reconnect, confirm its limit rises to 26 s, then at most 28 s; a later
   play and a redeploy retain the learned level. Do not force a provider outage to test this.
4. After about three hours of reading that pair with worst lag at least 4 s under its level, confirm a 2 s drop. Downtime
   earns no credit; a reconnect for lag resets the window. Repeat at the lower level if needed.
5. During the next Test on Fox Cricket 501, check Sports and Settings → Sports preview: the day's play appears as an
   event throughout the daily playing window (including unflagged lunch/tea/delayed starts), overnight Test blocks
   as replays, and Mini/Classic/ODI replay blocks stay out of live events.
6. During the next MLB game, confirm one Sports event includes FOX affiliates, Sportsnet, AFN, team channels and the
   overlapping MLB broadcasts. Climbing highlights, Dodgermentary and World Series in 30 must not join it. Roster-only
   recognition requires the league to be followed and its ESPN roster to be stored. If several games overlap, bare MLB
   broadcasts stay shows; city-only titles must not infer another sport's league.

Nothing above is device/feed Verified until Mark reports the result.

## Acceptance pickup, 28 Oct

- Local tree was clean; `git pull --rebase origin main` found it up to date. No commits remained unpushed.
- Mark reports the latest build live; no device behavior or feed result is implied by that deployment report.
- FR-17: two isolated Node 24 regression assertions in a temporary server copy both fail on 0300
  (`show` instead of `event`), independently covering guide-category and sport-channel recognition without named overlap.
  No fix or failing test was added to the application tree. Mark subsequently approved an isolated repair as a separate batch.
- FR-9: current source preserves the analyzed info in the memory cache; `heaac: true` permits copy even with a known
  HE-AAC profile. Apple's `fmt?` fallback explicitly requests `audioEncode`, which overrides copy. The change of log
  message on the cached retry does not prove the first probe missed HE-AAC. Initial decode failure remains unresolved.
  No tracked media sample was found locally; no provider connection or production bench was taken.
- Mark approved the isolated FR-17 repair below as the next code batch. FR-18 needs stored-guide frequency
  evidence before tightening aliases; FR-15/FR-16 remain display debts. FR-9 needs log/request correlation before a capture.
- Approved read-only SSH confirmed ffmpeg **6.1.1-3ubuntu5**. Bounded sanitized logs since this container start
  showed initialization and the completed pre-migration backup; no matching playback/reconnect/recording failure
  lines were present. This is a quiet startup observation, not a playback soak.
- Explicitly read-only SQLite inspection: `feed_lag_limits` exists and is empty. The eight saved lag reads predate
  deployment, total 8,205 reader-seconds (includes concurrent providers), worst lag 5.1–15 s, zero reconnects, all
  ended because nobody was watching. No evidence yet of 0300 learning, persistence or clean-hour decay.
- Stored `epg_live` retains Fox Cricket day/session/live flags, overnight Test blocks and the incorrectly live-flagged
  Mini; World Series rows retain mixed flags and differently timed named/generic broadcasts. Raw-guide channel counts
  include hidden/unmapped rows and are not acceptance of the visible Sports grouping. The bounded FR-18 nickname
  query (Broncos/Titans and Panthers/Raiders in either order) returned none; other collisions remain unchecked.
- Stored archive flags: source 6 has 2,676 channels with 2–3 days, source 7 has 2,194 with 1–7 days, source 8 has
  978 with 3–7 days. This closes the question whether stored catch-up flags exist, not whether catch-up playback works.
- Recording work and transcode cache directories are empty; cleanup journal and recordings table are empty.
  Scheduled history has 12 completed, 3 cancelled and one old failed schedule (September), not a new startup failure.
  Appdata has about 86.9 GiB free, recording share about 2,274.7 GiB; transcode tmpfs is empty with 2 GiB free.
- The 28 Oct pre-migration backup exists (224,190,464 bytes). Older `.partial-shm` (32 KiB) and zero-byte
  `.partial-wal` backup sidecars remain from 20–26 Oct. No cleanup performed; restore integrity was not tested.
- Existing production samples remain, including historic HE-AAC samples `pos_1164.ts`/`pos_1165.ts` and 27 Oct
  captures. Only names/sizes/dates were inspected; identity and codec contents were not re-probed. Any production
  bench needs its own CPU window; no fresh capture is justified before correlating FR-9's fallback.
- Device acceptance remains pending the numbered steps above, plus recording/iPhone same/different-channel
  playback and segmented watch-from-start/seek/final-publication checks. Restart, takeover and share-loss tests
  need separate approval. No provider stream, bench, sync, recording, restart or production change was initiated.

## Separate FR-17 repair: 0301 (28 Oct)

Mark approved this isolated batch after deployment of 0300. The two P0 review rounds remain complete; this repair
has a new scope and baseline **36a9135**, not a third P0 review round.

Generic listings recognised by guide category or sport channel remain events when no named event overlaps.
Exactly one candidate still absorbs the broadcast channel; multiple candidates still produce a show.
Keyword-only zero-candidate listings remain shows. C-I records the restored behavior.

Failing-before proof: in the 0300 scratch copy both independent category/channel assertions fail (`show` vs `event`).
The repository regression also fails before the source guard, and passes after it. Added controls cover one/two
candidates for both recognition paths; existing keyword-only and MLB ambiguity coverage remains.

Validation: Node 24 full suite **1209/1209**, no skips; `verify-build.sh` and `git diff --check` pass.
The diagnostic docs commit separately passed 1207/1207 and the verifier. Initial sandbox runs could not bind
local HTTP listeners (`EPERM`); the complete runs above used approved local execution.

Separate review still required before this batch is ready for handoff. Mark's command:

```text
/codex:adversarial-review --background --base 36a9135 Challenge only the 0301 FR-17 repair: zero-candidate category/sport-channel generic listings retain events; keyword-only listings stay shows; one-candidate merging and multi-candidate ambiguity remain intact; check C-I and recording-rule implications. No production/provider access.
```

After review and Mark's push/deploy, check a category/sport-channel generic live listing with no named overlap in
Sports and any applicable existing sport-rule schedules; confirm it remains eligible. With two overlapping named games, the
generic broadcast must remain a show; with exactly one, it must join only that game. No test recording is authorised.

## Additional read-only acceptance checks, 28 Oct

The deployed HTTP `/api/version` endpoint returned 200 with build **0300**, commit **58745fe**.
Explicitly read-only SQLite reads confirmed `sharedIngestEnabled=true` and `segmentedRecordings=true`.
No post-deployment `feed_lag` rows or learned limits were present at this check. These observations confirm
configuration and endpoint availability, not adaptive behavior or device playback. No provider connection was taken.

## Acceptance status, 28 Oct (later, 01:00–01:30 UTC)

Re-checked with approved read-only SSH. Production is **0300 (`58745fe`)**, built 00:10 UTC; the container started 00:43:59
UTC with 0 restarts and is healthy; ffmpeg is 6.1.1-3ubuntu5. Local `main` is three docs/0301 commits ahead of
`origin/main` (`36a9135`, `91a63ca`, `c93239a`); PigTV-Swift has none. Since the deploy there are no play, ingest,
relay or recording log lines, no `feed_lag` rows and no `feed_lag_limits` rows: nobody has watched yet.

| Check | Status | Evidence / reason |
|---|---|---|
| 1. 0300 live; shared ingest on; stored opt-out wins | **Production read-only complete** (version, stored settings) + automated | The opt-out case is covered by tests; there is no stored opt-out on Mark's server to observe |
| 2. Feed lag rows show the current limit | **Production read-only: rows present (01:07–01:23 UTC plays)**; the page display is not checked | 3 identity-backed `feed_lag` rows, e.g. FOX [Birmingham] `s429387`/Strong8K: 781 s, worst 24.6 s, 8 reconnects, 1 for lag |
| 3. 24→26→28 s on a lag reconnect; kept across a later play and a redeploy | **Raise and persistence observed read-only** (26 s); 28 s and survival across a redeploy pending | 01:20:19 `lost the stream (25s behind real time)` on Mark's play; `feed_lag_limits` then held `s429387`/8 at **26000 ms** with 64,951 ms clean after the raise. Not forced |
| 4. A 2 s drop after ~3 clean reading hours | **Pending: needs ≥3 h of reading at a raised level** | Automated only |
| 5. Fox Cricket daytime live, overnight replays | **Fails offline on production rows** | Day 2 Fox sessions (live-flagged) come out as replays (FR-20); overnight 01:00/04:00 blocks come out as live via a Sheffield Shield fixture (FR-19). Willow lists Day 2 live. `sports-replay/RESULTS.md` |
| 6. MLB carrying channels; recaps excluded | **Passes offline on production rows** (0300 and 0301) | One event, 45 channels (affiliates, Sportsnet, AFN, team channels, TNT/ESPN broadcasts); recaps out. Device display pending |
| FR-17 (0301) | **Automated/local complete**; separate review pending | Round-2 synthetic case repaired; 0300 and 0301 identical on production rows (no category generics there) |
| Roster inference on the real guide | **New defect (FR-21)** | A live EFL Cup game is listed as an EPL replay, a regression from 0289 even with "EFL Cup" followed; AFL CAR v BRI tagged FA Cup |
| FR-9 HE-AAC first-start failure | **Cause established offline; fixed locally in 0302** (review and device check pending) | FOX feeds label HE-AAC as AAC Main in every ADTS header; the copied ASC (object type 1) is refused by Apple. 0302 reads the label in the probe and re-encodes; 0303 fixes Codex round 1 (label per PID for the mapped track; headers split across TS packets reassembled). `avsync-repro/README.md` |
| iPhone same/different-channel playback while recording | **Pending: device** | Needs exact timestamps for log correlation |
| Segmented recording watch-from-start, seek, publication | **Pending: device + a recording** | No recording started under read-only scope |
| Catch-up playback | **Pending: provider connection** | Stored archive flags only |
| Restart, takeover, share loss | **Pending: separate approval** | |
| Long-play freeze (FR-10) | **Pending: recurrence** | Note time and channel; an Xcode main-thread backtrace if possible |

**Prioritised next action:** a small sport-recognition repair batch for **FR-20, FR-19 and FR-21**, in that order. Each is
reproduced on stored production rows with `sports-replay/replay.js`; the fix and its tests come from those rows. FR-20
decides whether Fox Cricket 501 shows the Test live; FR-21 hides live cup games. These are not P0 rounds; they need their
own approval and review. Meanwhile Mark's 0301 review runs as planned.
