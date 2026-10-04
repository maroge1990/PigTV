# In-stream recovery and the hot standby: brief

**Status:** approved by Mark, 2 Oct 2026 ("go ahead with the build"). Experimental, **off by default**.
Replaces decision D1 of `MULTI-PROVIDER-BRIEF.md` (cold standby only) *when switched on*; with both switches off the server
behaves exactly as before.

## Why

A stream that is lost mid-play costs about half a minute today: 20 s for the stall watchdog, then the player's playlist
answers 404, the client re-resolves and starts cold (5–10 s). The same path is what a failover to a backup takes. Status →
**Interruptions** (0188) is the baseline this work is judged against.

## What is built

| Switch | What it does |
|---|---|
| Settings → Transcoding → **In-stream recovery** (`relayEnabled`, off) | **In-stream recovery.** When the playing stream is lost, the server starts the channel again (the next provider that has it, or the same one) and continues the *same* HLS stream after an `EXT-X-DISCONTINUITY`. The player keeps its URL and never re-resolves. |
| Settings → Transcoding → **Hot standby** (`standbyEnabled`, off; needs In-stream recovery, greyed out otherwise) | **Hot standby.** While a linked channel plays, a second copy of it runs on a backup provider, unseen. When the playing one stops producing for `PIGTV_RELAY_SWITCH_MS` (10 s), the standby is spliced in at once. |

A switch applies to plays started after it is changed: a stream already running keeps the mode it began with, so turning recovery off never breaks a running relay. `PIGTV_RELAY_SWITCH_MS` stays an environment variable (tuning, not a switch). Status shows each followed stream's state (`starting`, `playing`, `switching`, `standby-starting`, `standby-ready`, `promoted`, `reclaimed`, `failed`) and the last reason code (`lost`, `stalled`, `timestamps`, `blank`, `standby-incompatible`, `standby-reclaimed`, `no-candidate`); the reasons also appear in Interruptions and Recent plays. A feed joins a stream only if segment type, video range, video codec, frame size, frame rate (within 1%) and audio codec and channels match; a field unknown on either side counts as matching.

Neither applies to a bare-URL play or to a direct play.

## How it works (`server/services/streamRelay.js`)

- A **relay** is created for a channel play that produced an HLS session. Its id is that first session's id, which is the
  id the client holds for the playlist, the segments, DELETE and terminal-status.
- A relay has **legs**: one `TranscodeSession` each (its own ffmpeg, folder and provider connection). Leg 0 is the session
  the resolve started. Each leg is an ordinary session in the registry, so the connection pools count it.
- **Until the first switch the playlist is ffmpeg's own file, served as it always was.** The relay only reads it, to keep
  its own list of segments.
- **At a switch** the relay renders the playlist itself (`hlsPlaylist.renderMediaPlaylist`): leg 0's segments under their
  own names, later legs' as `L<n>-seg0001.m4s` / `L<n>-init.mp4`, an `EXT-X-DISCONTINUITY` (and a new `EXT-X-MAP` for fMP4)
  at each join, `EXT-X-MEDIA-SEQUENCE` continuing, `EXT-X-DISCONTINUITY-SEQUENCE` counted as joins slide out of the
  90-segment window. A leg's folder is kept until none of its segments is listed, then deleted.
- **A leg must match the stream it joins**: the same segment type (fMP4 or MPEG-TS) and the same video range (SDR/HDR), since
  the master playlist the player already has cannot change. One that does not match is not used.
- **Cold switch** (no standby ready): the lost leg's connection is freed, the channel's candidates are planned again
  (`providerRouting.plan`: the lost one is quarantined, so the next provider comes first; with nowhere else to go, the same
  provider), and the first that can be admitted and started becomes the next leg. If none starts, the relay ends: the
  playlist answers 404 and the client re-resolves, **which is today's behaviour**.
- **Standby**: started 20 s into a play on the first other provider that has the channel linked and a connection that is
  *free* (no viewer, recording or other standby on it). Its owner is `standby:<relay id>`, never a viewer's.
  It is retried every 60 s when it is not running. Ready = it has two segments and wrote one recently. At a switch its last
  two segments are joined on, it becomes the playing leg and takes the viewer's ownership; a new standby is then looked for.
- **Giving way**: the coordinator treats a standby as abandoned from the moment it starts. A viewer or a recording that
  needs that provider's connection takes it without a prompt (`requestForViewer`, `requestForRecording`, `canRecordFreely`,
  `announceUpcoming` all ignore it or release it first). The relay notices and carries on without a standby.
- **Ending**: a relay ends when its playing leg is stopped on request (the viewer changed channel, DELETE, the idle sweep,
  a takeover), when the same viewer resolves anything again, or when nothing can take over. Ending removes every leg.

## What is recorded

`[Relay <id>]` log lines for every start, switch, standby start/stop and end. A switch writes an Interruptions row (lost,
then recovered on the new provider), so Status shows how long it took. The lost provider's channel is quarantined and
counted toward its breaker exactly as a lost session is today.

## Known limits (test on the devices before trusting it)

- The two feeds are not in step: expect a jump or a few seconds repeated at a switch.
- A cold switch still waits for the 20 s stall watchdog (or ffmpeg exiting) before it starts; it saves the player's
  error-and-restart, not the wait. The standby is what shortens the wait.
- While a cold switch is starting, the playlist does not grow. AVPlayer and hls.js are expected to stall and resume when
  it does; this is **not yet verified on the Apple TV**.
- A wrong backup link puts the wrong channel on screen. Only Auto, Approved and Manual links are used, as for failover.
- A standby uses a backup's connection and the bandwidth of a second stream for as long as you watch.
- The provider shown in Stream info is the one the play started on; it is not updated after a switch.

## Rollback

Turn both switches off in Settings → Transcoding. New plays are no longer followed; running ones finish as they were. Nothing else is stored.
