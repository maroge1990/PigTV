> **Archived 23 September 2026. Superseded by [`blueprint.md`](../../blueprint.md)**, the current single source of truth
> for the server, the web app and the joint roadmap. Kept for history and file:line reasoning only; don't follow it as instructions.

# PigTV blueprint — archive (frozen snapshots)

> **Historical. Not maintained. Do not read this in normal work.** Two frozen copies of `blueprint.md`, kept because they
> record *how* each fault was found and measured, which is occasionally useful when the same area is touched again.
> Everything still true and worth knowing has been carried into the current `blueprint.md`. Anything here may be out of
> date - statuses, next steps, "pending" checks, file names - and the current `blueprint.md` wins.
>
> - **Snapshot 1** (below): build **0086**, 20 September 2026 - the full per-patch write-ups for 0048-0086.
> - **Snapshot 2** (at the end): build **0104**, 23 September 2026 - the condensed handover as it stood after the one-path work
>   (0087-0104: timestamp populations, stream-doctor, channel identity, HDR, the retirement of remux), before the 23 Sept refresh.

---

# PigTV server — handover (single source of truth)

**Last updated:** 20 September 2026
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
| Shipped through | **build 0086** (0054–0080 are on `main`; 0081–0086 written) |
| Next patch number | **0087** |
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
| 0055 | Viewer-vs-viewer arbitration + live idle timeout (A3) — see below |
| 0056 | Atomic EPG swap via generations (P1-5) — see below |
| 0057 | HLS segment route hardening (P2-4, traversal half) — see below |
| 0058 | `?token=` carried through the HLS *proxy* rewriter (P2-5) — see below |
| 0059 | Favourites id normalisation + migration (P1-3, server half) — see below |
| 0060 | Guide query bounds + item-id index (P2-3, partial) — see below |
| 0061 | Recording time zone + honoured User-Agent (P2-6) — see below |
| 0062 | Recording native-playback server fixes (P1-2, server half) — see below |
| 0063 | Body-size cap + rate limits on login and pairing (P2-7, partial) — see below |
| 0064 | Remux: reliable codec identification (fixes "Malformed AAC bitstream") — see below |
| 0065 | Web player reports media errors (client → `docker logs`) — see below |
| 0066 | Remux: AC-3 / E-AC-3 audio (`delay_moov`) — see below |
| 0067 | EPG-icon `logo` fallback in `/api/library/*` (P1-3, server half) + §C plan — see below |
| 0068 | Audio re-encode self-heal for the remux path (fixes the unreproduced web fault) — see below |
| 0069 | Fix: 0065 reported every channel change as a playback error — see below |
| 0070 | Diagnostics for silent "nothing plays" failures + remux start-up measurements — see below |
| 0071 | Quiet the probe-phase decoder chatter 0070 exposed — see below |
| 0072 | Fix: Hide All / Show All left the group checkboxes unchanged — see below |
| 0073 | Fix: A/V start-time skew made HLS sessions log a discontinuity per packet and drop audio — see below |
| 0074 | Housekeeping: `access.test.js` runs on Windows without admin; blueprint status refreshed — see below |
| 0075 | §C Phase 1: "HLS Delivery (beta)" toggle for the web player + `play-start` / `play-end` measurement — see below |
| 0076 | Dead-code batch (a): `users.js`, `m3uXtreamAdapter.js`, `hello.js` removed — see below |
| 0077 | Dead-code batch (b): OIDC/SSO and express-session removed, two dependencies dropped — see below |
| 0078 | Dead-code batch (c, part 1): JSON-file `hiddenItems` / `favorites` removed from `db.js` — see below |
| 0079 | Unknown `/api/*` paths return a JSON 404 instead of the web app + an Apple-client route guard test — see below |
| 0080 | A failed `db.json` write is reported to the caller instead of swallowed — see below |
| 0081 | `scripts/playback-report.js`: turns saved logs into the HLS-vs-remux trial report — see below |
| 0082 | Recordings waiting for a viewer are listed, cancellable and not duplicated — see below |
| 0083 | Recording playback can be polled (`?async=1` → 202 preparing) + `/api/info` capability flags + the Swift hand-off doc — see below |
| 0084 | The playback report keeps Apple-device plays apart from the web HLS trial — see below |
| 0085 | Stream-copy HLS sessions ignore the source's DTS (`igndts`) — uneven frame timing found in the HLS trial — see below |
| 0086 | A source that ends (a file served from the start) is read at real time in HLS sessions — the black-screen `fragLoadError 404` found in the HLS trial — see below |

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

