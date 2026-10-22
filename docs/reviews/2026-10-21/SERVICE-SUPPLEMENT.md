# Service review supplement

Snapshot `a104726` (0226); fixed window 23 September 00:00 +10 through 21 October 23:59:59 +11. Continued 22 October. This supplement reviews current owners for fixtures, logo fetch/cache, health/Status, library paging, channel links and EPG mapping, with relevant corrective diffs inspected newest-first. The parent report covers sync/import filters, backups, event slots, notifications and sports-event workers. No application changes, network requests, deployed access or media processes.

## Additional confirmed defects

### S5 — P2: a partial ESPN outage is recorded as complete fixture coverage

`server/services/sportsFixturesEspn.js:130` treats any successful day as a successful whole-window fetch. It drops failed days without returning their coverage. `sportsFixtures.js:203` does the same across paths (UEFA), and `:263` across cricket series. `refreshLeague` at `:230` replaces all prior league fixtures and records the full requested window as successfully covered. Cricket does the same at `:279`. `sportsClassify.fixtureVerdict` at `:704` consequently trusts an absent fixture as evidence of a replay when both teams are known.

This leaves 0162's intended protection against incomplete ESPN knowledge unfinished: its six-hour freshness and ±12-hour window checks consume coverage that was never actually established. The missing-day fetch behaviour originates in 0161 (`999b20d`), full-coverage metadata and cricket replacement in 0162 (`ef5c3e4`); 0185 (`1f28506`) adds another partial-success layer for multiple UEFA paths.

**Reproduction:** the actual fixture service first stores the recorded Chargers/Bills fixture and classifies it live. On the next refresh, synthetic HTTP returns 503 for the game's day and successful empty results for other days. The service deletes the fixture, marks fresh full coverage and returns `live:false, why:'ESPN has no such game at this time'` for the same airing. `service-supplement-reproduction.cjs` passes this assertion without network use.

**Repair:** carry successful coverage at day/path/series granularity and preserve last-good data for failed slices, or conservatively keep the last complete snapshot and withhold absence-based conclusions after partial refresh. Do not merely merge forever: genuinely removed/postponed games must disappear after a complete authoritative refresh. Cover one failed day, failed UEFA path, failed cricket series, all-failed refresh, successful empty response, and malformed success payload. This is not proof of the original AUS v SA incident's cause.

### S6 — P2: the logo download deadline ends at headers, leaving stalled bodies pending

`server/routes/logo.js:175–194` creates a ten-second abort timer, awaits `fetch`, and clears the timer in `finally` at `:182`, before reading `response.body`. A response that sends valid image headers and then stalls can hold the request indefinitely. This is retained from 0112 (`119b4fd`); 0141 transparency and 0154 full-resolution corrections do not address it. Unlike the separate shared-ingest defect, this affects artwork requests and their retained server work.

**Reproduction:** the actual function is run in a VM with a synthetic open image body and timer owner. Body iteration has begun, the function remains pending, and its timer has already been cleared. No filesystem mutation, network or child process is reached in this fixture. The reproduction is in the same script.

**Repair:** retain an absolute deadline through body consumption; cancel the reader/controller on every failure, oversize response and abandoned request as appropriate. Give conversion a separate bounded child-process lifetime: `downscale()` currently also waits indefinitely for close. Add headers-only/partial-body/slow-body tests, plus child nonexit and bounded failure cleanup. Preserve transparency, size limits and original-byte fallback.

### S7 — P2: changing a sibling link's status does not invalidate cached guide membership

`channelLinks.setStatus()` at `server/services/channelLinks.js:708` changes usable sibling links and reranks them, but neither it nor `server/routes/links.js:120` bumps the library revision. A rejected sibling becomes visible immediately under `channelNumbers.VISIBLE_SQL`, while `currentGuideVersion()` remains unchanged. A version-gated Apple/web guide can keep the former membership until an unrelated update. The reverse approval hides a row with the same problem. The explicit revision bump added for relinks by `cb8e339` does not cover this mutation path; 0205 (`e1aa273`) fixes linker input visibility but leaves this gap.

**Reproduction:** isolated SQLite holds one auto sibling link. The row is hidden, then `setStatus(id,'rejected')` makes it visible; guide version before/after is identical. The existing `channel-links.test.js` test named “a sibling whose link is rejected is listed again, and the guide version moves only when that set changes” directly edits SQL for rejection and never asserts a version change for that action.

