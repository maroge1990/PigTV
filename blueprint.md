# PigTV server — handover (single source of truth)

**Last updated:** 19 September 2026
**Home in repo:** `C:\Users\markr\OneDrive\Documents\GitHub\PigTV Server\blueprint.md`

This is the authoritative handover for PigTV **server / webapp** work. It
supersedes the two 16 September docs and all earlier chat notes. The deep
review — `C:\Users\markr\OneDrive\Documents\GitHub\PigTV Server\server-review.md` — stays the file:line reference
for the *why* behind each item. The Apple client has its own log (`HANDOVER.md`
in the Xcode project) and a separate agent; anything in §6 (frozen contract)
must not change without a coordinated client patch.

## Core Requirements and Guidelines
We are developing an IPTV Server, with supporting webapp and swift clients (iPad / AppleTV). The IPTV server and webapp are contained within this repository.
Wherever possible, we should ensure stream stability and quality, and reduce overhead and complexity
As progress is made, ensure the blueprint is up to date for handover

---

## 1. Orientation

| | |
|---|---|
| Repo | `github.com/maroge1990/PigTV` |
| Deployment | Unraid box "PassyFlix", image `ghcr.io/maroge1990/pigtv` |
| Local repo folder | `C:\Users\markr\OneDrive\Documents\GitHub\PigTV Server` |
| Patch folder | `C:\Users\markr\Downloads\patches` |
| Shipped through | **build 0054** (written, awaiting Mark's apply + deploy) |
| Next patch number | **0055** |
| Deep review | `server-review.md` (repo root) |

Don't hard-code the `origin/main` SHA anywhere — it advances as patches land.
The deployed build is whatever `/api/version` reports (§3).

---

## 2. How patches are delivered

Each change ships as a numbered `git format-patch` file, continuing the running
sequence. From a Claude Code session in the repo: commit the change on a local
`patch-NNNN-*` branch (never on `main`, never pushed), run
`git format-patch -1 --start-number N -o "C:\Users\markr\Downloads\patches"`,
and give a size sanity-note plus **both** command blocks below. Mark applies and
pushes; Claude does not push.

**Apply + push (PowerShell):**
```powershell
cd "C:\Users\markr\OneDrive\Documents\GitHub\PigTV Server"
git fetch origin
git checkout -B main origin/main
git am "$HOME\Downloads\patches\NNNN-<subject>.patch"   # one line per patch, in order
git push origin main
```

**Pull + recreate + verify (Unraid / Docker):**
```bash
docker pull ghcr.io/maroge1990/pigtv:latest
docker compose up -d --force-recreate pigtv     # recreate, not restart
curl -s http://192.168.1.235:3000/api/version      # confirm the build number
```

---

## 3. Version & build identity (the testing instrument)

`server/version.js` is the single source of truth: product semver
(`package.json`) + a **`build`** number equal to the last patch applied, bumped
by every patch *in its own diff* so the number can never lag the code.
`/api/version` and `/api/info` return it; the webapp's **top-left badge** shows
the `display` string (e.g. `v3.7.0 · build 0054`). Optional git SHA / build-time
can be stamped at image build via the Dockerfile `PIGTV_COMMIT` / `PIGTV_BUILT_AT`
args (inert if unset). Every functional patch also adds a `verify-build.sh` check.

---

## 4. Shipped log

**Prior agent (0033–0047):** `segmentedDelivery` HLS for the native client,
stream-token propagation to child segments, AAC-in-fMP4 fix, native
recording-playback contract (0045), HLS on-disk bounding (0046), EPG streaming
parser queue + backpressure (0047).
⚠️ **`-bsf:v dump_extra` was tried (0043) and reverted (0044)** for corrupting
live copy sessions — do **not** re-add it on any copy path. (It is still present
on the *remux* path — see §5 architectural notes.)

**Server-review session (0048–0054):**

| Patch | What |
|---|---|
| 0048 | Build identity surfaced (§3) |
| 0049 | Live-HLS `temp_file` + `hls_delete_threshold` (torn-playlist / rolled-out-segment stalls). Retry-directory fix deferred → §5 |
| 0050 | Auth gate (review P0-3): `requireAuth` on `/api/channels`, `/api/probe`; token on `/api/subtitle`, `resolve`, `DELETE /api/playback/:id`. `requireStreamAuth` default **unchanged** |
| 0051 | Dropped the dead `require('ffmpeg-static')` (startup-crash risk) from `proxy.js` |
| 0052 | Credential redaction in logs / `/sessions` / errors (both Xtream URL formats). Opaque-handle part deferred → §5 |
| 0053 | `db.json` in-memory write-through cache + `saveUninitialized:false` (MemoryStore leak) |
| 0054 | ffmpeg output-inactivity watchdog (A1) — see below |

**0054 detail.** New `server/services/stallWatchdog.js`: kills an ffmpeg that has
produced no media for `PIGTV_STALL_TIMEOUT_MS` (default **20 s**; 30 s grace
before the first output, and HLS keeps a floor of 5 segments). *Output* means
bytes on stdout for a remux, and any file written into the session directory
(segments, `.tmp`, playlist, init) for an HLS session — **not** stderr, which
gets louder during a reconnect loop. A stalled HLS session is removed from the
registry (so the coordinator stops counting it) and its dir cleaned; a stalled
remux is killed and its response ended. A remux whose stdout is paused because
the *client* isn't reading (`isPaused()` / `writableNeedDrain`) is **not**
treated as stalled. Idle accounting fixed in the same patch: a remux's `idleMs`
is now time since media last flowed (was time since start), and the
coordinator's remux `idleMs:0` special-case is gone. **Behaviour change to be
aware of:** a remux viewer paused for >60 s (`viewerIdleTimeoutSec`) is now
"stale" like an HLS viewer, so a due recording reclaims it silently instead of
prompting. The legacy piped `GET /api/transcode?url=` path has the same
reconnect flags but is *not* covered — it is superseded by sessions and slated
for deletion (P2-1). Recordings are not covered either (bounded by the
programme hard-stop timer). Tests: `test/stall-watchdog.test.js`,
`test/remux-watchdog.test.js` (POSIX only — skipped on Windows, runs in CI).
**Verification done on the dev machine:** `stall-watchdog.test.js` 8/8; full
`verify-build.sh` passes; the remux route was also run against *real* ffmpeg
(local HTTP upstream that sends TS then hangs; and an endless upstream with a
client that stops reading) — dead upstream reaped ~4 s after last data at a 3 s
limit, paused viewer not killed over 4× the limit, `idleMs` grew while paused,
stream resumed, no stray ffmpeg. **Dev-machine notes (Windows):**
`access.test.js` fails at import with `EPERM` on `symlink` (needs developer
mode / admin; pre-existing — with a junction it passes 9/9); `verify-build.sh`
needs a real `python3` on PATH (the Store stub won't do) and `PYTHONUTF8=1`.

**Post-deploy checks still owed by Mark:** badge reads **0054**; `docker logs`
shows redacted URLs (no provider password); on the real feed,
`SELECT COUNT(*) FROM epg_programs` matches the XMLTV `<programme` count (final
verification of 0047); 0054 live check (see the 0054 hand-off: cut the upstream
mid-stream and confirm the `treating ffmpeg as stalled` log line and that the
provider slot frees), plus confirm a *paused* web player is not killed.

---

## 5. Roadmap — in order

**Guiding direction (committed): one server path, one contract.** Converge on a
single server-side pipeline and a single delivery contract — HLS segments from
`playbackStrategy.resolve()` — with each platform running a thin native player
on top (hls.js / Safari-native HLS on the web, AVPlayer on Apple). *Not* one
player codebase (the runtimes differ); one **path**. The current two-path split
(remux for the web, HLS sessions for native) is the source of most recurring
defects — favourites ids, logo handling, the resolve response shape, reconnect
flags duplicated across files, the `dump_extra` fix that reached transcode but
not remux. Collapsing to one path means a fix lands once for everyone, the
the watchdog guards one thing (0054 had to wire it into both), and the remux
pipeline can eventually be deleted. This is not a rewrite:
`resolve()` is already the shared brain and the native client already runs this
path via `segmentedDelivery`, so convergence is mostly opting the webapp in.
**Sequencing matters:** harden the one path first (A1 watchdog, A3 arbitration,
self-heal), *then* move the webapp onto it (§C) — the last, low-drama step, not
a big-bang migration onto an un-hardened path. Everything in section A below is
that hardening.

### A. Do now (client-independent — build and test without the Swift client)

1. ✅ **0054 — ffmpeg output-inactivity watchdog** (written; pending live
   verification — see §4). Remux *and* HLS session paths; remux idle accounting
   folded in.
2. **Client-side remux retry (webapp).** *[MED, interim — ON HOLD per Mark]*
   Re-resolve on an unexpected remux end while live so playback self-heals. This
   hardens the remux path the guiding direction retires (§C), so keep it small —
   a stopgap worth doing only while the webapp→HLS move is still out. If §C
   lands soon, skip it: the migration *is* the webapp's recovery mechanism. Note
   0054 now ends a stalled remux's response, which is the event this retry would
   react to.
3. **P1-1 — viewer-vs-viewer arbitration + shorter live idle timeout.** *[HIGH]*
   Release a stale viewer before starting a new session; 409 a live one so the
   client can force through; drop `SESSION_TIMEOUT_MS` for live from 30 min to
   ~2 min. Fixes the "changed channel / app crashed while a session still holds
   the slot → unexplained timeout" case.
4. **P1-5 — atomic EPG swap.** *[MED]* Staging table / generation column so the
   guide isn't empty for minutes each sync; stop storing full programme JSON.
5. **P1-3 (server half) — favourites id normalisation + migration**, plus a
   derived `stable_id` so a provider reorder can't re-point favourites, history,
   or scheduled recordings. *[MED]*
6. **P2-1 — dead-code removal**, as one deliberate verify-build-guarded batch
   (`users.js`, `m3uXtreamAdapter.js`, JSON `hiddenItems`/`favorites`, OIDC +
   express-session remnants, VOD/series, non-VAAPI encoders, unread settings).
   *[MED — worth doing early; "edited a dead path" caused two prior incidents.]*
7. **P2-8 — tests for Apple-relevant paths.** *[MED]* parseStreaming under bursty
   input, `withStreamToken` on fMP4, recordings Range behaviour,
   viewer-already-holds-slot, favourites id mismatch.
8. **Pre-Tailscale hardening + refactors.** *[LOWER]* P2-2 shared helpers
   (`channelUrl`, `ffmpegProcess`, `probe`, `ids`); P2-3 guide indexes + bounds;
   P2-4 segment traversal + MIME; P2-5 `?token=` in the HLS *proxy* rewriter;
   P2-6 `TZ` + honoured UA for recordings; P2-7 rate-limit login/pair-poll +
   1 MB body cap + `USER node`.
9. **`requireStreamAuth` default flip.** Mark's call, before Tailscale exposure.

### B. Blocked on the Swift client (server code can be written ahead; verify/land with the client)

- **Version display in the Swift app** — fetch `/api/version`, show server build
  next to the app's own build.
- **0050 native gate — confirm** the client sends its bearer on `resolve` and
  `DELETE /api/playback/:id` (`?token=` is a fallback). Already shipped.
- **P1-2 — recording native playback.** Server fixes (`-tag:v hvc1`, in-flight
  remux dedupe, temp-file-then-rename, sidecar cleanup) are buildable now, but
  HEVC playback needs a device to confirm; the `202 {status:"preparing"}` part
  needs the client to poll instead of erroring on non-200.
- **P1-3 (client half)** — EPG-icon `logo` fallback in `/api/library/*` lets the
  client drop `loadArtworkIndex()` + its `/api/proxy/epg/{id}` download.
- **P1-4 (deferred half)** — `resolve` returns an opaque handle instead of a
  credentialed `?url=` (contract change both clients consume; log-redaction half
  shipped in 0052).
- **0049 retry-directory fix** — the software-decode retry clears the live dir a
  client may be mid-fetch on; validate on a device (fresh dir or
  `#EXT-X-DISCONTINUITY`).

### C. Converge the webapp onto the one path (committed — the last step, after hardening)

This is the endpoint of the guiding direction at the top of §5. It is a
**committed direction**, not an open question — what's deferred is only its
*timing* (after the path is hardened), not whether to do it.

- **Webapp → HLS sessions (`segmentedDelivery`).** Opt the webapp into the same
  `resolve → HLS session` path the native client already uses. Do it **after**
  A1 (watchdog), A3 (arbitration) and self-heal land, so the webapp inherits an
  already-good pipeline rather than migrating onto a fragile one. Known costs,
  accepted going in: slower channel-change (segment vs pipe), tmpfs disk vs
  zero-disk, more playback on hls.js / Safari-native HLS (browser variance), and
  a real migration/test surface. It does **not** by itself fix the upstream
  reconnect-hang — that's A1's job.
- **Then retire the remux pipeline:** delete the remux code, the `-bsf:v
  dump_extra` still on it (§4 warning), and the remux's watchdog wiring and idle
  accounting. Removing a whole delivery path is the payoff for converging.

---

## 6. Frozen Apple-client contract (do not change without a client patch)

- **`/api/library/guide`** rows: `id`, `sourceId`, `name`, `logo`, `category`,
  `tvgId`, `programmes[]` with `startTime`/`endTime` in **ms**.
- **`/api/recordings/{id}/markers`**: camelCase `startMs`/`endMs`.
- **`/api/recordings/{id}/playback`**: bearer header required; returns
  `{url:"/api/recordings/{id}/media.mp4", container:"mp4", durationSec}`.
  `media.mp4` takes `?token=`, supports byte ranges, `+faststart`.
- **Favourites:** client writes `POST/DELETE /api/favorites` (bare id), lists via
  `/api/library/favourites`.
- **`/api/version`** gaining `build`/`commit`/`display` is additive — safe.

---

## 7. Standing disciplines

- Every functional patch pairs with a `verify-build.sh` check.
- Each patch bumps `version.js` `build` to its own number, in its own diff.
- Nothing in §6 changes without a coordinated client patch; flag client-coupled
  changes in the handover.
- Deliver both command blocks together, with a size note per patch; the patch
  file goes to `C:\Users\markr\Downloads\patches` (§2). Claude commits only on a
  local `patch-NNNN-*` branch and never pushes.
- The two reference docs are `blueprint.md` and `server-review.md`, both in the
  repo root. Don't cite any other location for them.
- Say plainly when a patch's tests / `verify-build.sh` could not be run, and
  give Mark the live-test steps for anything that needs the real feed.
- **Update this doc at the end of each session** — it is the single source of truth.

---

## 8. Open questions

- **GHCR build mechanism** — GitHub Actions on push, or local `docker build`?
  Decides whether `commit`/`builtAt` auto-inject; the committed `build` number
  works either way.
- **Dead-code batch timing** — early deliberate batch (recommended) vs late.
- **`requireStreamAuth` flip timing** — tied to Tailscale exposure.
- **Stall timeout tuning** — 20 s default (`PIGTV_STALL_TIMEOUT_MS`) is a
  conservative guess for long-GOP sources; tighten only after watching the real
  feed's `[TranscodeSession]`/`[Remux]` stall logs for false positives.
