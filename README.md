<p align="center">
  <img src="public/img/pigtv-logo.png" alt="" height="96" />
</p>

<h1 align="center">PigTV</h1>

<p align="center">A self-hosted live TV server with a guide, a DVR, a web app and native Apple TV, iPad and iPhone clients.</p>

---

PigTV turns an IPTV subscription (M3U or Xtream Codes, plus XMLTV guide data) into a guide you can read, channels in the
order your provider intended, recordings that run on the server, and sport events gathered across channels. It is built
for one household on a private network (it is reached over a VPN) and a provider that allows one stream at a time.

This repository is the **server and the web app**. The Apple client is
[PigTV-Swift](https://github.com/maroge1990/PigTV-Swift). It started as a fork of
[nodecast-tv](https://github.com/technomancer702/nodecast-tv); the fork's movies, series and plugin code have been removed.

## What it does

- **Live TV on one playback path.** Every play asks the server (`POST /api/playback/resolve`), which probes the channel and
  starts an HLS session that copies what the client can decode and re-encodes only what it can't. Frame rate and HDR are
  declared in a master playlist so an Apple TV switches to 50 Hz or HDR.
- **Guide** from XMLTV, with channel numbers (labels; the provider's order is kept), channel health, EPG matching for channels
  the guide doesn't cover, and a logo cache.
- **Recordings** scheduled from the guide, made on the server, with ad-break detection (Comskip).
- **Sport:** events recognised per programme across every channel, with a follow list, replays and a 72-hour horizon.
- **Web app:** Home, Live TV, Guide, Recordings, a Status page for the admin, and Settings (sources, channel numbers, EPG
  matching, sports, devices, users).
- **An optional tuner model** (`PIGTV_TUNER=1`, off by default and not yet tested live): shared tuners, hours of
  timeshift, watching a recording while it records.

## Running it

PigTV is published as a container image, built by CI after the tests pass. A typical setup (Unraid shown):

```yaml
services:
  pigtv:
    image: ghcr.io/maroge1990/pigtv:latest
    container_name: PigTV
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data               # database, settings, logo cache, samples; back it up
      - ./recordings:/app/recordings   # recordings; somewhere with room
    tmpfs:
      - /app/transcode-cache:size=2g   # live HLS sessions
    devices:
      - /dev/dri:/dev/dri              # optional: VAAPI hardware transcoding
    environment:
      - TZ=Australia/Sydney            # required: recording file names use local time
      - LIBVA_DRIVER_NAME=iHD          # Intel VAAPI only
    restart: unless-stopped
```

Open `http://<host>:3000` and sign in; the first account created is the admin. Add sources under Settings → Sources, then
sync each one with its refresh button (⟳, "Refresh Data"; the docs call it **Sync now**). Pair an Apple device under Settings → Devices.

- `JWT_SECRET` is optional. Without it the server creates a random key once and keeps it in `data/auth-secret`; if you set
  it, it must be at least 32 characters.
- Map `/app/recordings` to a real host path, or recordings live inside the container and vanish on the next update.
- Give the container 15 s or more to stop, so recordings close cleanly.
- Every `PIGTV_*` environment variable, with its default, is in [`blueprint.md`](blueprint.md) §9.

## Developing

```bash
git clone https://github.com/maroge1990/PigTV.git && cd PigTV
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # Node 24; better-sqlite3 does not build on Node 26
npm ci
npm test                          # node --test; tests that need ffmpeg skip without one
bash scripts/verify-build.sh .    # asserts features live where they should
npm start                         # http://localhost:3000
```

Needs Node 22 or 24 (CI tests both; the image runs 24) and ffmpeg. Pushing to `main` runs the tests and publishes
`ghcr.io/maroge1990/pigtv:latest` (and a `sha-<short>` tag) only if they pass.

## Where to read next

| Document | For |
|---|---|
| [`blueprint.md`](blueprint.md) | Start here: how everything works, how changes ship and deploy, the roadmap and its status, the configuration reference, and the known limitations |
| [`docs/SWIFT-CLIENT-HANDOFF.md`](docs/SWIFT-CLIENT-HANDOFF.md) | The contract with the Apple client, the `/api/info` flags, and every client-visible server change |
| [`docs/ROADMAP-CONTRACTS.md`](docs/ROADMAP-CONTRACTS.md) | The server ↔ client contracts C-A…C-I |
| [`docs/TEST-BLOCK.md`](docs/TEST-BLOCK.md) | The device and live test rounds and their results |
| [`docs/archive/`](docs/archive/README.md) | Frozen history |

## Licence and credits

GPL-3.0 (see [`LICENSE`](LICENSE)). Built on [nodecast-tv](https://github.com/technomancer702/nodecast-tv) by
technomancer702; the DVR, the playback pipeline, the Apple client contract and the large-playlist work are additions on top.
