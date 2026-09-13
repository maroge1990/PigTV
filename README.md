<p align="center">
  <img src="public/img/pigtv-logo.png" alt="" height="96" />
</p>

<h1 align="center">PigTV</h1>

<p align="center">A self-hosted web player for live TV, with a DVR.</p>

---

PigTV turns an IPTV subscription into something you'd actually want to use: a guide you can read, channels that stay where the provider put them, and recordings that keep running whether or not a browser is open.

It's a fork of [nodecast-tv](https://github.com/technomancer702/nodecast-tv), rebuilt around scheduled recording, a smarter playback pipeline, and a set of fixes for very large playlists.

## What it does

**Live TV.** Fast channel switching, categories in the order your provider intended, and search across the whole playlist. Tested against 17,000 channels.

**Guide.** A scrolling EPG grid built from XMLTV data. Click a channel to tune it, click a programme to record it. Only the channels you've chosen to see are loaded, so the guide stays quick even when the source carries guide data for fifty thousand channels.

**Recording.** Schedule from the guide with per-recording pre-roll and post-roll. Recording happens server-side, so closing the browser doesn't stop it. Recordings survive restarts unless the server goes down mid-recording, in which case the partial file is kept and the schedule is marked failed. There's a free-space floor that refuses to start a recording that would fill the disk, and stops one that's about to.

**Playback that doesn't work harder than it needs to.** PigTV asks your browser what it can decode, then picks the cheapest path that works: direct play, a container remux, or a transcode. Video is only re-encoded when there's genuinely no alternative. On a machine with VAAPI, decode and encode both run on the GPU.

**Movies and series** are supported when your provider offers them, and can be hidden entirely when it doesn't.

## Running it

PigTV is published as a container image. The example below matches a typical Unraid setup.

```yaml
services:
  pigtv:
    image: ghcr.io/maroge1990/pigtv:latest
    container_name: pigtv
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./recordings:/app/recordings
    devices:
      - /dev/dri:/dev/dri          # hardware transcoding
    environment:
      - JWT_SECRET=change-this     # see below
      - LIBVA_DRIVER_NAME=iHD      # Intel: forces the modern driver
    restart: unless-stopped
```

Open `http://<host>:3000` and sign in. The first account you create is the admin.

**Set `JWT_SECRET`.** Without it the app falls back to a value that's in this repository, and anyone who knows it can forge a session. Generate one with `openssl rand -hex 32`. Changing it signs everyone out once.

**Map `/app/recordings`** at somewhere with room. If the host path isn't mounted when the container starts, the app will create the directory inside the container instead, and your recordings will vanish on the next update. Check that the first recording lands where you expect.

**Give the container time to stop.** Recordings are closed gracefully on shutdown, which takes a few seconds. A stop timeout below about 15 seconds risks truncated files.

## Sources

Add sources under Settings. Two kinds are supported:

- **M3U or Xtream Codes** for the channels themselves.
- **XMLTV** for guide data, matched to channels by `tvg-id`.

They can be the same provider or different ones. After adding or changing a source, run a sync — channel identity and ordering are written during sync, not at startup.

## Hardware transcoding

Pass `/dev/dri` into the container and set the encoder under Settings → Transcoding.

Intel integrated graphics need `LIBVA_DRIVER_NAME=iHD` to use the modern driver. Without it some chips expose a VAAPI encoder but no working scaling pipeline, and transcodes fail to start.

Two toggles are available if your hardware misbehaves:

- **Decode on the GPU** keeps decoding off the CPU. If a session fails to start, PigTV retries once with software decode automatically rather than leaving you with nothing.
- **Scale on the CPU** works around chips without a usable VAAPI scaling pipeline. On by default.

## When something goes wrong

**A stream is stuck playing after you closed the tab.** Settings → Debug lists every active stream with its age, and kills them individually or all at once. Each one holds a connection to your provider, which matters if your subscription allows only one.

**Playback fails on one channel but works on others.** Open the browser console. PigTV logs the codecs it found and the strategy it chose. `video=copy` means no re-encoding; `video=encode` means it's doing real work and will be slower.

**Channels appear under "Uncategorized".** Run a sync. Category assignment is written during sync.

**The guide is empty.** Check that your XMLTV source has synced and that its channel IDs match the `tvg-id` values in your playlist.

## Building from source

```bash
git clone https://github.com/maroge1990/PigTV.git
cd PigTV
npm install
npm start
```

Requires Node 20 and ffmpeg with your platform's hardware acceleration support.

Pushing to `main` builds and publishes a container image automatically via GitHub Actions.

## Credits

Built on [nodecast-tv](https://github.com/technomancer702/nodecast-tv) by technomancer702. The DVR, the playback strategy work, and the large-playlist fixes are additions on top.
