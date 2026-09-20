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
| Shipped through | **build 0082** (0054–0080 are on `main`; 0081–0082 written) |
| Next patch number | **0083** |
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
  remux dedupe, temp-file-then-rename, sidecar cleanup, MP2→AAC) ✅ 0062; HEVC
  playback still needs a device to confirm, and the `202 {status:"preparing"}` part
  needs the client to poll instead of erroring on non-200.
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
