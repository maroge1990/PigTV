# GET /api/status cost on a copy of production (#129)

31 Oct 2026. Production's database as copied on 30 Oct (read-only snapshot on the Unraid test share, copied again
before use and deleted after), opened by image 0362 in a test container (`--cpus 3`), no provider contacted, no live
sessions. `measure-status.js` mounted the real status route and timed eight requests and each piece inside them.

| What | Median per request |
|---|---|
| Whole request | **111 ms** (first: 1 005 ms, cold cache) |
| `rawChannels.archiveSummary` (catch-up per provider: a GROUP BY over ~150 000 `provider_raw_channels` rows) | **104 ms** |
| `feedLag.summary` | 0.9 ms |
| `channelHealth.leastReliable` | 0.4 ms |
| Everything else (recordings, interruptions, backups, routing, warming, fixtures) | < 0.3 ms each |

Response size: 11.9 kB. The Status page asked every 5 s while shown, so about 2 % of the event loop went to one
summary that changes only when a sync writes the raw list. 0369 keeps it until then (or an hour).
