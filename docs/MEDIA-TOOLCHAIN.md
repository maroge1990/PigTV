# Production media toolchain (0306)

0306 prepares **FFmpeg and ffprobe 9.0.2** for the Linux amd64 image and Linux CI. Mark approved upgrading production
on 28 Oct to remove the test/deployment version mismatch. It is a separate change from 0305's reconnect timeline fix.
**Local checks pass; the Linux image has not been built here (no local Docker). CI image validation, adversarial review
and device/hardware acceptance remain pending. Nothing has been deployed.**

## One release and recipe

- `docker/media-toolchain.conf` pins the release archive hashes for [FFmpeg 9.0.2](https://ffmpeg.org/download.html)
  and [nv-codec-headers 11.1.5.3](https://github.com/FFmpeg/nv-codec-headers/tree/n11.1.5.3).
- `docker/build-media-tools.sh` checks both downloads, including cached files, before building. The FFmpeg checksum was
  computed from the official archive and independently matched the installed Homebrew formula. The downloaded PGP
  signature was not verified (no GPG installed); no signature-verification claim is made.
- Docker's `media-build` and `.github/actions/setup-media-tools` use that same recipe on **Ubuntu 24.04 amd64**.
  It explicitly enables software H.264/HEVC, AAC, MP3, VAAPI, NVENC/NVDEC, CUDA scaling, QSV, HTTPS and SRT. FFmpeg's own
  libraries are static in the tools; external codec/driver libraries come from Ubuntu 24.04. Those system packages and
  Node are still allowed security updates; this is release/feature parity, not bit-for-bit reproducibility.
- The image puts `/opt/pigtv-ffmpeg/bin` first on PATH and does not install the distro ffmpeg executable. Comskip still
  links Ubuntu's separate libav* libraries; the new static FFmpeg libraries do not replace that ABI. Existing Intel/Mesa
  driver packages and the entrypoint/device-group behaviour remain unchanged.
- NVIDIA headers use the oldest API FFmpeg 9's configure explicitly accepts, with a documented minimum Linux driver of
  470.57.02. This avoids selecting current moving headers that require much newer drivers. Actual GPU execution still
  requires acceptance on the host. QSV keeps the existing libmfx API; its upstream deprecation warning is expected.
- `scripts/check-media-tools.js --hardware` rejects a wrong release of **either** tool, missing software/hardware
  encoders or filters (including `scale_cuda`), and missing HTTPS/SRT support. It checks compiled support without opening
  a GPU or provider. Build failure or a missing capability stops the image; there is no fallback to a stripped build.

No production session, recording or probe command-line flags change. Apple capabilities, endpoint shapes and the 30 s
hold remain unchanged. This is not a fix for FR-22's startup stall or unmeasured iPhone sound timing.

## Validation before publication

1. Node 22 and 24 CI use the pinned pair, cached by recipe/hash, before running the full suite and build verifier. Performance reporting
   remains separate/non-blocking. The release tests run on Ubuntu 24.04 rather than moving `ubuntu-latest`.
2. The publish job builds **without pushing**, loads `pigtv:candidate`, verifies its actual binaries/capabilities and runs
   `npm test` inside that final runtime image. The checked-out `.github` directory is mounted read-only because it is
   excluded from the image. That disposable container's writes never enter the image being published.
3. Only after the candidate tests pass does the job tag and push **that same image**, with the existing metadata tags and
   build identity. It does not rebuild after validation. Container smoke also checks exact versions/capabilities.
4. No local push or CI dispatch was performed. These new Linux build/runtime checks cannot be claimed passed until
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

## Offline comparison, 28 Oct

Official 6.1.1 was built in `/private/tmp/pigtv-ffmpeg-upgrade/baseline`, leaving the installed 9.0.2 pair unchanged. The
6.1.1 build has native demux/remux/audio support and no optional external encoders or hardware; an initial x264-enabled
configure failed because local pkg-config is absent. This comparison covers the session's copy-video/audio paths,
**not** the old production build configuration, Linux loader, GPU drivers or cross-version performance.

The original corpus's seven server samples are not available locally. Available broadcast sample: the existing FOX
capture used for FR-22. No new provider capture was taken. Two additional samples were generated offline, outside the
repository: 16 s H.264/59.94/AAC-LC and HEVC Main10/HDR10-tagged/50/HE-AAC. The HDR sample is synthetic tagged video,
not a claim to validate real HDR mastering/image quality. The recording test uses the same one-second synthetic HE-AAC
fixture on every OS, rather than silently substituting AAC-LC on Linux.

For **each** of the three samples, with each ffmpeg/ffprobe pair first on PATH:

```bash
node scripts/stream-doctor.js bench --via-ingest <sample.ts>
```

All six commands complete; **12/12 URL-versus-ingest verdicts are SAME**, covering fMP4 copied A/V and TS copied video /
audio handling. Between versions, segment counts/durations, frame counts and timing outliers match:

| Sample | Segments / duration | Video timing, both versions | Warnings |
|---|---|---|---|
| FOX capture | 20 / 76.78 s | 4602 packets, 16.683 ms, no outliers/backwards | Copied fMP4: 20 existing packet-duration warnings on both; TS branch: none |
| H.264 59.94 + AAC-LC | 4 / 16.00 s | 959 packets, 16.683 ms, no outliers/backwards | None |
| HEVC Main10 / HDR-tagged 50 + HE-AAC | 4 / 16.02 s | 800 packets, 20.000 ms, no outliers/backwards | None |

FOX TS output start is 1.416689 s on 6.1.1 and 1.42 s on 9.0.2 (3.311 ms difference); other reported starts match. This
small encoder-timing difference is recorded rather than claiming byte identity. Existing FOX copy warnings remain;
the version upgrade is not their fix. Text outputs are in `reviews/2026-10-28/ffmpeg-upgrade/`; media stays in `/private/tmp`.

Additional runs:

- `node --test test/media-toolchain.test.js`: 10 pass; all 10 fail with the new implementation files stashed. Tests
  reject ffmpeg/ffprobe version drift, patch-prefix confusion, missing NVENC/CUDA/QSV/HTTPS, and tampering of either cache.
- `node --test test/recording-segments-media.test.js test/hdr-master-playlist.test.js test/heaac-passthrough.test.js`:
  15 pass. After changing to the shared HE-AAC fixture, two attempts found a leftover old diagnostic variable; removed it,
  then `node --test test/media-toolchain.test.js test/recording-segments-media.test.js`: 11 pass. This exercises capture
  interruption, joined epochs, Apple watch copies, final MP4 preparation checks, HDR metadata and 50 fps.
- `npm test`: **1234/1234 pass**, zero skips, Node 24 / installed 9.0.2 (61.77 s; final rerun after the install-prefix guard: 62.15 s).
- `node docs/reviews/2026-10-27/avsync-repro/reconnect.js <FOX sample> /private/tmp/pigtv-0306-av`: real strategy/session/
  relay/HLS route → ffmpeg reader + macOS AVPlayer. One same-provider discontinuity, two connections, max segment 4.004 s,
  max audio step 21.667 ms, no consecutive tiny segments. AVPlayer's known startup stall at 6.58 s recovers at 36.48 s;
  picture/clock offset ≤13 ms. HLS audio timing remains unavailable (`tapCalls=0`). Finite ffmpeg reader is deliberately
  killed at 48 s, as documented by the harness. No iOS Simulator/device acceptance claimed.
- Source `--verify-only`, software capability check, Bash syntax, Ruby YAML parsing and `git diff --check`: pass.
  Build verifier passes; restoring the old image/publish recipe **or** changing `push: false` to `push: true` makes its
  new placement gate fail. No new structural checks were added for behaviours covered by executable tests.

The Linux source build, final runtime/container suite, actual hardware encodes and the reference feeds on devices remain
**pending**, rather than implied by the macOS comparison. Review base for this batch: `806c1d6`. The preceding 0305 batch
also still requires its review; a combined review from `da00a7c` can cover both before Mark pushes.

## Mark's acceptance after review and CI

1. Require the Linux CI version/capability checks and final-candidate tests to pass before using its published image.
2. Deploy through Unraid and check `/api/version` is 0306; check both `ffmpeg -version` and `ffprobe -version` in the
   container report 9.0.2. Deploying ends existing sessions, as usual.
3. Check the hardware encoder actually used on this host (VAAPI/QSV/NVENC as applicable), not just its name in the list.
4. Repeat cold and warm starts of the same affected channel: Mark now reports intermittent A/V offset from the start,
   without the earlier pause (current build number unconfirmed). Record which starts are in/out of sync; correlate first
   segment track starts and copy/encode mode. Then watch H.264 and an HDR/HEVC channel with the expected 50/59.94 display rate, exercise HE-AAC, watch a recording while
   it records, and play its final MP4. Watch FOX on iPhone through a reconnect and report sound/picture alignment.
5. If acceptance regresses, select the previous known-good image tag/digest using OPERATIONS/AGENTS rollback steps.
