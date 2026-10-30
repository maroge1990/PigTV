# Service repair review — 24 October 2026

Scope: server 0247–0250 (`87f89de`, `11a3724`, `b61c91f`, `bd52998`) at current HEAD `bc92dfc`, against the original S4–S7 intent. Read AGENTS, blueprint, client contract, the user attachment and repair claims. No application changes, commits, provider/deployed-server contact. Fixture-backed local HTTP tests only.

| Finding | Verdict | Independently observed outcome |
|---|---|---|
| S4 | Fixed locally | Synthesized rows carry `channel_key`; `eventsFromProgrammes` joins these only to that slot. Ordinary XMLTV rows still join by TVG ID, preserving simulcasts. `buildEvents` carries the synthesized property into this join. Parent fails same-placeholder test; current passes. |
| S5 | Partial | Failed/malformed scoreboard days, failed paths and failed discovered series retain prior fixtures without renewing coverage. However malformed cricket **discovery** still becomes an authoritative empty result: see R-S5 below. |
| S6 | Fixed locally | Native fetch deadline remains active through body consumption, aborts the request and closes a stalled upstream. Conversion has its own kill deadline, with original-byte fallback. Default/full/640 paths use these owners. Independent stalled headers/body and hung-child checks pass. |
| S7 | Fixed locally | Admin status, manual and bulk mutation entry points compare sibling membership and invalidate revisions/assign numbers when it changes. Reviewed relink mutation path (existing membership invalidation) and source deletion caller (explicit revision bump after removal). Non-sibling decisions preserve the revision. Actual PUT route before/current test confirms outcome. |

## R-S5 — P2: malformed cricket discovery still erases fixtures and renews complete coverage

At `server/services/sportsFixturesEspn.js:173–183`, an HTTP-200 JSON value without a `scores` array becomes `{ok:true, series:[]}`. `server/services/sportsFixtures.js:296` then treats this as a legitimate successful empty league; lines 311–314 replace the stored fixture set and update full coverage and `last_success_at`.

This is the same unmet S5 intent—an incomplete provider answer must not become authoritative negative evidence—on the discovery stage rather than the repaired scoreboard stage. It predates 0248; it is **remaining coverage**, not a newly introduced regression. This review does not establish it as the root cause of the original AUS v SA report.

Independent reproduction: `service-discovery-repro.cjs`, using real saved cricket fixture shapes, isolated SQLite and an entirely mocked fetch. First a valid discovery stores one cricket game. The next discovery responds HTTP 200 `{}`. Current code deletes the known fixture (1 → 0) and advances coverage by 1 second. The script explicitly asserts the defective behavior; these assertions should be inverted/replaced for a regression test.

Run:

```sh
/opt/homebrew/opt/node@24/bin/node docs/reviews/2026-10-24/service-discovery-repro.cjs
```

Repair acceptance: validate discovery shape before treating it as empty; malformed discovery must preserve existing fixtures and prior success/coverage while reporting failure. Cover valid `scores: []` separately as a legitimate empty answer. Also ensure deliberately truncated discovery (the current 20-series cap) cannot claim complete coverage for omitted series. The cap issue was identified in source, not exercised in this reproduction.

## Independent before/after evidence

Each case uses `git archive <revision> server` in a fresh temporary directory with **current tests**, copied fixture/helper files and a symlink to existing dependencies. The live checkout is never rewritten. Node 24; `PIGTV_SKIP_PERF=1`; test timeouts enabled. Saved logs are beside this report.

| Test file | Old server revision | Before | Current |
|---|---|---|---|
| `event-channels.test.js` | `87f89de^` | 5 pass, 1 fail: Pittsburgh incorrectly listed on both slots | 6 pass |
| `sports-fixtures.test.js` | `11a3724^` | 21 pass, 4 fail, 1 perf skip: lost fixtures on partial days/paths/series | 25 pass, 1 perf skip |
| `logo-cache.test.js` | `b61c91f^` | Only `S6: headers` selected; both header-only and partial-body tests time out at 7 seconds | Full file: 8 pass, including hung conversion child killed |
| `channel-links.test.js` | `bd52998^` | 22 pass, 2 fail: unchanged guide version, followed by the documented cascading list failure | 24 pass |

Current total: **64 tests, 63 passed, one intentional performance skip**. These focused runs supplement, and do not replace, the lead's required full checks. The initial restricted S7 attempts failed with localhost `EPERM`; both were rerun with localhost permitted, and those successful infrastructure runs are the saved evidence. No fake conversion process was started in the old S6 run; current test confirms its child's PID no longer exists.

## Limits and handoff

No further confirmed S4/S6/S7 defect found in the examined ownership/mutation paths. Logo request coalescing remains a separate unstarted efficiency item; a bounded deadline does not imply one conversion per key or immediate cancellation when a browser disconnects. Existing relink early-return branches are not all wrapped in the new guard; the production source mutation callers were checked and no standalone user-visible failure was reproduced here.

`REPAIR-STATUS.md` correctly separates device/feed acceptance, bugs 5 and 8, efficiency work and F4 policy acceptance. Its S5 “Fixed” entry and blueprint's blanket “Every finding ... now has a local fix” need narrowing until R-S5 is repaired. Findings passing locally are not proof of production or device acceptance.
