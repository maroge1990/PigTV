# Commit inventory: 23 September–21 October 2026

Fixed Melbourne boundaries: `2026-09-23T00:00:00+10:00` through `2026-10-21T23:59:59+11:00`. Newest-first. Includes docs, tests and merges. Inventory is not a line-by-line verification claim. Explicit timezone boundaries were rechecked to ensure early 23 September commits were included; the totals remain 196 server/web and 115 Apple commits.

## PigTV — 196 commits

| Commit | Author date | Subject |
|---|---|---|
| a104726 | 2026-10-18T21:38:52+11:00 | 0226: Status and the recording banner count a shared provider connection once (bug 9) |
| cdf4fb5 | 2026-10-18T20:16:59+11:00 | docs: 18 Oct handover - bug 9, R7 (5c), standbys and warm onto the ingest, B4, what waits on Mark |
| 5aa6488 | 2026-10-18T20:15:44+11:00 | docs: Wave 5 device test step 6 - both ingests closed after their linger |
| 8b630d4 | 2026-10-18T20:15:09+11:00 | docs: Wave 5 device test - one connection shared by viewers and a recording; bug 9 noted |
| 2e71fdc | 2026-10-18T20:00:40+11:00 | docs: samples are named by channel; Fox Sports 505 is even now, so no feed exercises igndts |
| e1d56bb | 2026-10-18T13:58:38+11:00 | docs: shared ingest benched on the server - SAME on six real samples with production ffmpeg |
| 4de6d72 | 2026-10-17T07:17:54+11:00 | docs: Wave 5 status - shared ingest phases 5a/5b, Mark's bench and device checks, handover |
| bb53f28 | 2026-10-17T07:17:02+11:00 | 0225: shared ingest, phase 5b - live plays and their probe read the ingest; one connection per stream (Wave 5, R2) |
| 14597ae | 2026-10-16T15:07:35+11:00 | 0224: shared ingest - bench through the ingest, every queued byte drains, the opener starts at its first PAT |
| dd942a1 | 2026-10-16T15:04:29+11:00 | 0223: shared ingest, phase 5a - one provider connection per stream, recordings first (Wave 5, R2) |
| a3facc1 | 2026-10-16T13:09:38+11:00 | docs: Wave 4 done in code - blueprint, roadmap progress and device checks, handover, operations |
| 16cea0b | 2026-10-16T13:05:33+11:00 | 0222: EPG matching weighs the country, and maps clear matches in one undoable batch (R10) |
| 5338732 | 2026-10-16T13:04:38+11:00 | 0221: Sport lists games announced by event-slot names (R9) |
| bee5ff4 | 2026-10-16T13:04:38+11:00 | test: segments media test watches the second capture's exit from its start |
| 9236a60 | 2026-10-16T12:25:54+11:00 | 0220: recording artwork from the guide (R6) |
| 5d5b449 | 2026-10-16T12:23:41+11:00 | 0219: recording rules - record every game of a team or league, or a series (R5) |
| 1e479d6 | 2026-10-16T11:00:51+11:00 | 0218: segmented recordings, watchable from the start while they record (R3, behind a switch) |
| e3ad3c2 | 2026-10-16T10:31:24+11:00 | docs: R3 approved (Wave 4 brief), tvOS icon option B, and the 16 Oct handover |
| f3a980c | 2026-10-16T10:21:24+11:00 | docs: Plan B1 status in the blueprint and Wave 3 progress in the roadmap |
| d727bea | 2026-10-16T10:21:03+11:00 | 0217: groups a provider's sync never imports (R8, pilot) |
| 77824f5 | 2026-10-16T10:17:29+11:00 | 0216: whether a provider offers catch-up is kept and shown on Status |
| ba93756 | 2026-10-16T10:15:40+11:00 | 0215: one webhook for provider down, recording failed and licence ending (R11) |
| d110f79 | 2026-10-16T10:11:31+11:00 | 0214: a recording's end follows the guide (R4) |
| 35c60e3 | 2026-10-16T10:08:17+11:00 | 0213: the server backs up its database before migrations and nightly (R12) |
| aaf4fcb | 2026-10-16T09:58:10+11:00 | docs: Wave 2 progress and the cricket probe's findings |
| 13176d4 | 2026-10-16T09:57:07+11:00 | 0212: a favourite is pink on the web too, and the copy says favourites |
| 68584e2 | 2026-10-16T09:55:09+11:00 | 0211: the web guide only refreshes while it is on screen, and only when changed |
| 4439aaf | 2026-10-16T09:52:28+11:00 | 0210: the web's viewing actions work from the keyboard |
| 01942e9 | 2026-10-16T09:39:20+11:00 | docs: Wave 1 progress in the roadmap and the blueprint's state line |
| cc23fe0 | 2026-10-16T09:15:38+11:00 | 0209: web guide, Home and Back/Forward settle on the latest intent |
| 25881cb | 2026-10-16T09:13:06+11:00 | 0208: the image carries Unraid's icon and WebUI labels |
| 3ed3254 | 2026-10-16T09:13:06+11:00 | tests: a port taken between freePort() and listen is retried, not a red run |
| bf6bd6a | 2026-10-16T09:10:48+11:00 | docs: commit-only workflow, the 15 Oct review and the 16 Oct roadmap |
| 3449719 | 2026-10-13T21:18:38+11:00 | tests: the two slowest files wait a tenth as long (suite 58 s -> 35 s) |
| dd31238 | 2026-10-13T20:54:42+11:00 | docs: AGENTS.md, a trimmed blueprint and the Plan B roadmap |
| a4e0cb1 | 2026-10-13T20:47:43+11:00 | docs: final TEST-BLOCK results (rounds 7 and N complete) |
| ff5780e | 2026-10-10T18:32:11+11:00 | 0207: recordings batch (scroll, delete failures, resume, live comskip) |
| 03a585b | 2026-10-10T18:32:11+11:00 | recordings: scroll, delete failures, per-login resume, live comskip |
| 3e1b784 | 2026-10-10T10:11:15+11:00 | 0206: Pig family brand 1.6.0 |
| d5a7ad3 | 2026-10-10T10:11:15+11:00 | brand: Pig family 1.6.0 in the web app |
| e1aa273 | 2026-10-04T19:44:06+11:00 | 0205: the linker sees linked siblings again |
| e2544a3 | 2026-10-04T14:32:07+11:00 | 0204: the simplification build |
| 7d7dbc2 | 2026-10-04T14:29:36+11:00 | simplify: verify-build keeps only what tests cannot check (1,077 -> 297 checks) |
| cb8e339 | 2026-10-04T14:28:35+11:00 | feat: a provider's linked "(Backup)" feeds are not listed in the guide |
| 7d00647 | 2026-10-04T14:21:50+11:00 | simplify: recordingEngine.js split into capture, media and post-processing |
| a641db0 | 2026-10-04T14:16:31+11:00 | simplify: the tuner model and six rollback flags are gone |
| 8d8217a | 2026-10-04T14:06:05+11:00 | test: speed budgets run in their own non-blocking CI job |
| a2cb13e | 2026-10-04T14:04:56+11:00 | test: one way to start the real server in tests; the terminal-status expiry test survives load |
| 12ed73e | 2026-10-04T13:08:35+11:00 | test: the stream-auth test really starts its server; recording lookups create the schema |
| ae51851 | 2026-10-04T12:58:25+11:00 | test: the relink performance guard allows 10 s (a CI runner took 3.3 s) |
| c3a7b07 | 2026-10-04T12:54:06+11:00 | 0203: recordings are captured as MPEG-TS; audio is re-encoded when prepared and must decode before an original is deleted |
| 9976138 | 2026-10-04T09:48:38+11:00 | docs: TEST-BLOCK O for Phase 3; blueprint next steps |
| 68c8c41 | 2026-10-04T09:21:37+11:00 | 0202: a hot standby may take a warm channel's connection |
| 5a4b4b5 | 2026-10-04T08:27:16+11:00 | 0201: sport event requests are served from a per-minute cache |
| 8580524 | 2026-10-04T08:26:43+11:00 | 0200: the web nav is labelled for everyone; Status pauses when hidden and shows the background work (audit R16) |
| 4e0b363 | 2026-10-04T08:26:12+11:00 | 0199: the image runs as PUID/PGID (99:100 by default), is built in stages, and reports its health (audit R17) |
| 205db98 | 2026-10-04T08:25:50+11:00 | 0198: provider connections are leased before the probe; the likely next channel can be warmed (audit R11) |
| d9992d7 | 2026-10-04T08:25:03+11:00 | 0197: in-stream recovery and the hot standby are Settings switches; Status shows what they do (audit R12) |
| 6387a77 | 2026-10-04T08:24:40+11:00 | docs: TEST-BLOCK results (Mark, 4 Oct): M1-M3, N1, N3, N4 passed |
| 0ef5985 | 2026-10-04T03:48:16+11:00 | docs: TEST-BLOCK N for the audit build; blueprint next steps |
| 2467ff7 | 2026-10-04T03:46:26+11:00 | test: recording-failover runs without background preparation |
| b52ec54 | 2026-10-04T01:56:24+10:00 | 0196: media and session control always need a signed-in user; the proxy takes handles only (audit R01) |
| a9d8fc8 | 2026-10-04T01:43:20+10:00 | 0195: sport events are built on a worker thread (audit R09) |
| c684be0 | 2026-10-03T20:14:30+10:00 | 0194: the recordings routes read files asynchronously (audit R09) |
| 4f49f2f | 2026-10-03T20:07:02+10:00 | 0193: recordings are prepared before the first Play; compression verifies before it deletes (audit R06, R08) |
| 29f4adf | 2026-10-03T19:44:54+10:00 | 0192: recording codec probe reads ffprobe JSON by field name (audit R02) |
| 3699628 | 2026-10-03T15:27:43+10:00 | Updated Tuning |
| 2e78e0d | 2026-10-03T12:51:02+10:00 | Detailed brand refresh |
| 8fadcdd | 2026-10-03T07:11:43+10:00 | Design Refresh |
| d414c2f | 2026-10-02T13:32:43+10:00 | 0190: the Status page no longer keeps streams alive, and names the channel and provider |
| e3c57a2 | 2026-10-02T13:18:35+10:00 | 0189: in-stream recovery and a hot standby, off by default (PIGTV_RELAY, PIGTV_STANDBY) |
| 65d3bcd | 2026-10-02T12:56:19+10:00 | 0188: streams lost mid-play are counted, with the time to recover (Status -> Interruptions) |
| a346cbe | 2026-10-02T12:53:53+10:00 | 0187: the build badge is right again; the PigTV name shows on the light theme |
| 02fe866 | 2026-10-02T12:00:40+10:00 | 0186: only the English Premier League is EPL |
| 1f28506 | 2026-10-02T11:20:51+10:00 | 0185: more sport fixtures, leagues and teams picked from lists, old grand prix no longer live |
| 8b30c11 | 2026-10-02T10:30:46+10:00 | 0184: provider cards show the playlist login, backup coverage, and the EPGenius playlist on Xtream cards only |
| 1ce9ad9 | 2026-10-02T10:29:14+10:00 | 0183: an M3U backup covers the provider's whole list, not only its playlist |
| 616b1f2 | 2026-10-02T09:10:03+10:00 | 0182: one Providers section with identical cards; settings from 14 tabs to 6 |
| e9df35a | 2026-10-01T08:36:55+10:00 | Docs: Fox Footy 504 audio flood on the watch list; next build 0182 |
| 9224b27 | 2026-10-01T08:35:17+10:00 | 0181: providers that are the same account share one connection pool, and the admin is warned (P10) |
| f9d636c | 2026-10-01T08:32:31+10:00 | 0180: a start stopped on request is not a provider failure (P10) |
| 13e53c2 | 2026-10-01T07:08:17+10:00 | Docs: round 7 for 0179 (Dream4K as raw Xtream, backup order), blueprint 0179 |
| a3fa14f | 2026-10-01T07:08:02+10:00 | 0179: a raw-epg link is automatic only when the names agree too |
| ce93299 | 2026-10-01T07:05:16+10:00 | 0178: raw-list bridge for the channel linker (P9) |
| e51be22 | 2026-10-01T06:57:58+10:00 | Test fixtures: raw Xtream lists for Strong8K and Dream4K |
| 684e884 | 2026-10-01T06:12:32+10:00 | Docs: multi-provider build status and round 7 test list |
| 63dd48d | 2026-09-30T22:15:32+10:00 | 0177: recordings fail over between providers (P7) |
| 1898a3d | 2026-09-30T21:41:42+10:00 | 0176: review fixes for P8 (reminder banner, Status providers) |
| 81b7dee | 2026-09-30T21:37:36+10:00 | 0175: Status providers panel and reminder banner (P8) |
| b462c37 | 2026-09-30T21:30:01+10:00 | 0174: resolve failover, breaker, quarantine and C-J (P6) |
| 7651fd0 | 2026-09-30T21:11:36+10:00 | 0173: per-provider connection pools (P5) |
| 5bee9cc | 2026-09-30T21:00:01+10:00 | 0172: Settings Providers and Backup links pages (multi-provider P4) |
| 76bd8ed | 2026-09-30T20:47:24+10:00 | 0171: channel linker and backup links API (P3) |
| 83493dd | 2026-09-30T20:27:21+10:00 | 0170: backup provider sync into backup_channels (P2) |
| d6424c5 | 2026-09-30T20:17:13+10:00 | 0169: read the login from EPGenius's dns key |
| 61e9c42 | 2026-09-30T20:13:14+10:00 | 0168: provider fields, account info and licence reminders (P1) |
| 4fc02ea | 2026-09-30T20:13:14+10:00 | Docs: contract C-K (licence reminders) |
| 4285601 | 2026-09-30T20:06:09+10:00 | Docs: multi-provider failover development brief and provider fixtures |
| 81c3330 | 2026-09-29T10:30:37+10:00 | Docs: handover state after the 28-29 Sept fix run |
| e8e7dd0 | 2026-09-29T08:23:10+10:00 | 0167: Settings refuses a relative recordings path |
| 3c6146b | 2026-09-29T06:44:22+10:00 | Docs: test block round 6 (server 0166, app 34) |
| a4b87c9 | 2026-09-29T06:43:54+10:00 | Docs: blueprint header after 0161-0166 were pushed |
| be6714d | 2026-09-29T06:41:11+10:00 | Update verify-build.sh: verify dead channel-number ordering code was removed in 0164 |
| 02ddc2b | 2026-09-29T06:39:03+10:00 | Update blueprint.md: document W10 cleanup (0163-0166), update next build number |
| fde2bb2 | 2026-09-29T06:38:02+10:00 | 0166: Remove dead CSS for removed hidden-items list |
| 0be79f2 | 2026-09-29T06:35:39+10:00 | 0165: Remove web player and settings leftovers from deleted Movies/Series pages |
| a9f731a | 2026-09-29T06:31:42+10:00 | 0164: Remove dead channel-number ordering branches in /guide and /channels |
| 4abbb09 | 2026-09-29T06:26:57+10:00 | 0163: Remove unused xml2js dependency and nodecast.patch |
| ef5c3e4 | 2026-09-29T06:22:56+10:00 | 0162: stale or out-of-window ESPN data must never manufacture a replay (C-I) |
| 999b20d | 2026-09-29T06:11:31+10:00 | 0161: ESPN fixtures as a first rule for live vs replay (C-I) |
| 3c2326a | 2026-09-28T21:49:06+10:00 | 0160: the recordings folder is never created inside a disconnected share |
| 63e2903 | 2026-09-28T21:43:35+10:00 | Docs: blueprint after 0156-0159 (schedule observability, recordings folder health, prompt timeout, sport events off the request path) |
| 49bbfa0 | 2026-09-28T21:41:24+10:00 | 0159: sport events are built off the request path |
| 3d2216f | 2026-09-28T21:32:22+10:00 | 0158: an unanswered recording prompt no longer blocks a recording forever |
| 3c91e86 | 2026-09-28T21:25:12+10:00 | 0157: the recordings folder is checked for real, not just for free space |
| 349276f | 2026-09-28T21:18:18+10:00 | 0156: missed and failed schedules are logged and kept visible |
| 555a21f | 2026-09-26T07:00:14+10:00 | 0155: tuner compatible joining (an Apple TV shares a recording's HE-AAC tuner) |
| 0a531b1 | 2026-09-26T06:48:31+10:00 | Docs: handover once-over |
| 0994a5f | 2026-09-26T06:09:37+10:00 | 0154: full-resolution logos for the Top Shelf (?size=full, ?size=640) |
| bcd1be4 | 2026-09-25T22:20:11+10:00 | 0153: the sport horizon is a whole weekend: hours up to 72 (C-I) |
| 5f93402 | 2026-09-25T22:16:13+10:00 | 0152: sport live or replay from guide flags, the first airing and league hours (C-I) |
| 34cc093 | 2026-09-25T18:03:45+10:00 | Docs: test block round 4 (server 0151, app 31) |
| 1bb80bc | 2026-09-25T16:57:45+10:00 | 0151: web Settings -> Sports preview grouped by kind |
| acf0edc | 2026-09-25T16:55:34+10:00 | 0150: sport programmes have a kind, and listings of one game merge by meaning (C-I) |
| df6d583 | 2026-09-25T11:38:00+10:00 | Docs: test block round 3 (server 0149, app 30) |
| 392a7a1 | 2026-09-25T10:35:19+10:00 | Docs: blueprint after 0147-0149 (sport events, C-I) |
| e05d111 | 2026-09-25T10:34:44+10:00 | 0149: web Settings -> Sports: the follow list and a preview of recognised events |
| 298b7d0 | 2026-09-25T10:32:22+10:00 | 0148: sport events recognised per programme, and the follow list (C-I) |
| 77d7157 | 2026-09-25T09:01:41+10:00 | 0147: EPG programme categories are stored, and counted for the Status page |
| f160fdf | 2026-09-25T08:53:45+10:00 | Docs: contract C-I, sport events recognised per programme |
| 0d09a41 | 2026-09-25T06:57:26+10:00 | Docs: the Sport toggle lives in Settings → Manage Content |
| 29679e0 | 2026-09-25T01:14:35+10:00 | Docs: test block round 2 (server 0146, app 28) |
| 4b14fad | 2026-09-24T23:54:30+10:00 | Docs: blueprint after 0141-0146 (Mark's test-block fixes) |
| a43a885 | 2026-09-24T23:53:48+10:00 | 0146: sport categories for the Apple Home screen (C-H) |
| 5fb4950 | 2026-09-24T23:52:37+10:00 | Test: the fail-fast check allows for 0143's two refused-connection retries |
| 5b82d9c | 2026-09-24T23:49:16+10:00 | 0145: the playback report shows where the time goes (client wait) |
| 14934ff | 2026-09-24T23:47:34+10:00 | 0144: a finite source starts with an 8 s burst, then real time |
| de1cb40 | 2026-09-24T23:42:02+10:00 | 0143: a refused reconnect gets two retries (1.5 s, then 3 s) |
| 6a9d12a | 2026-09-24T23:37:32+10:00 | 0142: stalls count towards channel health |
| fb4b9fc | 2026-09-24T23:34:31+10:00 | 0141: logos keep their transparency |
| 2409dc6 | 2026-09-24T23:03:33+10:00 | Docs: contract C-H, sport categories for the Home screen |
| d15a60f | 2026-09-24T21:52:11+10:00 | 0140: a deploy makes cached guides reload once |
| 4c98d3c | 2026-09-24T21:50:49+10:00 | 0139: channel numbers are labels; the guide keeps the provider's order |
| 7b21d9c | 2026-09-24T19:10:44+10:00 | Docs: the combined test block for builds 0138 / app 22 |
| a0b132e | 2026-09-24T19:08:25+10:00 | Docs: blueprint after 0133-0138 (Phase 4 server round) |
| c8cb4e1 | 2026-09-24T19:07:42+10:00 | 0138: Carried-over small items - /api/info resilience, stored badges, P2-8 tests |
| 32da410 | 2026-09-24T19:02:41+10:00 | 0137: Express 5 (S4.3c) |
| be14f17 | 2026-09-24T18:57:08+10:00 | 0136: Auth without passport - jsonwebtoken and bcrypt directly (S4.3b) |
| 58f9ee4 | 2026-09-24T18:53:14+10:00 | 0135: Sources, settings and users move from db.json into SQLite (S4.3a) |
| 81ec71f | 2026-09-24T18:47:19+10:00 | 0134: EPG matching tool - admin maps a channel to an EPG id (S4.2) |
| 42a6df5 | 2026-09-24T18:42:05+10:00 | 0133: Channel health - per-channel start outcomes, `health` on guide rows (C-G) |
| 8ec1091 | 2026-09-24T18:35:52+10:00 | 0132: timeshift can live on a local disk (PIGTV_TIMESHIFT_DIR) |
| 4a9c31b | 2026-09-24T18:33:57+10:00 | Docs: blueprint after 0125-0131 (the tuner model behind PIGTV_TUNER=1) |
| d0a98ee | 2026-09-24T18:33:22+10:00 | 0131: A recording lets go of a tuner that died, and takes the channel up again |
| f996769 | 2026-09-24T14:39:08+10:00 | 0130: A recording's own tuner uses the Apple TV's default capabilities (no heaac) |
| 120c640 | 2026-09-24T14:24:35+10:00 | 0129: Tuner model T4 - watch a recording while it records, from its start (PIGTV_TUNER=1) |
| 761724f | 2026-09-24T14:21:25+10:00 | 0128: Tuner model T3 - timeshift: hours of segments on the recordings volume, delta playlists, gzip |
| bd7e77a | 2026-09-24T14:16:35+10:00 | 0127: Tuner model T2 - recordings take their segments from a tuner (PIGTV_TUNER=1) |
| 9ff958f | 2026-09-24T14:05:12+10:00 | 0126: Tuner model T1 - viewers of one channel share a tuner (PIGTV_TUNER=1, off by default) |
| 9b3a414 | 2026-09-24T13:41:56+10:00 | 0125: HTML is revalidated after a redeploy |
| b0d2fe5 | 2026-09-24T13:35:57+10:00 | Docs: blueprint after 0121-0124 (web on /api/library, fork removals, channel-number editor, status page) |
| b8bb576 | 2026-09-24T13:35:31+10:00 | 0124: Admin status page (W2.2) |
| e5ce771 | 2026-09-24T09:27:07+10:00 | 0123: Channel-number editor in Settings (X2.1, web) |
| 6b2ac88 | 2026-09-24T09:24:00+10:00 | 0122: Delete the fork leftovers (W2.1) |
| e80d4cd | 2026-09-24T09:15:21+10:00 | 0121: The web reads /api/library (W2.1) |
| 7417669 | 2026-09-24T08:59:11+10:00 | Docs: blueprint after 0117-0120 (channel numbers, resolve wording, playback handles, source catalogue) |
| 377cbae | 2026-09-24T08:58:39+10:00 | 0120: GET /api/sources/:id/catalogue for the Sources picker |
| 1c7ceec | 2026-09-24T08:56:56+10:00 | 0119: Opaque playback handles for direct plays; redacted proxy/probe logs (C-D) |
| 41fad36 | 2026-09-24T08:52:33+10:00 | 0118: Resolve failures use the client's allowed wording, never a URL (C-B) |
| f85f38f | 2026-09-24T08:47:32+10:00 | 0117: Channel numbers and the admin lineup API (C-A, roadmap X2.1) |
| 224a2fb | 2026-09-24T08:40:37+10:00 | Docs: server/client contracts for Phases 2-4; one testing block |
| d8f0d64 | 2026-09-23T22:12:05+10:00 | Docs: record the Phase 1 speed baseline |
| c7643c4 | 2026-09-23T22:08:27+10:00 | Docs: queue client follow-ups to 0113/0116 (A1.3) |
| e159a25 | 2026-09-23T22:07:00+10:00 | Docs: blueprint after 0113-0116, and the provider's 38 s cut |
| e5711ec | 2026-09-23T22:03:12+10:00 | 0116: HE-AAC passthrough for clients that can decode it (capability heaac) |
| 773fd84 | 2026-09-23T21:59:31+10:00 | 0115: frame-rate-aware master playlist for every session (roadmap S1.2) |
| 51bd72c | 2026-09-23T21:56:00+10:00 | 0114: channel profiles - a repeat play skips ffprobe (roadmap S1.1) |
| cc83485 | 2026-09-23T21:52:16+10:00 | 0113: fail fast, say why, retry a refused first connection once; report relabelled |
| d7f735b | 2026-09-23T21:25:55+10:00 | Docs: roadmap status after 0110-0112 |
| 119b4fd | 2026-09-23T21:24:52+10:00 | 0112: logo cache (roadmap S1.4) |
| ce9ce30 | 2026-09-23T21:17:20+10:00 | 0111: guide API for scale (roadmap S1.3) |
| 968bc69 | 2026-09-23T21:04:11+10:00 | 0110: favourites follow the channel's identity in /api/favorites |
| ac3f69d | 2026-09-23T15:29:49+10:00 | CI: test on Node 22 and 24 (Node 20 is end of life) |
| 710f361 | 2026-09-23T15:39:43+10:00 | Docs: Phase 0 status after review |
| 2ba44f2 | 2026-09-23T15:29:49+10:00 | 0109: supported runtime and a reproducible image |
| 7a8e75a | 2026-09-23T15:25:18+10:00 | 0108: gzip JSON responses, never media or ranged requests |
| 90fcc6b | 2026-09-23T15:21:45+10:00 | 0107: remove the dead duplicate GET /epg/:sourceId and DELETE /cache/:sourceId |
| ae5f0ec | 2026-09-23T15:20:06+10:00 | 0106: stableId actually present on guide and favourites rows |
| 59d3edc | 2026-09-23T15:16:31+10:00 | Docs: new blueprint with the joint roadmap; archive the old ones |
| 0e68c03 | 2026-09-23T14:51:22+10:00 | Ship from the MacBook: push to main, image only after tests pass |
| 209c84e | 2026-09-23T10:46:23+10:00 | Docs: refresh the blueprint; move its history to the archive |
| f45d0ae | 2026-09-23T09:50:57+10:00 | Harden HLS sessions: honest exits, a narrower retry, network-only inputs |
| 31ed4f6 | 2026-09-23T09:41:44+10:00 | Retire remux: HLS sessions are the only delivery path (Phase 4) |
| b29b188 | 2026-09-23T09:34:44+10:00 | Put the web player on the one path (Phase 3) |
| 7ff435c | 2026-09-23T09:22:42+10:00 | Give the watchdog's "keeps writing" test room for a busy CI runner |
| 97fb829 | 2026-09-23T08:55:03+10:00 | HDR channels carry VIDEO-RANGE in a master playlist (SR-1) |

## PigTV-Swift — 115 commits

| Commit | Author date | Subject |
|---|---|---|
| 8f09ea3 | 2026-10-18T21:34:59+11:00 | Build 46: one header position on every tab, iPhone Guide search icon, no player TV Guide pill, tvOS fast-scroll snap-back |
| 4e3046b | 2026-10-16T13:09:38+11:00 | docs: builds 44-45 in the blueprint (watch from start, rules, artwork) and the current build |
| f8b98e4 | 2026-10-16T13:08:40+11:00 | Build 45: recording rules and programme artwork (C-M, C-N; server 0219, 0220) |
| fe0173c | 2026-10-16T11:24:59+11:00 | Build 44: watch a recording from the start while it records (C-L, server 0218) |
| a6482af | 2026-10-16T10:27:25+11:00 | Build 43: the larger tvOS app icon (kit 1.7.1, option B) |
| 78eb3dd | 2026-10-16T09:54:10+11:00 | Build 42: one page header, iPhone category refresh, no "cancelled" errors |
| 3eff8cd | 2026-10-16T09:10:48+11:00 | docs: commit-only workflow and the 15 Oct review note |
| 63f9a43 | 2026-10-14T06:59:06+11:00 | tests: run in tiers, cheapest first (Tools/test.sh) |
| 6889c18 | 2026-10-13T21:16:38+11:00 | docs: AGENTS.md, a trimmed blueprint, working test commands |
| 72beb6f | 2026-10-10T18:32:19+11:00 | Build 41: recordings grid, landscape guide, resume, landscape player, PiP |
| d007d8e | 2026-10-10T10:11:22+11:00 | Build 40: Pig family brand 1.6.0 |
| 156ab0e | 2026-10-04T15:19:40+11:00 | Build 39: guide long-press test waits for the details cover to settle |
| af511a6 | 2026-10-04T14:44:09+11:00 | chore: build 39; blueprint for the simplification build |
| dd317d8 | 2026-10-04T14:41:34+11:00 | simplify: the largest app files split by type; tests wait for state, not a fixed time |
| 8eef2ee | 2026-10-04T14:37:54+11:00 | simplify: Start over, the timeshift window and HLS recordings are gone from the app |
| 1aa8210 | 2026-10-04T10:24:44+11:00 | test: the recovery-allowance test waits for the model to know it played |
| 3cd33c0 | 2026-10-04T10:04:22+11:00 | docs: build 38 in the blueprint (Phase 3 client work, test baseline) |
| ffabd68 | 2026-10-04T09:48:09+11:00 | chore: build 38 |
| 441ba2a | 2026-10-04T09:48:00+11:00 | Merge branch 'p3/observation' into p3/app-integration |
| c6acddb | 2026-10-04T09:47:37+11:00 | perf: screens observe only what they show (audit R05) |
| 9244fb6 | 2026-10-04T09:20:15+11:00 | feat: the app warms the channel you are likely to play next (audit R11; server setting, off by default) |
| 82edd0a | 2026-10-04T09:05:22+11:00 | Merge branch 'p3/guide-stall' into p3/app-integration |
| ba10988 | 2026-10-04T09:04:54+11:00 | fix: the guide store notices programme corrections of the same shape (audit R14) |
| f83295e | 2026-10-04T09:04:54+11:00 | perf: the TV Guide opens without a first-visit stall |
| c63a42b | 2026-10-04T08:20:51+11:00 | perf: artwork is fetched once per logo, written off the main thread, and bounded |
| 6776dab | 2026-10-04T08:20:51+11:00 | fix: private caches are per server and account, and cleared on sign-out (audit R14) |
| 4febfcd | 2026-10-04T04:08:03+11:00 | test: the first TV Guide visit keeps the 1 s limit until the Guide work lands |
| 5359474 | 2026-10-04T03:47:49+11:00 | docs: build 37 in the blueprint (audit client work, test baseline) |
| 09ed009 | 2026-10-04T03:29:42+11:00 | Merge branch 'audit/sw-r03' into audit/sw-integration |
| ce7dfdc | 2026-10-04T03:23:35+11:00 | test: the tab-switch test measures what the remote feels, with signposts for device profiling (audit R03) |
| 5592332 | 2026-10-04T03:16:39+11:00 | Merge branch 'audit/sw-sport' into audit/sw-integration |
| e6380dd | 2026-10-04T03:16:09+11:00 | perf: Sport builds only what is on screen (audit R04/R05) |
| 1e84c5b | 2026-10-04T03:00:15+11:00 | Merge branch 'audit/sw-r07' into audit/sw-integration |
| dd326d9 | 2026-10-04T01:59:51+10:00 | feat: recordings show when the server is still preparing them |
| bdb79b0 | 2026-10-04T01:59:51+10:00 | fix: a recording starts without waiting for its break markers (audit R07) |
| e49fee5 | 2026-10-04T01:57:51+10:00 | Merge branch 'audit/r10-ci-fix' into audit/sw-integration |
| 337a942 | 2026-10-04T01:43:20+10:00 | test: the large Sport fixture lands in every bucket at a fixed clock |
| 110e604 | 2026-10-04T01:43:20+10:00 | test: the large Sport fixture lands in every bucket at a fixed clock |
| 529f6f6 | 2026-10-04T01:25:10+10:00 | fix: recordings fixture is offline and the UI-test focus helper waits for focus |
| d1eadb2 | 2026-10-03T21:48:45+10:00 | fix: the provider reminder no longer asks for dates to be typed |
| f897ad6 | 2026-10-03T21:48:43+10:00 | chore: remove Siri and App Shortcuts (not wanted; failed on tvOS) |
| ca367d5 | 2026-10-03T19:48:59+10:00 | chore: Tools/bump-build.sh; build 37 |
| 424a0e9 | 2026-10-03T19:48:54+10:00 | test: production-sized Sport fixture (PIGTV_UI_TEST_SPORT_EVENTS) |
| 96825f8 | 2026-10-03T15:27:54+10:00 | Updated TV Guide categories |
| 736813a | 2026-10-03T12:51:10+10:00 | Detailed brand refresh |
| 9d63eaa | 2026-10-03T07:11:36+10:00 | Design Refresh |
| 6fffdbd | 2026-09-30T20:49:13+10:00 | ci: sign tvOS tests ad hoc so the App Group exists |
| 88398e3 | 2026-09-30T20:38:16+10:00 | feat: multi-provider client (provider on resolve, licence reminders, renewed recovery allowance) |
| 367545e | 2026-09-30T20:38:16+10:00 | chore: bump app build to 36 |
| 4dcb48c | 2026-09-29T10:31:12+10:00 | docs: handover state at build 35 |
| 5ec8f86 | 2026-09-29T09:05:12+10:00 | feat: Spotlight branding (icons, Top Shelf, launch screen, animated splash) |
| eb2b2b6 | 2026-09-29T08:35:28+10:00 | fix: guide Jump to… and Search are full-screen pages on tvOS |
| 4181f3c | 2026-09-29T08:35:28+10:00 | chore: bump app build to 35 |
| b1c50d3 | 2026-09-28T22:04:19+10:00 | fix: review follow-ups for build 34 (sport buckets use the new clock; problem rows focusable on tvOS; empty text counts active schedules only) |
| 6af71f6 | 2026-09-28T22:01:34+10:00 | chore: bump app build to 34 |
| c4fb7b4 | 2026-09-28T22:01:28+10:00 | perf: optimize sport refresh to avoid unnecessary work |
| f6e47de | 2026-09-28T22:01:20+10:00 | feat: show missed and failed recordings from last 7 days |
| ede9ca6 | 2026-09-28T21:48:39+10:00 | docs: blueprint and testing notes for the sport-channel and guide-forward fixes; build 33 |
| 722dca9 | 2026-09-28T21:48:32+10:00 | fix: the TV guide extends forward instead of hitting a wall; build 33 |
| c44309f | 2026-09-28T21:14:10+10:00 | fix: an upcoming sport event's secondary channels offer Record or Watch when it starts, not an immediate tune |
| 3b5be1e | 2026-09-26T06:48:31+10:00 | Docs: handover once-over |
| 9aac4ea | 2026-09-26T06:30:14+10:00 | feat: Sport covers 72 hours in Tomorrow and weekday sections |
| 266b5da | 2026-09-26T06:23:20+10:00 | feat: Top Shelf shows rendered 16:9 cards instead of stretched logos |
| bc54149 | 2026-09-25T22:17:03+10:00 | fix: tab switches never show tvOS's backdrop; build 32 |
| c96c95e | 2026-09-25T17:59:01+10:00 | feat: Sport tab has a Replays section |
| de2da66 | 2026-09-25T17:53:14+10:00 | perf: tabs switch without reloading; measured on 1,000 channels |
| da32dc9 | 2026-09-25T17:28:26+10:00 | fix: Siri App Shortcuts register channels at launch; Open PigTV shortcut |
| 1102411 | 2026-09-25T17:23:42+10:00 | feat: iPad and iPhone player has one set of large touch controls |
| a91770c | 2026-09-25T17:07:00+10:00 | fix: Top Shelf extension enters through NSExtensionMain; diagnostics in Settings |
| 99b6ffa | 2026-09-25T16:49:53+10:00 | fix: Home fits the hero and two shelves on one TV screen; build 31 |
| 6e2ba71 | 2026-09-25T11:34:37+10:00 | docs: blueprint and screenshots for the Sport feature (build 30) |
| 6f21a62 | 2026-09-25T11:34:37+10:00 | feat: Sport tab and Home "Sport now & next" from sport events (C-I); build 30 |
| 3f6362a | 2026-09-25T11:05:43+10:00 | feat: iPad and iPhone player and guide match the TV |
| 6e6728a | 2026-09-25T09:07:25+10:00 | feat: channel numbers never over artwork; muted text after the name |
| 0bebaa0 | 2026-09-25T08:59:59+10:00 | fix: shared App Group files live under Library/Caches (tvOS refuses the container root); build 29 |
| e2337da | 2026-09-25T01:07:53+10:00 | feat: programme information redesign and a consistency pass |
| 5132e76 | 2026-09-25T00:46:41+10:00 | feat: Home screen, the tab the app opens on |
| 3acdad7 | 2026-09-25T00:23:42+10:00 | build: Swift 6 language mode for the app and Top Shelf, callbacks made explicit |
| 37cf04d | 2026-09-25T00:15:45+10:00 | test: real-playback harness (local HTTP server, HLS fixture); build 28 |
| c2156fe | 2026-09-25T00:05:46+10:00 | fix: Top Shelf extension can load http logos; os_log diagnostics end to end |
| e7a5d88 | 2026-09-25T00:00:03+10:00 | fix: legible tvOS tab bar: solid pink focused pill, pink-on-faint-pink selection |
| 0315994 | 2026-09-24T23:50:33+10:00 | refactor: the UIKit guide is the only tvOS grid; old SwiftUI tvOS grid removed |
| 78aae69 | 2026-09-24T23:45:21+10:00 | feat: HE-AAC passthrough on for every play; Labs switch removed |
| b95fe6b | 2026-09-24T23:41:54+10:00 | fix: one-off fallbacks for -11868 (stream playlist) and 'fmt?' (audioEncode) |
| cd362ab | 2026-09-24T23:37:36+10:00 | fix: channel start no longer waits ~3 s for display criteria (build 27) |
| 6c63acd | 2026-09-24T22:29:13+10:00 | fix: guide Details icon missing on tvOS (build 26) |
| 58406a7 | 2026-09-24T22:20:25+10:00 | fix: link AVKit on tvOS so display-mode switching can't crash (build 25) |
| c59ff41 | 2026-09-24T22:13:29+10:00 | fix: channel start crashed on AVPlayerItem.externalMetadata (build 24) |
| cb161e6 | 2026-09-24T21:46:21+10:00 | fix: crash on channel load; back to Swift 5 language mode (build 23) |
| e95a83f | 2026-09-24T18:52:51+10:00 | A4.5: app target in the Swift 6 language mode |
| 10fb951 | 2026-09-24T18:46:21+10:00 | A4.5: Siri Play channel intent with a channel entity query and App Shortcut |
| ddbef96 | 2026-09-24T18:41:38+10:00 | A4.4: iPhone On now list; iOS player Last channel and control layout |
| 34ca576 | 2026-09-24T14:40:37+10:00 | A4.1: Top Shelf extension, App Group snapshot and pigtv://play deep links |
| e657712 | 2026-09-24T14:27:07+10:00 | A2.1: new guide Now in the header, Up from the grid lands on it; Earlier/Later keep focus |
| 851f4ad | 2026-09-24T14:19:13+10:00 | A4.2: stream info overlay behind Labs; play-end dropped frames and bitrate (build 22) |
| 479d08f | 2026-09-24T14:08:57+10:00 | A2.1: UIKit guide focus restore, focus-following header moves, cell rendering |
| a210fae | 2026-09-24T13:52:04+10:00 | A4.3/C-E: tvOS recordings in the custom player; HLS recordings |
| 0228b2e | 2026-09-24T13:41:30+10:00 | C-E: timeshift Start over and programme timeline (build 21) |
| f46e4f5 | 2026-09-24T09:25:14+10:00 | A2.1: UIKit TV-guide grid behind Labs → New guide (build 20) |
| cd669dc | 2026-09-24T08:53:55+10:00 | C-G: mark flaky channels in the guide |
| 6870017 | 2026-09-24T08:51:36+10:00 | C-A: decode and show channel numbers; iOS Go to number |
| 90f76fc | 2026-09-24T08:47:26+10:00 | C-B: show allow-listed resolve error messages |
| 344e50e | 2026-09-24T08:45:04+10:00 | C-F/C-C: Settings Labs section and HE-AAC passthrough capability (build 19) |
| 3952a45 | 2026-09-23T21:20:43+10:00 | A1.2 (2/2): "Last channel" memory |
| 656daf6 | 2026-09-23T21:18:35+10:00 | A1.2 (1/2): tvOS tuning/reconnecting card |
| 25d843a | 2026-09-23T21:10:14+10:00 | A1.1: cursor-paged, version-gated guide refresh (build 18) |
| 78c7376 | 2026-09-23T15:35:35+10:00 | A0.3: add Swift CI workflow (iOS build + tvOS tests) |
| 6e81521 | 2026-09-23T15:24:59+10:00 | A0.1: delete unused live-channels/favourites code and retire /api/remux |
| 6ecbab4 | 2026-09-23T15:16:28+10:00 | docs: archive the old blueprint; new blueprint points at the joint roadmap |
| b624c40 | 2026-09-23T14:51:21+10:00 | docs: push-to-main workflow; stop tracking Xcode/Finder user state |
| fd19292 | 2026-09-23T11:08:30+10:00 | fix: guide horizontal navigation works with remote swipes via edge focus targets (R19, build 16) |
| 8fb7800 | 2026-09-23T09:44:15+10:00 | fix: guide Right navigation stuck at the screen edge on duplicate EPG entries (R19, build 15) |
| 7d2ed2f | 2026-09-23T09:26:42+10:00 | feat: HDR display switching for the custom player; fix light-mode clash after playback (build 14) |
| 5f1cc07 | 2026-09-23T08:53:01+10:00 | feat: category-switch hang fix, uniform guide spacing, scrub bar, wide guide slide; retire AVKit fallback (build 13) |
| 9e62caf | 2026-09-23T08:35:52+10:00 | docs: round-3 device feedback handover — R07/R08/U02 accepted; open R14/R16/R17/R18 |

## Pig-Branding — 11 commits

| Commit | Author date | Subject |
|---|---|---|
| f84d8cd | 2026-10-16T10:25:57+11:00 | 1.7.1: a larger PigTV Apple TV icon (option B) |
| b40c958 | 2026-10-13T21:53:16+11:00 | Agent setup: AGENTS.md, CLAUDE.md, ignore CLAUDE.local.md |
| ffdeaed | 2026-10-13T21:37:33+11:00 | Docs: retire the PigTV 1.0 record and finished docs; fix stale READMEs |
| 86a18c3 | 2026-10-13T21:35:29+11:00 | Tools: fast verify tier, flake-free preview check, asserted kit rewrites |
| 8ab54b0 | 2026-10-10T12:29:16+11:00 | Brand 1.7.0: PigMenu, the chef's hat pig |
| 7ab6f84 | 2026-10-09T18:13:33+11:00 | Brand 1.6.0: PigFinance, layered vector family and iOS adaptation |
| 6744bf2 | 2026-10-07T11:13:40+11:00 | Brand 1.5.1: corner bloom from the top-left corner only |
| b1e2f01 | 2026-10-07T11:00:12+11:00 | Pig family brand system 1.5.0 (final): PigDomain, PigBoard and radiance |
| 07fb072 | 2026-10-07T07:35:21+11:00 | Pig family brand system 1.4.0 |
| a467f0f | 2026-10-05T15:58:27+11:00 | ignore |
| b000ce8 | 2026-10-05T15:47:47+11:00 | Initial commit |
