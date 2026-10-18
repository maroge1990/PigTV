# Shared ingest (Wave 5, Plan B3: R2 then R7): design

16 October 2026 (status updated 17 October). The design note the [16 Oct roadmap](reviews/2026-10-16/ROADMAP.md) asks for before Wave 5 code, answering
the [15 Oct review](reviews/2026-10-15/REVIEW.md)'s corrections 3–5. Native implementation of the idea in
[`DISPATCHARR-REVIEW.md`](DISPATCHARR-REVIEW.md) §5 R2/R7 (Dispatcharr is AGPL: read, never copied).

## 1. Why

Today every consumer opens its own provider connection: the resolve probe (ffprobe), each HLS session's ffmpeg
(`-i <url>`), each recording's ffmpeg, a relay's standby, a warm channel. Most of Mark's providers allow **one**. So:

- watching a channel while it records needs two connections: the viewer is refused or the recording waits (bug 8's
  family; the 0158 prompt);
- the probe and the session's ffmpeg open two connections in a row for one play, and a provider slow to release the first
  refuses the second (0143's refusal retries);
- the provider cuts some plays ~38 s in (blueprint §2) and every consumer meets that on its own.

One reader per provider stream, shared by everyone who wants that stream, removes the first two outright and gives one
place to handle the third.

## 2. What an ingest is

An **ingest** reads one provider stream once and hands the bytes to any number of **subscribers**.

| | |
|---|---|
| Key | `(pool, upstream URL)`: the coordinator's pool (0173/0181: the provider *account*) and the exact stream URL that pool was given. Two sources on one account share a pool, so they share an ingest of the same URL. The key is stored and logged only as a hash; the URL is never logged (`redact`). |
| Reader | A plain HTTP(S) GET in Node (redirects followed, at most 5; the configured user agent), **not** an ffmpeg remux: the bytes subscribers get are the provider's own, so every timestamp quirk the existing classifiers handle (0085/0088, 0191: an ffmpeg copy hides them) reaches the consumers unchanged. |
| What it accepts | MPEG-TS only: the first bytes must show the 0x47 sync byte at 188-byte steps. Anything else (an HLS playlist, an MP4 file, an HTML error page) is refused at start, and the caller uses today's path. A source the probe calls finite (`info.finite`) never uses an ingest: it is paced and seekable, a different problem. |
| Buffer | A ring of chunks with their arrival time, capped by **both** bytes and seconds: 48 MB and 20 s by default (`PIGTV_INGEST_BUFFER_MB`, `PIGTV_INGEST_BUFFER_SEC`). 20 s at 25 Mb/s is ~60 MB, so a UHD feed is held by the byte cap (~15 s), an HD one by the time cap. Per ingest, not per subscriber. |
| Subscribers | Each gets a Node `Readable`. A new one starts at a **join point**: the last PAT packet (PID 0) in the buffer's final 2 s, else the live edge. A fresh HTTP connection starts mid-GOP too, so ffmpeg sees what it sees today and waits for a keyframe as it does today. |
| Slow consumer | A subscriber whose unread backlog passes 16 MB (`PIGTV_INGEST_SLOW_MB`) is **evicted**: its stream ends with `slow-consumer`, which its consumer treats as a lost stream. The reader is never slowed for one subscriber (no backpressure to the provider: that would stall everyone). |
| Upstream loss | On a socket error, an HTTP error or EOF the reader reconnects (0.5, 1, 2, 4 s) for up to 10 s (`PIGTV_INGEST_RECONNECT_MS`). Subscribers keep their streams open meanwhile; the bytes simply resume (a discontinuity, as ffmpeg's own `-reconnect` gives today). After that the ingest **fails**: every subscriber's stream ends with `upstream-lost` and a provider-reason flag, which drives the consumers' existing failover (recordings: 0177; sessions: the relay or the client's re-resolve). |
| Teardown | The last subscriber leaving starts a 10 s linger (`PIGTV_INGEST_LINGER_MS`): a channel change back, or the recording's next part, rejoins without a new connection. Then the reader closes and the lease is released. A reclaim by the coordinator (a viewer took the connection) closes it at once. |
| Stall | No bytes for 15 s while connected counts as upstream loss (the same budget as the session watchdog's 20 s less ffmpeg's own buffering). R7 replaces this with a byte-rate rule in phase 5c. |

## 3. Admission: the coordinator counts ingests

The connection is the **ingest's**, so the lease (R11) is the ingest's: it takes one when it starts (`purpose` of its
first subscriber) and binds it to the ingest id. Subscribers hold no connection of their own.

- `getOrJoin(pool, url)` is synchronous up to the registry insert, so two plays of the same channel in the same tick find
  one ingest (the second joins the first while it is still connecting). This is the "single-connection admission under
  concurrency" case.
- Counting per pool: legacy sessions and recordings (no ingest) count as today; everything on an ingest counts **once
  per ingest**. A viewer or recording asking for a stream that already has a live ingest in that pool is admitted with
  no prompt and no new connection, whatever the limit (it costs nothing).
- Reclaim rules are unchanged in spirit: an ingest whose subscribers are all abandoned (idle viewers, a standby, a warm
  channel) is reclaimable; one with a recording or a live viewer is not. Reclaiming an ingest ends every subscriber on it.
- A *different* channel still needs a connection and still meets the limit: the tests prove both halves.
- **Phase 5a** keeps the leases where they are (a recording's lease binds to its recording, as today) and has the pool
  count recordings on one ingest **once** (`streamCoordinator.recordingsInPool` dedupes by `ingestKey`); a recording
  whose stream already has a live ingest is a free candidate. Without a backup provider the coordinator does not count
  recordings against each other at all (today's rule; `maxConcurrentRecordings` does), so 5a's sharing shows with
  backups configured and in the connection count. Phase 5b moves the lease to the ingest when sessions join it.

## 4. Consumers, in order (one phase each, each behind the switch)

The switch is `sharedIngestEnabled` (Settings → Playback, **off by default**), read when a consumer starts, like 0197's
relay switch: turning it off never breaks a stream already running.

1. **Recordings (phase 5a).** The recording ffmpeg reads `-i pipe:0` from its subscription; its output arguments are
   unchanged (TS file, or 0218's segments). It is stopped with SIGINT instead of `q` on stdin (stdin is the data).
   Input-side reconnect flags go (the ingest reconnects). A recording of a channel already being watched or recorded
   joins that ingest.
2. **HLS sessions and the probe (phase 5b).** The session's ffmpeg reads `-i pipe:0`; every other argument is today's
   (`buildSourceArgs` keeps the classification flags: `igndts` for uneven feeds, `-dts_delta_threshold`, the probe sizes).
   The resolve probe reads the ingest's buffered tail through ffprobe on stdin instead of opening the provider, so a cold
   play is one connection, not two. Watch + record and two viewers of one channel then share one connection.
3. **R7 inside the ingest (phase 5c).** Health from the reader's byte rate rather than ffmpeg's `speed=`: below the
   feed's own rate for 15 s while connected = buffering; reconnect the same URL if it had been stable ≥ 30 s, else switch
   to the next candidate in `providerRouting`'s order (a source swap keeps the subscribers; they see a discontinuity).
   A swap is only taken when the new feed's codec, resolution, frame rate, audio and HDR match the probe's fingerprint
   (correction 4: the relay's `unusable` check, kept); otherwise the subscribers end and today's failover runs.
4. **B4 retirements** only on the evidence in §6.

Not consumers: direct plays (the client fetches `/api/proxy/stream` itself) and finite sources.

## 5. What stays the same

- Every ffmpeg output argument, the HLS layout, the master playlist, the Apple contract: nothing a client sees changes.
- K1–K15 (`DISPATCHARR-REVIEW.md` §9) and the viewer/recording policy (ask once, the 3-minute hand-over, partial
  recordings): the coordinator still decides *who* gets a connection; only *what holds it* changes.
- With the switch off, every path is byte for byte today's (a test per consumer).

## 6. Evidence gates (AGENTS.md: capture first)

| Gate | Before | How |
|---|---|---|
| 5a ships (off) | the recording through the ingest equals today's | Tests: a fake TS provider over HTTP; the recording file is the provider's bytes from the join point (byte comparison), reconnect, eviction, linger, stop by SIGINT, switch off = today's arguments. |
| 5b ships (off) | an HLS session fed through a pipe produces what `-i <url>` produces | **`stream-doctor bench --via-ingest <sample>`**: the server's own argument builders run twice on a reference sample served over local HTTP, once `-i <url>`, once through an ingest into `pipe:0`, compared per segment (count, durations, first PTS, A/V start skew, timestamp warnings). Run locally on synthetic HEVC HDR10/50 fps/HE-AAC samples, and by Mark (or a session with server access) on the five reference samples. |
| 5b on for Mark | watch + record share one connection; a different channel still meets the limit; HDR/50 Hz/HE-AAC unchanged on the Apple TV | Mark's device test: record a channel, watch it on the TV and the phone, try a second channel (refused/prompted as today), check Stream info and the HDR/50 Hz switch. |
| 5c | R7's thresholds come from data | Real reader byte rates from production logs (logged by 5a/5b), as R7 always required. |
| B4 | no slot leaks, arbitration, cancellation, crash cleanup, bounded memory, HDR/50 Hz/HE-AAC, rollback | A week on with the switch on, the Status page's ingest panel showing no leaked leases, then one retirement per commit. |

Memory bound: ingests are at most one per (pool, channel) and pools are bounded by the providers' limits, so with Mark's
setup (a few connections) the worst case is a few × 48 MB plus 16 MB per subscriber backlog. The Status page shows each
ingest's buffer bytes, subscribers, byte rate and reconnects.

## 7. Risks

- **A provider that serves HLS, not TS**, or redirects to one: refused at start, legacy path. Logged once per URL hash.
- **Pipe input and ffmpeg's probing**: ffmpeg cannot seek a pipe. Live TS is never seeked, and finite sources are excluded.
  The bench in §6 is the check.
- **The 38 s cut** still happens; the ingest only makes one reconnect serve everyone. The resend of old content remains
  ffmpeg's to rebase, as today.
- **Production's ffmpeg 6.x vs 9.0**: the bench must run on the server.

## 8. Status

| Phase | Build | State |
|---|---|---|
| 5a ingest core, recordings | 0223, 0224 | Done, off by default. `stream-doctor bench --via-ingest` added (0224); its first run found two faults, fixed there. |
| 5b sessions and the probe | 0225 | Done, off by default. Bench SAME on synthetic HEVC HDR10/50 fps/HE-AAC and H.264/AAC (ffmpeg 9.0), and **on the server (18 Oct, build 0225, production ffmpeg) on six real samples, both session shapes, every metric equal**: `pos_31` (Sky Sports UHD, HDR10, 50 fps), `pos_1164`/`pos_1165` (HE-AAC), `pos_1157` (30 fps; the same two "packet duration out of range" warnings either way), `pos_29430`, `pos_31148` (50 fps), and a fresh `pos_1187.ts` (beIN Sports 3, 1080p). **No uneven-timestamp feed exists to bench:** Fox Sports 505 (now `pos_1182`), the uneven one in September, measured even on 18 Oct; the `igndts` flag is an input option the session keeps either way (`buildSourceArgs`), covered by the unit tests. Not benched: the three ~700 MB `pos_1178` captures (too big for the bench's temporary folder). **Next:** Mark's device test with the switch on. |
| 5b device test (Mark, 18 Oct) | 0225 | **Passed the parts run:** the HDR channel played on several devices on Strong8K's one connection (one ingest, no second connection); recording it while watched joined the same ingest with no prompt; a different channel went to Dream 4K on its own ingest. An hour of logs: no slow-consumer, reconnect, give-up or refusal. **Open:** bug 9 (Status shows a shared connection as 2/1, and the recording banner still warns; display only), and the stop-everything/linger check. |
| 5c R7 inside the ingest | | Not started: waits for real byte rates (Status → Shared provider connections shows each ingest's kb/s and reconnects). |
| B4 retirements | | Not started: a week with the switch on and the §6 evidence first. |

Not on the ingest yet: relay legs and standbys, warm channels, direct plays (`/api/proxy/stream`). They keep their own
connections, counted as today.
