# Fake provider (local end-to-end testing)

`scripts/fake-provider.js` is a made-up Xtream Codes provider: account, live categories and streams, an M3U, a 96-hour
XMLTV guide with sport, and live MPEG-TS from ffmpeg test patterns. Nothing leaves the machine. It needs Node (22+) and
ffmpeg, no npm packages. Without ffmpeg the API, M3U and guide still work and streams answer 503.

```bash
node scripts/fake-provider.js                                  # profile a on http://127.0.0.1:8090, login pigtv / fake
node scripts/fake-provider.js --port 8091 --profile b --channels 0   # a second provider (other names and ids)
```

In PigTV (Settings → Providers) add an **Xtream** source: URL `http://<host>:8090`, username `pigtv`, password `fake`.
A second one added is a backup; profile b's channels link to a's automatically (same guide ids, "UK| X" = "UK: X").
Start the server with `PIGTV_SPORT_FIXTURES=0` so sport stays offline too. `GET /fake/status` shows what is running;
`POST /fake/fail?stream=<id>&mode=close|stall|404|ok` breaks a channel while it plays. `--help` lists every option.

**Streams** start on the first reader, are shared by every reader of the channel (a late joiner starts on a packet
boundary) and stop `--linger-ms` (5 s) after the last leaves. H.264 640x360 25 fps at a constant 600 kbit/s (above the
server's blank-picture threshold) plus AAC; `.m3u8` is the same stream remuxed to HLS. `--max-connections` (4) is the
account's limit, and a stream past it gets HTTP 403. With an ffmpeg that has drawtext (Debian's does) the picture
carries the channel name and a clock; Homebrew's has none, so channels alternate testsrc and testsrc2 and differ by tone.

**The guide** is anchored on the half hour the provider started in (moved every `--reanchor` hours, default 3): the F1
race (four F1 channels plus Main Event) and a cricket Test and an AFL game are live; an EPL and an NFL game start
within 30 minutes; replays, a delayed "(Live)" airing, magazines and filler fill the rest. Re-sync to pick up a move.

## Channels (profile a)

| Channels | For |
|---|---|
| `UK\| SKY SPORTS F1 UHD/4K`, `F1 FHD`, `F1 HD`, `F1 SD`; `US\| ESPN UHD` / `HD` | Name-based quality (UHD first, FHD = HD, SD last), siblings, per-sport channel preference. The UHD channels are 960x540 (`--uhd-size`), not 4K, to save CPU |
| Other `UK\|`, `AU\|`, `US\|` sport channels | Live now, merged events across channels, backup links |
| `AU\| KAYO SPORTS 1 HD` (no guide id), `##### SKY SPORTS #####` | An unmatched channel; a separator line (404) |
| `UK\| TEST STALLS AFTER 20S` / `CLOSES AFTER 20S` | Each connection stops sending (connection kept) / is dropped after `--stall-after` / `--close-after` s. A reconnect gets a fresh 20 s. For a stall that stays, use `/fake/fail` mode `stall` |
| `UK\| TEST OFFLINE 404` | Refused at once: failover to profile b |
| `UK\| TEST BLACK SCREEN HD` | Black at ~40 kbit/s: the blank-picture check |
| `UK\| TEST HE-AAC AUDIO HD`, `HE-AAC LABELLED MAIN HD` | HE-AAC labelled AAC-LC, and labelled AAC Main (Strong8K's FOX feeds); looped from `test/fixtures/synthetic-heaac.aac` |
| `EXTRA\| FILLER nnn HD` | `--channels N` more ordinary channels |

Profile b carries most of these as `VIP: …`, `|UK| …`, `UK: …` names, with ids from 5000; its TEST channels play normally.

## In a container (Unraid)

```dockerfile
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/fake-provider.js scripts/
COPY test/fixtures/synthetic-heaac.aac test/fixtures/
USER node
CMD ["node", "scripts/fake-provider.js", "--host", "0.0.0.0", "--port", "8090"]
```

`docker build -f <that file> -t pigtv-fake-provider .` from the repo, then `docker run -d --name pigtv-fake-a --cpus 1
--cpu-shares 256 --memory 512m -p 8090:8090 pigtv-fake-provider` (add `--profile b --port 8091` and `-p 8091:8091` for a
second). Listings use the request's Host, so PigTV must reach it by the address it was added with (or set `--public-url`).

**Cost** (Apple M1, 30 Oct): 9–13 % of one core per stream being read at 640x360, 13.5 % at 960x540; nothing when idle
(node itself ~56 MB). Lower it with `--fps 15` or `--size 480x270`; keep `--video-kbps` ≥ 300 or plays are marked blank.