**Repair:** centralize membership-change invalidation for every link mutation, bumping only when the visible sibling set changes. Test actual PUT rejection/approval/undo, non-sibling changes that should not invalidate membership, and relinks with unchanged membership. Recompute numbering when a newly visible sibling needs one without making labels the sort order.

## Current outcome ledger (newest first)

This ledger records the reviewed service contribution of each commit; it does not claim that unrelated hunks of a cross-cutting commit were covered here. Current source was read throughout the listed owners; focused corrective diffs were compared with their predecessors. The initial large combined history outputs were truncated, so this is not an independent line-by-line certification of all deleted historical code. Parent/other reports own the other areas.

| Commit | Intent and retained outcome |
|---|---|
| `a104726` 0226 | Status deduplicates same-ingest active consumers. Current `connectionsUsed` does this. It remains consumer accounting, not every connecting/lingering socket. Admission correctness belongs to PB2/PB3. |
| `dd942a1` 0223 | Shared-ingest diagnostics on Status are wired, feature gated and final document scrubbed. Parent covers ingest lifecycle. |
| `16cea0b` 0222 | Region weighting and undoable automap implemented in current EPG owner. Threshold/margin skip ambiguous choices; hand mappings are excluded and manual edits clear batch ownership. Apply recomputes its plan, so a preview is advisory rather than a frozen transaction. Numeric Xtream category IDs cannot supply the intended category-name region hint; this is a limitation, not a demonstrated wrong mapping here. |
| `1e479d6` 0218 | Status exposes archive/finalization states. Recording safety defects reviewed separately. |
| `77824f5` 0216 | Catch-up capability summary present; it does not implement catch-up playback. |
| `35c60e3` 0213 | Backup status lists safe file metadata. Parent covers concurrency defect in backup owner. |
| `e1aa273` 0205 | Linker now uses LISTED_SQL, retaining linked siblings during repeated relinks. Corrects `cb8e339`; does not fix S7. |
| `cb8e339` | Linked siblings hidden from user-facing channel/guide/category counts. Source retains membership check and relink revision comparison. Status mutation invalidation remains S7. |
| `a641db0` 0204 | Tuner branches removed; old tuner Status rows are not current capabilities. |
| `8580524` 0200 | Status shows purpose, preparation queue and loop delay; hidden-page polling handled in parent web review. Current diagnostics do not themselves bound queue lifetime. |
| `205db98` 0198 | Warming/lease diagnostics visible. Full admission belongs to playback review. |
| `d9992d7` 0197 | Relay switches/status modes visible; no measured throughput benefit asserted here. |
| `a9d8fc8` 0195 | Sports worker status published; worker build owner reviewed by parent. |
| `3699628` 0191 | Health records blank-picture failure separately from successful first picture; threshold remains a heuristic, not actual image analysis. |
| `d414c2f` 0190 | Status uses peekSession instead of getSession and resolved channel name. Actual diff/current owner confirm passive observation no longer renews that session's activity. |
| `e3c57a2` 0189 | Relay diagnostics added; old code not proof of current playback invariants. |
| `65d3bcd` 0188 | Interruption summary integrated; playback owns event correlation/recovery. |
| `02fe866` 0186 | English Premier League allow-list corrects 0185's overly narrow country exclusions. Current classifier retains that correction. It does not establish universal sport-title recognition. |
| `1f28506` 0185 | Additional ESPN paths, team follows and absent-F1-session replay logic retained. S5 affects evidence completeness, including multi-path UEFA. |
| `a3fa14f` 0179 | Raw EPG matches now need loose name agreement for auto status; variant-digit differences stay pending. Current matcher retains correction to 0178. |
| `ce93299` 0178 | Raw-name/raw-EPG bridge retained, event slots excluded, regions checked. 0179 is the final form to assess. |
| `63dd48d` 0177 | Status names recording provider; actual recording failover covered separately. |
| `1898a3d` 0176 / `81b7dee` 0175 | Provider state/expiry/account/limit status and reminder integration retained. Current status scrubs URL-shaped strings recursively. |
| `b462c37` 0174 / `7651fd0` 0173 | Health attributes serving provider; Status per-provider connections. Later shared-ingest implementation is authoritative for final counting. |
| `76bd8ed` 0171 | Channel linker current owner retains ranked/manual/rejected/broken decisions and serial relink writes. Link load still yields every 5,000 rows; source decisions are identity keyed. No actual provider correspondence verified. |
| `a9f731a` 0164 | Removed number-order branches; current guide keyset remains provider-order, name, row-ID total order. |
| `ef5c3e4` 0162 | Freshness and window checks improve 0161 but S5 defeats completeness after partial fetches. |
| `999b20d` 0161 | Background fixture service, roster caches, snapshot and ESPN-first classifier implemented. Requests have body-covering timeouts here (unlike logos); partial successes are unsafe as complete coverage. |
| `3c91e86` 0157 / `349276f` 0156 | Folder health and recent recording problems visible on Status; recording safety owner reviewed separately. |
| `0994a5f` 0154 | Full original and 640 logo sizes retained; independent ETags and allowed sizes. Source keeps original when conversion fails/larger. S6 remains. |
| `5f93402` 0152 / `acf0edc` 0150 | Replay/first-airing/league-hour and semantic merge work subsequently extended by ESPN. Current rule ordering inspected; concrete title acceptance requires actual guide samples. |
| `298b7d0` 0148 / `a43a885` 0146 | Programme sport recognition and marked categories retained, later worker/event-slot additions reviewed by parent. |
| `6a9d12a` 0142 | Channel health includes stalls only with sufficient watched time; owner correlation and 30-day pruning remain. |
| `fb4b9fc` 0141 | Explicit RGBA conversion and cache-version bump correct older palette transparency. New URL keys prevent cached old bytes from masking correction. S6 remains independent. |
| `4c98d3c` 0139 | Channel numbers become labels; 0164 cleans obsolete branches. Current guide rejects older number-sort cursors. |
| `81ec71f` 0134 | Stable-key EPG mapping overrides applied to guide/now-next/logo; cache invalidated on mapping changes. 0222 adds batches. |
| `42a6df5` 0133 | Seven-day health aggregate and guide dot retained; reads cached for 60 sec and invalidated on writes. No physical performance measurement here. |
| `9ff958f` 0126 | Historical tuner Status support removed in 0204; not counted delivered today. |
| `b8bb576` 0124 | Admin Status source explicitly selects fields and scrubs URL-shaped values; 0190 fixes its activity side effect. |
| `f85f38f` 0117 | Stable-key numbers and initial numbering retained, subsequently label-only. |
| `119b4fd` 0112 | Opaque registered logo cache paths and one DB transaction per page retained. Fetch-once intent is only eventual cache reuse: parallel misses have no shared in-flight owner. |
| `ce9ce30` 0111 | 500-row guide keyset paging, window bounds and version checks retained. Current owner still executes COUNT for every cursor page despite avoiding OFFSET. |
| `ae5f0ec` 0106 | Stable identity projection retained in guide rows. |

