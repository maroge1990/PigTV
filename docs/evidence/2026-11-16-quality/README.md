# Measured quality and one-row-per-channel pickers (16 Nov 2026)

Server/web 0798–0808 (#265 step 2, #266; design D-65, player badge D-67). Apple follows in its own batch.

## What was checked

- **T1:** full suite 2829 pass (the 4 known WSL-only AAC failures in recording-segments-media); `verify-build.sh`
  clean. Every new test failed on the code before its change.
- **T3 (web):** headless-browser screenshots against the fake provider with fixture feeds, 1440 and 430 wide: Sky
  Sports F1 in eight copies groups into one row; three 4K·50 copies fold into one chip; an unmeasured copy shows a
  dashed chip; a copy on another airing is its own chip with its start time; the narrow row opens its chips on a long
  press; the player badge reads "4K 50" in the accent. The screenshots found three bugs fixed here: a "UHD/4K" name
  making its own row (0805), the player badge never seeing the measurement (0806), chips pushing Watch and Record out
  of the details window (0807).

## Codex

- Round 1, two mediums: a profile-backed play kept its measurement after a placeholder verdict (0803); folding
  same-quality copies hid a different airing from the recording picker (0804). Both fixes approved.

## Not checked

T5 on devices; measured labels on production need the channel audit's import (`scripts/import-channel-audit.js`)
and plays after the Force Update.
