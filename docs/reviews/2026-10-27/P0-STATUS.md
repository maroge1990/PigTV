# P0 implementation and checks, 28 Oct 2026

The five approved server changes and round-1 fixes **0295–0300** are local on `main`, **not pushed or deployed**. Server 0289 and Apple 57 remain the
reported deployed versions. No Apple code or ffmpeg flags changed. Next server build is 0301; next Apple build remains 58.
**Round 1 repairs are complete locally. Round 2 and Mark's device/feed acceptance are outstanding.**

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
clean. FR-13's cache-test boundary hazard is reproduced and fixed in 0300 (details below); it is removed from the
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

## Round 1 dispositions (one of two review rounds used)

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
| FR-13: cache-count wall-clock boundary | Fixed in **0300**: pin Date in the non-perf and both perf cache-identity tests; performance.now remains real. Production cache behavior unchanged | On a16eb11, controlled 2 ms rollover reproduces all three original assertions (2 builds versus 1); restored pinned tests and full gates pass |

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
| 0300 | Commit containing this update | 1207/1207, passed |

Round 2 is the final permitted review round. AGENTS.md requires Mark to type:

```text
/codex:adversarial-review --background --base a16eb11 Round 2 of the P0 batch: fixes for round 1 (roster matching precision across followed leagues, cricket daily live window incl. day 1 and session blocks, generic MLB broadcast joining only a single overlapping game, concurrent feed-lag limit writes, and the low items). Check the fixes and that 0290-0294's intent still holds.
```

After round 2 only high findings block; medium/low findings remain in `docs/FINDINGS.md` with reproduction steps. No push
is authorised by this handoff.

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