## Efficiency opportunities

1. Coalesce server logo misses by key, share fetched originals across default/full/640 requests and bound conversions globally. Currently simultaneous misses can duplicate downloads and ffmpeg work. Use asynchronous writes with atomic publication; keep the existing page-level DB transaction optimization. Benchmark cold guide loads before/after; no numeric speed claim yet.
2. Remove synchronous filesystem work from Status requests where slow mounted recording shares can block all playback/control handlers: `diskAt()` calls `existsSync/statfsSync`; backup listing and segmented status also perform filesystem work. Publish a bounded-age background snapshot with timeout/error status. This extends the intent of asynchronous recording-route work rather than weakening storage checks.
3. Cache counts/version-stable channel metadata for multi-page guide requests. The current keyset fetch still runs a full visibility COUNT each page and registers logos each page; count caching by library revision could avoid repeated SQL while preserving stable paging and invalidation. Measure on realistic 18,000-row data.
4. Keep last-good fixture snapshots and bounded refresh fanout. Current per-day/path/league requests are serial; a worst-case refresh can take minutes. Correct coverage ownership before considering limited concurrency, and keep external fetches off request paths.
5. Channel-health/status aggregate scans and channel-link admin list materialization are candidates for snapshot/SQL aggregation if measured event-loop latency warrants it; current guide aggregate cache already avoids one scan per channel. Do not rewrite on speculation.

## Verification

`/opt/homebrew/opt/node@24/bin/node docs/reviews/2026-10-21/service-supplement-reproduction.cjs` completed successfully with all three current-defect assertions. These assertions deliberately describe the faulty snapshot; convert them to expected-correct tests and prove failure on the old code when repairing. No full suite was rerun by this worker; the parent reports its earlier full-suite/build results. No physical-device or production acceptance claim.
