# DVR repairs0257 and0256 — independent review

Newest first, compared with their parents in isolated archives; current HEAD230118c, baseline93583f6. No application changes, commits, provider/deployed contact.

| Prior finding | Verdict |
|---|---|
| R4-D2 deletion/publication | Direct segmented paths fixed; broader publication intent remains partial because native preparation does not observe retirement. |
| R4-D1 unsafe schema claim | Fixed in examined local scope: inference removed; historical retained-work recovery proves bytes or republishes; unprovable historical files preserved. Mark confirms no pre0243 recordings exist. |

## Independent direct proof

`dvr-parent-proof.cjs` copies current `recording-segments` tests over isolated server revisions. Current **9/9 pass**: four recovery cases and five publication/delete cases.0257 parent: **0/5 pass**, all fail intended behavior.0256 parent: **0/1 pass**, reopening the interrupted0242 row deletes foreign bytes. Three recovery-function tests are not counted as parent behavioral proof because that API does not exist there. Parent0257 also produced a late closed-database rejection after a failing assertion; those five intended assertions already failed independently. Every run bounded and disposable; local fixtures only.

Source review confirms retirement happens before delete's first await, refreshed row ownership is read after work cleanup, and segmented kept-original/fallback/share-move/remux publication checks retirement before recording ownership. Tests cover deletion both completed and still awaiting cleanup. The in-memory retired-ID set is monotonic (IDs AUTOINCREMENT); no ID-reuse defect found.

## R5-D1 — P2: native preparation of fallback TS can publish after deletion

The new retirement owner exists in `recordingSegments`, but fallback TS continues through `recordingMedia.ensureNativePlayback`/`prepareRecording`. Those paths do not consult it or re-check row ownership after their awaited ffmpeg/checks. `recordingMedia.js:418` publishes a native MP4, and `prepareRecording:578` falls back to the stale `rec` after the row has gone, allowing `adoptPrepared` to publish the final MP4.

`native-delete-probe.cjs` uses the real preparation/engine/database in an isolated copy. It creates a completed segmented fallbackTS, starts native preparation, holds fake ffmpeg after opening the input but before opening its output, deletes the recording, then lets encoding finish. That ordering is permitted for a child that opened its input before deletion and creates output afterward. Real publication then logs readiness and adopts the MP4 even though the row is gone. Expected-correct assertion fails: final MP4 remains unlisted on the share. Saved `native-delete-probe.log`.

This is a deterministic synthetic ffmpeg/file scheduling proof, not a real feed/ffmpeg runtime reproduction. It is a pre-existing uncovered publication path, not evidence that the newly repaired segmented paths regressed. The broad claim “every publication path” and C-M's no-leftover guarantee still need narrowing or completion.

Retire/cancel native and other media owners before deletion, check ownership before publishing/adoption, and clean only their own late output. Cover both input-open/output-not-open and existing-output/check-in-progress orderings. Preserve coalesced playback requests. A row-existence guard alone is insufficient while deletion awaits; use the same retirement semantics.

## Recovery limits

`recoverLegacyOriginals` is asynchronous and not all historical recovery awaits consult retirement; the first queue pass can also overlap another call before finishing is set. No additional applicable product defect is asserted from those source observations because Mark reports no pre0243 recordings. They should not be described as proven universal legacy race safety. The destructive schema-init ownership inference itself is gone and its direct regression is independently established.
