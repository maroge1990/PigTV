# Handover, 16 October 2026

For the next agent session. Read `AGENTS.md`, then `blueprint.md` (state line, §4, §5), then
[`ROADMAP.md`](ROADMAP.md) in this folder; it holds the plan, every finding and the progress notes.

## Workflow (changed today)

**Commit to `main`, never push.** Mark reviews and pushes. This is in both repos' `AGENTS.md`. Every functional server
commit bumps `server/version.js` and blueprint §1 "Next build number" (now **0218**); every Swift app change runs
`sh Tools/bump-build.sh` (now **43**). Tests that fail on the old code come with each change.

## What is committed and waiting for Mark to push

| Repo | Commits | Contents |
|---|---|---|
| PigTV | `bf6bd6a`…`f3a980c` + this handover (17) | 0208 Unraid icon labels · 0209 web guide/Home/Back fixes · 0210 keyboard access · 0211 visible-only guide refresh · 0212 accent favourites, AU copy · 0213 DB backups · 0214 recording end follows the guide · 0215 webhook · 0216 catch-up flag on Status · 0217 groups never imported (pilot) · test-port fix · docs |
| PigTV-Swift | `3eff8cd`, `78eb3dd`, `a6482af` | build 42 (one page header, iPhone category refresh, no "cancelled" errors, tuning hint, Recordings refresh, break list removed) · build 43 (larger tvOS icon) |
| Pig-Branding | `f84d8cd` | kit 1.7.1: PigTV Apple TV icon option B |

Gates at the last run: server 940/940, `verify-build.sh`, Swift contracts 224, unit tests, regression UI tier 14/14,
iOS build, `TopShelfCardsUITests`, kit `tools/verify.sh`. Nothing is device-verified.

## Waiting on Mark

- Push, deploy, and the device/feed checks listed in the 16 Oct session summary (first start should log a
  `pre-migration` backup; webhook "Send a test"; iPhone category switching; headers; tvOS Home hero; new icon).
- **Cricket (bug 5):** the real guide titles of the AUS v SA Test. Probe findings are in ROADMAP Wave 2 (Day 2+ classed a
  replay without an ESPN fixture; untagged free-to-air airing unrecognised; "Proteas" not merged). Fixture first.
- **iPhone tuning hang (bug 8):** the server log from when it happens; suspected `recordingsInPool` provider attribution
  (`streamCoordinator.js:497`).
- Open decisions: web break markers on the scrub bar (keep?), backup retention 7 vs 14.

## Next: Wave 4, starting with R3 segmented recordings (approved 16 Oct)

The full brief, with Mark's six answers and the shape of the work, is in ROADMAP.md, "Wave 4". In short: HLS event
playlist in appdata, append across restart/failover, remux to the K12 MP4 and move it to the share at the end; a
"watch from start while recording" route plus Apple client action (additive contract + `APPLE_CLIENT_ROUTES`); behind a
Settings switch, off by default; tests first, then the reference-sample capture, then Mark's test day. Provider use for
test recordings is approved. After R3: R5 rules, R6 artwork, R9, R10.

## Gotchas met today

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
