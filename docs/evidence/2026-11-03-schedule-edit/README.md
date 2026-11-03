# Change recording: server 0444–0445 (#49)

3 Nov 2026. The server half of D-44's "Change recording" page: `PUT /api/recordings/scheduled/:id` with
`{ preBufferMin?, postBufferMin? }` (C-M, since 0444). No real provider touched.

| Build | Change | Failing-before test |
|---|---|---|
| 0444 | Edit a schedule's start-early / finish-late minutes (rules' limits: 0–60, 0–180). Not started: both; recording: only finish late, the hard stop re-armed; 409 for a start-early change while recording or a stop at or before now; 404 when gone or finished. Household-wide, as DELETE | `recording-schedule-edit` (9 of 10 fail on f2ceb8f; the 404 test passes only because the route is missing) |
| 0445 | A start under way re-checks an edit: moved later, or a clash it now loses, starts no capture and gives back its feed and lease (Codex round 1, high) | `ingest-recordings` (2 tests, both fail on 0444) |

Also, test-only: the `/api/sports/pages/f1` route test is asked as of 28 Oct 2026; from 3 Nov it failed on `main`
because its captured fixture ends on 2 Nov.

**Gates:** `PIGTV_SKIP_PERF=1 npm test` passes except the 4 known `recording-segments-media` HE-AAC tests (this WSL
machine's ffmpeg 8; CI pins 9.0.2). `verify-build.sh` passes (CLIENT-CONTRACT.md is over its 600-line size warning).

**Codex** (base f2ceb8f): round 1, one high, fixed in 0445; round 2, approve, no findings.

**Not run:** T3 on the rig and T5 (Mark): both need the Apple record page (D-44 batch 5a).
