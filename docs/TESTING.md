# Testing

The protocol for both repos: which tier proves what, who runs it, and the tools. Commands are in
[`../AGENTS.md`](../AGENTS.md); the Apple client's suites and fixtures are in its own `TESTING.md`.

## Tiers and who runs them

| Tier | What | Who | Required for |
|---|---|---|---|
| T1 Automated | `npm test`, `verify-build.sh`; Apple `Tools/test.sh fast` per commit, `push` per batch, iOS build | Claude | Every functional commit |
| T2 Real media, offline | ffmpeg fixture tests, relay rig, stream doctor and avsync harness on saved captures, AVPlayer over loopback | Claude | Any change to playback, recording or ingest |
| T3 End to end | Server against the fake provider; web app driven in the browser pane; the real Apple app in tvOS and iOS simulators against that server; before/after screenshots of every changed screen as evidence | Claude | Any change a user can see or touch, **once the test rig is live** |
| T4 Deployed, read-only | `/api/version`, health, logs; no provider connection | Claude | Diagnosing a live report |
| T5 Device and real feed | Physical Apple TV / iPad / iPhone; real provider over time; A/V sync, picture, how the remote feels; deploy | Mark | Anything labelled `needs-device-test` |

- **T3 is active once the Unraid test rig is live** (#73). It needs the fake provider (built: [`FAKE-PROVIDER.md`](FAKE-PROVIDER.md))
  and the Unraid test containers. Until both exist, UI acceptance stays with Mark, and handoffs say which T3 checks could
  not run.
- **Machines:** this Mac runs Claude, Xcode and one simulator at a time. Heavy work (fake provider, staging server, full
  test runs, real-media tests) runs in CPU-capped containers on the Unraid server (≤ 3 cores, low priority, ≤ 6 GB,
  ≤ 20 GB under `appdata/pigtv-test`). Claude may create, rebuild and remove those test containers and read production
  status; anything that changes the production container or opens a real provider connection still needs Mark's yes.
- **Status words:** *Implemented* (code done) → *Locally verified* (T1–T3 pass, evidence linked) → *Verified* (Mark's T5
  report). Claude never writes *Verified*. An issue closes at *Locally verified* unless its acceptance names T5 (D-38).
- **Claude's default is to test, not to ask.** T1–T3 touch no real provider, so Claude runs them without asking,
  including driving the simulators (attach, screenshots, input).
- **Mark's checklist** in each handoff lists only T5 items: numbered steps, each with the expected result and what to
  report (app build, server build, device, channel, approximate time).
- Every functional change has a test that **fails on the old code**; show it. An acceptance line in an issue names the
  tier that proves the fix.

## T5: device checks

For a device run, note the app build (Settings → Version), the server build (`/api/version`), the device and OS, and for
a fault the channel and roughly when; keep provider URLs and tokens out of anything shared. On-device diagnostics:
Settings → Diagnostics (tvOS, the Top Shelf), and Console on the Mac filtered to subsystem `au.markrogers.PigTV.TopShelf`.
Checks no simulator can settle carry the `needs-device-test` label. Until TestFlight, Claude installs a build on Mark's
device with the Apple repo's `Tools/install-device.sh`, run in the desktop app's Terminal panel so Mark types the Mac
password there (its `AGENTS.md` › Installing on Mark's devices).

## Evidence

Small text evidence only, in `docs/evidence/YYYY-MM-DD-slug/`: before/after outputs, summaries, screenshots. Written once,
linked from an issue or commit. The repos are public: raw captures, media, full logs and anything naming provider
internals stay out of Git (local disk or the Unraid test share), referenced by path and SHA-256 in the folder's README.

## Tools

- **Stream doctor** (`scripts/stream-doctor.js`): capture, classify and bench a real channel. Reach for it first on any
  playback fault; how to use it is in [`architecture/playback.md`](architecture/playback.md) › Diagnosing playback.
  `capture` and `probecost` take the provider connection (Mark's yes).
- **Relay rig** (`scripts/relay-rig.js`): in-stream recovery, the standby and reconnects against real ffmpeg in a sandbox
  copy of the server (stall, flap and reconnect scenarios); paces a sample through `pace-pcr.js` from the A/V harness
  folder below.
- **Fake provider** (`scripts/fake-provider.js`): an Xtream look-alike with test-pattern streams, failure channels and a
  backup profile. See [`FAKE-PROVIDER.md`](FAKE-PROVIDER.md).
- **Playback report** (`scripts/playback-report.js <saved log>`): first-picture time, client wait, stalls per hour and
  failures from a server log.
- **Fixtures:** `test/fixtures/` (the HE-AAC fixture's note is
  [`../test/fixtures/synthetic-heaac.README.md`](../test/fixtures/synthetic-heaac.README.md); the sport guide export is
  `sports-export.json`, Mark's 25 Sept titles plus later real rows).

### A/V sync harness

From [`evidence/2026-10-28-avsync-start-repro/`](evidence/2026-10-28-avsync-start-repro/README.md), where the scripts live:

A synthetic live feed through the production session's exact ffmpeg command, into a local AVPlayer set up like the
Apple app (`configuredTimeOffsetFromLive` 30 s). No server, provider or device is involved.

1. Make a feed: `ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=60000/1001 -f lavfi -i sine=... -c:v libx264
   -profile:v high -level 4.2 -g 120 -bf 3 -c:a aac -f mpegts -muxrate 7000000 src.ts` (240 s; keyframes every 2.002 s).
2. Build the harness: `swiftc -O -swift-version 5 avsync.swift -o avsync`. Serve `www/` on 127.0.0.1:8899 with
   `python3 -m http.server`.
3. Run: `BURST=<head start s> ./run.sh <name> <start byte> [encode]`. `pace.js` sends the feed from that byte at its mux
   rate after the head start; `session.sh` is the 0300 session command from the 28 Oct log; the player starts when
   segment 0 exists, as the server answers.

### Sports replay

`replay.js` in [`evidence/2026-10-28-sports-replay/`](evidence/2026-10-28-sports-replay/RESULTS.md) runs the Sports build
offline on a read-only export of production guide rows:

**What this is:** the Sports build (`sportsEvents.buildEvents`) run offline, in throwaway copies of the server, on rows
exported read-only from production at 01:03 UTC on 28 Oct (`export.js`). The export covers 1,248 visible channels
(sibling backups excluded), 1 EPG mapping, 74,456 guide rows (26–30 Oct), the follow list, 128 stored ESPN fixtures and
10 stored rosters. No stream URL, credential or `provider_accounts` row was read or exported. No provider was contacted.
The export itself (1.1 MB) was kept out of the repo.

**How:** `git archive <ref> server package.json` into a scratch folder, then `node replay.js <copy> <from ISO>...`, run
in the copy's own `data/` (it fills a fresh SQLite there). The copies used were 0289 (`ed40bd1`), 0300 (`origin/main`,
deployed) and 0301 (local).

**What it shows and doesn't:** this is the server's output, before the Apple app or the web page draws it. Channel health,
logos and per-request time filtering are left out, and the ESPN fixtures are the ones stored at 00:44 UTC. This is not
device acceptance.

### Dual-provider capture

`dualcap.js` in [`evidence/2026-10-27-p0-batch/`](evidence/2026-10-27-p0-batch/) reads one channel from two providers at
once (no playback) and logs their pauses; run in the container as `node /tmp/dualcap.js 8 pos_90 660 60`. It takes two
provider connections: Mark's yes.

## Client contract checks

What the Apple client relies on, and how a change to it is tested, is in
[`CLIENT-CONTRACT.md`](CLIENT-CONTRACT.md) › 4. Testing client-visible changes. A new endpoint the client calls goes into
`APPLE_CLIENT_ROUTES` in `test/api-404.test.js`.

## CI and the media toolchain

1. Node 22 and 24 CI use the pinned pair, cached by recipe/hash, before running the full suite and build verifier. Performance reporting
   remains separate/non-blocking. The release tests run on Ubuntu 24.04 rather than moving `ubuntu-latest`.
2. The publish job builds **without pushing**, loads `pigtv:candidate`, verifies its actual binaries/capabilities and runs
   `npm test` inside that final runtime image as UID 99/GID 100. Only its data, transcode-cache and recordings paths are
   writable tmpfs mounts; `HOME=/tmp`, and the checked-out `.github` directory is read-only because it is excluded from
   the image. This validates test-user filesystem permissions as well as the final image. It does not start the server's
   main process as a separate smoke test; the container smoke checks binaries and capabilities.
3. Only after the candidate tests pass does the job tag and push **that same image**, with the existing metadata tags and
   build identity. It does not rebuild after validation. Container smoke also checks exact versions/capabilities.
4. Source archive hashes are checked by `build-media-tools.sh` whenever the source archive is consumed. A cache hit for
   the compiled tools skips compilation and does not independently validate source contents. The documented PGP
   signature was not verified. No local push or CI dispatch was performed. These new Linux build/runtime checks cannot be claimed passed until
   Mark's reviewed push runs them. A compiler, dependency, loader or codec regression fails closed before publication.

For local acceptance, keep the system tools at the pinned release, then run:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node scripts/check-media-tools.js
npm test
bash scripts/verify-build.sh .
```

The software check works on macOS; `--hardware` is for the Linux production recipe. `npm test` alone still permits
machines without ffmpeg to run non-media tests and skip media checks, so it is not sufficient to establish parity.
The npm fallback packages currently installed on this Mac contain ffmpeg **6.0** and ffprobe **4.4.1**; they are not the
acceptance tools. The server's existing preference for the system pair remains unchanged; the image always supplies it.

On an isolated Ubuntu 24.04 amd64 test machine, without touching deployed PigTV:

```bash
sudo bash docker/install-media-deps.sh build
bash docker/build-media-tools.sh /tmp/pigtv-media
export PATH="/tmp/pigtv-media/bin:$PATH"
node scripts/check-media-tools.js --hardware
npm test
```

`MEDIA_BUILD_JOBS` limits compile concurrency; `MEDIA_DOWNLOAD_DIR` retains verified source archives. These are exported
shell build knobs, not server settings; the scripts do not load `.env`. Use a new or empty absolute install prefix; existing directories are rejected before compilation/cleanup. Release bumps require updating the pins, repeating
media/device acceptance and reviewing the image change. Do not replace them with a moving PPA or download URL.

## Running tests on a busy Mac

- The server suite's timing tests and speed budgets fail when the Mac is busy with other work (load 40–70 on 17 Oct):
  rerun the failures alone, and use `PIGTV_SKIP_PERF=1` (CI's gate) for the full run.
- Don't run the server suite and the Swift UI tier at the same time: under that load the guide-grid UI tests fail and a
  real-ffmpeg test once hung (fixed in `bee5ff4`). Run them one after the other.

- The tvOS/iPhone simulators can overload the MacBook (load average in the hundreds); then timing tests (e.g.
  `ChannelWarmerTests`, the sports speed budget) fail spuriously: rerun them alone, and shut simulators down after a run.
- `xcodebuild` can sit idle after a UI run has finished (collecting diagnostics); the results are already in the log.
- Xcode re-saves `project.pbxproj` with reordered lines: `git checkout` it after test runs, but not over an uncommitted

- CI runs every test file at once on 2 vCPUs: keep timing margins ≥ 1 s, or poll. Flaky tests are tracked in #77.
