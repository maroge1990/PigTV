# Sport 2 (server 0712 to 0723): one source for the sport pages (#297, #282, #291 item 2, #29)

| build | change |
|---|---|
| 0712 to 0714 | F1, Events and Cricket pages take each game's status and score from the score collector (as the front page), renewing their own ESPN read only for results (#297 item 1) |
| 0715 | a game still being played past its guide slot stays in /api/sports/events, live, until the collector says it is over (#297 item 3) |
| 0716 | the event list's reading of a programme follows leagues only (#291 item 2; team and keyword matching stays the recording rules') |
| test | with the collector off the only ESPN read is the schedule read, which keeps no score or status (#297 item 2: kept by design) |
| 0717 | with scores off, the Sport front page draws the fixture list's games as upcoming cards with the guide's channels (#282) |
| 0718 | review (Codex high): Cricket shows its own line, crease and declarations only beside the score the account sees |
| 0719 | review (Opus low): a page with an entry answers at once while its read renews |
| 0720 | review (Opus medium): F1 holds back the championship table while the race is still on for the account |
| 0721 | review (Opus medium): an Events item over in the read but on for the account shows none of the read's results |
| 0722 | review (Opus low): Cricket shows no score from its own read when the collector has none to place |
| 0723 | sign-off (Codex high, Mark's go-ahead): a held-back golf field is listed by name, not in finishing order |

`PIGTV_SPORTS_DASHBOARD=0` now means: the collector never starts, polls or writes; the 30-minute fixture read stays as the
schedule read under `PIGTV_SPORT_FIXTURES` (it uses the same ESPN scoreboard URLs, once per day of its window, and stores
no score or status). Production's settings were read for #291 (T4, read only): the relay, standby, shared ingest and
renewal are on, so #291's other items are playback work for a later batch.

Reviews: Codex round 1 (one high, fixed) and an Opus review (two mediums, four lows; the score-delay ones fixed); Codex
signed off 0718 to 0722 with one more high (0723), signed off. Left: #328 (Events fields while both views are live).

Rig T3 (fake providers and scores, build 0711 tree + Sport 2): the EPL game stayed in /api/sports/events past its guide end
with `end` about now + 10 min and left 2 minutes after its final; the front and Football pages agreed while live and at
the final (`window-1366-front.png`, `final-1366-front.png`). Collector off: scheduled cards with the channel and no score
(`off-1366-front.png`); /api/status showed the collector off with 0 ticks. The fake scores server keeps no request log.

#29 re-measure (62 leagues followed, one fake channel over HLS; timings and sizes only):

| | collector on | collector off | 0409 |
|---|---|---|---|
| playlist ms p99 / max | 3 / 10 | 3 / 7 | 3 / 8 |
| segment ms p99 / max | 4 / 8 | 7 / 8 | 4 to 6 / 7 to 10 |
| event-loop p99 per minute | 2 ms | 2 to 3 ms | 2 ms |
| event-loop worst minute | 95 ms | 92 ms | 207 to 253 ms |

Per collector tick: parse 0.1 ms, normalise 2.1, ingest 4.7 (the fake feed's scoreboards are near empty, so the
collector's own cost is lower than a real day's by construction). HLS and the event loop are the same with it on and off.
