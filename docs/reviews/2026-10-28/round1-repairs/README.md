# 0307 review repairs and open dispositions

Review batch: builds 0305 (`806c1d6`) and 0306 (`c7127e6`), baseline `da00a7c`. The review was supplied by Mark on
28 Oct. This record captures the first review's findings, repair evidence, remaining limits, and the required second-round
review. Nothing here represents a deployed change.

## High findings

| Finding | Disposition |
|---|---|
| H1 — candidate test container runs as root and permission-sensitive tests fail | Fixed in `.github/workflows/docker-publish.yml`: run as UID 99/GID 100 with writable tmpfs data, transcode-cache and recordings paths, `HOME=/tmp`; `.github` remains read-only. `scripts/verify-build.sh` checks this wiring. Demonstrated the old permission-sensitive cases fail as root (2 failures) and pass as UID 99 (2 passes) using a disposable copied server and mocked ffmpeg; no deployed data was used. Full final image check still awaits Linux CI. |
| H2 — reconnect flapping can starve the 6 s renewal wait | Fixed with a maximum 8 s settling wait and a 20 s total renewal deadline. Every4s reconnect flap: old 0305 first renewed at 63.845 s, after the flap ended; 0307 first renewed at 12.462 s. The 75 s rig then observed 15 provider connections and 12 timeline switches; its consumer was intentionally stopped at the wall deadline. Each intentionally closed startup epoch ends stdin cleanly, and cannot launch a hardware-decode retry. A new regression covers that retry guard. |
| H3 — determine whether renewal and the 30 s hold fix intermittent A/V offset | Investigated; no sync fix claimed. Four offline FOX loop-capture comparisons (baseline `da00a7c` and 0305, hold 30 s and 0 s) all had a join stall: baseline about 4.8 s / 4.2 s, 0305 about 11.25 s / 10.29 s. Thus the renewal, not only hold duration, added join delay in this fixture. The looped transport stream itself had earlier loop stalls; AVPlayer's audio tap had zero calls, so audio timing was unmeasured. The test does not identify the random at-start A/V offset Mark reported. No ffmpeg flags or Apple hold changed. Renewal is now an explicit web setting, off by default, pending device acceptance. |

The extended fixture was generated from the already-existing FOX capture outside the repository. It is not a new provider capture
or a representative live feed. Raw timing JSON, player logs and rig logs are kept in `/private/tmp/pigtv-h3-*` on this machine;
the source transport stream is not checked in.

## Medium findings

| Finding | Disposition |
|---|---|
| M1 — test real session/ingest accounting across viewers, recording, takeover, warm and standby | Added `test/shared-session-accounting.test.js`, using a real local synthetic HTTP provider, ffmpeg sessions, recording engine, coordinator, Status route and playback takeover route. Two viewers plus warm and standby share one provider connection and one counted ingest; warm/standby do not make the group reclaimable. A viewer plus recording shares one connection; takeover closes the old viewer/recording ingest and admits the replacement. Status reports one used connection and one recording. Mutation proof removed `ingestKey` from session summaries; the group test failed. |
| M2 — zero-linger cold-probe double connection and repeatability | Test now restores normal linger before its target cold play. The corrected test passed in 20 isolated runs. Reproducing the old fixture passed 5/6 runs; one created a serial second probe connection. Registered below as FR-24; production change not made. |
| M3 — compare deployed tool capabilities with the 0306 recipe | User-authorized read-only inventory captured from deployed build 0305: ffmpeg/ffprobe 6.1.1; build uses `--enable-libvpl --disable-libmfx`, lacks AMF encoders and includes NVDEC. 0307 switches the source recipe to VPL, explicitly requires VPL, dav1d, XML2, iconv, H.264/HEVC CUVID, DASH/HLS/MOV/MPEG-TS, and installs corresponding runtime libraries. Capability checks fail on omissions. AMF remains intentionally absent from this Linux profile; the broader optional-library differences are listed below as FR-25. Linux candidate build is unrun. |
| M4 — validate private encoder options against actual session builders | Added `scripts/check-encoder-options.js`: runs the actual software/NVENC/VAAPI/QSV/AMF argument builders for low/medium/high against each encoder's own `ffmpeg -h encoder=...` output; performs real software lavfi encodes for all three qualities. It explicitly reports hardware options unchecked where the encoder is absent. Local three-quality software runs pass; actual GPU paths remain unverified. |
| M5 — test 0305 against production FFmpeg 6 before upgrading | Confirmed via read-only access that the deployed server was build 0305 on FFmpeg 6.1.1. The reported intermittent offset at play start means that is not device acceptance. No deploy or provider play was made. Mark's controlled 0305 baseline/device decision remains required before the 0306 toolchain image is deployed. |

## Low findings

