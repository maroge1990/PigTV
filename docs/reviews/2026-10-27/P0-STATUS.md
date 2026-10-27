# P0 implementation and checks, 28 Oct 2026

The five approved server changes are local on `main`, **not pushed or deployed**. Server 0289 and Apple 57 remain the
reported deployed versions. No Apple code or ffmpeg flags changed. Next server build is 0297; next Apple build remains 58.
**Round 1 is back; fixes are in progress. Round 2 and Mark's device/feed acceptance are outstanding.**

| Build | Local commit | Change | Required checks |
|---|---|---|---|
| 0290 | `caf39eb` | Shared ingest defaults on; explicit stored false survives reload | 1187 tests; build verifier passed |
| 0291 | `24deba6` | Unreferenced web scripts and server helpers removed; active admission coverage retained | 1187 tests; build verifier passed |
| 0292 | `7dc5f2b` | Stored per-provider/channel limits: 24 s, up 2 s on lag, max 28 s; down after 3 clean reading hours | 1193 tests on full rerun; build verifier passed |
| 0293 | `d182128` | Fox Cricket format titles, stage suffixes, daily Test live window | 1197 tests; build verifier passed |
| 0294 | Commit containing this note | Roster match-ups and overlapping MLB broadcast channels | 1200 tests; build verifier passed |

All suites use Node 24 with performance checks enabled. Regression tests fail with the corresponding source changes
removed and pass after restoration. Restoring the retired web scripts and server functions makes every new retirement
guard fail. Cricket evidence covers all 14 captured Fox rows, including a Mini wrongly flagged live; the existing day-three
case and later-day pre-play boundaries are retained. MLB evidence preserves mixed flags and the RDS/MLB 01 time differences,
including the unrelated titles that must stay out; a database-backed build test exercises the persisted roster path.

0292's first full run failed the sports cache-count assertion (`served from the cache`, 33 versus 32); its full rerun was
clean. This recurrence is retained under FR-13 in `docs/FINDINGS.md`; its cause remains unestablished.

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

## Round 1 dispositions (one of two review rounds used)

Reviewed baseline: `a16eb11`; reviewer passed 1200 tests and the build verifier. No deployed-server/provider access is
used for repairs. Source fixes are separately proved against that baseline before restoration and full gates.

| Finding | Disposition | Regression proof |
|---|---|---|
| 1 HIGH: city-only roster inference / first league wins | Fixed locally in **0295**: exact informative names/nicknames/stored abbreviations; each team and inferred league must be unique across all followed rosters | Both new precision/order and ambiguity tests fail on a16eb11; World Series/Fox fixtures and full gates pass after restoration |
| 2: Test session blocks | Fixed locally in **0296**: overlap an inferred daily eight-hour playing window, including day one, with pre-play grace; explicit live flag still qualifies in-span | New unflagged lunch/tea/delay test and changed overlap cases fail with a16eb11 source; restored Fox evidence/day-three tests and full gates pass |
| 3: ambiguous generic broadcasts | Pending | Multiple overlapping MLB games required |
| 4: concurrent limit writes | Pending | Two open states required |
| 5: configured default above ceiling / no-PCR display | Pending disposition | See reviewer reproduction |
| 6: legacy lag-history current limits | Pending disposition | See reviewer reproduction |
| 7: anonymous multi-provider ownership coverage | Pending | Production guard is already correct at a16eb11; prove coverage by removing it |
| FR-13: cache-count wall-clock boundary | Pending | Controlled five-minute rollover reproduction required |

Round 2 is the final permitted review round. Its command and final validation will be recorded when repairs finish.
After round 2 only high findings block; medium/low findings remain in `docs/FINDINGS.md` with reproduction steps. No push
is authorised by this handoff.

## Device/feed checks after review and Mark's deployment

1. Force Update PigTV on Unraid, then confirm `/api/version` reports **0294**. Check Settings → Playback: a stored off
   choice remains off; shared ingest is on for a fresh install.
2. After a normal play lasting at least a minute closes, open Status → Show details → Feed lag. New identity-backed rows
   show the current limit beside worst lag, initially 24 s. Check the provider/channel labels and usual playback.
3. During normal viewing, if a channel has a lag reconnect, confirm its limit rises to 26 s, then at most 28 s; a later
   play and a redeploy retain the learned level. Do not force a provider outage to test this.
4. After about three hours of reading that pair with worst lag at least 4 s under its level, confirm a 2 s drop. Downtime
   earns no credit; a reconnect for lag resets the window. Repeat at the lower level if needed.
5. During the next Test on Fox Cricket 501, check Sports and Settings → Sports preview: the day's play appears as an
   event, overnight Test blocks as replays, and Mini/Classic/ODI replay blocks stay out of live events.
6. During the next MLB game, confirm one Sports event includes FOX affiliates, Sportsnet, AFN, team channels and the
   overlapping MLB broadcasts. Climbing highlights, Dodgermentary and World Series in 30 must not join it. Roster-only
   recognition requires the league to be followed and its ESPN roster to be stored.

Nothing above is device/feed Verified until Mark reports the result.