**0055 detail.** `streamCoordinator.requestForViewer()` used to consider a
conflict only when a *recording* was active, so a second device (or the same
device after a crash / channel change without a `DELETE`) opened a second
upstream connection and failed as an unexplained ffmpeg timeout. Now every
stream records its **owner** (`device:<id>` for a paired device, `user:<id>` for
a web login; anonymous = nobody) and, when `maxProviderStreams` would be
exceeded, the slot is freed in this order: (1) streams idle ≥
`viewerIdleTimeoutSec` (60 s) — silently; (2) the caller's *own* earlier stream
— silently; (3) another owner's live stream — **409**
`{conflict:{type:"viewer-in-progress", streamId, lastActiveSec, message}}`,
overridden by `force:true` (same shape and `force` flag as the existing
`recording-in-progress` conflict). `admitViewer()` does the releasing before the
new stream starts. `/api/remux` and `POST /api/transcode/session` use the same
logic in **soft** mode (reclaim (1)+(2), never 409 — their web callers can't
answer a prompt). Live-session idle sweep: **5 min** (`PIGTV_LIVE_IDLE_TIMEOUT_SEC`),
swept every 60 s (was 30 min / 5 min) for sessions flagged `live` (resolve with a
channel; the web player's session fallback); seekable sessions keep 30 min.
**Deliberately not the ~2 min in the original A3 note:** the 60 s idle rule
already reclaims a dead stream the moment anyone needs the slot, so the timeout
is only housekeeping, and 2 min would kill a TV that is merely paused through a
phone call (beyond ~6 min the 90-segment window has rolled past the pause point
anyway). **Behaviour changes to know about:** (a) with `maxProviderStreams` left
at its default of 1 on a provider that actually allows more, a second device
now gets the prompt instead of silently opening a second connection — raise the
setting if that's you; (b) the web player's confirm text now varies by
`conflict.type`. **Client-coupled:** the Apple client must handle a 409 whose
`conflict.type` is `viewer-in-progress` (show `conflict.message`, retry with
`force:true` on confirm) — see §B. Tests: `test/stream-coordinator.test.js`
(13 cases, no ffmpeg needed).

**0056 detail.** The guide is no longer emptied by a sync. `epg_programs` gains a
`gen` column and a small `epg_state(source_id, active_gen)` table; a sync loads
the feed as generation *active+1* (invisible), then flips `active_gen` in one
statement (an instant, atomic swap — deliberately *not* a big `INSERT…SELECT`,
which would block the event loop, and every stream, for seconds), then deletes
the superseded generation in 20 000-row slices that yield between them. Every
reader (`/api/library/*`, `/api/proxy/epg`) now reads the **`epg_live`** view,
which shows only each source's active generation — **use `epg_live`, not
`epg_programs`, for any new guide query.** A feed that fails half-way, or yields
zero programmes, leaves the live guide untouched and discards its partial load;
debris from a crashed sync is swept at the next one. Existing rows become
generation 0, and a source with no `epg_state` row is treated as generation 0, so
they are live with no migration step (and a row inserted directly into
`epg_programs` — as `access.test.js` does — is visible). The per-programme JSON blob is
no longer stored (nothing read it), so new generations are smaller; the DB file
itself won't shrink without a `VACUUM`. **Cost:** disk headroom of roughly one
extra copy of the guide while a sync runs. View overhead measured at ~0 on 500k
rows. Not done from the original P1-5 note: dropping `AUTOINCREMENT` (needs a
table rebuild for no real gain). Tests: `test/epg-swap.test.js` (7 cases incl.
a legacy-schema upgrade and a mid-sync read).

**0057 detail.** `GET /api/transcode/:id/:segment` only checked a `.ts|.m4s|.mp4`
suffix, and Express URL-decodes params *after* routing, so
`..%2F..%2Fx.mp4` reached `path.join` as a real path (verified in the review).
The route now accepts only the names ffmpeg is told to write —
`seg<4+ digits>.ts|.m4s` and `init.mp4` — and `getSegment()` additionally refuses
anything that doesn't resolve directly inside the session directory. **MIME
deliberately left alone:** fMP4 segments are still served as `video/MP2T`. It is
imprecise but works with both clients today, and changing a Content-Type on the
live path can't be verified on a real Apple device from here while playback is
being chased for instability; revisit as its own patch with a device on hand.
Tests: `test/transcode-segments.test.js` (4 cases through the real router with
real files; confirmed to fail 3/4 against the old code).

**0058 detail.** `/api/proxy/stream` rewrites an upstream HLS manifest so the
player fetches segments and keys back through the proxy, but the rewritten URIs
dropped the request's `?token=`. With `requireStreamAuth` on, direct-strategy HLS
loaded its manifest and then 401'd on the first segment. Every rewritten URI
(segment lines and `URI="…"` attributes: key, init map) now carries the token,
URL-encoded; no token in, none appended, so today's behaviour with enforcement
off is unchanged. This is groundwork for the `requireStreamAuth` flip (§A.9) —
without it that flip would have broken direct HLS playback. Tests:
`test/proxy-hls-token.test.js` (4 cases, real proxy route against a local HLS
upstream; 2 fail against the old code).

**0059 detail.** The web app favourites a channel by its composite id
(`m3u_<src>_<item>`); the native client writes the bare id, and
`/api/library/*` joins on the bare id — so a favourite made in one client never
appeared in the other. The **bare id is now canonical**: `favorites.add/remove/
isFavorite` normalise channel ids on the way in (new `services/channelIds.js`),
and `initSchema` rewrites any existing prefixed channel rows to bare at startup,
merging with a bare twin rather than duplicating (idempotent; only touches rows
still carrying a prefix; movie/series rows are left alone). **No web-client
change:** `GET /api/favorites` re-presents channel ids in the composite form the
web already matches on (`?format=bare` returns the stored form), so both clients
now see each other's favourites. **One-way door:** the startup migration rewrites
`favorites.item_id` in `content.db` — back that file up before the first start of
this build if you care about the old spelling. **Not done — still open under
P1-3:** the derived `stable_id`, so a provider reorder (`pos_N` shifts) can no
longer re-point favourites, history and scheduled recordings; that re-keys three
tables and deserves its own patch. Tests: `test/favourites-ids.test.js` (6
cases incl. a legacy-database migration and the two cross-client scenarios
through the real routes; 4 fail against the old code).

**0060 detail.** The EPG index is `(channel_id, start_time, end_time)`, but the
guide and now/next queries only bounded `end_time > from` and `start_time < to`, so
SQLite walked every programme a channel has ever had before the window (the whole
feed) to discard them. Both queries now also require `start_time > from − 24 h`
(`MAX_PROGRAMME_MS` in `routes/library.js`), turning it into a true range scan.
**Deliberate limit:** a programme that began more than 24 h before the window is
no longer shown even if still running (a 24 h+ "marathon" block); pinned by a
test. Also added `idx_items_source_item(source_id, item_id)` for the per-request
lookups (resolve, recordings, favourites join). **Not done from P2-3:** an index
for the paged channel ordering (the `ORDER BY CASE WHEN sort_order IS NULL …`
expression can't use a plain index — it would need a generated column) and
keyset pagination (changes the client's paging contract). Tests:
`test/guide-bounds.test.js` (5 cases through the real route; 4 fail on the old
code).

**0061 detail.** Recording files are named with the server's *local* time
(`Title - 2026-09-19 19-30.mkv`), but the image sets no `TZ`, so a default
container is on UTC and a 7:30pm Sydney programme was filed as `09-30`.
`docker-compose.yml` now passes `TZ=${TZ:-UTC}` (falls back to UTC, i.e. no change
unless you set it). **Action for Mark:** set `TZ` (e.g. `Australia/Sydney`) — in
a `.env` next to the compose file, or as a variable in the Unraid container
template if you deploy from that rather than compose. Node reads the zone from
its own ICU data, so no tzdata package is needed (confirmed under `TZ=Australia/Sydney`,
including the October DST changeover). The recording ffmpeg also ignored the
`userAgentPreset` setting and hard-coded a Chrome string; it now uses
`db.getUserAgent(settings)` like playback, so a provider that fingerprints the UA
sees one client. Timestamp formatting moved to a dependency-free
`services/recordingNames.js` so it can be tested under different `TZ` values.
Tests: `test/recording-names.test.js` (4 cases, each zone in its own child
process). The UA change is covered by a `verify-build.sh` check, not a unit test
(`startRecording` needs the whole engine).

**0062 detail.** Server side of P1-2, all in `recordingEngine.js`. (1) **`hvc1`:**
the native remux and the HEVC compression output now carry `-tag:v hvc1`;
ffmpeg's default for a stream-copied HEVC is `hev1`, which AVFoundation refuses in
MP4 — so every HEVC recording produced a file AVPlayer would not open while H.264
worked. Confirmed against real ffmpeg: tagged `hvc1` with the flag, `hev1`
without. (2) **MP2 audio** (common in DVB-sourced TS; not playable from MP4 by
AVPlayer) is re-encoded to AAC; AAC keeps `aac_adtstoasc`, AC-3 stays a copy.
(3) **In-flight dedupe:** concurrent requests for one recording (`/playback` then
`/media.mp4`, or two devices) share a single remux instead of both running
`ffmpeg -y` on the same file. (4) **Atomic output:** the remux writes
`<name>.native.mp4.partial` and renames it into place, so the final name only ever
refers to a finished file; debris from a killed remux is cleared first. Existing
`.native.mp4` files from older versions are probed once per run (a truncated one —
the moov index is only moved to the front at the very end — has no readable
duration) and regenerated if unreadable; verified files aren't re-probed on every
Range request. (5) **Sidecar cleanup:** deleting a recording now also removes its
`.native.mp4`, `.partial` and `.compressed.mp4`, which were orphaned before.
**Still open (client-coupled):** `GET /api/recordings/:id/playback` still awaits the
remux inside the request (a big file over SMB can outlast URLSession's 60 s); the
`202 {status:"preparing"}` fix needs the Swift client to poll instead of erroring
on non-200. **Needs a device to confirm:** an HEVC recording actually playing in
AVPlayer (only verified here that the tag is right). Existing HEVC sidecars made
by older versions are `hev1` and are *not* regenerated (they're readable); delete
`*.native.mp4` for HEVC recordings once to force a re-remux. Tests:
`test/native-playback.test.js` (12 cases, ffmpeg/ffprobe stubbed; no binaries
needed), plus a real-ffmpeg check of the flags run once on the dev machine.

**0063 detail.** A conservative slice of P2-7, for before Tailscale exposure.
(1) `express.json` limit **50 MB → 2 MB**. The largest real body is the web app's
bulk hide/show, sent in batches of 5 000 items (~300 KB), so there is ~6× headroom;
if a legitimate request ever 413s, this is the knob (`server/index.js`).
(2) **Failed-login limit:** 10 failures per 15 min per *(client socket address,
username)* → `429` + `Retry-After`. Only failures count and a success forgets them,
so nobody is locked out for typos; the right password is refused *while* locked
(otherwise the limit is just a slower guess); one user's mistakes never block
another. Keyed on the **socket address, not `X-Forwarded-For`** — `trust proxy` is
`true`, so XFF is client-controlled and useless as a key. Behind a reverse proxy
that means every client shares the proxy's address, which is why the username is
in the key. (3) **Pairing:** `/api/devices/pair/start` 60 and `/pair/poll` 1 500
requests per 10 min per client — far above a real device (one start, then a poll
every couple of seconds), enough to stop an anonymous client hammering the
database. All in-memory (`services/rateLimit.js`, no dependency); a restart clears
the counters. **Deliberately not done:** `USER node` in the Dockerfile — on Unraid
it could lose write access to the bind-mounted `data/` and `recordings/` folders
and I can't verify that from here; do it separately with the volume ownership
sorted, or leave it. Tests: `test/rate-limit.test.js` (7 cases: the limiter on a
controlled clock, then the real login and pairing routes).

**0064 detail — live-playback failure reported by Mark.** Symptom in `docker logs`:
`[Remux] Full command: … -f mp4 …` with **no** `-bsf:a aac_adtstoasc`, then
`Malformed AAC bitstream detected`, `Error submitting a packet to the muxer`, and the
client disconnecting after ~3 s. Cause: the remux route learns the audio codec from
a separate `ffprobe` (`detectCodecs`), which needs *another* connection to a provider
that likely allows one; when it failed (silently — it returned `null` with no log) the
route carried on with no way to know the audio was AAC. MPEG-TS carries AAC as ADTS
and MP4 rejects every packet of it without `aac_adtstoasc`; **verified against real
ffmpeg that there is no safe guess** — ADTS AAC fails without the filter (with or
without `dump_extra`), and forcing the filter onto AC-3/MP2 fails at start-up
(`Error opening output file`). So: (1) the route now reuses what
`/api/playback/resolve` already learned (`streamProbe.findCachedCodecs`) — **no extra
provider connection at all** in the normal web flow; (2) otherwise it probes, and
retries once after 1.5 s (a provider that has just closed a connection often refuses
the next for a moment); (3) every probe failure now logs *why* (exit code + stderr, or
timeout) — grep `docker logs` for `Codec probe failed`; (4) if it still can't identify
the stream it answers **503 + `Retry-After: 2`** with a clear message instead of
starting a stream that dies on its first audio packet. If `ffprobe` itself is
unavailable the old behaviour is kept. Reproduced against real ffmpeg with a local
"provider" that refuses the probe's connection: old code 0/3 (only the 1 271-byte MP4
header delivered), fixed code 3/3. Tests: `test/remux-codecs.test.js` (6 cases,
injected dependencies, no binaries). **Root cause of the provider-side flakiness is
not proven** — the screenshot Mark sent started at "Starting remux", so the
`Codecs:`/probe-failure line above it wasn't visible; the new log line will say.

**0065 detail — diagnostics for an unreproduced web-playback fault.** One live
channel on Mark's provider makes the web player's remux
stream drop after ~10 s with `[Remux] Client disconnected after 10s` and *no*
ffmpeg error: the server side is healthy and the **browser** hangs up. The player
had no `error` listener on its `<video>`, so a decode failure was completely
silent. Now: `VideoPlayer.handleMediaError()` logs the element's error (code name,
browser message, network/ready state, current time, buffered end, and the strategy
the server chose: `remux`/`transcode`/`direct`/`hls`/`local`), shows a red
`Playback error (MEDIA_ERR_…)` badge instead of a silent spinner, and POSTs the
same details to the new **`POST /api/playback/client-event`**, which writes one line
to the server log:
`[Player] media-error MEDIA_ERR_DECODE(3) via remux path=/api/remux msg="…" networkState=… readyState=… t=10s buffered=9.9s from=user:1`.
So next time it happens: **`docker logs pigtv | grep media-error`**, next to the ffmpeg
lines from the same moment. Privacy/safety: the URL is reduced to its *path* (the
query string holds the provider login and the session token) and the server also
redacts the message; the endpoint needs a token, accepts only the `media-error` event,
whitelists and bounds every field, strips control characters (no forged log lines),
is rate limited (30/min per client, over that it drops quietly) and never affects
playback. Clearing the source (channel change, `stop()`) also fires an `error` event
and is deliberately ignored. Reported once per source. While hls.js is driving, the
badge is left to it (it recovers from many of these), but the error is still
logged. **Not a fix** — it only makes the fault diagnosable. Suspicions to test when
it recurs: Chrome rejecting this channel's fragmented MP4 (odd timestamps / long GOP);
the same channel via HLS (Settings → Stream Processing: Auto Transcode off, Force
Audio Transcode on) and on the Apple client would show whether the remux path is at
fault (which would favour bringing §C forward). Tests: `test/player-media-error.test.js`
(7, the real player script in a `vm`) and `test/client-events.test.js` (5, real route,
real token).

**0066 detail — AC-3 / E-AC-3 through the remux path.** Found while testing 0064:
real ffmpeg cannot write AC-3 or E-AC-3 into the empty-moov fragmented MP4 the remux
produces (`Cannot write moov atom before AC3 packets`, only the ~950-byte header is
delivered). It matters because `resolve` sends a stream to remux whenever the client
reports it can decode the audio — Safari reports AC-3 — so an AC-3 channel on a
Safari web player would have gone there and failed. The MP4 header for these codecs
has to be built from the first frames, so `delay_moov` (hold the header until the first
fragment) is added to the movflags **only when the audio is `ac3`/`eac3`**; every
other stream keeps exactly the flags it has today (asserted byte-for-byte in a test),
since `delay_moov` delays a stream's start by up to a keyframe interval. To make that
testable the remux ffmpeg arguments moved out of the route into pure
`remuxFixes(codecs)` + `buildRemuxArgs(url, userAgent, fixes)` (same arguments, same
order). Verified against **real ffmpeg through the real route with an endless,
live-style upstream**: old route AC-3 and E-AC-3 → header only (950 B); fixed route →
playable `h264+ac3` / `h264+eac3`; AAC unchanged. The log's `Codecs:` line now adds
`(delay_moov)` when it applies. **Not verified:** actual AC-3 playback in Safari (only
that ffmpeg now produces a valid stream); Chrome cannot decode AC-3 natively so it is
routed to transcode by `resolve` and never reaches this. Tests: `test/remux-args.test.js`
(6 cases, no binaries).

**0067 detail — EPG icon fallback (P1-3, the part the server can do).** A playlist
often has no logo for a channel that the EPG feed *does* have an icon for. The Apple
client made up for that itself — downloading the whole EPG channel list
(`loadArtworkIndex()` + `/api/proxy/epg/{id}`) and matching on tvg-id then name. The
library API now does it: `/api/library/channels`, `/favourites` and `/guide` fill a
missing `logo` from the EPG channel with the same **tvg-id**, else the same **name**
(case and spacing ignored). A logo the playlist supplied is **never replaced**; no match
leaves `null`; an EPG entry with no icon is ignored. The response shape is unchanged
(`logo` was already a string-or-null field), so this is additive and **cannot break the
current client** — it just means the client can *stop* doing its own matching (§B).
Implementation: a small in-memory index of the EPG channel icons, built once and reused
for 5 min (matching by name has to look at every EPG channel, so it isn't done per page);
an EPG sync's new icons appear within 5 min. Failure to build it never fails a listing.
Known limitation: name matching can pair two different channels that share a name (first
source to supply an icon wins). Tests: `test/library-logos.test.js` (6 cases through the
real routes; 3 fail against the old code).

**0068 detail — the unreproduced web-playback fault, diagnosed.** 0065's error log
caught it on the next occurrence:
`[Player] media-error MEDIA_ERR_DECODE(3) via remux … msg="PipelineStatus::PIPELINE_ERROR_DECODE: Failed to send audio packet for decoding: {timestamp:25066646 duration:21333 size:355 …}" t=25.1s`.
So: the server side is healthy; **Chrome's audio decoder rejected one AAC frame ~25 s in**
(a normal-sized frame: 355 B / 21 ms = one AAC-LC frame), and Chrome aborts the *whole*
`<video>` on a single rejected audio frame, dropping the connection. The remux **copies**
the provider's audio, so it hands the browser exactly what was sent, damaged frames
included; an ffmpeg-based player conceals them. Reproduced the class with real ffmpeg by
damaging audio bytes of a TS: the copy output contains AAC frames that fail decoding
(`channel element 2.7 is not allocated`, 20–56 errors) and even records a **wrong audio
config in the MP4 header** (a stereo 48 kHz source came out declared mono 44.1 kHz,
because a damaged ADTS header seeded the AudioSpecificConfig), while a re-encode gives
0 errors and a correct header. **Not proven:** that this provider's channel actually
carries damaged audio (I can't see the stream), or Chrome's exact rule — but a
random-time audio-decode failure on one channel, every time, fits it, and the fix is
harmless if wrong. (A mid-stream *config change* — channels/sample rate — was tested and
does **not** break ffmpeg's decoder, so that hypothesis is unconfirmed.)
**The fix — self-healing, not global.** `GET /api/remux?…&audio=encode` re-encodes only the
audio to AAC-LC stereo 48 kHz / 160 kb/s with `aresample=async=1` (video still copied, so
~no CPU; no `aac_adtstoasc`, no `delay_moov` since the output is plain AAC). `resolve`
accepts `audioEncode:true` (adds `&audio=encode` to the remux URL; for HLS sessions sets a
new `audioMode:'encode'` that **beats the "smart copy" shortcut** — a stereo AAC source is
normally copied straight through in a session too). The web player: on a `MEDIA_ERR_DECODE`
whose message mentions *audio*, on a **remux** stream that wasn't already re-encoding, it
replays the channel **once** with `audioEncode`, and **remembers the channel** in
`localStorage['pigtv_audio_encode']` (max 200) so it starts re-encoded next time. It can't
loop (one retry per selection; a play already re-encoding never retries), ignores video
errors and hls.js streams, and **forgets the flag if re-encoding didn't help**. Nothing
changes for a channel that has never failed. Cost: an audio re-encode for that channel
only. **Apple client:** the same `audioEncode` field works on `resolve` (both remux and
HLS-session strategies) if AVPlayer ever shows the same class of failure — §B. **To reset
the browser's memory:** clear that localStorage key. Tests: `test/player-audio-retry.test.js`
(7, the real player script in a `vm`, incl. every no-retry case), `test/audio-encode.test.js`
(5), and 4 more cases in `test/remux-args.test.js`; verified through the real route with
real ffmpeg and a damaged endless upstream (copy → decoder errors; `?audio=encode` → 0).

**0069 detail — a bug in 0065, found from Mark's console.** After 0065, the browser
console showed `[Player] Media error: MEDIA_ERR_SRC_NOT_SUPPORTED "MEDIA_ELEMENT_ERROR:
Empty src attribute" (local, /api/remux)` (plus WatchPage's own `[WatchPage] Video error:
4 … Empty src attribute`). Cause: `stop()` sets `video.src = ''` on every channel change
(and on 0068's replay), and the browser answers with that code-4 "Empty src attribute"
error. 0065 meant to ignore it but tested `video.currentSrc === ''` — **Chrome still holds
the *previous* URL in `currentSrc` while raising it**, so the check never fired. My test
had assumed `''`, so it passed against a browser that doesn't behave that way. Effects: a
red "Playback error" badge flashing on channel changes, and — whenever the old URL differed
from the last one reported — a bogus `media-error MEDIA_ERR_SRC_NOT_SUPPORTED via local`
line in `docker logs` (in Mark's case it was deduplicated against the earlier real report,
which is why it stayed console-only). No effect on playback or on 0068's retry (code 4 is
not an audio decode error). Fix: `isSourceCleared()` — the **`src` attribute** ('' or absent
once cleared) is the reliable signal, with the "Empty src attribute" message as an
independent second check; a genuine failure right after a channel change is still reported
(tests cover both directions). WatchPage's own listener now skips the same routine event.
Tests: 3 new cases in `test/player-media-error.test.js` modelling what Chrome really does;
2 fail against the 0065 handler. **Lesson recorded:** browser-behaviour assumptions in a
`vm` test are only as good as the fixture — the fixture now encodes the real Chrome sequence.

**0070 detail — "some channels now fail, no error in the log or console".** Mark's log
(after 0068/0069) showed `Started remux_3` … `Client disconnected after 13s` … `Started
remux_4`, ffmpeg silent, no `media-error`, on a channel that used to play ~25 s before its
audio failed. Two things were missing: the **server** logged whether the client left but
not whether a single byte had ever been sent, and the **player** only reported the
element's `error` event — a load that *never starts* raises none. Now: the remux logs
`first output after X s` and ends with `Client disconnected after 13s (sent 1 KB, first
output after 5.2s)` or `(ffmpeg had produced no output yet)`; **all** ffmpeg messages are
logged (first 25 per remux, tagged with the remux id — previously only lines containing
"error"/"Warning", which hid reconnect attempts); and the player reports a new
**`start-timeout`** event when nothing has played 15 s after a load began (skipped if
paused, already moving, the source was replaced or cleared; once per source):
`[Player] start-timeout via remux path=/api/remux waited=15s networkState=2 readyState=0 …`.
Read it as: `sent ≈1 KB` = only the MP4 header arrived, no media (waiting on a
keyframe); `no output yet` = ffmpeg silent (provider slow/refusing, or still probing);
`sent N MB` = data flowed and the failure is in the browser.
**Measured while diagnosing (synthetic 4 Mbps stream, real-time paced, tuned in at a
random point — not Mark's provider):** the remux's `-probesize 5000000 -analyzeduration
5000000` makes it wait ~the full analyze window in real time before writing the MP4
header (~5.8 s), and `frag_keyframe` then needs a keyframe boundary before any media:
time to first playable media ≈ **9 s at 2 s keyframe spacing, 13–17 s at 5 s, 23 s or
*none in 50 s* at 10 s** (2 of 3 runs). Shrinking the probe (2 MB/2 s) cuts a 2 s-GOP channel
to ~6 s but makes long-GOP channels **fail more** (5 s GOP: often no output at all), so it is
*not* a universal fix and was not shipped. Hypotheses for Mark's channel, not yet told
apart: (a) long keyframe spacing → nothing for 15–45 s, the browser/user gives up;
(b) the provider is slow or refusing a second connection (rapid re-clicks make it worse —
0055 deliberately replaces the device's own earlier stream). **The HLS session path uses the
same 5 MB / 5 s probe (`transcodeSession.js`), so §C Phase 2 must measure start-up there
too, not assume it is faster.** Tests: `test/remux-diagnostics.test.js` (6),
`test/player-start-watch.test.js` (4, real player script with controlled timers), plus a
`start-timeout` case in `test/client-events.test.js`.

**0071 detail — noise from 0070's fuller ffmpeg logging.** Live-verification item A1 showed
a healthy channel (playback normal) logging `[h264 @ …] non-existing SPS 0 referenced in
buffering period`, `non-existing PPS 0 referenced`, `decode_slice_header error`, `no frame!`
and `Last message repeated N times`, until the cap ("further ffmpeg messages suppressed").
Cause: a remux copies and never decodes, but **ffmpeg decodes the first frames while probing
the input**, and joining a live stream mid-keyframe-interval makes the H.264 decoder complain
until the next keyframe; it stops by itself once the probe ends. Harmless — but before 0070 the
"error"-only filter mostly hid it, and after 0070 it consumed the whole 25-message budget,
leaving no room for something that matters (a reconnect, a timestamp problem) later. Now
messages from a decoder (`h264/hevc/mpeg2video/mpeg4/aac/aac_latm/ac3/eac3/mp2/mp3`) and
ffmpeg's own "repeated N times" note that follows one are **counted, not logged**, and
summarised in one line when the probe ends (first output) and again at the end:
`remux_15: 40 decoder messages while probing the stream - normally just joining mid-keyframe
(h264: non-existing PPS 0 referenced x8; …)`. Everything else ffmpeg says is still logged
individually, and the budget is no longer spent on the noise. **A very large count in that line
would itself be a signal** (a stream that never gets a keyframe).
**Also fixed here — a bug in 0070's logging that a real-ffmpeg run exposed:** a process's
stderr arrives in arbitrary *pieces*, not lines, so a read could end halfway through
`Last message repeated 1 times`; 0070 treated each piece as a line and logged fragments
(`Last mess` / `age repeated 1 times`), both in the per-message log and in the "Last ffmpeg output"
tail printed when a remux stalls or dies. Now a real line buffer (`makeLineBuffer`) holds the
unfinished last line until the rest arrives (`end()` releases it when the process is over).
**What a failed join looks like** (seen with a 10 s-keyframe stream joined at a random point):
`Could not find codec parameters for stream 0 (Video: h264 …): unspecified size` → `dimensions
not set` → `Could not write header` → ffmpeg exits with code 4294967274 (-22) at ~6 s, because the
5 MB / 5 s probe window ended before the first keyframe. That is the long-keyframe failure the
0070 measurements predicted; it now announces itself in the log. Tests: 7 new cases in
`test/remux-diagnostics.test.js` — the exact lines from the live log, and the *same output whether
the stream is cut anywhere or delivered a byte at a time*; 6 fail against the 0070 logger.

**0072 detail — Hide All / Show All checkboxes (found in live-verification item A3).** In
Settings → Sources, pressing **Hide All** hid everything on the server but the group
checkboxes stayed ticked until the page was reloaded (then correctly unticked). **Not a
regression from this session** — `SourceManager.js` was not touched by any of 0054–0071. Cause:
a group's checkbox is drawn from the *category's own key* (`hiddenSet.has('group:<categoryId>')`,
deliberately "authoritative", see the comment in `getGroupHtml`), but `setAllVisibility` only
updated the per-*item* keys after the server call, never the group keys. The server side was
right all along (`POST /api/channels/hide/all` hides both categories and items in single
statements). Fix: `setAllVisibility` now sets/clears the group key too (`group` / `vod_category` /
`series_category` by content type); **Show All had the mirror-image bug**, fixed by the same
change. `originalHiddenSet` follows so **Save Changes** has nothing left to repeat. No server
change. Tests: `test/source-manager-hide-all.test.js` (5, the real script in a `vm`, rendering the
actual group checkbox HTML; 3 fail against the old code).

**0073 detail — timestamp-discontinuity flood in HLS sessions (found in live-verification, an
E-AC-3 6-channel channel).** The session log showed an endless alternation of `timestamp
discontinuity (stream id=…): -23760000, new offset= …` between the video and the audio stream. Cause:
ffmpeg keeps **one** timestamp offset per input and treats any DTS jump over `-dts_delta_threshold`
(default **10 s**) as a discontinuity, shifting that offset. This feed's audio and video clocks start
23.76 s apart, so the two streams take turns "jumping" and every packet re-triggers the correction.
Reproduced with real ffmpeg on a transport stream whose video timestamps and PCRs are moved by
+23.76 s: the session's old arguments logged **790** discontinuity messages and kept only **767 of
1409 audio packets** (audio audibly dropping in and out); with the threshold raised: **0** messages,
all audio packets. Fix: `-dts_delta_threshold 60` as an *input* option on every HLS session
(`transcodeSession.js`, `DTS_DELTA_THRESHOLD_SEC`, tunable with `PIGTV_DTS_DELTA_THRESHOLD_SEC`,
non-positive/garbage falls back to 60). 60 s clears any realistic A/V start-up skew but real
discontinuities (a splice or provider restart — minutes or hours; also any *backward* jump) are still
corrected; measured: +30 s forward jump is not corrected, +200 s and −8 s still are. Not chosen:
`-fflags +igndts` (also fixes it, but throws away DTS entirely — a bigger behavioural change than the
fault needs). **Not applied to the remux route** (it uses `igndts` already and never showed the flood)
**or to recordings** (measured on the same input: 243 log lines but every packet intact, so it is
noise, not data loss — left alone rather than change what gets written to disk; a candidate if the
recording log noise ever matters). Tests: `test/hls-timestamp-skew.test.js` (4: the argument and its
position before `-i`, the env override, and the real-ffmpeg reproduction — which also asserts that the
*old* arguments still reproduce the fault, so the test cannot pass by accident; skipped if ffmpeg is
absent). **Still seen after this, and harmless:** the E-AC-3 probe line `Could not find codec
parameters for stream 1 (Audio: eac3 … 0 channels …)` — ffmpeg's 5 MB / 5 s probe window ended before
it had read enough E-AC-3 to know the layout; the session goes on to decode and re-encode audio
correctly. Not touched. If audio on such a channel is ever silent from the start, that line is the
first suspect (a longer `-analyzeduration` for E-AC-3 would be the fix).

**0074 detail — housekeeping (hand-over session, 20 Sept 2026).** No server behaviour change.
(1) `test/access.test.js` linked the sandbox's `node_modules` with a directory *symlink*, which
Windows refuses (`EPERM`) without developer mode / admin, so the suite could never be fully green on the
dev machine. It now uses a *junction* on `win32` (no privilege needed; POSIX is unchanged). Local baseline
before: 158 pass / 1 fail (this file) / 1 skipped (`remux-watchdog`, POSIX-only); after: the file passes 9/9.
(2) **`verify-build.sh` on Windows:** it needs a real `python3` on PATH. If only `python` is installed, put a
one-line shim ahead of the Store stub — a `python3` script containing `exec python "$@"` — and run it with
`PYTHONUTF8=1` (this is how it was run for 0074). (3) Status lines refreshed (0071–0073 deployed) and the
decisions below recorded.

**0075 detail — §C Phase 1: "HLS Delivery (beta)" for the web player, plus measurement.**
(1) **The toggle.** Settings → Transcoding → Stream Processing → **HLS Delivery (beta)**. When on, the web
player's `resolve` request adds `capabilities.segmentedDelivery:true` — the request the Apple client already
makes — so a stream with fine codecs comes back as an HLS *session* (fMP4 segments, `videoMode:'copy'`) played by
hls.js, instead of `/api/remux`. No new server delivery code: `playDecision()` already played any `container:'hls'`
decision. **Per browser, not a server setting** (`localStorage['pigtv_hls_delivery']`, exactly `"1"`; off by
default): the Settings API is admin-only and global, and a per-browser flag lets one browser trial HLS while every
other browser and the Apple client stay as they are. Rollback = untick it. The status badge reads `HLS (video
copied)` / `HLS (video encoded)` when on (it used to say "Transcoding (Audio)" for the copy case, which is
misleading for a stream that is not being transcoded). With the toggle off the resolve request is byte-for-byte what
it was (asserted in a test).
(2) **Measurement (the Phase-2 instrument).** The player reports two new events to `POST
/api/playback/client-event`, logged as plain lines:
`[Player] play-start via transcode(hls, video copy) hls-delivery=on resolve=5.0s first-picture=5.0s from=user:1` —
`resolve` is the time the server took to answer (probe + session start + first segment), `first-picture` is the
whole time from the channel click to the element's `playing` event; and
`[Player] play-end via … watched=312s stalls=2 from=user:1` — sent when a play is closed out (channel change or
stop) if it ran ≥10 s; `stalls` counts the element's `waiting` events after it had started, ignoring seeks.
Compare the two paths with `docker logs pigtv | grep -E "play-start|play-end"`; the `via` part says which path
(`remux(fmp4)` vs `transcode(hls, …)`) and `hls-delivery=` says whether the browser had opted in. They have their
own rate limit (120/min) so channel-surfing cannot use up the 30/min that `media-error` / `start-timeout` rely on.
Lost if the tab is closed mid-play (nothing to send it with) — fine for a sample.
(3) **Where the seconds go.** `resolve()` now logs one line per call:
`[Playback] resolve timing: HLS session, probe 4.8s, first segment after 5.0s` (or `probe cached`; `remux, probe …`;
`direct, probe …`; `first segment NOT produced in time` before the 15 s failure). `docker logs pigtv | grep "resolve
timing"`. Log only — no change to the response.
(4) **hls.js fatal errors are no longer swallowed.** `playHls()` used to `console.error` and destroy the instance,
leaving a frozen picture with no badge and nothing in `docker logs` — the exact silence 0065 removed for the element's
own errors, on the path we are about to trial. It now shows `Playback error (HLS <details>)` and reports a
`media-error` line with `codeName=HLS_<type>` (e.g. `HLS_networkError`, `msg="manifestLoadError http 404"`) and the
*playlist's* path (under hls.js `currentSrc` is an opaque `blob:` URL). Type, reason and HTTP status only — never the
URL (it carries the session token). **No recovery is attempted** (no `recoverMediaError`, no fall-back to remux):
that is §C Phase 3, deliberately not slipped in here.
**Measured in this session (synthetic stream, real Chrome in the dev browser pane, sandbox copy of the server —
*not* the real provider):** a local real-time-paced H.264/AAC upstream, 2 s keyframes. **HLS session:** probe 4.8 s
+ first segment 5.0 s → first picture **9.8 s** fresh, **5.0 s** with the probe cached, 0 stalls in 13 s, 1280×720.
**Remux:** probe 4.8 s + ffmpeg first output 4.8 s → first picture **12.6 s** fresh, **7.8 s** cached, 1 stall in an
earlier 14 s watch (HLS: 0). So on a well-behaved 2 s-GOP stream HLS is *not* slower than remux; the two big costs on both paths are
(a) the ffprobe pass in `resolve()` (≈ the 5 s analyze window on a live stream — cached for 5 min per URL) and
(b) ffmpeg's own 5 MB / 5 s input probe. **Real providers with long keyframe spacing are the open question** (0070
measured remux at 23 s or nothing in 50 s at 10 s GOP) — the live `play-start` lines are how we find out. The Phase-2
levers, if channel change needs winning back without giving up stability: skip the `resolve` probe when the source
is already known (cache warm-up for favourites), or shorten the *first* segment(s); both change what a live stream
is judged on, so measure first. **Not verified:** anything on Safari / native HLS, or on real E-AC-3 / HEVC content.
**Also found (not touched):** `VideoPlayer` defines `stop()` **twice** (an `async stop()` near line 1082 and a
`stop()` near line 1933); the later one wins, so the earlier — which also calls `stopConflictWatch()` and dispatches
`playbackStopped` — is dead. The 0075 hooks are in the live one and a test pins that. Cleanup candidate for P2-1.
Tests: `test/player-hls-delivery.test.js` (12, the real player script in a `vm` with a controlled clock: opt-in,
request shape, labels, first-picture / play-end / stall accounting, fatal hls.js error handling incl. no token),
`test/resolve-timing.test.js` (4), 6 new cases in `test/client-events.test.js`; 16 of the 24 tests in those two files
fail against the 0074 sources. **0075 live check (Mark):** deploy, confirm the badge reads **0075**; on ONE browser
tick Settings → Transcoding → **HLS Delivery (beta)** and play a few channels; badge should read `HLS (video
copied)`; then `docker logs pigtv | grep -E "play-start|play-end|resolve timing|media-error"` and compare
`first-picture` against a browser with the toggle off (`remux(fmp4)`). Watch specifically for: `media-error … HLS_…`
lines, `first segment NOT produced in time`, `stalls=` above 0, and any channel that only fails with the toggle on.

**0076 detail — dead-code batch (a): three inert files (review P2-1).** Deleted `server/routes/users.js`
(186 lines, never mounted — `routes/auth.js` has the live user routes), `server/services/m3uXtreamAdapter.js`
(134 lines, no importer; `docs/HANDOVER.md` records that editing it "had no effect") and `server/plugins/hello.js`
(a demo plugin whose unauthenticated `GET /api/hello` listed every internal service name). Confirmed by grep that
nothing required them; `verify-build.sh` lost its three checks that pinned the adapter and gained a block asserting
the files stay deleted and nothing refers to them. **The plugin *loader* and `PLUGINS.md` are deliberately kept** —
it is a documented extension point, not dead code, just currently empty; say the word to remove it. A booted copy of
the server started clean with the plugins folder empty. `/api/hello` now falls through to the SPA catch-all like any
unknown path (roadmap A.10 covers making unknown `/api/*` return a 404 JSON). No behaviour change; no test needed
beyond the verify-build assertion (there is nothing left to test).

**0077 detail — dead-code batch (b): OIDC / SSO and express-session removed (review P2-1, and the rest of P1-7).**
Nothing in the repo configures OIDC (no `OIDC_*` in `docker-compose.yml` or the README; the review found it unconfigured — **if the Unraid template ever set `OIDC_*` variables, SSO stops working with this patch**), and the auth model is bearer
tokens (web login + paired devices), so this was a login path that is unreachable unless configured. Removed: `express-session` and
`passport.session()` from `index.js` (authentication is stateless, so there is no session store to grow or lose —
0053's `saveUninitialized:false` mitigation is superseded; a request now sets **no cookie at all**, checked); the
OIDC strategy, session (de)serialisation and their exports from `auth.js`; the `/api/auth/oidc/login` and
`/oidc/callback` routes (the callback put a JWT in a redirect URL — review §3.2); `getByOidcId` / `getByEmail` and the
`oidcId` field on new users in `db.js`; the "Sign in with SSO" button and script on `login.html`; the page-load script
in `index.html` that saved a `?token=` from the URL into `localStorage` (only the SSO callback ever used it); the SSO
badge branch and OIDC field in the Settings user editor; `.user-badge-sso`. **Dependencies: `express-session` and
`passport-openidconnect` are gone from `package.json` and the lockfile, which drops six packages** (`express-session`,
`oauth`, `on-headers`, `passport-openidconnect`, `random-bytes`, `uid-safe`) — the lockfile was edited with `npm
uninstall --package-lock-only`, so `npm ci` in the Docker build needs nothing new. `authSecret.js` is unchanged (it
still signs JWTs and device tokens). **Verified:** the full test suite and a real server boot both run with those six
packages *blocked at module resolution* (nothing tried to load one); login and `/api/auth/me` work; no `Set-Cookie`
on `/` or the API. **Not exercised in a real browser:** the login page after the edit (checked the markup is
balanced) and the Settings → Users edit dialog (syntax-checked only) — worth a click on first deploy. **Leftovers, on
purpose:** users created before this patch keep an `oidcId: null` field in `db.json` and in `/api/auth/users`
output (new users don't have one) — harmless, and stripping it would just be churn; `/api/auth/oidc/*` now falls
through to the SPA catch-all like any unknown path (roadmap A.10). If SSO is ever wanted, it is in git history
(this commit's parent) — but a paired-device flow would be the better fit for this server than OIDC.

**0078 detail — dead-code batch (c, part 1): the JSON-file `hiddenItems` and `favorites` removed from `db.js`
(review P2-1).** Hidden channels/categories live in SQLite (`routes/channels.js`) and favourites in SQLite
(`routes/favorites.js`); the two `db.json` collections (~140 lines: `hiddenItems.*`, `favorites.*`, their keys in
`loadDb`, and the clean-up in `sources.delete`) had no caller. Checked by grepping every `require('…/db')` for
destructured use, not only for `db.hiddenItems`. **One data effect to know about:** an existing `db.json` still contains
those two arrays; they are not loaded any more, so **the next write to `db.json` drops them** (and only them —
sources, users, settings and the id counter are kept, asserted in a test using a legacy-shaped file). They were unread
leftovers from the nodecast era; a weekly appdata backup covers the paranoid case. Tests: `test/db-legacy-keys.test.js`
(3; 2 fail against the 0077 code). **Deliberately left for later (still in this review item):** the dead
`persist()` / `restore()` / `recoverSessions()` / `getOrCreateSession()` in `transcodeSession.js` — `persist()` is
called from `start()`, i.e. inside the HLS path being trialled with 0075, so it waits until that trial is over (or §C
Phase 4). **Not started, and why:** `cache.js` + the upstream Xtream/EPG proxy routes in `routes/proxy.js` + the
non-streaming `epgParser`/`m3uParser` functions. The review called them unused "with an M3U-only setup", but the
`/api/proxy/xtream/:id/:action` routes are exactly what the web app's Movies/Series pages would use against an Xtream
provider — and VOD/series are being *kept* for a future provider (decision above). They should go only after Mark
decides whether that Xtream path is also being kept.

**0079 detail — unknown `/api/*` paths are a JSON 404, not the web app (roadmap A.10, review §2.14).** Anything
under `/api` that no router handled fell through to the SPA fallback and answered **200 with `index.html`** — so a
mistyped or missing endpoint looked like success and failed later as an unexplained JSON decode error (this is how
`/api/hello` and the SSO routes kept "working" after their code was deleted). Now `app.use('/api', …)` after the last
router answers `404 {"error":"No such API endpoint","endpoint":"GET /api/x"}` for every method; the query string is
left out (it can carry a token) and the path is capped at 200 characters. Everything that is not `/api` still gets the
web app. A router that requires a token still answers 401 first, so an anonymous caller can't map which paths exist.
**Contract guard:** `test/api-404.test.js` boots the *real* `server/index.js` as a child process and asserts that every
route the Apple client calls (list taken from `PigTV-Swift-Client`: `APIClient.swift` and its callers, plus the media
prefixes and §6's recording endpoints) still reaches its own handler and is never answered by the new catch-all. **When
the Swift client gains an endpoint, add it to `APPLE_CLIENT_ROUTES` in that test.** No client change needed: all 22
paths the client uses exist server-side, checked by reading the client source (read-only). Tests: 7 (4 of them fail
against the 0078 `index.js`; the client-route guard passes both ways by design — it protects the future).

**0080 detail — a failed `db.json` write is reported, not swallowed (roadmap A.10, review §2.14).** `saveDb()`
caught its own write errors, logged them and returned a *resolved* promise, so a full disk or read-only mount made every
source / settings / user change answer "success" and then vanish at the next restart. Now the caller of the failing save
gets the rejection: the routes already `await` every mutation inside a `try/catch` (audited — all eleven call sites are
in `routes/sources.js`, `settings.js`, `auth.js`, none fire-and-forget, so nothing can raise an unhandled rejection),
and a client receives a 500. Three details that matter: (1) **the write queue survives** — a failed write must not make
every later save fail too, so the queue chains off `thisWrite.catch(() => {})` while the caller gets the real rejection;
(2) **the in-memory copy is rolled back** when the write fails, unless a newer save has overtaken it (a later save
carries the whole database and may succeed) — otherwise a change that "failed" would stay live until the next restart
and then silently revert; (3) **the error a client can see is a plain sentence** ("The server could not save its data (is
the disk full or read-only?)"): `settings.js` and parts of `auth.js` return `err.message` directly, and the raw Node error
names a file path, which now stays in `docker logs` and on `.cause`. Tests: `test/db-write-failure.test.js` (5,
including a simulated ENOSPC on the first of two in-flight writes; all 5 fail against the 0079 code).

**0081 detail — `scripts/playback-report.js`, for reading the HLS trial (tooling only; no server behaviour change).**
Turns saved `docker logs` output into one comparison of the delivery paths: per path (remux, HLS session (opt-in),
plus any server-chosen transcode / direct) the plays, **time to first picture** (median / p90 / max, split **cold**
— the stream had to be probed — and **warm**, probe cached), **watch time, stalls and stalls per hour** (only quoted
once a path has 10 minutes behind it) and sessions of an hour or more; the failures the player reported by path;
the server-side failure signatures (`Could not write header`, ffmpeg produced no output, stalled ffmpeg killed,
`Codec probe failed`, remux refused to start, HLS first segment not produced in time); and a checklist against the
trial criteria (≥50 plays per path, ≥3 HLS sessions of an hour or more, no failures that happen only on HLS, stalls per
hour no worse than remux — edit the constants at the top of the script if the plan changes). Use:
`docker logs pigtv --since 24h > pigtv-today.log` then `node scripts/playback-report.js pigtv-today.log` (several files
are merged; stdin works; `docker logs -t` timestamps are ignored). It needs only Node, so it runs on the dev machine —
copy the saved log across; nothing has to be deployed. **Limits:** the log never names a channel, so "10+ different
channels" is the tester's own tally; cold/warm pairing uses the nearest earlier `resolve timing` line of the same kind,
reliable with one viewer and a guess with several; a play watched for under 10 s sends no `play-end` (by design), so
very short watches don't count towards stall rates. **The script parses the log by its exact wording**, so
`verify-build.sh` now also pins the three server log lines it depends on — change their format and the check fails
until the script is updated. Checked against a real sandbox log (it reproduced the hand-measured 9.8 s / 5.0 s HLS and
12.6 s / 7.8 s remux). Tests: `test/playback-report.test.js` (11, fixtures made of real log lines).

**0082 detail — a recording waiting for a viewer is visible, cancellable and not duplicated (found reading the Apple
client's own notes; server bug, fixes what the client shows).** A recording that is due but held back because someone is
watching on the provider's only stream has status `waiting`. Three places forgot that state: `listUpcoming()` (behind
`GET /api/recordings/scheduled`) returned only `scheduled` and `recording`, so the recording **disappeared from the list at
exactly the moment it was being held back**; `cancelScheduled()` handled only `scheduled` and `recording`, so cancelling a
waiting one returned it unchanged (the client, correctly, reports that as a failed cancel); and `findByProgram()`, the
duplicate check, ignored it, so the same programme could be scheduled twice. All three now include `waiting`, and
cancelling a waiting recording also withdraws the prompt that asks the viewer to stop watching (the Apple client polls for
that prompt). The engine's own announce loop already tested `status === 'waiting'` on that list — the state was clearly
meant to be there — and including it cannot raise a spurious prompt (a waiting schedule's start is already past). Web app:
`statusLabel` showed the raw word `waiting`; it now reads "Waiting for viewer" with an amber badge. **Client-visible
change:** `GET /recordings/scheduled` can now contain rows with `status:"waiting"` (the Apple client already decodes and
displays that status). Tests: `test/recordings-waiting.test.js` (6; 5 fail against the 0081 code).

**0083 detail — recording playback can be polled, and `/api/info` says what a client can rely on (review P1-2's
open half; the Apple client's pending server dependency).** `GET /api/recordings/:id/playback` awaited the whole native
remux inside the request. The Apple client's requests time out after 35 s (`APIClient.swift`), a big recording over SMB
takes longer, so it timed out while the server carried on and then asked again. **New, opt-in:** `?async=1`. Ready → the
same `200 {url, container, durationSec}` as ever. Still remuxing → **`202 {"status":"preparing","retryAfterSec":3}`** with a
`Retry-After: 3` header; the client asks again. Failed → **`500 {"status":"failed","reason":"remux-failed"|"file-missing",
"error":"The server could not prepare this recording for playback"}`** — a plain sentence (the ffmpeg output and paths go to
`docker logs`), reported **once**: asking again starts a fresh attempt instead of being told the old failure for a minute.
Without `?async=1` behaviour is byte-for-byte what it was, so nothing that exists today changes. Engine: `pollNativePlayback`
(ready / preparing / failed / idle), `startNativePlayback` (one shared background attempt per recording — concurrent clients
share it, as 0062's dedupe already did for the blocking flavour) and `startNativePlaybackAndWait`, which gives a fresh
attempt a **1.5 s grace period**, so a recording that only needs its existing `.native.mp4` checking answers `200` at once
rather than costing a round trip. **`/api/info` `features` gains five flags a client can ask for** (older servers simply lack
them): `recordingPlaybackPolling`, `scheduledWaiting` (0082), `viewerConflict` (0055), `epgLogoFallback` (0067),
`clientEvents` (0065). `apiVersion` is unchanged — everything is additive. Tests: `test/recording-playback-polling.test.js`
(9, the real recordings + info routers over a real database with ffmpeg/ffprobe stood in for: legacy blocking unchanged, fast
path, a real 202 sequence, no extra ffmpeg on re-ask, two clients share one remux, failure reported once without paths,
missing file, the old 409/404/401, the flags; 5 fail against the 0082 code). **Found on the way, not changed:**
`routes/info.js`'s handler is an `async` function with no `try/catch`, so an exception in it would leave the request hanging
rather than answering 500 (Express 4 ignores the rejected promise) — cosmetic today (nothing in it throws), worth a
one-line fix if that route ever grows.

**0084 detail — the playback report separates Apple-device plays from the web trial.** The Apple client is now
asked (`docs/SWIFT-CLIENT-HANDOFF.md`, C7) to send the same `play-start` / `play-end` / `media-error` events the web player
does, and it will send `hlsDelivery: true` because it always uses HLS sessions. Left alone, `scripts/playback-report.js`
would have counted those plays as the web's opt-in HLS trial and quietly inflated its sample. Every client event ends
`from=user:<id>` (web login) or `from=device:<id>` (paired device); the report now labels device lines
**"[Apple/device]"**, gives them their own rows (first-picture times, stalls per hour, failures), and keeps them out of
the trial-criteria block, which is about the web toggle only. A line with no sender is treated as the web player, as
before. Tests: 4 new cases in `test/playback-report.test.js` (15 in all). **Slip caught on the way:** my first version of
the sender regex lost its `\b` to a stray backspace character (an escaping mistake in a helper script) and silently
matched nothing — the new tests caught it, and a scan of every tracked file found no other stray control characters.

**0085 detail — stream-copy HLS sessions ignore the source's DTS (found in the first days of the HLS trial).** Three
channels put ffmpeg warnings in `docker logs`, and one played stop/start. Reproduced with real ffmpeg: a 50 fps H.264 stream
with B-frames whose DTS repeats on every fifth packet — the shape of the live `Non-monotonic DTS in output stream 0:0;
previous: N, current: N` log — run through the session's own arguments (copy video, fMP4 segments). **No packets are lost,
but the frame timing in the segments is uneven: DTS steps of 0 ms to 60 ms instead of a steady 20 ms** (a frame with no
duration, then one three frames long) — judder, and a plausible contributor to stalls in a player's buffer. Copy mode
cannot repair this, because it hands the source's DTS to the muxer as it finds it. **Fix:** `-fflags +igndts` on the input
of every session with `videoMode: 'copy'` — ffmpeg derives DTS from the PTS order, which is what `/api/remux` has always done
for the same feeds (and why the strategy comment in `playbackStrategy.js` records that this content "played fine over
remux"). Measured on the same input: the steps become a steady 20 ms, the packet count and segment lengths are unchanged,
DTS stays at or below PTS, and a clean B-frame stream comes out identical. Not applied to re-encodes (the encoder makes its
own timestamps). **This is the option 0073 declined** ("a bigger behavioural change than the fault needs") — for *that* fault
(audio/video clocks 23 s apart) the threshold was the narrower answer; for repeated DTS there is no narrower one, and it
also happens to fix the 0073 fault, so `test/hls-timestamp-skew.test.js` now removes `igndts` from its arguments to keep
testing the threshold on its own. **The other two log samples:** `[h264] non-existing PPS 0 referenced / decode_slice_header
error / no frame!` repeated, ending `Increasing reorder buffer to 2` — ffmpeg joining the feed part-way through a GOP
during its start-up probe, before the first SPS/PPS; harmless and self-ending (the channel that logged it played fine), it
does mean a start-up of up to one GOP. `[mp4] Packet duration: -1 / dts: N is out of range` — the same repeated-DTS fault
seen from the fMP4 muxer (reproduced; ffmpeg 9 keeps every packet, **the container's 6.1 was not tested** — so whether it
also explains the channel that *never started* is unconfirmed; the `docker logs` lines around that session id are the
next evidence). **ffmpeg upgrade considered and not done:** the same message appears on ffmpeg 9.0, and a swap touches the
hardware-driver stack under the Apple path. Tests: `test/hls-copy-dts.test.js` (3; the behaviour test fails on the old
arguments with the 0–60 ms steps). **Apple client:** every Apple live play with compatible codecs takes this path, so the
change reaches it — no client change, but it wants a device retest (see `docs/SWIFT-CLIENT-HANDOFF.md` §5).

**0086 detail — a source that ends is paced to real time (found in the HLS trial: black screen, `fragLoadError http 404`).**
Two plays of the same provider URL (`.../live/.../1803789.ts`) died a couple of seconds after the picture appeared. The
session log was identical both times: the same 15 `[mp4] Packet duration: -1 / dts: N is out of range` lines with the *same* `dts`
values in the same order, ending on the same last value, then `FFmpeg completed successfully`, then the browser's
`[Player] media-error HLS_networkError ... fragLoadError http 404 t=2s buffered=24s`. A live channel cannot repeat a timestamp
sequence, so this URL is **a file served from the start** — it ends, and ffmpeg reads it as fast as the network allows (24 s already
buffered 2 s into the play; the `dts` values reach roughly 32 minutes). An HLS session keeps 90 listed segments plus 12 spare, so
ffmpeg was half an hour ahead of the player within seconds and the segment the player asked for next had been deleted: **404, which
hls.js does not retry** — playback ends at once and the player destroys itself, leaving a black frame under the banner. The web
client's `play-end` kept counting from `play-start` until the next channel (`watched=99s stalls=0` for a black screen) — misleading,
fixed below. **Reproduced with real ffmpeg:** a 20-minute source through the session's own arguments was read in **0.7 s**, the
playlist listed `seg0210`–`seg0299`, and `seg0006` did not exist. **Why the remux path never showed it:** its output is a pipe, so the
client's read rate throttles ffmpeg (back-pressure); an HLS session writes to disk and has none. Any source that delivers faster than
real time — a file, a catch-up channel, a provider's start-up burst — runs ahead of the window; this is a property of §C, and worth
remembering for Phase 3 (and for VOD/series, which would meet it head-on). **Fix, three parts.** (1) `streamProbe.analyzeProbeResult`
gains `finite` and `durationSec` from the `-show_format` output the server already runs: measured with real ffprobe over HTTP, a file
served with a `Content-Length` reports a `size` (and a `duration` when it also supports ranges), while an open-ended chunked live
response reports neither. (2) `playbackStrategy` passes `paceInput: info.finite === true` to the HLS session, which adds **`-re`** to the
input: measured, the same 20-minute source then produces 3 segments in 14 s and `seg0000` is still there. (3) The resolve timing line
says so: `... first segment after 7.8s, source ends (32 min) - paced to real time`, so the next trial log confirms the diagnosis on the
real channel. **`-re` is gated, not blanket, on purpose:** measured on a source that was already arriving in real time, `-re` cost
about 8 s of start-up (2 segments against 4 in 16 s), so a live feed must never get it; a live source wrongly seen as finite
(a provider that sends a fake `Content-Length`) would pay those seconds but still play. **Also:** `routes/transcode.js` now logs one
`[HLS] 404 for <file> in session <id>: <why>` per session and file (session gone / file not on disk) — a 404 used to leave nothing
in the log — and `VideoPlayer.handleHlsFatal` clears the play timer so `play-end` no longer counts time after a fatal error.
`info` in the resolve response gains `finite` and `durationSec` (additive). **Answers 0085's open question:** the channel that "never
started" was this, not the timestamp warnings. **Not done:** the web player still gives up on the first fatal 404 (Phase 3's one-time
fallback to remux will cover it); nothing changes for live channels. Tests: `test/hls-finite-source.test.js` (7; six fail on the old
code, the seventh reproduces the fault by design).

**Decisions recorded 20 Sept 2026 (Mark).** (a) Start §C Phase 1 now, as a **Settings toggle**, off by default.
(b) **Stability and quality outrank channel-change speed** — a slower channel change is acceptable if that is
the price; §C Phase 2 measures what it costs and we look for what we can claw back without giving up stability.
(c) **VOD / series are kept** (Mark: a future provider may offer them). They are **unverified and unsupported
today** — there is no VOD source to test against — so treat them as latent code: don't refactor them casually,
keep them out of the dead-code batches (§5 A.6), and note that `/api/proxy/stream` still buffers a whole
progressive-MP4 body in memory (review §2.4), which a VOD file would hit. Revisit deleting them if they ever
block a refactor. If they are ever removed, tag the last commit that had them first.

**Live verification of 0054–0072 against the real server (Mark, PassyFlix, VPN'd device).**
Checklist A (web app): **A1** playback of several channels ✅ (the h264 decoder log noise it showed
became 0071); **A2** ✅; **A3** bulk hide worked but the group checkboxes did not update until a
refresh ❌ → 0072; **A4** ✅. Checklist B (server): **B2, B6, B8** ✅; **B4** (find the ffmpeg
PID: second column of `docker top pigtv | grep ffmpeg`; a session's process is the one whose
command line ends in `stream.m3u8`, a remux's ends in `-`, its output is stdout) answered; **B1, B3, B5, B7 not yet run**
— they need the Swift client / an Apple device. Optional live checks **C1–C3 not run**. The
intermittent "nothing plays on some channels" (silent failures, remux disconnecting ~10 s in) stopped
reproducing and other people reported the same channel group failing at the same time, so it is
put down as a **provider fault** for now; 0070's diagnostics will name the cause if it returns
(`docker logs pigtv | grep -E "Could not write header|never produced a byte|media-error"`).
**Decision (Mark): `requireStreamAuth` stays OFF.** The server is reached only over an approved-device
VPN (Tailscale) — it is not exposed to the internet — so the default flip (§5 A.9) is not required
now. Revisit if that ever changes.

**Post-deploy checks still owed by Mark:** badge reads **0073**; 0073 live check: play the
E-AC-3 channel that flooded the log — `docker logs pigtv | grep -c "timestamp discontinuity"`
should stay at (or near) 0 and its audio should be continuous; `docker logs`
shows redacted URLs (no provider password); on the real feed,
`SELECT COUNT(*) FROM epg_live` matches the XMLTV `<programme` count (final
verification of 0047; use `epg_live` since 0056 — `epg_programs` can briefly hold two
generations); 0054 live check (see the 0054 hand-off: cut the upstream
mid-stream and confirm the `treating ffmpeg as stalled` log line and that the
provider slot frees), plus confirm a *paused* web player is not killed; 0055 live
check: with two devices, start playback on one, then the other — expect the
"Another device is watching" prompt (web `confirm()`; Apple client per §B), and
that a device changing channel never sees a prompt about its own old stream;
0056 live check: trigger an EPG sync and confirm the guide stays populated
throughout (it used to blank for minutes), and `docker logs` shows
`Removed N superseded programmes` afterwards; 0057 live check: normal playback
still loads segments (a regression here would show as a stream that starts and
then stalls with 404s in `docker logs`), and
`curl -i "http://<host>:3000/api/transcode/<id>/..%2Fx.ts"` returns 404; 0059 live
check: favourite a channel in the web app and confirm it shows in the Apple app's
favourites (and the reverse), and that existing favourites in the web app are all
still starred; 0060 live check: the guide and channel list still show current
programmes (nothing that should be on now has disappeared); 0061 live check: set
`TZ`, then schedule a recording and confirm the file name shows your local time;
0062 live check: play a **HEVC** recording on the Apple client (delete any old
`*.native.mp4` for it first), confirm it opens, then delete a recording and confirm
its `.native.mp4`/`.compressed.mp4` disappear from the recordings folder; 0063 live
check: sign in normally (nothing changes), and confirm bulk hide/show in Settings
still saves a large selection (a 413 in `docker logs` would mean the 2 MB cap is
too tight); 0064 live check: play several live channels back to back (web player); if
any fails, `docker logs pigtv | grep -E "Codec probe failed|Not starting remux"` says why.
A 503 that clears on retry means the provider is being slow to release connections; 0065 live
check: when that channel's fault next recurs, `docker logs pigtv | grep media-error`
(and the DevTools console) should name the reason; a normal channel change must show *no* error badge; 0068 live check: play the problem channel. Expect a brief
"Playback error" badge, then "Remux (audio re-encoded)" and playback that continues
(`docker logs`: the `media-error … audio packet` line, then `Codecs: … (audio re-encode)`
on the replay). Select it again later: it should start re-encoded straight away with
no error. If it still fails after the replay, that line appears again and the browser
forgets the flag — send me it; 0069 live check: changing channel shows **no** red badge and no
`Media error … Empty src attribute` in the console or `docker logs`.

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
3. ✅ **P1-1 / A3 — viewer-vs-viewer arbitration + shorter live idle timeout**
   (0055; written, pending live verification — see §4). Live timeout is 5 min,
   not ~2 (rationale in the 0055 detail).
4. ✅ **P1-5 — atomic EPG swap** (0056; written, pending live verification —
   see §4).
5. **P1-3 (server half) — favourites id normalisation + migration** ✅ 0059. Still
   open: a derived `stable_id` so a provider reorder can't re-point favourites,
   history, or scheduled recordings. *[MED]*
6. **P2-1 — dead-code removal**, as one deliberate verify-build-guarded batch
   (`users.js`, `m3uXtreamAdapter.js`, JSON `hiddenItems`/`favorites`, OIDC +
   express-session remnants, non-VAAPI encoders, unread settings). **VOD/series are kept** (Mark, 20 Sept).
   *[MED — worth doing early; "edited a dead path" caused two prior incidents.]*
7. **P2-8 — tests for Apple-relevant paths.** *[MED]* parseStreaming under bursty
   input, `withStreamToken` on fMP4, recordings Range behaviour,
   viewer-already-holds-slot, favourites id mismatch.
8. **Pre-Tailscale hardening + refactors.** *[LOWER]* P2-2 shared helpers
   (`channelUrl`, `ffmpegProcess`, `probe`, `ids`); P2-3 guide indexes + bounds
   (✅ 0060, partial: sort index and keyset paging not done, see §4);
   P2-4 segment traversal ✅ 0057 (MIME deliberately unchanged, §4); P2-5 `?token=` in the HLS *proxy* rewriter ✅ 0058;
   P2-6 `TZ` + honoured UA for recordings ✅ 0061; P2-7 rate-limit login/pair-poll +
   1 MB body cap + `USER node` (✅ 0063: 2 MB cap, login + pairing limits; `USER node`
   deliberately not done, see §4).
9. **`requireStreamAuth` default flip.** Mark's call — **decided: stays off** while access is
   VPN-only (see the live-verification note in §4); revisit if the server is ever exposed.
10. **Review items never picked up** *(found missing from this roadmap on 20 Sept; small, one patch each)*:
    `/api/proxy/stream` buffers the whole upstream body in memory, incl. progressive MP4 and `bytes=0-` ranges
    (§2.4 — matters more now VOD is kept); no ffmpeg `-protocol_whitelist`, so `file:`/`concat:` inputs are
    accepted on the URL-taking routes (§3.5 — bounded today by the VPN-only decision); `saveDb()` swallows write
    errors so a failed `db.json` write reads as success (§2.14); ~~unknown `/api/*` paths return `index.html` 200
    instead of a 404 JSON~~ ✅ 0079; exit code 255 leaves a dead HLS session marked `running` (§2.14); `USER node`
    in the Dockerfile (needs volume ownership sorted first, see 0063). Done: ✅ 0079 unknown `/api/*` → 404 JSON, ✅ 0080
    `saveDb` errors. **Still open in this item:** `/api/proxy/stream` memory buffering; the ffmpeg protocol allow-list
    (touches the remux / HLS argument builders, so it waits until the 0075 trial is over); the exit-255 session status
    (`transcodeSession.js`, same reason).

### B. Blocked on the Swift client (server code can be written ahead; verify/land with the client)

- **0055 — handle the new `viewer-in-progress` 409.** `POST /api/playback/resolve`
  can now return the existing 409 shape with `conflict.type ==
  "viewer-in-progress"` (another device is watching). The client should show
  `conflict.message` and, if the user agrees, repeat `resolve` with `force:true`.
  Until it does, the client sees this as a generic resolve failure — better than
  the old unexplained ffmpeg timeout, but not the intended UX.
- **Version display in the Swift app** — fetch `/api/version`, show server build
  next to the app's own build.
- **0050 native gate — confirm** the client sends its bearer on `resolve` and
  `DELETE /api/playback/:id` (`?token=` is a fallback). Already shipped.
- **P1-2 — recording native playback.** Server fixes (`-tag:v hvc1`, in-flight
  remux dedupe, temp-file-then-rename, sidecar cleanup, MP2→AAC) ✅ 0062; the polling flavour
  (`?async=1` → `202 {status:"preparing"}`) ✅ 0083 — the client must opt in and poll (see
  `docs/SWIFT-CLIENT-HANDOFF.md`); HEVC playback still needs a device to confirm.
- **P1-3 (client half)** — the server now does the EPG-icon fallback in `/api/library/*`
  (0067), so the client can drop `loadArtworkIndex()` + its `/api/proxy/epg/{id}`
  download. Safe to do at any time; until then the client's own matching just becomes
  redundant.
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

**Plan (written after 0064–0066; the hardening prerequisites A1 + A3 are done).**

*What is already true — the migration is smaller than it looks.* The web player
**already plays HLS sessions**: `playDecision()` sends any `container:'hls'` decision to
`playHls()` (hls.js, or Safari-native), which is what the transcode strategy uses today.
The *only* reason the web gets `remux` is that its `resolve` request does not set
`capabilities.segmentedDelivery` (`VideoPlayer.resolvePlayback`). Setting it makes
`playbackStrategy.resolve` return a copy-mode HLS session (fMP4 segments when the codecs
are fine) instead of `/api/remux` — the same path the Apple client runs. So Phase 1 is
essentially one line on the client plus a setting; no new server code.

*Phases (each independently shippable and reversible):*
1. **Opt-in.** ✅ **0075** (written; pending live use). A Settings toggle "HLS delivery (beta)", **off by default**, that sets
   `segmentedDelivery:true` in the web's resolve call. Mark uses it for a week. Rollback =
   untick it. Also the immediate test for the unreproduced remux fault: if that channel
   plays via HLS, the remux path is the culprit.
2. **Measure** before deciding a default: time-to-first-frame and stall/`media-error` rate
   for both paths. 0065's `client-event` endpoint is the vehicle — the `play-start` / `play-end` events
   and the `resolve timing` log line shipped with Phase 1 (0075). **Now: Mark uses the toggle for about a
   week, then we read the logs and decide.**
3. **Default on, with a safety net.** If an HLS session fails to start (the 15 s
   `waitForPlaylist` timeout, a fatal hls.js error), fall back *once* to remux for that
   play — the self-heal in the other direction — so a bad channel never becomes a dead one.
4. **Retire remux** only after a clean run of Phase 3: delete `routes/remux.js`, the
   coordinator's remux branches, `stallWatchdog`'s remux wiring, `-bsf:v dump_extra`, the
   legacy `GET /api/transcode?url=` pipe, the web's direct `/api/remux` callers
   (WatchPage, VideoPlayer fallbacks) and their tests. This is also when P2-1's dead-code
   batch stops being risky to sequence.

*Risks and what covers them:* (a) **slower channel change** — a session must spawn ffmpeg
and write the first segments (`SEGMENT_DURATION` is 4 s; startup is seconds, not the pipe's
near-instant) → measure in Phase 2; if unacceptable, look at shortening the first
segment(s) rather than abandoning the path. (b) **provider slot held by
an idle session** → 0055 already reclaims a session idle ≥60 s on demand and replaces a
device's own; the 5-min live sweep covers the rest. (c) **browser variance in hls.js /
Safari-native** → fMP4 segments are the same ones the Apple path uses; 0065 now surfaces
element errors. (d) **AC-3** → served as HLS copy/transcode, not the remux (0066 fixed the
remux case regardless). (e) **tmpfs** → 2 GB, ~360 MB/session capped; fine for one viewer.
(f) **direct-play HLS upstreams** stay `direct` — unaffected.

*Decisions for Mark:* **answered 20 Sept 2026** — start Phase 1 now, as a Settings toggle; and "acceptable"
channel-change time is whatever stability and quality allow (stability first; Phase 2 reports the cost and we
see how much can be won back without giving any up).

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
- **Dead-code batch timing** — decided: early, in reviewable patches that do not touch the remux path (that
  part waits for §C Phase 4). VOD/series are *excluded* (kept — see §4, decisions of 20 Sept).
- ~~`requireStreamAuth` flip timing~~ — decided: off while access is VPN-only; revisit if exposed.
- ~~AC-3 through the remux path~~ — fixed in 0066 (`delay_moov`); still unverified in a real
  Safari.
- **Stall timeout tuning** — 20 s default (`PIGTV_STALL_TIMEOUT_MS`) is a
  conservative guess for long-GOP sources; tighten only after watching the real
  feed's `[TranscodeSession]`/`[Remux]` stall logs for false positives.

---
---

# Snapshot 2 — `blueprint.md` at build 0104 (23 September 2026, before the refresh)

# PigTV server — handover (single source of truth)

**Last updated:** 23 September 2026 (build 0100)

Authoritative handover for PigTV **server / webapp** work. Keep it **short**: it is read at the start of every session.

| Document | Use it for |
|---|---|
| `blueprint.md` (this) | Current state, durable knowledge (§4b), roadmap, decisions, disciplines |
| `docs/SWIFT-CLIENT-HANDOFF.md` | What the Apple client must change, its test tips, and a log of server changes it should know about (§5 there) |
| `server-review.md` | Point-in-time code review (16 Sept 2026): the file:line *why* behind roadmap items named "P1-x / P2-x". Many items are since fixed — this file tracks status |
| `docs/blueprint-archive.md` | Frozen pre-condensing copy of this file with the full per-patch write-ups (0048–0086). **Historical; don't read routinely** |
| `../PigTV-Swift/blueprint.md` | The Apple client's current state, roadmap and verification; replaces its old handovers |

## Core Requirements and Guidelines
We are developing an IPTV server with a supporting webapp and Swift clients (iPad / Apple TV); the server and webapp are this repository.
Wherever possible ensure **stream stability and quality**, and **reduce overhead and complexity**.
As progress is made, keep this file current for handover — and keep it small (condense, don't append narrative).

---

## 1. Orientation

| | |
|---|---|
| Repo | `github.com/maroge1990/PigTV` |
| Deployment | Unraid box "PassyFlix", image `ghcr.io/maroge1990/pigtv`, `http://192.168.1.235:3000`, reached over an approved-device VPN (Tailscale) only |
| Local repo folder | `C:\Users\markr\GitHub\PigTV` (moved out of OneDrive, 21 Sept 2026) |
| Patch folder | `C:\Users\markr\GitHub\patches\PigTV` |
| Shipped through | **build 0104** once applied; 0100/0101 on `origin/main`. Confirm with `/api/version` |
| Next patch number | **0105** |
| Container name | **`PigTV`** on PassyFlix — every command in these docs names it literally, so it can be pasted as written. `docker ps` if it is ever renamed |

Don't hard-code the `origin/main` SHA anywhere. The deployed build is whatever `/api/version` reports (§3).

---

## 2. How patches are delivered

Each change ships as a numbered `git format-patch` file continuing the running sequence: commit on a local
`patch-NNNN-*` branch **based on the previous patch's branch if that one isn't on `origin/main` yet** (never on `main`, never
pushed), run `git format-patch -1 --start-number N -o "C:\Users\markr\GitHub\patches\PigTV"`, give a size sanity-note and **both**
command blocks. Check the patches apply in order on a throwaway `git worktree` of `origin/main`. Mark pushes; Claude never pushes
(Claude may apply patches to the working folder's `main` if asked — Mark then only pushes).

**Apply + push (PowerShell):**
```powershell
cd "C:\Users\markr\GitHub\PigTV"
git fetch origin
git checkout -B main origin/main
git am "C:\Users\markr\GitHub\patches\PigTV\NNNN-<subject>.patch"   # one line per patch, in order
git push origin main
```
**If `git am` says `previous rebase directory .git/rebase-apply still exists`:** a stale state folder from an earlier interrupted
`am` (happened twice, while the repo still lived in OneDrive). Run `git am --quit` (keeps HEAD and files; **not** `--abort`,
which can rewind commits), then repeat. The suspected cause — OneDrive syncing the repo with GitHub Desktop open on it — no
longer applies since the move, so a recurrence means something else and is worth chasing rather than shrugging off.

**Pull + recreate + verify (Unraid / Docker):**
```bash
docker pull ghcr.io/maroge1990/pigtv:latest
docker compose up -d --force-recreate pigtv     # recreate, not restart (or Force Update on the Unraid Docker tab)
curl -s http://192.168.1.235:3000/api/version      # confirm the build number
```
A redeploy restarts the container and ends every session — avoid it mid-trial unless fixing a fault the trial found.

---

## 3. Version & build identity (the testing instrument)

`server/version.js` is the single source of truth: product semver (`package.json`) + a **`build`** number equal to the last patch
applied, bumped by every functional patch *in its own diff*. `/api/version` and `/api/info` return it; the webapp's top-left
badge shows `display` (e.g. `v3.7.0 · build 0086`). Git SHA / build time can be stamped via Dockerfile `PIGTV_COMMIT` /
`PIGTV_BUILT_AT` (inert if unset). Docs-only commits don't bump it.

---

## 4. Shipped log

Full write-ups: `docs/blueprint-archive.md`. Facts worth keeping are in §4b.

**0033–0047 (prior agent):** `segmentedDelivery` HLS for the native client, stream-token propagation to segments, AAC-in-fMP4 fix,
native recording-playback contract (0045), HLS on-disk bounding (0046), EPG streaming-parser backpressure (0047).
⚠️ `-bsf:v dump_extra` was tried (0043) and **reverted (0044)** for corrupting live copy sessions — never add it on a copy path.
It left with remux (0103) except in one place: `transcodeSession.js`'s MPEG-TS copy branch for a video codec that is neither
H.264 nor HEVC (e.g. MPEG-2). Not seen in any log; remove it only against a captured sample of such a feed (§7).

| Patch | What |
|---|---|
| 0048 | Build identity (§3) |
| 0049 | Live HLS `temp_file` + `hls_delete_threshold` (torn playlist / rolled-out segment stalls) |
| 0050 | Auth gate: `requireAuth` on `/api/channels`, `/api/probe`; token on subtitle, resolve, `DELETE /api/playback/:id`. `requireStreamAuth` default unchanged |
| 0051 | Dropped the dead `ffmpeg-static` require |
| 0052 | Provider-credential redaction in logs / `/sessions` / errors |
| 0053 | `db.json` in-memory write-through cache |
| 0054 | ffmpeg output-inactivity watchdog (remux and HLS) |
| 0055 | Viewer-vs-viewer arbitration + 5-minute live idle timeout |
| 0056 | Atomic EPG swap via generations (`epg_live`) |
| 0057 | HLS segment route allow-list (traversal fix) |
| 0058 | `?token=` carried through the HLS *proxy* rewriter |
| 0059 | Favourites: bare channel id canonical + startup migration |
| 0060 | Guide query bounds + item-id index |
| 0061 | Recording file names in local time (`TZ`); recordings honour the UA setting |
| 0062 | Recording native playback: `hvc1`, remux dedupe, atomic output, sidecar cleanup, MP2→AAC |
| 0063 | 2 MB body cap; login and pairing rate limits |
| 0064 | Remux: reliable codec identification (fixes "Malformed AAC bitstream") |
| 0065 | `POST /api/playback/client-event`; web player reports media errors |
| 0066 | Remux: AC-3 / E-AC-3 (`delay_moov`) |
| 0067 | EPG-icon `logo` fallback in `/api/library/*` |
| 0068 | Audio re-encode self-heal for the remux path (`audioEncode`) |
| 0069 | Fix: 0065 reported every channel change as an error |
| 0070 | Diagnostics for silent "nothing plays" + remux start-up measurements |
| 0071 | Quiet probe-phase decoder chatter; real line buffer for ffmpeg stderr |
| 0072 | Fix: Hide All / Show All left group checkboxes stale |
| 0073 | `-dts_delta_threshold 60` (A/V start-time skew flooded HLS sessions and dropped audio) |
| 0074 | Housekeeping: `access.test.js` runs on Windows (junction) |
| 0075 | §C Phase 1: "HLS Delivery (beta)" toggle + `play-start` / `play-end` measurement |
| 0076 | Dead code (a): `users.js`, `m3uXtreamAdapter.js`, `hello.js` |
| 0077 | Dead code (b): OIDC/SSO + express-session (two dependencies dropped) |
| 0078 | Dead code (c, part 1): JSON-file `hiddenItems` / `favorites` in `db.js` |
| 0079 | Unknown `/api/*` → JSON 404; Apple-client route guard test |
| 0080 | A failed `db.json` write is reported, not swallowed |
| 0081 | `scripts/playback-report.js` (turns saved logs into the HLS-vs-remux trial report) |
| 0082 | Recordings in `waiting` are listed, cancellable, not duplicated |
| 0083 | `?async=1` recording-playback polling + `/api/info` capability flags + the Swift hand-off doc |
| 0084 | Playback report keeps Apple-device plays apart from the web trial |
| 0085 | Copy-video HLS sessions ignore the source's DTS (`igndts`) |
| 0086 | Sources that end are read at real time (`-re`); `[HLS] 404` log line; `play-end` stops counting after a fatal error |
| 0087 | Fix: cancelling the webapp takeover prompt no longer falls through to the local path and takes the stream anyway |
| 0088 | `igndts` decided per feed from the probe (supersedes 0085, which applied it to every copy) |
| 0090 | `scripts/stream-doctor.js`: the timestamp diagnostics as a supported tool (0089 was docs) |
| 0093 | Captured samples go on the data volume, so a redeploy stops destroying the regression corpus |
| 0094 | `GET /api/playback/:id/terminal-status`: a displaced client can tell takeover from an ordinary failure |
| 0095 | CI stamps `PIGTV_COMMIT` / `PIGTV_BUILT_AT`, so `/api/version` proves what is running |
| 0096 | P1-3 part 1: `stable_id`, a channel identity a provider reorder cannot move (nothing keyed on it yet) |
| 0097 | P1-3 part 2a: favourites follow the channel, not the position |
| 0098 | P1-3 part 2b: scheduled recordings and watch history do too |
| 0099 | SR-2 (client R15): strip the decorative small-caps "ᴸɪᴠᴇ" badge from EPG titles/sub-titles/names and M3U channel names at ingest (shared `textCleanup.js`, ranges match the client) |
| 0100 | SR-1 (client R13): an HDR copy session is handed out via `master.m3u8` carrying `VIDEO-RANGE=PQ\|HLG` |
| 0101 | Test-only (no build bump): the watchdog's "keeps writing is left alone" test used 300 ms limits and failed CI's Node 20 job under load; now 1.5 s. **CI runs every test file at once on 2 vCPUs — keep timing margins ≥1 s** |
| 0102 | §C Phase 3: the web player is on the one path — always resolve + HLS, one re-resolve per selection as its recovery; local strategy, beta toggle, force-* settings gone; VOD page's remux → HLS copy sessions |
| 0103 | §C Phase 4: **remux retired** — `routes/remux.js`, the legacy piped `GET /api/transcode?url=`, their coordinator/resolve branches, `findCachedCodecs`, four unread settings and their tests deleted (589-line route, 454 lines of tests). HLS sessions are the only delivery path |
| 0104 | Session hardening: honest exit status (unrequested 255/signal = error), software-decode retry only for a GPU-decoding encode with no playlist yet, network-only URLs at every entry (`streamUrl.js`), `/api/proxy/stream` streams, dead `persist`/`restore`/`getOrCreateSession` gone |

---

## 4b. What to know before touching each area

**Provider slot and viewers** (`streamCoordinator.js`)
- The provider allows **one stream** (`maxProviderStreams`, default 1; a recording holds a slot of its own). To admit a viewer the
  slot is freed in this order: streams idle ≥ `viewerIdleTimeoutSec` (60 s) silently → the caller's *own* earlier stream silently →
  another owner's live stream, which needs confirmation: **409** `{conflict:{type:"viewer-in-progress", streamId, lastActiveSec,
  message}}`, overridden by `force:true` (same shape as `recording-in-progress`). Owner keys: `device:<id>` (paired device) /
  `user:<id>` (web login). `admitViewer()` releases before the new stream starts. `POST /api/transcode/session` (the movie/series
  page) uses **soft** mode (reclaim only, never 409 — its caller can't answer a prompt). HLS sessions are the only streams (0103).
- Live sessions are swept after **5 min** idle (`PIGTV_LIVE_IDLE_TIMEOUT_SEC`, checked every 60 s); seekable sessions 30 min. Not
  ~2 min on purpose: the 60 s rule already reclaims on demand, and a TV paused through a phone call shouldn't die (the 90-segment
  window has rolled past a ~6-minute pause anyway).
- **Stall watchdog** (`stallWatchdog.js`): kills an ffmpeg with no output for `PIGTV_STALL_TIMEOUT_MS` (20 s; 30 s grace before first
  output; HLS floor of 5 segments). *Output* = any file written in the session dir — **not** stderr (it gets louder during
  reconnects). Recordings (hard-stop timer) are not covered.
- Consequence: a viewer paused >60 s is "stale"; a due recording takes the slot silently instead of prompting.
- **Telling takeover from failure** (0094). A displaced client only sees a 404, the same as an expired session or a stalled feed;
  recovering from that takes the connection back off whoever just got it, and the two clients ping-pong. Owner equality cannot
  break the tie — two password logins are both `user:<id>`. So every release `admitViewer` performs leaves a short-lived record
  (`terminalRecords`, ~15 min, `PIGTV_TERMINAL_STATUS_TTL_SEC`, in memory) that only that session's owner can read, via
  **`GET /api/playback/:sessionId/terminal-status`** → `taken-over` | `none`. Non-consuming; anything else is `none`, so it cannot
  be used to discover that somebody is watching. **Only `admitViewer` writes records** — an explicit `DELETE`, the idle sweep, the
  stall watchdog and a recording reclaiming a stale stream all go elsewhere and leave nothing, which is what keeps ordinary
  recovery working. Releases now carry a `cause` (`idle` / `replacement` / `forced-takeover`) and the log line says which.

**HLS sessions** (`transcodeSession.js`, `playbackStrategy.js`)
- Shape: 4 s segments, playlist of 90 + 12 spare (`hls_delete_threshold`) ≈ 102 kept; flags `independent_segments+delete_segments+temp_file`
  (atomic playlist swap; margin for a client re-requesting a just-rotated segment). No `append_list`. Directory on tmpfs (2 GB).
- fMP4 segments when copying video and (HEVC, or codecs fine): hls.js can't demux HEVC from MPEG-TS, and TS's strict ordering
  flooded "Invalid DTS" on feeds that were fine over remux. HEVC fMP4 needs `-tag:v hvc1`. AAC copied into fMP4 needs
  `-bsf:a aac_adtstoasc` (ADTS→ASC; it refuses non-AAC, so only for AAC).
- Input timestamp flags: **`-dts_delta_threshold 60`** (default 10 s let feeds whose audio and video clocks start >10 s apart
  "jump" on every packet: thousands of log lines and half the audio dropped; env `PIGTV_DTS_DELTA_THRESHOLD_SEC`). **`-fflags +igndts` only for a copy-video
  session whose feed the probe called uneven** (0088; `PIGTV_DTS_AUTO=0` restores 0085's unconditional version). Two populations
  of feed exist and one flag cannot serve both — see "Two kinds of feed" below. **`-re` only when the probe says the source ends.**
- **Two kinds of feed, and why one flag cannot serve both** (0088). Measured on four captured channels:
  a feed is **uneven** when a third of its video DTS steps are ~1 tick followed by a double — an upstream muxer bumped repeated
  DTS by +1 instead of fixing them (Fox Sports 505: with `igndts`, even frames and no warnings; without, ~1015 "Non-monotonic
  DTS" a minute). A feed is **even** when its DTS is simply correct (TSN, Sky Sports UHD, Sportsnet 4K) — and there `igndts`
  *causes* the fault: ffmpeg discards a good clock, re-derives it from the PTS reorder buffer, and emits zero-length frames
  followed by double-length ones. **0085 applied it to every copy session, so it fixed one population and broke the other** —
  the reason spot fixes kept trading one report for another. Reverting 0085 only swaps which channels break.
  `streamProbe.classifyTimestamps()` decides it: mean video frame period over the probe's packets, count steps below a quarter
  of it, >5% ⇒ uneven. Measured 33.8% vs 0.0%, so the threshold is nowhere near either. It does **not** count repeated or
  backward DTS — on a real feed those are already gone, and the near-zero step is what survives. `null` (no packets, <20, an
  older cache entry) ⇒ keep the source's DTS.
- **The classification rides on the resolve probe's own ffprobe call** (`-show_packets -read_intervals %+#300`). It must stay in
  that one call: the provider allows a single connection, so a second ffprobe collides with it. `-read_intervals` is what bounds
  it — without it `-show_packets` on a live feed never returns and the probe hits its 15 s timeout, i.e. nothing plays at all.
  Measured on the box (ffprobe 6.1.1, live HTTP): terminates at exactly 300 packets (~145 KB), ~157–179 of them video, and costs
  nothing (−360 ms and +165 ms on two channels — noise; the packets come from bytes `-probesize` already reads).
- **HDR needs a master playlist, not colour flags** (0100). Measured 23 Sept on `pos_31` Sky Sports Main Event UHD: source
  **HDR10 (PQ) + BT.2020, HEVC Main 10** (not HLG, as the client's SR-1 guessed), and the copied fMP4 `init.mp4` already keeps
  `colr`/`nclx` with the same values. Yet tvOS stayed SDR in both players: a media playlist has no `VIDEO-RANGE`, and Apple
  treats that as SDR. `streamProbe.classifyVideoRange()` reads `color_transfer` off the resolve probe (no extra connection);
  a **copy + fMP4** session with PQ/HLG gets `options.videoRange` and resolve returns `/api/transcode/{id}/master.m3u8`
  (built in memory; one variant → `stream.m3u8`). **No `CODECS`** on purpose — a wrong string makes AVPlayer refuse the variant.
  An encode is never called HDR (its output isn't). SDR is byte-for-byte unchanged. `mdcv`/`clli` boxes are absent (tvOS reads
  the SEI). Known sample: `pos_31` HDR10, timing even.
- **HLS sessions have no back-pressure** (a session writes to disk; nothing throttles ffmpeg to the player's read rate).
  A source that delivers faster than real time — a file served from the start (found on a provider URL), a catch-up channel, a
  start-up burst — runs ahead of the ~102-segment window and the player's next segment is gone: **404, which hls.js does not
  retry** (fatal at once, black frame under a `fragLoadError` banner). Fix = pace the input, gated by the probe: `format.size` or
  `duration` present ⇒ finite (a file with a `Content-Length` reports a size; an open-ended chunked live response reports
  neither). **Never blanket `-re`:** on a live-rate source it cost ~8 s at start-up. Remember this for Phase 3 and for VOD/series.
- **How a session ends** (0104). `stop()` marks it `stopped` *before* signalling ffmpeg, so the exit handler can tell "we ended it"
  (→ `stopped`, whatever code: 255 after SIGTERM, null after SIGKILL) from "it ended" (anything but 0 → `error`, logged
  `FFmpeg exited with code N` / `FFmpeg was killed (SIGNAL)`). An unrequested 255 used to leave the session `running` with no ffmpeg.
  The **software-decode retry** (clear the folder, restart with CPU decode) now happens only for an *encode* that really decoded on
  the GPU (`_usedVaapiDecode`) and died within 10 s **before any playlist** — it used to fire for copy sessions too (i.e. every live
  session), 404ing a client already fetching, for a restart that could not help.
- **Only network URLs are opened** (0104, `services/streamUrl.js`: http(s), rtmp(s), rtsp(s), udp, rtp, srt). Checked with a 400 at
  resolve, `POST /api/transcode/session`, `/api/probe`, `/api/subtitle` (whose `index` must be a number: it is a `-map` spec), and
  again where ffprobe/ffmpeg are spawned. Chosen over `-protocol_whitelist` because stream-doctor and the tests run the server's own
  ffmpeg arguments against local sample files.
- Start-up cost = the resolve-time probe + ffmpeg's own 5 MB / 5 s input probe + one 4 s segment. ffprobe result cached 5 min per
  URL. Trial logs: typically 7.5–9.6 s to first picture, 14 s occasionally (probe 3.6–6.6 s of it). Long keyframe spacing (≥10 s)
  can make a join fail ("Could not find codec parameters … unspecified size", exit -22); a smaller probe makes it worse — not shipped.
- The image's ffmpeg is Ubuntu 24.04's apt package (6.x). An upgrade was considered and rejected: the same warnings appear on 9.0,
  and it touches the hardware-driver stack under the Apple path.

**Audio that the browser rejects.** `audioEncode:true` on resolve makes the HLS session re-encode only the audio (AAC-LC,
video still copied) and beats the "smart copy" shortcut. Reason: **Chrome aborts the whole `<video>` on one rejected audio
frame**, and a copy hands it the provider's damaged frames. The web player replays once per selection on an audio
`MEDIA_ERR_DECODE` and remembers the channel in `localStorage['pigtv_audio_encode']` (max 200; clear it to reset). (Until 0103
this lived on the remux route, `?audio=encode`, with its own codec probe, `delay_moov` for AC-3 and line buffer — all in git.)

**Reading ffmpeg's log** — harmless, recurring:
`[h264] non-existing PPS/SPS referenced`, `decode_slice_header error`, `no frame!`, `Increasing reorder buffer` (joining mid-GOP
during the probe; self-ending); `Could not find codec parameters … eac3 … 0 channels`
(probe window ended early; if audio is ever silent from the start, suspect it — longer `-analyzeduration` for E-AC-3);
`[mp4] Packet duration: -N / dts: M is out of range` and `[hls] Non-monotonic DTS … changing to +1` — **not noise since 0088**:
a flood of these on a copy path means the feed was classified wrong. Check the channel's `[Playback] resolve timing` line, which
now ends `source timing even - DTS kept` / `uneven - DTS rebuilt` / `unknown - DTS kept`. A handful per hour is still normal. Real problems: `Could not write header`, `Codec probe failed`,
`FFmpeg exited with code`, `Releasing stalled session`, `[HLS] 404 for …`.

**`scripts/stream-doctor.js` — reach for this first on any playback fault** (0090). Five subcommands: `list <search>`,
`capture <pos_N> [sec]` (60 s of the real feed + a verdict), `classify <sample>`, `bench <sample>` (runs the server's *own*
argument builders once per candidate flag set and scores ffmpeg's warnings and frame-timing evenness), `probecost <pos_N>`.
Run it as `docker exec PigTV node scripts/stream-doctor.js …`. `capture` and `probecost` open a provider connection, so
**nothing may be playing**; the rest only read files. It reuses `streamProbe.classifyTimestamps` and `redact` rather than
copying them, so its verdict is by construction the one the server will act on. **The lesson worth keeping: a 60-second
capture turns a playback bug into a local, repeatable experiment and removes the redeploy cycle entirely — and a redeploy ends
every session. It found the 0085 regression, and the two-populations result, in an afternoon after weeks of spot fixes.** Channel ids are `pos_N` (`item_id` in `playlist_items`); the provider's numeric stream id
appears only inside the URL, and the URL itself is in the row's `data` JSON blob, not `stream_url`. Known samples: `pos_31` Sky Sports
Main Event UHD (HDR10, even); `pos_1187` Fox Sports 505 uneven; `pos_463` TSN, `pos_328` Sky Sports UHD (HEVC), `pos_468` Sportsnet 4K (a ~190 kbps slate) all even.

**Diagnostics and the trial** (`routes/playback.js`, `VideoPlayer.js`, `scripts/playback-report.js`)
- `POST /api/playback/client-event` (token required; whitelisted, bounded fields; **path only, never a query string**): events
  `media-error`, `start-timeout` (30/min limit) and `play-start`, `play-end` (120/min, separate budget). Log lines end
  `from=user:<id>` (web) or `from=device:<id>` (Apple). Grep: `docker logs PigTV 2>&1 | grep -E "\[Player\]|\[Playback\]|\[HLS\]"`.
  `[Playback] resolve timing: <direct|HLS session>, probe <X s|cached>[, first segment after Y s][, source ends (N min) - paced to real time]`.
- `scripts/playback-report.js`: `docker logs PigTV --since 24h > x.log` then `node scripts/playback-report.js x.log`. It parses
  the exact log wording (pinned by `verify-build.sh`) and reports per path first-picture time (cold/warm), stalls/hour, failures,
  device plays separately, and the trial criteria (≥50 plays per path, ≥3 HLS sessions of ≥1 h, no HLS-only failures, stalls/hour no
  worse than remux — constants at the top of the script). The log never names a channel; stall rates need ≥10 min watched.
- **Web player (0102): one path.** `play()` always calls resolve with `segmentedDelivery:true` (the Apple client's request) and plays
  what comes back; there is no browser-side strategy any more (no own probe, remux, legacy pipe or force-* settings; the beta toggle is
  gone). **Recovery = ask the server again, once per selection** (`recoverPlayback`): a resolve that fails, or a fatal hls.js error —
  including a segment 404, which hls.js never retries — gets one fresh session; a fatal *media* error is first tried in place
  (`hls.recoverMediaError()`, once). A second failure is shown, never looped. The audio re-encode self-heal now applies to HLS plays too.
  Subtitles: the live player adds no `/api/subtitle` tracks — that route opens a second provider connection (the removed local path
  was the only caller). Chrome keeps the *previous* URL in `currentSrc` while raising "Empty src attribute" on `video.src = ''` —
  detect a cleared source from the `src` attribute (`isSourceCleared`), and make `vm` test fixtures model real Chrome.
- **Movie/series page** (`WatchPage.js`, latent VOD): probes, then anything not browser-ready goes through `POST /api/transcode/session`
  (the only path that can resume, via `seekOffset`); what used to be remuxed is an HLS **copy** session in fMP4.

**Data, guide and library**
- Guide: query **`epg_live`** (each source's active generation), never `epg_programs`; a sync loads generation *active+1*, flips
  `active_gen` in one statement, deletes the old one in 20 000-row slices; a failed/empty feed leaves the live guide untouched; needs
  ~one extra guide of disk during a sync. Guide/now-next queries bound `start_time > from − 24 h` (`MAX_PROGRAMME_MS`) so the index
  range-scans — a programme that began >24 h before the window is not shown.
- `/api/library/*` fill a missing `logo` from the EPG channel with the same tvg-id, else the same name (case/spacing ignored); a
  playlist logo is never replaced; index cached 5 min; name matching can pair same-named channels.
- **Small-caps "ᴸɪᴠᴇ" badge stripped at ingest** (0099, SR-2): `services/textCleanup.js` `stripBadgeSuffix` is applied to EPG
  `title`/`sub-title`/`display-name` (both `epgParser` parse paths) and the M3U channel `name` (`m3uParser.parseExtinf`, so it also
  cleans derived `pos_N`-fallback tvg-ids). The code-point ranges match the client's `String.strippingBadgeSuffix()` exactly, so
  the client's interim stripper is now redundant. Only a *trailing* run of modifier/small-cap glyphs is removed — mid-title text is
  untouched. **It only cleans what is ingested after the deploy:** a redeploy skips any source synced <24 h ago (`syncIfStale`),
  so 0099 looked like it had failed until a manual Sync now (confirmed clean 23 Sept). Any ingest-time change needs a sync to show.
- **Channel identity vs playlist position** (0096–0098). `item_id` is `pos_N`, the M3U line number, and the provider moves it:
  on 21 Sept a reorder shifted Fox Sports 505 from `pos_1187` to `pos_1185` and a favourite was seen playing a different channel.
  `playlist_items.stable_id` (`services/stableIds.js`) is what a channel *is* — the provider's stream id out of the URL
  (`s441360`), a hash of the credential-stripped URL otherwise, NULL for a row with no URL. On the real playlist: 18 322 of
  18 323 from the stream id, 0 missing, **845 channels listed more than once**.
  Favourites (`favorites.stable_id`), scheduled recordings (`scheduled_recordings.channel_stable_id`) and `channel_history`
  all key on it, backfilled at startup, with `item_id` kept only as the fallback for rows that have **no** identity.
  **The trap, and it was caught by a test rather than by reading:** a row that HAS an identity still carries the position it was
  made at, and that position may now be a different channel — so matching must never fall back to it. Any new query joining these
  tables needs `(x.stable_id IS NOT NULL AND p.stable_id = x.stable_id) OR (x.stable_id IS NULL AND p.item_id = x.item_id)`,
  and a `GROUP BY` on the identity, or the 845 duplicates show up several times in a list.
  Only *pending* schedules are backfilled: rewriting a completed one would misstate what was recorded. Drift that already
  happened is not recoverable — the migration keeps whatever a row now points at.
- **Favourites: bare channel id is canonical** (`services/channelIds.js`); `initSchema` rewrote prefixed rows at startup (one-way,
  in `content.db`); `GET /api/favorites` re-presents the composite form the web matches on (`?format=bare` gives stored form).
  Open: derived `stable_id` (a provider reorder shifts `pos_N`).
- `db.json`: in-memory write-through cache; `saveDb` rejects on failure, rolls back the in-memory copy unless a newer save
  overtook it, keeps the write queue alive, and gives clients a plain sentence (path stays in `docker logs`). Legacy `hiddenItems` /
  `favorites` arrays are dropped on the next write.
- Auth is stateless bearer tokens (web login + paired devices); **no sessions or cookies** (express-session and OIDC removed in 0077 —
  if SSO is ever wanted it's in git history, but device pairing fits better). `requireStreamAuth` stays **off** (VPN-only).
- Limits: `express.json` 2 MB; failed logins 10 / 15 min per (socket address, username) → 429 + `Retry-After` (keyed on the socket,
  not `X-Forwarded-For`); pairing 60 start / 1 500 poll per 10 min; all in-memory. HLS segment names allow-listed
  (`seg\d{4,}.(ts|m4s)` and `init.mp4`); fMP4 segments are still served as `video/MP2T` on purpose (revisit with a device on hand).
  The HLS *proxy* rewriter carries `?token=`. Unknown `/api/*` → `404 {"error":"No such API endpoint"}`; **add any new Apple-client
  endpoint to `APPLE_CLIENT_ROUTES` in `test/api-404.test.js`.**
- `/api/proxy/stream` **streams** binary content (0104; it used to buffer the whole body, so a progressive VOD file sat in memory and
  an endless source never reached the client) and aborts the upstream fetch when the client leaves. Playlists are still read whole —
  they have to be rewritten. VOD/series are latent code (§8).

**Recordings** (`recordingEngine.js`, `routes/recordings.js`)
- Statuses `scheduled → waiting → recording → …`; `waiting` = due but held back by a viewer; it is included in the upcoming list,
  cancellable (cancelling also withdraws the viewer prompt) and in the duplicate check.
- File names use the server's **local** time: set `TZ` (compose passes `TZ=${TZ:-UTC}`; the Unraid template needs it too, e.g.
  `Australia/Sydney`). The recording ffmpeg uses `db.getUserAgent(settings)`.
- Native playback = a `.native.mp4` remux (`-tag:v hvc1` — ffmpeg's default `hev1` is refused by AVFoundation; MP2 audio →
  AAC), concurrent requests share one remux, written as `.partial` then renamed, existing files probed once per run, sidecars
  removed with the recording. Old HEVC sidecars are `hev1` and not regenerated: delete `*.native.mp4` for HEVC recordings once.
  **HEVC playback in AVPlayer has never been confirmed on a device.**
- `GET /api/recordings/:id/playback` blocks until ready (legacy). With **`?async=1`**: 200 as before when ready; **202
  `{status:"preparing",retryAfterSec:3}`** + `Retry-After: 3`; **500 `{status:"failed",reason:"remux-failed"|"file-missing",error}`**
  once, then a fresh attempt on the next ask. A fresh attempt gets a 1.5 s grace before answering 202.
- `/api/info` `features` flags: `recordingPlaybackPolling`, `scheduledWaiting`, `viewerConflict`, `epgLogoFallback`, `clientEvents`
  (plus the original `playbackResolve, library, guide, devicePairing, recordings, streamCoordination, streamTokenAuth`).
  `routes/info.js`'s handler is async with no `try/catch` (cosmetic today).

**Dev environment (Windows)**
- Tests: `node --test test/*.test.js` (~290, none skipped since 0103 removed the POSIX-only remux watchdog test). `verify-build.sh` takes the repo path
  (`bash scripts/verify-build.sh .`) and needs a real `python3` on PATH (a one-line `exec python "$@"` shim) with `PYTHONUTF8=1`.
- Tests that copy `server/` into a temp sandbox link `node_modules` with a *junction* on Windows. Working tree is CRLF (autocrlf).
  Where `ffmpeg` is a launcher shim (chocolatey), killing the process orphans the real one — end test runs with `-t`, don't kill.
- Every functional patch adds a `verify-build.sh` check *and* a test that fails on the old code (reintroduce the bug to prove it).

---

## 5. Roadmap

**Guiding direction (committed): one server path, one contract** — HLS segments from `playbackStrategy.resolve()`, with a thin
native player per platform (hls.js / Safari on the web, AVPlayer on Apple). The two-path split (remux for web, HLS for native) was
the source of most recurring defects (favourites ids, logos, resolve shape, flags duplicated across files, `dump_extra`).
**Done (0102–0103): one path.** The web plays through resolve + HLS and the remux route is gone.

### A. Server backlog (client-independent)
1. ✅ **Session hardening** (0104): exit status, software-decode retry, network-only URLs, streaming proxy, dead session code.
2. **Dead code still held:** `cache.js` + the upstream Xtream/EPG proxy routes + non-streaming `epgParser`/`m3uParser` functions
   (kept by Mark's 21 Sept decision), non-VAAPI encoders, any unread settings left (0103 dropped four). The plugin loader / `PLUGINS.md` is kept on purpose (empty extension point).
3. **P1-3 — part 1 shipped in 0096; part 2 is the remaining work.**
   **Part 1 (0096, done):** `playlist_items.stable_id` — what a channel *is*, from the provider's stream id inside its URL
   (`/live/<user>/<pass>/441360.ts` → `s441360`), falling back to a hash of the credential-stripped URL, and NULL for a
   placeholder row with no URL. Derived by `services/stableIds.js`, backfilled at startup, rewritten by every sync, and
   deliberately **not unique** — a channel cross-listed twice is two rows with one identity. Nothing is keyed on it yet, so
   0096 changes no behaviour; the sync logs `[Sync] Channel identity: …` so the derivation can be checked against the real
   18 000-channel playlist before anything depends on it.
   **Measured on the real playlist (21 Sept, 18 323 live rows):** 18 322 identities came from the provider's stream id, 1 from a
   URL hash, **0** with no URL; 17 127 distinct, **845 channels listed more than once**. The derivation is essentially total, and
   the duplicate count is what forced `library/favourites` to group by identity.
   **Part 2a (0097, done):** favourites. Keyed on the identity, migrated at startup, with the stored `item_id` used only for rows
   that have no identity — **a row that has one must ignore its stored position, or the stale id reintroduces the whole bug**
   (caught by a test, not by review). A channel listed twice is now one favourite.
   **Part 2b (0098, done):** scheduled recordings and `channel_history`. A schedule resolves its identity when it is *made* and
   prefers it at record time, so a reorder in between can no longer record the wrong programme. Only **pending** schedules are
   backfilled — rewriting a completed one would misstate what was actually recorded. History is joined the same way, grouped so a
   cross-listed channel appears once in "recently watched".
   **What none of it can do: favourites that had already drifted are already wrong**, and the migration preserves whatever they
   now point at. Mark should walk his favourites once after 0097 and fix any that look odd; after that they stay put.

   *Background — why the position was ever the id.* On 21 Sept the provider reordered its playlist mid-session:
   Fox Sports 505 moved from `pos_1187` to `pos_1185` within six hours (same channel, same URL, same provider stream id), and
   **a favourite was observed pointing at a different channel that evening**. `pos_N` comes from the channel's position in the
   M3U, so every id after an insertion shifts. Favourites, `channel_history` and scheduled recordings all key on it — a
   recording scheduled for one channel would record another. Needs a `stable_id` derived from something intrinsic; the provider's
   numeric stream id inside the URL survived both the reorder and is not the credentials (which rotate, and are why 0015 moved
   *off* a URL hash in the first place). Re-keys three tables; its own patch.
   Related, same day: the same channel is listed at **two** positions with an identical URL, so a favourite on one does not match
   the other and the recording duplicate-check may not see them as the same programme. `stable_id` gives both rows one identity,
   which is what part 2 needs to fix that too.

   **P1-4:** `resolve` returns an opaque handle instead of a credentialed `?url=` (contract change for both clients).
4. **Tests for Apple-relevant paths (P2-8):** EPG parser under bursty input, `withStreamToken` on fMP4, recordings Range,
   viewer-already-holds-slot.
5. **Lower:** shared helpers (`channelUrl`, `ffmpegProcess`, `probe`, `ids`); paged-channel-ordering index and keyset paging;
   `USER node` (needs volume ownership sorted first); fMP4 segment MIME; the duplicate `stop()`; try/catch in `info.js`.

### B. Apple client
See `docs/SWIFT-CLIENT-HANDOFF.md` (prioritised changes C1–C9, contract, test tips, and a change log). Nothing on the server blocks
it. Server ideas built only if asked: a **session keep-alive** riding the 5 s conflict poll (so a short pause can't lose the stream;
recommendation: skip — the client needs its recovery path either way, and the 60 s rule protects recordings), and **codec names on
`recordings/{id}/playback`** (only if an Apple TV fails an HEVC recording).

### C. Converge the webapp onto the one path (committed; the last step)
1. ✅ **Opt-in** (0075).
2. **Measure** — cut short by decision (Mark, 23 Sept: "move away from multiple approaches asap"); the report was not run. Mark uses the toggle for about a week, then saves logs and runs the report. The trial has already found
   and fixed two real faults (0085 uneven timestamps in copy sessions; 0086 finite sources outrunning the window). **Still to confirm
   after deploying them:** the channel that stopped and started (its `play-end` `stalls=`); the finite channel (provider stream id
   `1803789`) plays and its resolve line ends `source ends (N min) - paced to real time` — if not, check what ffprobe reports:
   `docker exec PigTV ffprobe -v error -show_entries format=size,duration -of default=nw=1 "<channel URL>"`.
3. ✅ **Default on** (0102). The safety net is a fresh HLS session rather than remux (which step 4 deletes): see "Web player" in §4b.
4. ✅ **Remux retired** (0103), straight after step 3 by the same decision: `routes/remux.js`, the coordinator's remux branches,
   the legacy `GET /api/transcode?url=` pipe and their tests are gone. `/api/remux` now answers the JSON 404.

Risks: slower channel change (measured above; if it must be won back, shorten the first segment or skip the resolve probe for known
sources — measure first); a session holding the provider slot (60 s reclaim + 5 min sweep); browser variance (fMP4 is what the Apple
path uses); AC-3 (HLS copy/transcode); tmpfs 2 GB (~360 MB/session cap) — fine for one viewer; direct-play HLS
upstreams stay `direct`.

---

## 6. Frozen Apple-client contract (do not change without a client patch)

- **`/api/library/guide`** rows: `id`, `sourceId`, `name`, `logo`, `category`, `tvgId`, `programmes[]` with `startTime`/`endTime` in **ms**.
- **`/api/recordings/{id}/markers`**: camelCase `startMs`/`endMs`.
- **`/api/recordings/{id}/playback`**: bearer required; `{url:"/api/recordings/{id}/media.mp4", container:"mp4", durationSec}`;
  `media.mp4` takes `?token=`, supports byte ranges, `+faststart`. (`?async=1` is opt-in and additive.)
- **Favourites:** client writes `POST/DELETE /api/favorites` (bare id), lists via `/api/library/favourites`.
- **Playback:** `POST /api/playback/resolve` with `capabilities.segmentedDelivery:true`; `playbackURL` allow-list
  (`/api/proxy/stream`, `/api/transcode/…`, `/api/recordings/…`; `/api/remux` is gone since 0103 and was never handed to it); token as `?token=`; bearer on `DELETE /api/playback/{id}`.
- **Additive, safe:** `/api/version` and `/api/info` fields (`build`, `commit`, `display`, `features`); `waiting` rows in
  `recordings/scheduled`; `finite` / `durationSec` in the resolve `info`.
- Client-coupled server changes are flagged in the handover and logged in `docs/SWIFT-CLIENT-HANDOFF.md` §5.

---

## 7. Standing disciplines

- **Diagnose a playback fault from a capture of the real channel before changing anything.** `scripts/stream-doctor.js`
  (§7a) turns it into a local, repeatable experiment; a redeploy costs a session and an evening. **No ffmpeg-flag or
  timestamp patch ships on a hypothesis** — 0085 did, and silently broke a whole class of channel that nobody had a sample
  of. If a fault cannot be captured, say so and treat any fix as provisional.
- Every functional patch pairs with a `verify-build.sh` check and a test that fails on the old code.
- Each functional patch bumps `version.js` `build` to its own number, in its own diff. Docs-only commits don't.
- Nothing in §6 changes without a coordinated client patch. **Every patch that changes what the Apple client sends or receives
  adds a row to `docs/SWIFT-CLIENT-HANDOFF.md` §5 in the same patch** (including changes to `transcodeSession.js` /
  `playbackStrategy.js`, which reach the Apple client even when no response shape changes).
- Deliver both command blocks together with a size note; patch files go to `C:\Users\markr\GitHub\patches\PigTV` (§2). Claude commits
  only on a local `patch-NNNN-*` branch and never pushes.
- Say plainly when tests / `verify-build.sh` could not be run, and give Mark live-test steps for anything that needs the real feed.
- Reference docs: `blueprint.md`, `server-review.md`, `docs/SWIFT-CLIENT-HANDOFF.md` (the archive is history, not reference).
- **Update this doc at the end of each session — and condense as you go:** replace narrative with the fact worth keeping (§4b),
  one line in §4, and move nothing back in from the archive.

---

## 7a. When a channel misbehaves

The loop that works, in order. Mark can do steps 1–4 alone; steps 2 and 4 are the ones worth pasting into a session.

1. **Note the channel name and roughly when.** The log never names a channel, so this is the only link back to it.
2. **Ask what the server decided**, before touching anything:
   `docker logs PigTV --since 30m 2>&1 | grep -E "resolve timing|\[HLS\]|Non-monotonic|Packet duration"`.
   Each play's `resolve timing` line ends `source timing even - DTS kept` / `uneven - DTS rebuilt` / `unknown - DTS kept`
   (0088). A flood of timestamp warnings against a play classified the other way is a misclassification — that is the
   whole diagnosis, and the sample below proves it.
3. **Find its id:** `docker exec PigTV node scripts/stream-doctor.js list "<name>"` → `pos_N`.
4. **Capture and bench it, with nothing playing** (both take the provider's only connection):
   `… stream-doctor.js capture pos_N` then `… stream-doctor.js bench /app/data/samples/pos_N.ts`.
   `capture` prints the verdict; `bench` shows what the shipping arguments produce against the forced alternatives.
5. **Keep the sample.** They are the regression corpus: any future flag change gets tried against every one of them
   before it ships, which is exactly what 0085 had no way to do. Known so far (21 Sept): `pos_1187` Fox Sports 505
   **uneven**; `pos_463` TSN, `pos_328` Sky Sports UHD (HEVC), `pos_468` Sportsnet 4K (a ~190 kbps slate) all **even**.
   They live in **`/app/data/samples`**, which is the bind mount (`./data:/app/data`) and so survives a deploy. 0090 wrote
   them to `/app/samples` — the writable layer — and `docker compose up --force-recreate` destroyed the first corpus before
   anything had been retested against it (fixed in 0093). **A sample is evidence: it has to outlive the build it was taken on.**

Channel ids are `pos_N` (`item_id` in `playlist_items`); the provider's numeric stream id appears only inside the URL,
and the URL itself is in the row's `data` blob, not `stream_url`.

---


## 8. Decisions, open questions and checks still owed

**Decided (Mark, 20 Sept 2026).**
- §C Phase 1 as a Settings toggle, off by default.
- **Stability and quality outrank channel-change speed** — a slower change is acceptable if that's the price; Phase 2 reports the cost.
- **VOD / series are kept** (a future provider may offer them) but are **unverified and unsupported** (no VOD source to test
  against): latent code, excluded from dead-code batches, don't refactor casually. If ever removed, tag the last commit that had them.
- **`requireStreamAuth` stays off** while access is VPN-only; revisit if the server is ever exposed.
- Dead-code batches go early, in reviewable patches.
- Mark applies and pushes patches.

**Decided (Mark, 23 Sept 2026).**
- **One delivery path now** — §C Phases 3 and 4 shipped together (0102–0103) without waiting for the trial report: "move away from
  multiple approaches asap". The web's recovery is a fresh HLS session, not a remux fallback.

**Decided (Mark, 21 Sept 2026).**
- **Keep the Xtream/upstream proxy path and `cache.js`.** Likely wanted in the near future, so they stay out of the dead-code
  batches (§A.2 is now only the other items listed there).
- **Images are built by GitHub Actions on push to `main`** (`.github/workflows/docker-publish.yml`) — that was never in doubt,
  only undocumented. 0095 passes the commit and build time through, so `/api/version` carries them instead of `dev`.

**Open.**
- **Bug 2 is unexplained**: `[mpegts] Invalid timestamps … pts=X, dts=X+1800` (DTS *ahead* of PTS) on the mpegts segment path.
  None of the four captures reproduced it and playback was reported stable, so 0088 deliberately does not claim it. Needs the
  channel that produced it — the resolve-timing log line now names how each was classified, which should find it.
- **The classifier has seen one uneven feed out of four.** The margin is huge (33.8% vs 0.0%) but it should be checked across
  more channels; post-deploy the `source timing …` log line does this for free over an evening.
- Stall timeout tuning: 20 s is a conservative guess for long-GOP sources; tighten only after watching real stall logs for false positives.
- Session keep-alive / codec names on recording playback (§5 B) — build only if asked.

**Live checks never recorded as done** (status unknown as of 20 Sept — tick off or drop when seen):
0054 cut the upstream mid-stream → `treating ffmpeg as stalled`, slot frees, a *paused* web player isn't killed ·
0055 two devices: the second gets "Another device is watching", a device changing channel never sees a prompt about itself ·
0059 a favourite made in the web shows in the Apple app and back · 0062 an **HEVC** recording plays on the Apple client
(delete old `*.native.mp4` first); deleting a recording removes its sidecars ·
0073 `docker logs PigTV | grep -c "timestamp discontinuity"` stays ~0 on the E-AC-3 channel · Apple-device checks B1/B3/B5/B7
from the original list need the Swift client.

**Verified live (21 Sept):** 0056 EPG sync keeps the guide populated · 0061 recording file names in local time (`TZ` is set) ·
0063 a large bulk hide/show saves · `/app/transcode-cache` really is a 2 GB tmpfs (`docker exec PigTV df -h /app/transcode-cache`
→ `tmpfs 2.0G`), so segment churn never touches the array · 0087/0088 deployed, and across the first 12 plays every feed
classified `even - DTS kept` with **zero** `Non-monotonic DTS` (against ~33 000 timestamp warnings in the 24 h before).

**Already verified live (20 Sept):** web playback of several channels (A1 → 0071), bulk hide (A3 → 0072), 0071–0073 deployed and
working, 0085 running. The intermittent "nothing plays on some channels" stopped reproducing while others saw the same channel group
fail — put down to the provider; 0070's diagnostics will name it if it returns
(`docker logs PigTV | grep -E "Could not write header|never produced a byte|media-error"`).
