# #29: the sport score collector's cost on the event loop (0409, T3)

Server 0409 (`rig-d877ff9`) on the Unraid rig's staging container (≤ 3 CPUs, cpu-shares 256), 1 Nov 2026, ~16:00
Melbourne. Real ESPN traffic (not a provider); the fake provider's BBC ONE played over HLS (transcode) throughout.
Staging's admin followed all **61 catalogue leagues**. `scripts/unraid-rig.sh measure-collector 15`, once with the
collector on (the server's default) and once off (`PIGTV_RIG_SPORTS_DASHBOARD=0`). Timings and sizes only.

| 15 min | Collector on | Collector off |
|---|---|---|
| HLS playlist ms (897 each) p50 / p95 / p99 / max | 2 / 3 / 3 / 8 | 2 / 3 / 3 / 8 |
| HLS segment ms (226 each) p50 / p95 / p99 / max | 2 / 3 / 4 / 7 | 2 / 4 / 6 / 10 |
| Event-loop lateness, per minute: p99 (all minutes) | 2 ms | 2 ms |
| ...worst per minute: median / worst | 8 / 207 ms | 3 / 253 ms |
| Failed fetches | 0 | 0 |

**The collector (on), 29 ticks:** at most 12 answers a tick (the cap), up to 2.4 MB; p95 per tick: 27.6 ms on the event
loop (parse 10.9, longest single parse 8.1, normalise 5.9, ingest 20); worst tick 106 ms (ingest 78 ms, the cold start
writing every league's cards in one transaction; parse 23 ms, longest single parse 8.5 ms). A tick takes 4–8 s, almost
all of it waiting on the network.

**Worst single answer:** a Grand Slam's (the Australian Open in ATP's feed, 1.8 MB): parse 13–15 ms, normalise 15–16 ms.

**Reading:** with 61 leagues the collector does not move HLS serving (identical playlist and segment times; the worst
minute's spike, 207–253 ms, happens with it off too, so it is not the collector). Its largest block on the loop is the
cold-start ingest (~78 ms), within what HLS tolerates here. **No worker is needed now.** Production's pilot (#29's other
half) waits for the revamp's deploy (D-42): the Status page now shows the same counters ("Sport score collector") for a
read-only check under real load.
