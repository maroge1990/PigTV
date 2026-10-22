# Web, sync, backup and operations review

Snapshot `a104726` (0226), fixed 23 September–21 October window; completed continuation on 22 October. Newest fixes were considered before earlier attempts. No deployed server/provider was contacted. Additional sport/logo/library coverage is in SERVICE-SUPPLEMENT.md.

## Confirmed defects

### S1 — P2: excluding every group keeps the old channels

0217 (`d727bea`) promises excluded rows disappear on next sync. `server/services/syncService.js:638` returns immediately for empty items; `purgeStaleItems` also refuses an empty set, and M3U's final purge at `:1050` runs only for nonempty imported IDs. A successful parse with all groups intentionally excluded leaves every formerly imported channel in place. Both empty-result safety and deliberate exclusion must be represented: do not fix by deleting all rows on any empty or failed provider response.

Evidence: `service-deep-reproduction.cjs` imports two synthetic groups, excludes both, syncs successfully, and observes both old rows. Required regression: intentional all-excluded success purges eligible rows, failed/partial upstream sync preserves data, removing exclusions restores stable identities; cover M3U and Xtream.

### S2 — P2: import-exclusion protection expires before the sync

`server/services/importFilters.js:setExcluded()` checks blockers only for newly added groups when the setting is saved. A favourite or recording can be added while the old channel rows remain before the next sync. Sync reads `excludedFor()` without rechecking blockers and deletes the now-protected channel. The reproduction adds a favourite after saving the exclusion, confirms the blocker exists, and then observes its channel being purged. The favourite record itself remains; its usable channel is lost.

Required regression: favourite/schedule added between save and sync is protected. Establish one coherent policy at destructive application time or prevent incompatible new references while exclusion is pending; include races during asynchronous fetches, stable identities, active recordings and rule-created schedules.

### S3 — P2: concurrent backups collide and prune active partials

`server/services/dbBackup.js:prepare()` chooses a suffix by testing only the completed destination. Two concurrent calls in the same second and with the same reason therefore select the same `.partial`; prepare unlinks it, and verification/cleanup races. In addition, `prune()` deletes all `.db.partial` files without checking whether another backup owns them—even different-reason backups can interfere.

The synthetic SQLite reproduction runs two actual asynchronous backups and observes rejection(s), independently of provider data. Sequential same-second tests do not cover this. Reserve unique temporary/destination names atomically, including separate manual processes; never prune another live backup. Test overlapping reasons/timestamps, failure cleanup, integrity, retention and interruption recovery. Existing before-migration best-effort policy is documented, not a newly discovered bug.

### S4 — P2: event-slot names attach each game to unrelated channels

0221 (`5338732`) synthesizes programmes from provider slot names. `server/services/eventChannels.js:148–151` reuses any nonempty `tvgId`; only a missing ID gets a unique synthetic identity. Two differently named event slots with the same placeholder tvg-id create two programmes with one channel identity. Sport then joins each programme to both channels, offering the wrong channel for watch/record.

The reproduction uses two different NHL games with a shared placeholder ID and sees two channels on each game. Preserve per-channel provenance for name-derived programmes or assign a distinct effective synthetic identity; preserve legitimate multi-channel real-EPG listings. Test shared placeholder, empty and distinct IDs, real-guide precedence and duplicate actual simulcasts.

### W1 — P2: returning to the cached guide window does not cancel the pending future window

0209 (`cc23fe0`) adds request generations, but `public/js/components/EpgGuide.js:125–141` advances the generation only when fetching. Navigate later and then immediately back to the already cached window: the back action skips fetch and does not invalidate the outstanding request. Its late response publishes the future data while `timeOffset` remains zero.

`web-return-window-reproduction.cjs` runs the real class with synthetic deferred API data and reproduces this mismatch. Every navigation intent must invalidate older publication, including cache hits; test later/back, multiple steps, filters, refresh, failure and loaded-window reuse.

### W2 — P2: keyboard focus continuity remains incomplete

0210 adds activatable controls, but EpgGuide/ChannelList markup replacement destroys the focused node without restoring stable channel/programme identity. This is the already-open F4 acceptance gap, not a second unrelated defect. Add real DOM/browser activeElement assertions across refresh, filter, redraw and dialog return. Preserve a sensible nearest surviving action if the old item disappears.

Browser playback cancellation is PB5 in PLAYBACK-DEEP-REVIEW.md; do not count it twice.

## Intent and supersession ledger

