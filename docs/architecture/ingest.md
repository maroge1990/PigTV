# Shared ingest

One provider connection per stream, shared by everyone who wants that stream (Plan B3: R2, then R7). Native
implementation of the idea in [`../archive/DISPATCHARR-REVIEW.md`](../archive/DISPATCHARR-REVIEW.md) §5 R2/R7
(Dispatcharr is AGPL: read, never copied). On by default since 0290 (Settings → Playback "Shared provider connection",
`sharedIngestEnabled`; a stored opt-out wins). The design history and phase status are in
[`../archive/SHARED-INGEST.md`](../archive/SHARED-INGEST.md).

## Why

Today every consumer opens its own provider connection: the resolve probe (ffprobe), each HLS session's ffmpeg
(`-i <url>`), each recording's ffmpeg, a relay's standby, a warm channel. Most of Mark's providers allow **one**. So:

- watching a channel while it records needs two connections: the viewer is refused or the recording waits (bug 8's
  family; the 0158 prompt);
- the probe and the session's ffmpeg open two connections in a row for one play, and a provider slow to release the first
  refuses the second (0143's refusal retries);
- the provider cuts some plays ~38 s in (blueprint §2) and every consumer meets that on its own.

One reader per provider stream, shared by everyone who wants that stream, removes the first two outright and gives one
place to handle the third.

## How the shared ingest works

**Shared ingest** (Wave 5, 0223–0225, `ingest.js`; Settings → Playback "Shared provider connection", `sharedIngestEnabled`,
**on by default since 0290** (a stored opt-out wins); design and evidence gates: [`docs/architecture/ingest.md`](#)). One plain HTTP(S) reader
per (pool, URL), not an ffmpeg remux, so consumers get the provider's own bytes; MPEG-TS only, and a response with a
Content-Length (a file) is refused. Ring buffer ≤ 48 MB / 20 s; a new reader joins at the last PAT in the final 2 s (the
opener at its first); > 16 MB behind = evicted; a lost connection is retried 10 s, then every reader ends `upstream-lost`
(a provider reason for the existing failover); 10 s linger. Recordings, live plays (`-i pipe:0`) and their probe (ffprobe
on stdin) read it; every other ffmpeg argument is today's. **0305 (FR-22):** a successful reconnect emits
`reconnected { forLag, gapSec }` to every subscription and clears the old connection's join buffer. Only a viewer leg
owned by a relay stops before the new bytes, without `lost` or quarantine. The relay keeps its old leg registered for
  admission and pins the same ingest. When the new experimental Settings option is enabled, it settles for **6 live seconds**
  after the latest reconnect, then adopts that slot for a fresh leg on the exact same candidate behind
  `EXT-X-DISCONTINUITY`; a forced renewal begins after 8 s and the whole attempt is capped at 20 s. The option defaults off
  pending iPhone acceptance. A reconnect during startup
discards the unpublished attempt and settles again; only the finished renewal is a switch. A ready standby stays standby.
Since **0311**, only a planned replacement opts into pre-ready EOF; ordinary cold failover enables renewal after ready.
At most three renewals start within a rolling minute. Exhaustion disables renewal for the rest of that play and runs
normal provider failover (`renewal-budget`). Follow-on operations after short startup epochs count toward the same
budget. Since **0314**, budget exhaustion quarantines only the channel and does not trip the provider-wide breaker.
If no backup is admitted/started, one ordinary restart on the pinned primary is attempted with renewal disabled;
normal admission/takeover/deadline checks remain. Rejected queued switches release their pin.
Planned renewals are recorded as relay reason `reconnected`, omitted from `playbackInterruptions` (including recovered counts).
Recordings, probe/warm/standby readers and sessions without a relay retain their existing behaviour. A promoted standby
becomes a managed viewer. 0191's direct-read protection is unchanged. The coordinator counts **one connection per ingest**
(`streamsInPool` groups; a lingering ingest is the first thing reclaimed); joining a live ingest needs no connection or
lease. Relay legs and standbys also use the ingest (0282); warm channels and direct plays keep their own connections. `stream-doctor bench
--via-ingest <sample>` compares the session's output from the URL and through the ingest (SAME expected).

**The ingest in detail**

An **ingest** reads one provider stream once and hands the bytes to any number of **subscribers**.

| | |
|---|---|
| Key | `(pool, upstream URL)`: the coordinator's pool (0173/0181: the provider *account*) and the exact stream URL that pool was given. Two sources on one account share a pool, so they share an ingest of the same URL. The key is stored and logged only as a hash; the URL is never logged (`redact`). |
| Reader | A plain HTTP(S) GET in Node (redirects followed, at most 5; the configured user agent), **not** an ffmpeg remux: the bytes subscribers get are the provider's own, so every timestamp quirk the existing classifiers handle (0085/0088, 0191: an ffmpeg copy hides them) reaches the consumers unchanged. |
| What it accepts | MPEG-TS only: the first bytes must show the 0x47 sync byte at 188-byte steps. Anything else (an HLS playlist, an MP4 file, an HTML error page) is refused at start, and the caller uses today's path. A source the probe calls finite (`info.finite`) never uses an ingest: it is paced and seekable, a different problem. |
| Buffer | A ring of chunks with their arrival time, capped by **both** bytes and seconds: 48 MB and 20 s by default (`PIGTV_INGEST_BUFFER_MB`, `PIGTV_INGEST_BUFFER_SEC`). 20 s at 25 Mb/s is ~60 MB, so a UHD feed is held by the byte cap (~15 s), an HD one by the time cap. Per ingest, not per subscriber. |
| Subscribers | Each gets a Node `Readable`. A new one starts at a **join point**: the last PAT packet (PID 0) in the buffer's final 2 s, else the live edge. A fresh HTTP connection starts mid-GOP too, so ffmpeg sees what it sees today and waits for a keyframe as it does today. |
| Slow consumer | A subscriber whose unread backlog passes 16 MB (`PIGTV_INGEST_SLOW_MB`) is **evicted**: its stream ends with `slow-consumer`, which its consumer treats as a lost stream. The reader is never slowed for one subscriber (no backpressure to the provider: that would stall everyone). |
| Upstream loss | On a socket error, an HTTP error or EOF the reader reconnects (0.5, 1, 2, 4 s) for up to 10 s (`PIGTV_INGEST_RECONNECT_MS`). Subscribers keep their streams open meanwhile. Since **0305**, each receives `reconnected { forLag, gapSec }` before the new bytes, and the ring drops the old connection's tail. Recordings, probes, warm/standby readers and sessions without a relay continue reading through the break. Since **0307**, a relay viewer renews only when the experimental `ingestReconnectRenewal` setting is on (default off). It settles for 6 live seconds after the last reconnect, forces an attempt after 8 s and caps total renewal at 20 s. It joins the same ingest on the same candidate with a fresh leg behind `EXT-X-DISCONTINUITY`; reconnects are coalesced, and a startup epoch closed for renewal ends with EOF. The old leg remains registered for admission until handoff and a draining subscription pins the ingest, including with zero linger. No standby promotion, new provider connection, quarantine or lost-play count for a planned renewal; Status records relay reason `reconnected`. After that the ingest **fails**: every subscriber's stream ends with `upstream-lost` and a provider-reason flag, which drives the consumers' existing failover (recordings: 0177; sessions: the relay or the client's re-resolve). |
| Teardown | The last subscriber leaving starts a 10 s linger (`PIGTV_INGEST_LINGER_MS`): a channel change back, or the recording's next part, rejoins without a new connection. Then the reader closes and the lease is released. A reclaim by the coordinator (a viewer took the connection) closes it at once. |
| Stall | **R7 (5c):** a feed behind real time by its own clock (PCR) counts as upstream loss at a stored per-channel/provider limit: default 24 s, up 2 s on each lag reconnect, ceiling 28 s (0292). After 3 measured reading hours with worst lag ≥4 s under the level it drops 2 s; lag or marginal headroom resets that window. Provider source + stable channel key (else item id) is the identity, names are only labels. Progress is saved each minute and on close; downtime and no-PCR reads earn none. Since 0298, different ingest URLs of one provider/channel share their active limit state, overlapping reading intervals count once, and the last reader releases it; Status reads do not retain state. Status Feed lag shows the current level. The default is `PIGTV_INGEST_BEHIND_SEC`; `feedPace.js` measures `deficit` = the most it was ahead since connecting (decaying 1 s a minute) minus how far ahead it is now. A pause the provider catches up from is not a loss; a feed that trickles below real time is. Until a PCR is seen, seconds since the last byte. Readers on the ingest (a session's watchdog, the relay) excuse ffmpeg's silence only while it has been handed less than their limit's worth of media since its last output (0283: measured in media, so recurring bursts cannot hide a frozen ffmpeg; 0284: once handed that much it has the limit again in time, once, so a catch-up burst after a long pause is not charged to it; a feed with no PCR excuses nothing), and the PCR is followed to another PID if the upstream moves it. Was: no bytes for 15 s, which called the 16 s pauses of healthy bursty feeds a loss (FINDINGS FR-8). Every ingest's worst lag (over all its connections) is kept in `feed_lag` (0287). |

## Admission: one connection per ingest

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

## Consumers

The switch is `sharedIngestEnabled` (Settings → Playback, **on by default since 0290**, with stored opt-outs preserved), read when a consumer starts, like 0197's
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

## What stays the same

- Every ffmpeg output argument and the master playlist remain unchanged. Since 0305, a successful shared-ingest reconnect gives relay viewers a fresh leg and a discontinuity (CLIENT-CONTRACT §2).
- K1–K15 (`DISPATCHARR-REVIEW.md` §9) and the viewer/recording policy (ask once, the 3-minute hand-over, partial
  recordings): the coordinator still decides *who* gets a connection; only *what holds it* changes.
- With the switch off, every path is byte for byte today's (a test per consumer).

## Evidence gates

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

## Risks

- **A provider that serves HLS, not TS**, or redirects to one: refused at start, legacy path. Logged once per URL hash.
- **Pipe input and ffmpeg's probing**: ffmpeg cannot seek a pipe. Live TS is never seeked, and finite sources are excluded.
  The bench in §6 is the check.
- **The 38 s cut** still happens; the ingest only makes one reconnect serve everyone. The resend of old content remains
  ffmpeg's to rebase, as today.
- **Production's ffmpeg 6.x vs 9.0**: the bench must run on the server.

## Known limitations

- First usable bytes and a reconnect each have an absolute deadline (`firstBytesMs`, `reconnectMs`); closing a connecting
  ingest rejects its waiters as a cancellation (`ingestCancelled`, never answered with a direct connection) (0230).
- Relay legs and standbys read through it (0282); warm channels and direct plays still open their own connections.
- A measured feed reconnects at its stored channel/provider limit (0292: 24 s by default, up 2 s on lag, at most 28 s).
  A clean 3 hours of reading ≥4 s under the level lowers it 2 s; progress is saved each minute and on close. Daily
  Provider pauses can change; device acceptance of adaptive limits remains outstanding.
- A standby only helps when the backup's feed matches (codec, size, frame rate, audio): TNT Sports 4 has none (FR-14).
- Benched SAME on seven real samples with production ffmpeg (18 Oct); no current feed is uneven, so the `igndts` path is
  covered by unit tests only.

- **Incompatible media during a same-provider renewal ends the relay** (finding FR-27, answered, no code change): the
  candidate is marked unusable for that relay because splicing changed media contracts is unsafe; the relay ends without
  provider-wide quarantine or a `providerReason` event. Reproduce with a new epoch that changes codec, resolution or audio
  layout and check the relay-local teardown.
