# Batch server 0502, Apple 188–191: Sport header and strip, quality badges (9 Nov 2026)

Issues: #263 (header), #264 (strip, option B of Mark's three mock-ups), #265 (quality), #266 (grouping, held).

## Fixes and tests (T1–T3; each test fails on the code before it unless noted)

| Build | Change | Test |
|---|---|---|
| 0502 | One quality rule from the name (UHD/FHD/HD/SD, superscripts folded); guide rows carry it (C-X) | `test/channel-quality.test.js`, sport-events quality test |
| 188 | Sport header fixed: iPhone header out of the scroll; TV/iPad page masked at its top | `SportHeaderPinUITests` (TV: banner covered the header; iPhone: header left the screen) |
| 189 | Guide UHD/SD badges, guide record page quality, FHD label | `ChannelQualityTests` |
| 190 | The banner shrinks to a strip pinned under the header | `SportHeroStripTests`, `SportHeaderPinUITests` |
| 191 | The strip takes layout room (Codex round 1, medium); brand sizes and colour roles | passes on 190 too (the case was not reproduced) |

## Gates

- `npm test`: 1780/1784 pass; the 4 failures are `recording-segments-media` (WSL ffmpeg 8.0.1, CI uses 9.0.2).
- `verify-build.sh`: all checks pass. Goldens updated for `channelQuality` and `quality` (info, library-guide, sports-events).
- Apple: `Tools/test.sh push` on tvOS 27 (contract, unit, regression UI) passes; iPhone 17 and iPad Pro 11 Sport and
  header suites pass.

## Codex (one round each)

- Server: approve, no findings.
- Apple: one medium, the strip drawn over the page could leave a focused card beneath it on tvOS: fixed in 191.

## Not checked (T5)

On the devices: the header and strip while scrolling (Apple TV, iPad, iPhone), the guide's UHD/SD badges on the real list.
