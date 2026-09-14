# PigTV — developer handover

Written 14 September 2026, at version 3.6.0, for whoever picks this up next —
including a future AI session starting without the conversation that produced
it.

This is not a feature list; the README covers that. It is the reasoning, the
things that have already gone wrong, and the state of play.

## What this is

A self-hosted web player for live IPTV, forked from
[nodecast-tv](https://github.com/technomancer702/nodecast-tv) at commit
`0e26a90`, rebuilt around scheduled recording and a smarter playback pipeline.

It runs as a Docker container on Unraid, for one user, against a single IPTV
provider. Almost every design decision follows from that last constraint.

## The environment it actually runs in

Assumptions that are safe here and would not be elsewhere:

- **One user.** No multi-tenancy concerns. Viewer/admin roles exist but only
  one account does.
- **One provider connection.** Strong8K permits a single concurrent stream.
  This is the single most consequential fact about the system, and the reason
  the stream coordinator exists.
- **A very large playlist.** Around 18,000 channels, 24 categories, and an EPG
  carrying roughly half a million programmes. Anything that is O(channels) per
  request will be too slow; several endpoints were rewritten once for this.
- **Intel VAAPI with gaps.** The GPU encodes but its scaling pipeline and rate
  control are both partial. Working around this took several attempts.
- **Recordings on a remote SMB mount**, separate from app data.
- **LAN only today**, with Tailscale planned. Stream endpoints are
  unauthenticated by default for this reason.

## Architecture, and why

### Playback strategy lives on the server

`services/playbackStrategy.js` decides how to play a stream, given what the
client says it can decode. It prefers, in order: direct play, container remux,
transcode — and when it must transcode, it re-encodes as little as possible.

This logic used to live in the browser. Moving it was the prerequisite for
native clients: a tvOS app cannot sensibly reimplement it, and two
implementations would drift. Clients now call `POST /api/playback/resolve` and
play whatever URL comes back.

The web player still has its original local logic as a fallback, used only if
the endpoint is missing. That can be deleted once nothing needs it.

### Capabilities are asked for, not assumed

The probe originally hardcoded "browsers play H.264" and so re-encoded every
HEVC channel — the single largest performance problem the project had. Clients
now report what they can decode via `MediaSource.isTypeSupported`, and the
server believes them.

With one exception, learned the hard way: **Chrome reports support for HE-AAC
and then fails to decode it.** So HE-AAC is detected by stream profile and
always re-encoded, regardless of what the client claims. See `streamProbe.js`.

### Identity comes from position, not metadata

M3U channel IDs are derived from the entry's position in the file, not from
`tvg-id` and not from a hash of the URL. Both alternatives were tried and both
lost channels:

- `tvg-id` is an EPG matching attribute and is **deliberately shared** between
  regional feeds of the same network.
- The stream URL is shared by channels **cross-listed in several categories**,
  and by placeholder entries that have no real URL.

Position is the only value unique per line. Changing this again would need the
same care.

### Provider order is preserved everywhere

The provider positions placeholder entries meaningfully — a category header
sits immediately above the channels it introduces. Alphabetical sorting
destroys that, so `sort_order` is carried on both `playlist_items` and
`categories`, and **four separate client-side sorts had to be removed** before
the order survived to the screen.

Consequence worth remembering: display names must never be used as sort keys.
Stripping flag emoji from category names silently reordered everything, which
is why the emoji are left alone.

### Recording is server-side and survives restarts

`services/recordingEngine.js` runs a 15-second tick, independent of any
browser. Recordings are stream copies, so they are the source bitrate —
roughly 4 GB/hour — and inherit the source codec.

The engine starts **before** the sync, deliberately: a stale EPG source blocked
startup for ten minutes, during which a due recording would have been missed
outright.

### The stream coordinator

`services/streamCoordinator.js` arbitrates the single provider connection
between viewing and recording. The policy was chosen by the owner:

| Situation | Behaviour |
| --- | --- |
| Recording due, stream silent > 60s | Reclaim it without asking. A silent session is a closed laptop, not a person. |
| Recording due, someone watching | Ask once, 5 minutes ahead. Never ask again for that recording. |
| Viewer declines | Recording waits in status `waiting`, retried every tick, starts the moment playback stops, flagged partial with the missing span recorded. |
| Programme ends while still watching | Marked missed, with the actual reason. |
| Viewer starts playback during a recording | `409` with the conflict described; the client repeats with `force: true`. Forcing finalises the recording rather than discarding it. |

`waiting` had to be added to both `findDueToStart` and `findMissed`, without
which a held-back recording is stranded in a status nothing queries.

Not handled: watching the same channel that is recording. It is currently a
conflict, though logically it need not be. Solving it means teeing the
recording output to the player. Deliberately deferred.

### Post-record work

Two queues, both serial, neither competing with an active recording.

**Ad detection** runs automatically on every finished recording, using Comskip.
It **marks breaks rather than cutting them**: a false positive removes
programme content permanently and is only discovered while watching. Markers
are shown on the scrub bar and offered as a Skip button.

**Compression** runs only when asked, from the Recordings page. The disk space
is already spent by the time a recording finishes, and most recordings are
watched and deleted, so compressing everything would spend GPU time on files
about to be thrown away.

The asymmetry is intentional: markers must exist before you sit down to watch;
compression is worth doing only once you have decided to keep something.

Detection runs before compression, because it reads the original frames.

### Device pairing

A TV cannot have a password typed into it. A device requests a code, displays
it, and polls; a signed-in user approves it; the device collects a long-lived
token exactly once. The token is an ordinary JWT carrying a `deviceId`, so the
existing auth path validates it unchanged. Revocation is checked on **every
request**, not at expiry, so removing a device signs it out immediately.

## API surface for clients

Native clients should use these and ignore `/api/proxy/xtream/*`, which exists
to emulate an Xtream provider and is an internal detail.

```
GET  /api/info                       version, apiVersion, feature flags, comskipAvailable
POST /api/playback/resolve           { sourceId, channelId, capabilities, force? } -> playable URL
                                     409 when a recording holds the provider stream
GET  /api/playback/conflict          a recording wants the stream; null when nothing to say
POST /api/playback/conflict/decline  { scheduleId }
DELETE /api/playback/:sessionId      release what resolve started
GET  /api/library/categories         provider order, with counts
GET  /api/library/channels           paginated, now/next, favourite flag
GET  /api/library/guide              time-window grid, paginated by channel
GET  /api/library/favourites         decorated, same shape as /channels
GET  /api/library/recent             recently watched
POST /api/devices/pair/start         unauthenticated; device has no token yet
GET  /api/devices/pair/poll?code=    token delivered once
POST /api/devices/pair/approve       requires a signed-in user
GET/DELETE /api/devices              list, revoke
GET  /api/recordings/:id/markers     detected ad breaks
POST /api/recordings/:id/detect-ads  detect or re-detect
POST /api/recordings/:id/compress    compress on request
```

Ask `/api/info` for feature flags rather than comparing version numbers.

## Things that have already gone wrong

Read this section before changing anything. Each of these passed syntax checks
and tests, and each shipped.

**`CREATE TABLE IF NOT EXISTS` silently skips an existing table.** Adding a
column to a table definition does nothing on an existing database. Twice: once
for `sort_order`, once for a second table that reused the name `watch_history`.
Both needed `ALTER TABLE` migrations. `scripts/verify-build.sh` now rejects
duplicate table names.

**Code can be correct and on a dead path.** Category ordering and flag
stripping were implemented in `m3uXtreamAdapter.js`, which the live route does
not use — it reads from a local helper in `proxy.js`. The change was real and
had no effect.

**A partially failed edit still commits.** A script that errored halfway left
`syncService.js` and `m3uXtreamAdapter.js` unmodified while their companion
changes were committed. The feature looked implemented and did nothing. This is
why verification greps the files rather than trusting the diff.

**CSS nesting is real in Chrome.** A theme block placed inside `:root` resolved
to `:root [data-theme="light"]` — valid, parsed, matching nothing.

**`npm ci` fails on a lockfile mismatch.** Installing a package locally for
testing bumped a range in `package.json` and broke CI. Use `--no-save`.

**Stream endpoints cannot use header auth.** A `<video src>` and AVPlayer both
issue a plain GET. Hence `?token=`, and hence stream URLs being bearer tokens
in their own right.

**`req.on('close')` also fires when the response ends.** A failing ffmpeg was
being logged as a client disconnect, which sent an investigation in entirely
the wrong direction.

## VAAPI, specifically

The working configuration was found by the owner, not derived:

- `-init_hw_device vaapi` and `-filter_hw_device`, **not** `-hwaccel_output_format vaapi`
- scale on the CPU, then `hwupload`
- no `-pix_fmt yuv420p` after `hwupload`
- `LIBVA_DRIVER_NAME=iHD` in the container environment
- compression must use **CQP**: this driver rejects a bitrate target outright

Both hardware behaviours are settings (`vaapiCpuScale`, `vaapiHwDecode`) so
they can be changed without a rebuild, and hardware decode falls back to
software automatically if a session dies within ten seconds.

## Workflow

Changes are delivered as a single patch applied on top of `origin/main`:

```powershell
git fetch origin
git checkout -B main origin/main
git am path/to/patch.patch
git push origin main
```

Then pull the image and recreate the container on Unraid. Pushing to `main`
builds and publishes `ghcr.io/maroge1990/pigtv` automatically.

Before publishing a change: run `scripts/verify-build.sh`, apply the patch to a
clean clone, and run it again there. The second run is the one that matters —
it is what catches a change that exists locally but never made it into the
patch.

There is a second AI agent contributing. It produced the access-hardening PR
and is working on the Swift client. Check `main` before assuming what is there.

## Where things stand

**Deployed but untested: 3.5.0 and 3.6.0.** The provider went down before
either could be exercised. The stream coordinator touches the recording
scheduler, so it warrants real testing rather than assumption.

Worth running when the provider returns:

1. Coordinator, both directions: schedule a recording, watch a channel, decline
   the prompt, confirm no second prompt, stop playback, confirm the recording
   starts and is flagged partial. Then start playback during a recording and
   confirm the `409` and the confirmation.
2. Ad detection: enable it, record something with adverts, check the markers on
   the scrub bar. Tuning `docker/comskip.ini` for Australian broadcasters is
   expected work.
3. Compression on request, confirming the CQP fallback still engages.

**Backlog**, in the order last agreed:

- Watching the channel that is currently recording
- Enforcing `requireStreamAuth` — it works, but the web player does not yet
  append a token, so turning it on breaks the browser
- Detecting a missing recordings mount; today a vanished SMB mount is written
  to silently inside the container
- Series and recurring recordings
- Surfacing `comskipAvailable` in Settings rather than requiring a curl
- Server-Sent Events instead of polling, if the conflict prompt feels laggy

**The native clients** are a separate effort. tvOS is the primary platform; the
web app is settling as a desktop administration and viewing tool and is not
being redesigned. Mockups exist for the Apple side, built around a top tab bar,
shelves, and a guide as the default screen.
