# #270 T2 for batch B (builds 0516-0523): rig at 0523

Rig run from a clean clone of 0c96ef8 (build 0523). No code changed, nothing committed. Fakes only.

- `unraid-rig.sh up` then `check`: passed (rig-check.txt). Staging went 0515 -> 0523 on its EXISTING database.
- `/api/version` says build 0523, commit rig-0c96ef8.
- Start-up (startup-log.txt): no refusal. A pre-migration backup copy was taken ("Build 0515 -> 0523"). The server
  logs no dbMinimum line and no films/series clean-up line (neither is logged when the database is fine / cleaned).
- `/api/info` has none of recordingCompression, channelHistory, adDetection, streamCoordination, streamTokenAuth,
  playbackHandles (api-checks.txt).
- With the admin token: GET /api/favorites, /api/settings/defaults, /api/transcode/sessions answer 404
  `{"error":"No such API endpoint",...}`; GET /api/settings and /api/sources answer 200.
- "Sync now" (POST /api/sources/:id/sync on both fake sources): 30 channels before, 30 after (sync-now-log.txt).
  The fake provider keeps no API request log and has no get_vod/get_series handlers, so the evidence is the server
  log: it fetches only "Live Categories", "Live Streams" and the guide (3204 programmes), never films or series.
- Database (db-check.txt): 0 playlist_items of type movie/series; meta schema_build 0523; films_series_cleanup set
  at the 0523 start-up.

Not shown: that the clean-up deletes rows (staging had none to delete); that is the unit test's job.

**T1:** 1827 of 1831 locally (the four known ffmpeg 8 failures); CI green on 0523.

**Reviews.** Codex on 0516-0522: approve, no findings; its check of 0523: approve. Opus on 0516-0522: no high; it
reproduced that a database upgraded through v0502 with its old db.json still on disk opens on 0522. Fixed in 0523,
each with a failing-before test: an unreadable database was reported as possibly damaged with restore advice
(medium); a process that cannot know its build was refused on its second open (medium); a stamp such as '0123abc'
was refused as old (low); the restore steps lacked the image name (low).

**Where the audit was wrong:** four start-up steps it called one-time still complete rows today's code writes
(kept); `shareFs._stuck` is used by tests (kept); no Apple route was missing from `APPLE_CLIENT_ROUTES`.

**Not done, filed as #291:** the audit's "unsure" list and the sport matching branches the product no longer reaches.