| Finding | Disposition |
|---|---|
| L1 — pin purpose named `viewer` | Fixed to the distinct purpose `renewal-pin`; relay test asserts it. |
| L2 — incompatible same-provider renewal handling | Answered and retained as a finding below: incompatibility makes that relay-local candidate unusable and ends the relay; it does not emit `providerReason` or quarantine the provider. The planned EOF path remains separate. |
| L3 — adopting a stream bypasses lease when it is not warm/joinable | Fixed: only an actually warm adopted lease bypasses `takeLease`; nonjoining adoption reserves its own lease. `coordinator-own-stream` regression added. |
| L4 — smoke, cache and signature claims | Corrected claims in `docs/MEDIA-TOOLCHAIN.md`: CI checks a candidate container; `npm test` is not the server main-process smoke test; binary cache hits do not revalidate source archive contents (the build script validates archives when used); PGP signature was not verified. |
| L5 — fallback tool versions not visible | Fixed: startup logs each tool's numeric version/origin and warns on mismatches; Status includes version/origin/mismatch only. A test verifies neither tool output nor paths leak. |
| L6 — suite runtime docs stale | Updated `AGENTS.md` from ~35 s to ~70 s using this batch's measured local run. Short settle test waits remain only in fixture tuning; the 3.5 s-spaced reconnect test retains the real 6 s settle. |
| L7 — relay renewal is default-off | Fixed and stated in Settings, the client contract and shared-ingest documentation. Enable relay, shared ingest and “Renew timeline after a reconnect” only for a controlled live check. |

## Open findings for Mark's priority

- **FR-23 (H3 / intermittent A/V from startup):** Mark reports that current playback sometimes starts in sync and sometimes offset,
  without the earlier pause. The offline FOX loop shows join stalls but does not measure its audio. Reproduce on 0305 before
  any deployment upgrade, recording channel, exact build, cold/warm start, copy/re-encode path, first video/audio packet
  start times, direction and approximate offset. Then compare the same steps on the reviewed 0307 image only after CI and
  Mark's review. Until device evidence exists, neither 0305 renewal nor FFmpeg 9 is established as a fix.
- **FR-24 (M2 / zero-linger cold probe):** `PIGTV_INGEST_LINGER_MS=0` can allow a serialized cold probe then session to open
  two provider connections. Reproduce with a cold channel at zero linger, record connection count and release timing; decide
  whether production should retain a short minimum linger. Existing test is stable after restoring linger before its target.
- **FR-25 (M3 / toolchain deltas):** deployed 6.1.1 enables a wider collection of optional external libraries than the
  intended 9.0.2 Linux profile, including AMF (platform-specific), frei0r, libaom, libbluray, libplacebo, librsvg,
  libsvtav1, libwebp, libxvid, OpenCL/OpenGL and others. The new profile intentionally focuses on PigTV's accepted source
  protocols, required decode paths and current hardware backends. No Linux image was built locally, so list each missing
  optional library by actual 9.0.2 candidate output before claiming full parity; add a dependency or record intentional
  omission. VPL replaces legacy MFX in the profile; actual Intel GPU encode/decode still needs host verification.
- **FR-26 (M4 / physical hardware):** NVENC, VAAPI and QSV option checks against encoder help do not prove an actual GPU
  invocation. On the production host, run one real encode/decode path for each installed backend and compare error output.
- **FR-27 (L2 / incompatible renewal):** A relay candidate whose renewed stream no longer matches the existing media
  contract is marked unusable for that relay and the relay ends; this intentionally avoids splicing incompatible tracks.
  Reproduction: use an ingest whose new epoch changes codec/resolution/audio layout and observe the relay's incompatible
  media decision and teardown. No provider-wide quarantine is intended.
- **FR-28 (L4 / smoke and cache wording):** The publication workflow checks tools and tests the built candidate container,
  not a running server process. A verified source archive is checked by the builder when downloaded/reused; GitHub binary
  cache hits skip rebuilding. PGP verification is absent. These limitations are now stated in the toolchain document.

## Deployed read-only evidence

Mark authorized necessary read-only commands. Deployed container reports build 0305 / commit `806c1d6`, ffmpeg and ffprobe
6.1.1, `relayEnabled=true`, `sharedIngestEnabled=true`; the new `ingestReconnectRenewal` setting did not exist there. The
version/capability inventory is in `/tmp/pigtv-review-deployed-tools.txt`; only the two setting booleans were read from the
database using an explicit read-only SQLite connection. No source/provider URL, credential or playback data is in this record.

## Required live acceptance and next review

Before calling the batch ready, run Codex adversarial review round 2 (the review limit is two rounds):

```text
/codex:adversarial-review --background --base c7127e6 Review 0307 repairs for 0305/0306: bounded reconnect renewal and
off-by-default setting, startup EOF/retry suppression, lease/pin ownership and takeover, real ingest accounting tests,
UID 99 candidate test container, VPL/media capability recipe, session-builder private option checks, safe tool version
reporting, documentation and claims. Focus on remaining high-severity correctness or security issues.
```

If no high finding remains, Mark's ordered live steps are:

1. Review the second-round dispositions and require Linux CI's 9.0.2 image and candidate tests to pass before deployment.
2. On deployed 0305, repeatedly cold-start and warm-start the affected channel and note whether each starts in sync, the
   first audio/video timestamps and approximate offset. This establishes the current baseline without changing renewal.
3. If choosing to deploy 0307, enable the experimental renewal setting only after both relay and shared ingest are on.
   Watch the same channel on iPhone through a reconnect; note whether the picture pauses, when the relay reports
   `reconnected`, and whether sound leads or lags afterward. Run several starts, since the symptom is intermittent.
4. Leave the setting off if renewal increases join delay or A/V offset. Do not change the Apple 30 s hold or session flags
   as part of this check.
5. Verify `/api/version`, `/api/status` media tool versions, and one real host hardware path. Nothing is verified until Mark
   reports these results.
