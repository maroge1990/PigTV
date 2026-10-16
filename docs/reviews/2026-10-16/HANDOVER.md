# Handover, 16 October 2026

For the next agent session. Read `AGENTS.md`, then `blueprint.md` (state line, §4, §5), then
[`ROADMAP.md`](ROADMAP.md) in this folder; it holds the plan, every finding and the progress notes.

## Workflow (changed today)

**Commit to `main`, never push.** Mark reviews and pushes. This is in both repos' `AGENTS.md`. Every functional server
commit bumps `server/version.js` and blueprint §1 "Next build number" (now **0223**); every Swift app change runs
`sh Tools/bump-build.sh` (now **46**). Tests that fail on the old code come with each change.

## What is committed and waiting for Mark to push

| Repo | Commits | Contents |
|---|---|---|
| PigTV | `bf6bd6a`…`HEAD` (`git log origin/main..main`) | 0208–0217 (Waves 1–3, see ROADMAP) · **Wave 4:** 0218 R3 segmented recordings (off by default) · 0219 R5 recording rules · 0220 R6 artwork · 0221 R9 events from event-slot names · 0222 R10 EPG auto-map · test and docs commits |
| PigTV-Swift | `3eff8cd`…`f8b98e4` | build 42 (Wave 1) · 43 (tvOS icon) · **44** watch from start (C-L) · **45** rules and artwork (C-M, C-N) |
| Pig-Branding | `f84d8cd` | kit 1.7.1: PigTV Apple TV icon option B |

Gates at the last run: server 968/968 and `verify-build.sh`; Swift contracts 243, unit tests, the regression UI tier (the
guide-grid navigation suite needed a rerun alone: it failed only while the server suite loaded the Mac), the iOS build.
Nothing is device-verified.

## Waiting on Mark

- Push, deploy, **Sync now**, then the device/feed checks: Waves 1–3 (the 16 Oct session summary) and Wave 4 (numbered in
  ROADMAP.md, "Wave 4 device and feed checks for Mark").
- **R3 capture:** the reference-feed recordings (HDR, 50 Hz, HE-AAC) through the new path were not run: this session's SSH to
  the server was refused by the permission check. Either Mark runs them, or a session with that permission does. Production's
  ffmpeg 6.x is also unmeasured for the R3 arguments (9.0 only). R3 stays off until then and Mark's test day.
- **Cricket (bug 5):** the real guide titles of the AUS v SA Test (findings in ROADMAP Wave 2).
- **iPhone tuning hang (bug 8):** the server log from when it happens (`streamCoordinator.js` `recordingsInPool`).
- Open decisions: web break markers on the scrub bar (keep?), backup retention 7 vs 14.

## Next: Wave 5, shared ingest (a separate project)

Wave 4 is done in code. Wave 5 (R2 shared ingest, then R7 inside it, then B4 retirements on evidence) starts with a
**written design note** (the 15 Oct review's corrections 3–5: identity, byte-capped buffers, slow consumers, late joins,
failover) and the full capture/bench pass on all five samples, which needs server access. Don't start it before Mark has
pushed and checked Waves 1–4 on devices.

## Gotchas met today

- Don't run the server suite and the Swift UI tier at the same time: under that load the guide-grid UI tests fail and a
  real-ffmpeg test once hung (fixed in `bee5ff4`). Run them one after the other.

- The tvOS/iPhone simulators can overload the MacBook (load average in the hundreds); then timing tests (e.g.
  `ChannelWarmerTests`, the sports speed budget) fail spuriously: rerun them alone, and shut simulators down after a run.
- `xcodebuild` can sit idle after a UI run has finished (collecting diagnostics); the results are already in the log.
- Xcode re-saves `project.pbxproj` with reordered lines: `git checkout` it after test runs, but not over an uncommitted
  build bump (re-run `bump-build.sh <n>`).
- In zsh, a `$VAR` holding several `-skip-testing:` arguments is not word-split.
- Some server tests copy only `server/` into a sandbox, without `package.json`: anything `getDb()` requires at open must
  be fail-safe (`version.js` needs `package.json`).
- The kit's release steps: change only the chosen product, revert other products' re-render noise, rebuild guide and
  package, `tools/verify.sh`; `tmp/` is git-ignored.