| Latest relevant commits | Retained outcome and limit |
|---|---|
| 0222 `16cea0b` | Country-aware EPG scoring and undoable mapping exist; supplemental review assesses matching/preview. |
| 0221 `5338732` | Name-derived event slots exist; S4 defeats channel association for shared placeholder IDs. |
| 0217 `d727bea` | Filtering/stats and settings UI exist; S1/S2 mean safe exclusion intent is incomplete. |
| 0216 `77824f5` | Catch-up capability metadata retained and displayed; does not implement archive playback. |
| 0215 `ba93756` | Best-effort bounded webhook and cooldowns wired to provider-down/failure/expiry transitions; does not implement speed-based recovery or guarantee delivery. |
| 0213 `35c60e3` | Pre-migration/nightly verified copies and retention exist; S3 is a concurrency hole. Backup is database-only, not a complete installation recovery plan. |
| 0212 `13176d4` | Favourite pink/copy corrections retained; provenance/token work is separate. |
| 0211 `68584e2` | Visibility/version gate retained; reduces unnecessary polling reloads. Not fresh measured performance evidence. |
| 0210 `4439aaf` | Enter/Space semantics present; W2 still open. |
| 0209 `cc23fe0` | Home render and history ownership retained; W1 is an uncovered cache-return branch. |
| 0208 `25881cb` | Unraid labels exist; a template override or an old installed image can still determine actual icon. |
| 0207 `03a585b`, `ff5780e` | Implementation then version wrap; current recording UI assessed alongside DVR and Apple reviews. |
| 0206 `d5a7ad3`, `3e1b784` | Family 1.6 web assets supersede earlier Design Refresh/Spotlight styling. Brand kit validation is recorded below. |
| 0205 `e1aa273`, `cb8e339` | Linked backup siblings hidden in listings while linker still sees them. Later correction must be included when evaluating initial hiding. |
| 0204 `e2544a3`, `a641db0`, `7d00647`, `7d7dbc2` | Removal/module splitting/check reduction are structural changes. Deleted tuner features are superseded; no speed gain is inferred from line count. |
| 0200 `8580524`, 0190 `d414c2f` | Status visibility gates and non-touching session inspection retained; polling must not prolong sessions. |
| 0199 `4e0b363` | Multi-stage runtime, numeric PUID/PGID, readiness and safe app-directory ownership implemented. Image not built locally; GPU/share/container acceptance remains environment-dependent. |
| 0184 `8b30c11`, 0183 `1ce9ad9` | Provider login/coverage UI and raw Xtream-list enrichment implemented; failed enrichment deliberately retains playlist-only coverage. No live-provider guarantee. |
| 0182 `616b1f2`, 0176 `1898a3d`, 0175 `81b7dee`, 0172 `5bee9cc` | Unified providers/settings and status/reminder UI; 0176 removes duplicate invalid SQL route, fixes local day, listener stacking and SQLite account status. Review latest form, not the initial 0175 defects. |
| 0169 `d6424c5`, 0168 `61e9c42` | EPGenius `dns` parsing corrects initial header omission; retained account lookup and reminders. |
| 0163–0166 cleanup | Removed unused dependencies, number-order code and movie/series CSS/controls; no independent runtime acceleration claim. |
| 0140 `d15a60f`, 0125 `9b3a414` | Guide version includes build; HTML revalidates, keeping redeploy invalidation. |
| 0139 `4c98d3c`, 0123 `e5ce771`, 0117 `f85f38f` | Stable channel numbers are display labels; provider order wins. Later dead-order removal is intentional. |
| 0137 `32da410`, 0122 `6b2ac88`, 0121 `e80d4cd`, 0120 `377cbae` | Express5 wildcard/routes and library/catalogue path replace fork endpoints; no revival of removed VOD flows. |
| 0109 `2ba44f2`, `ac3f69d`, `0e68c03` | Node24 image, fixed Comskip revision and CI22/24 gate. Full image reproducibility is not guaranteed by a few pins. Old push instructions superseded by current commit-only AGENTS. |
| 0108 `7a8e75a`, 0107 `90fcc6b` | Compression allowlist excludes ranges/media; dead duplicate routes removed. |

Coverage is by retained functional intent, integrations, tests and targeted historical diffs. Formatting-only/deleted legacy/binary lines are not each independently verified. The complete inventory is COMMITS.md; playback, DVR, Apple and supplemental ledgers cover the other areas. Passing tests do not prove every acceptance case.

## Branding and efficiency

PigTV-relevant history in Pig-Branding covers 11 commits through kit1.7.1 `f84d8cd`. 1.5's bloom was corrected by 1.5.1, 1.6 supplies the app/web baseline, and 1.7.1 enlarges the tvOS front ink (Apple43). Earlier artwork should not be judged as the current result. The previous continuation's read-only package check reported 1,627 asset/token files, 31 PDF pages, 20 solid text-colour pairs, nose/halo/bloom checks and current manifest. No fresh physical visual acceptance is claimed.

Prioritize lifecycle/resource bounds, then measure: coalesced Apple cache pruning, interval ingest throughput/backlog, incremental archive accounting, rule input batching, concurrent independent Apple recording requests, and reuse of versioned guide coverage. Preserve media verification and picture quality. No numerical savings are claimed from source inspection.

## Local validation on 22 October

The initial seven review reproduction scripts ran under Node24 and exited zero, asserting the documented faulty behaviour: ingest-startup, playback-cancel, playback-coordination, playback-web-cancel, recording-deep, service-deep and web-return-window. They use temporary databases/mocked transport or DOM/media; no provider/deployed server was contacted. Convert them into expected-correct regressions during repairs; a zero exit here means a defect was reproduced, not fixed.

The supplementary eighth script was subsequently rerun by the lead and reproduced S5–S7; see SERVICE-SUPPLEMENT.md.
