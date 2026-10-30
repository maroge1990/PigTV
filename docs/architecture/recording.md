# Recordings

The DVR: scheduling, capture, failover, segmented recordings, rules, artwork, and who owns each file. Recordings take a
provider connection like a viewer (admission: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) › Ownership, admission and
accounting) and read through the shared ingest ([`ingest.md`](ingest.md)). The contracts the Apple client uses are C-L,
C-M and C-N in [`../CLIENT-CONTRACT.md`](../CLIENT-CONTRACT.md). What a user notices is in
[`../PRODUCT.md`](../PRODUCT.md) › Known limitations.

## Recordings

**Recordings** (`recordingEngine.js`: capture, scheduling, failover; `recordingMedia.js`: probes, MP4 remux, native playback,
preparation; `recordingPost.js`: compression, break detection; `recordingJobs.js`: which recording each job is on)
- `scheduled → waiting → recording → …`, where `waiting` = due but held back, by a viewer on the provider's stream or (0324,
  #12) by the recording slot (`error` "Another recording is using the recording slot."; missed with its own text) (listed,
  cancellable, duplicate-checked).
- **One connection, one stream (D-28, 0324, #12).** `maxConcurrentRecordings` (default 1) counts provider connections, not
  recordings: recordings on one shared ingest are one (`recordingConnections()`). A due recording passes the cap without
  a slot only when its resolved candidate has a live ingest that a running recording reads (`sharedRecordingKey()`);
  `chooseProvider()` then gives it that candidate (0326, #137), and at the cap its start is abandoned back to waiting if
  the feed it gets is not that one (`joinedAsPromised()`, 0325, #133). Clashes
  are shown when scheduling: `listScheduled()` adds `conflictsWith` (up to ten ids) to each upcoming schedule that, at
  some moment of its window (with pre/post padding), is one of more connections than the cap or than its source's
  provider pool allows (`clashes()`, one sweep over the windows' boundaries with live schedules grouped by connection, #134, #138). With shared ingest on a channel's
  schedules share one connection; with it off each needs its own (#135). Backups are not counted (#136), so it may warn
  when a backup could have carried one. `POST /recordings/schedule` answers with it too; the web guide's toast and
  Recordings list say it.
- File names use the server's local time, so **`TZ` must be set** (verified).
- Native playback is a `.native.mp4` remux of the file: `hvc1`, MP2→AAC, shared across concurrent requests, written atomically,
  sidecars deleted with the recording. `?async=1` answers 202 while preparing. Old HEVC sidecars are `hev1`: delete
  `*.native.mp4` for those once. **HEVC recording playback on an Apple TV is still unconfirmed.**
- **Every status change is logged** (0156, `setScheduleStatus()` wraps `scheduledDb.setStatus`): one line per actual
  transition, including the `missed`/`failed` paths in `tick()` and `reconcileOnStartup()` that used to change the status
  with no log line at all. A missed/failed schedule also stays listed for 7 days via
  `GET /api/recordings/scheduled?include=recent` (flag `scheduleHistory`) - the plain route is unchanged - shown on the web
  Recordings page ("Recent problems") and the Status page.
- **The recordings folder is health-checked, not just space-checked** (0157, `services/recordingsFolder.js`,
  `checkRecordingsFolder()`): missing, not writable, a filesystem under 1 GB total (an unmounted network share or a stale
  Docker bind reads back this way, not as "missing" - what live testing actually hit), or free space below the configured
  minimum. Checked at startup and every 15 minutes (`recordingEngine.getFolderHealth()`, on `/api/status`, a warning banner
  on the web Status page); a warning is logged only on a state change.
- **A hung share cannot freeze the server** (0327, #8). The share is a network mount; a hung SMB server blocks a
  synchronous call (and fills libuv's thread pool for an asynchronous one), which froze every stream. File calls on it go
  to one helper process (`shareFs.js`, `shareFsWorker.js`) with a 5 s deadline; a miss kills the helper, a new one starts
  on the next call, and the folder reads `unresponsive` ("The recordings folder is not responding"). Killed helpers that
  have not exited (stuck in the kernel) are counted; with two, calls fail at once without forking more (0328, #142). A
  size the share did not give is unknown, never "no growth": it restarts the stall clock instead of ending a part as a
  provider stall (#143). Through it: the
  folder health check and the start pre-flight (`checkRecordingsFolderAsync`), `getRecordingsRoot`, the channel folder,
  segmented recordings' share folder, choosing a capture's file name and reading its size when it ends (#144), and each
  tick's growth, live-detection and free-space checks. `/api/status`
  shows a cached free-space line refreshed in the background (`shareFs.diskInfo`) and never touches the share. Still
  synchronous and rare: a segmented recording's final MP4 on the share, and deleting files (#141). `getRecordingsRoot()` only creates the final folder
  when its parent already exists. Settings → Recording → Storage refuses an unusable `recordingsPath` with 400 instead of
  saving it silently (`services/recordingsFolder.js` `validateRecordingsPathSetting()`).
- **An unanswered "give up the stream" prompt no longer blocks a recording forever** (0158): if a due recording finds a
  live viewer on the provider's only stream, it still asks once (`streamCoordinator.js` `requestForRecording` /
  `pendingPrompt`), but takes the stream if nobody answers within `recordingPromptTimeoutMin`
  minutes (setting, default 3) of the recording actually becoming due - tracked as `dueSince` on the prompt entry,
  deliberately not from the earlier `announceUpcoming` lead-time notice. An explicit "Keep watching" (`declinePrompt`)
  still waits, however long. No new terminal-status value (a client sees an
  ordinary reclaim: a 404, its one-time re-resolve, then the existing `recording-in-progress` 409).

## Segmented recordings

- **Segmented recordings** (R3, 0218, `recordingSegments.js`; Settings → Recording, `segmentedRecordings`, **off by
  default**; contract C-L). With it on, a new recording is captured into `/app/data/recordings-work/rec-<id>/e<n>/` as
  4 s MPEG-TS HLS segments, one folder per ffmpeg run ("epoch"); the arguments are the usual capture's with `-f hls`,
  `make_non_negative` and `-output_ts_offset <seconds so far>` (make_zero would undo the offset), so the timeline runs on.
  A failover or a restart continues the **same row** in a new epoch (no part 2; ≤ 20 resumes; gaps noted in `error`); a
  restart after the window finishes it. Not `append_list`: each run's playlist is ffmpeg's own and the server joins them.
  The Apple TV's watch copy (fMP4, `hvc1`) is made by a **local follower ffmpeg** per epoch, only when someone asks
  (`GET /:id/watch`); it never touches the provider. At the end the joined playlist is remuxed with preparation's own
  arguments straight onto the share under `.partial`, checked (`checkPrepared`), renamed, `native_status` ready; then the
  work folder goes. Share down: the MP4 waits in the work folder (`segment_state` `moving`, playable) and moves every
  15 min; three failed remuxes deliver the joined `.ts` instead. Appdata gets the health and free-space checks; the share is
  not needed to start. Measured on ffmpeg 9.0 with synthetic HEVC HDR10 / 50 fps / HE-AAC; **not yet on the reference
  feeds or production's 6.x**.

## Rules

- **Rules** (R5, 0219, `recordingRules.js`, tables `recording_rules`, `recording_rule_hits`; C-M): `sport` = a follow
  keyword over Sport's events (never replays) on the best channel; `series` = a title on one channel (7 days, optionally new
  episodes only). De-duplicated by identity (event id; episode number/subtitle, kept at ingest in `epg_programs.data` as
  `{sub, ep}`; else channel + quarter hour), by any schedule of the same programme within 15 min (any channel for sport),
  and by hits: a schedule the viewer cancels never comes back, even when the guide moves it. Evaluated after each EPG sync
  and every 15 min. Deleting a rule cancels its schedules that have not started.

- A Sport rule's schedule is matched to an event by instance: present within 15 min / moved (a schedule not yet begun,
  inside the 72-hour guide horizon, whose slot is gone; nearest same-title event, one to one) / new (0245, 0254). An
  existing schedule is reconciled before the rule's hit list is consulted (0253). F4 policy (Mark, 25 Oct; 0259): a
  cancelled schedule holds only when its pairing is unambiguous, otherwise the candidates are recorded; series airings
  without episode data pair the same way on their channel, up to 3 hours. Not durable identity (the guide has none);
  stated in C-M. 0260: unsure is decided per candidate at every evaluation (an older hit naming a declined cancelled
  schedule does not suppress); episode schedules are reserved from unidentified airings and follow their episode;
  series pair by the channel's stable identity.
  A name-derived event-slot programme belongs to its slot only (0247).

## Artwork

- **Artwork** (R6, 0220; C-N): the programme's `<icon>` is kept as `epg_programs.data.img`; a schedule takes it when made
  (`image_url`), the recording copies it; lists give only `/api/logo/<key>` (logo cache), never the address.

## Ownership and cleanup

Durable facts from the 22–26 Oct repair batches (0227–0280):

- A segmented recording whose MP4 could not be fully checked keeps its segments as its own published "<name>.ts" (or
  "<name> (original N).ts"), recorded in `recordings.segment_original`; the row stays `moving` until that copy is
  published (0242/0243). Deletion removes only `segment_original`, never a file found at "<name>.ts" (0251). A pathless
  kept original from 0227–0242 is claimed only by its bytes (segments still in appdata), else re-published under its
  own name, or (segments gone) left in place and logged (0256). A deletion retires the recording before it awaits, and
  every publication (MP4, kept original, fallback .ts, share move) removes its own output if it is no longer owned (0257);
  `recordingOwners` holds that retirement for every job, including the native remux, preparation and compression (0261),
  and every step writing a file for a recording runs as one of its writers: a deletion stops them (ffmpeg killed, a stream
  destroyed, a copy awaited) and waits until each has removed what it made, before it removes the files and the row (0264),
  at most 30 s (0270). Every file a writer makes has a name of its own and is journalled in `recording_cleanup` until it
  is published or removed; the start-up sweep removes what a crash or an abandoned writer left (0273).
  Share files are published with `link()`, never by rename over an existing name.
- A schedule with a stable channel identity never falls back to its stored position (resolve, guide-follow, blockers) (0228).
