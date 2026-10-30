# Independent DVR repair review — 25 October 2026

Reviewed newest-first: 0254 `18a0780`, 0253 `28a5245`, 0252 `0731453`, 0251 `493bd1d`, plus policy tests `d3bbcea`; current snapshot `63a022f`. Compared current tests with pre-repair server `7e1481b` in isolated copies. No application changes, deployment, provider access or commits.

## Verdict

| Prior defect | Verdict | Evidence |
|---|---|---|
| D4 active prebuffer absorbs later match | Fixed locally | Movable status filter excludes recording/completed/failed schedules. Running prebuffer test passes; old server fails. Present-event matching remains within15minutes by existing policy. |
| D3 A→B→A correction ignored | Fixed locally | Schedule reconciliation precedes hit suppression; pending repeated moves and cancelled control pass. Pending test fails on old server. |
| D2 delete during immediate failover restarts recording | Fixed locally | Delete retires failingOver owner synchronously, cancels schedule; post-settings/feed checks release late feed. Both await-boundary tests pass; both fail on old server. |
| D1 deletion/original ownership | Partial | Direct foreign-file and late-copy cases pass, but migration can claim foreign bytes and publication during an in-progress delete still leaves unlisted files. |

## R4-D1 — P1: migration restores unsafe ownership for an interrupted0242 copy

`server/db/recordingsDb.js:19–24` claims every kept, done, pathless original as `<name>.ts` without byte verification or provenance. Its comment says0242 always recorded the path before done. Historical code disproves that: `7373280:server/services/recordingSegments.js:501` stores done, then line507 awaits `keepOriginal`. A crash in that window leaves exactly the row claimed by the migration, with unrelated conventional TS still present. This is the F2 crash window fixed only in0243.

The isolated probe constructs that exact durable state with foreign same-size bytes, invokes the real migration, then the real delete: the foreign file is claimed and deleted. This is a state-based upgrade reproduction, not a subprocess crash simulation. It establishes code behavior, not evidence that this historical build was deployed. The migration is also run at schema initialization without a stored migration-version discriminator; it does not establish which build produced a row.

Repair: do not equate done/null with ownership. Where retained work exists, use the byte/provenance evidence to recover the real original; where provenance cannot be established, preserve the file and report an unresolved legacy original. Add the0242 interrupted-copy upgrade case, not merely a successful0227 row.

## R4-D2 — P2: deletion is not retired before asynchronous file cleanup

`server/services/recordingEngine.js:618–625` awaits work-folder deletion while retaining the old row snapshot; the DB row is only deleted at the end. The new guard at `server/services/recordingSegments.js:542–547` sees that row still present and permits publication/ownership recording. Delete resumes using its old `segment_original = null` snapshot, removes the row and MP4, and leaves the newly published original unlisted.

Deterministic probe: pause retained-original copy at its final write, start delete and pause its `removeWork` await, release copy so publication and `segment_original` update finish, then resume delete. Result: DB row gone; retained TS remains. The barriers alter scheduling only; real publication/deletion code runs. This is the converse ordering to the author's test, which finishes deletion before releasing publication.

A second missed publication path is `server/services/recordingSegments.js:439–446`: fallback `deliverTs` after repeated remux failure has no deleted-row check after `joinSegments`. Pause its copy at the end, delete fully, release: it publishes a TS and updates a nonexistent row, leaving an unlisted file. This existed before0251 but is within the requested deletion/publication audit and contradicts broad cleanup closure.

Repair: retire recording ownership before deletion awaits, and make every publishing path honor that retirement; clean up its own late output. Cover both sides of the delete/publication ordering for retained originals and fallback TS. A row-existence check only after copying does not establish ownership when deletion is still running.

## Validation

Run with Node24:

```sh
/opt/homebrew/opt/node@24/bin/node docs/reviews/2026-10-24/round4/dvr-probes.cjs
```

Current:14/14 assertions pass:11 production regression/policy tests and3 new probes that deliberately assert the remaining defects. Pre-repair server: all6 selected behavioral regression tests fail (D1 two, D2 two, D3 one, D4 one). No schema-missing failure is counted. Tests use isolated server copies, synthetic feed/ffmpeg fixtures and a bounded25second per-file runner; local HTTP permission was required. Initial restricted EPERM results were discarded and the permitted rerun is saved in `dvr-probes.log`.

The three F4 ambiguity/horizon/metadata-free-series tests pass, proving existing policy boundaries rather than approval of them. Root review covers the contract's contradictory blanket cancellation promise. No physical device or real feed acceptance is established here. Full server suite/build verification is reported by the lead reviewer.
