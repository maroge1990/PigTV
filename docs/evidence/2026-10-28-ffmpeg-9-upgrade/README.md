# FFmpeg 6.1.1 vs 9.0.2: offline comparison, 28 Oct 2026

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
- The first review-repair full-suite and verifier results are recorded with build 0307 in `docs/evidence/2026-10-28-0307-review-repairs/README.md`.
- `npm test`: **1244/1244 pass**, zero skips, Node 24.21.0 / local FFmpeg 9.0.2 (58.67 s).
- `bash scripts/verify-build.sh .`: all checks pass, including UID 99 candidate wiring. `git diff --check`: pass.
- `node scripts/check-encoder-options.js --software-only`: three actual lavfi software encodes pass. The `--hardware` production
  capability gate and the full NVENC/VAAPI/QSV option checks are not available on this Mac; Linux candidate CI must run them.
- `node docs/reviews/2026-10-27/avsync-repro/reconnect.js <FOX sample> /private/tmp/pigtv-0306-av`: real strategy/session/
  relay/HLS route → ffmpeg reader + macOS AVPlayer. One same-provider discontinuity, two connections, max segment 4.004 s,
  max audio step 21.667 ms, no consecutive tiny segments. AVPlayer's known startup stall at 6.58 s recovers at 36.48 s;
  picture/clock offset ≤13 ms. HLS audio timing remains unavailable (`tapCalls=0`). Finite ffmpeg reader is deliberately
  killed at 48 s, as documented by the harness. No iOS Simulator/device acceptance claimed.
- Source `--verify-only`, software capability check, Bash syntax, Ruby YAML parsing and `git diff --check`: pass.
  Build verifier passes; restoring the old image/publish recipe **or** changing `push: false` to `push: true` makes its
  new placement gate fail. No new structural checks were added for behaviours covered by executable tests.

The Linux source build, final runtime/container suite, actual hardware encodes and the reference feeds on devices remain
**pending**, rather than implied by the macOS comparison. Review batch base: `c7127e6` (0305 and 0306 baseline: `da00a7c`).
The user-supplied first adversarial review has been repaired/dispositioned in
[`docs/evidence/2026-10-28-0307-review-repairs/README.md`](../2026-10-28-0307-review-repairs/README.md); required second round
has not run yet.

Moved here from `docs/MEDIA-TOOLCHAIN.md` (archived) in the 30 Oct documentation reset; the toolchain itself is
docs/architecture/playback.md › Media toolchain.
