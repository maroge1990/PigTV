# Handover, 27 October 2026

Supersedes [`../2026-10-18/HANDOVER.md`](../2026-10-18/HANDOVER.md). The prompt below is for the next agent session;
paste it as the first message.

---

## Prompt for the next agent

You are picking up PigTV, a self-hosted IPTV server (Node 24, Express 5, SQLite, ffmpeg; this repo) with an Apple client
in `../PigTV-Swift`. Mark owns both and tests on his Apple TV against his Unraid server.

**Your task:** build the agreed next batch, **P0 in `docs/reviews/2026-10-27/ROADMAP.md`**, as five server commits in
this order. The roadmap has each one's specification, tests and docs; read it in full before starting.
1. **0290: shared ingest on by default** (`sharedIngestEnabled: true` in the defaults; a stored value still wins).
2. **0291: remove code nothing uses**: `public/js/auth.js`, `public/js/login.js` and the listed unused server
   exports (about 250 lines). Re-check each is unused before deleting it; add `verify-build.sh` checks that they stay
   gone.
3. **0292: an adaptive reconnect limit per channel and provider**: default 24 s, up 2 s on a lag reconnect, ceiling
   28 s (the Apple client holds live plays 30 s back), down 2 s after about 3 hours of reading with the worst lag at
   least 4 s under the level; stored so a redeploy keeps it; shown in Status → Show details → Feed lag.
4. **0293: Fox Cricket's Test titles (bug 5's conclusion)**: recognise "Test : South Africa v Australia"-style titles
   and match-ups on a "Cricket" channel as cricket, read the teams past a "3rd Test Day 1 Session 3" suffix, and call a
   later day of a Test live only during that day's play (tonight's overnight replay would read as live). The real guide
   rows are in `docs/reviews/2026-10-27/fox-cricket-501-titles.txt`; put them in `test/fixtures/sports-export.json` with
   their expected kinds first. Independent of 1-3 (sport files only).
5. **0294: MLB games whose title doesn't say "MLB"**: a match-up whose two sides are both teams of a followed league's
   stored ESPN roster is that league, and broadcast titles ("MLB World Series - Game 4", "MLB") join the overlapping
   event. Evidence: `docs/reviews/2026-10-27/world-series-titles.txt` (World Series Game 4 on ~40 channels, listed on one),
   including the rows that must stay out. Sport files only.

Mark has approved all five and the numbers. Do not change ffmpeg flags or the Apple client's hold in this batch.

**Read first, in this order:** `AGENTS.md` (its rules override your defaults), `blueprint.md` (state line, §2, §3
"Stall watchdog" and "Shared ingest", §6), the roadmap above (including "Mark's answers"), `docs/FINDINGS.md` (FR-8 and
FR-12 are the background for commit 3), `docs/SHARED-INGEST.md` (the Stall row), and `docs/CLIENT-CONTRACT.md` before
changing anything the Apple client can see. `docs/archive/` is history, not instructions.

**Rules that matter most here** (all in `AGENTS.md`):
- Commit to `main`, **never push**; Mark pushes. One logical change per commit. A functional commit bumps
  `server/version.js` and blueprint §1 "Next build number" (next is **0290**) and its subject starts with the number.
- Every functional change has a test that **fails on the old code**; prove it (stash the source change, run, restore).
  `npm test` and `bash scripts/verify-build.sh .` both pass before each commit. Use Node 24:
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.
- **Capture before changing the playback path.** Commit 3 changes when a feed is reconnected, not ffmpeg; its evidence
  is the `feed_lag` rows collected since 0289 went live on 27 Oct and the 27 Oct soaks in `docs/reviews/2026-10-27/`.
- **Ask Mark** before contacting the deployed server or taking a provider connection. When he allows it: `ssh passyflix`,
  container `PigTV`; `docker logs`, a read-only look at the database and files in `/app/transcode-cache` take no provider
  connection. Never print `provider_accounts` or any URL, login or token: select only the columns you need.
- This batch needs a **Codex adversarial review** before Mark is told it is ready. Mark types the command; give it to him
  with `--base origin/main` and a focus line naming the five commits. At most two rounds; after that only high
  findings block, and the rest go into `docs/FINDINGS.md` with a reproduction.
- End the session by updating the blueprint state line, §4 status and any durable fact, and tell Mark what is
  committed, the build numbers, and numbered device steps (the roadmap lists the live checks after the batch).

**State at handover:** server **0289** (`6c4cf96`) is deployed and everything is pushed except the docs commits that
carry this roadmap. Shared ingest and segmented recordings are on on Mark's server. Apple client **57** is on the Apple
TV; nothing is waiting there (next Apple build is 58). R7 (0282-0284 with Apple 56-57) fixed the stalls and provider
switches on Chicago Sports Network Plus and NBC Sports Boston on the device.

**Things that will save you time:**
- The ingest decides "lost" in `checkStall()` (`server/services/ingest.js`) against `tuning.behindMs`; `feedPace.js`
  measures the lag; `worstBehind` and `lagReconnects` (0287) are already counted per ingest. An ingest knows its
  channel and provider names; give it the channel's identity key from the routing plan (`candidate.channelKey`) through
  `ingest.sourceFor`, and remember `playbackStrategy.resolve` copies the ingest source field by field (0289 fixed the
  names being dropped there: carry any new field the same way, and test a play from a cached analysis).
- `feed_lag` rows come only from ingests that read live for a minute or more (`server/services/feedLag.js`).
- `settings.get()` returns a frozen object; a fresh test DB needs `meta.app_data_migrated` set before the settings
  module first opens it, or the defaults are seeded over your values (see `test/db-retired-settings.test.js`).
- Test patterns to copy: `test/ingest-pace.test.js` (a fake provider with paced PCR packets), `test/feed-lag.test.js`
  (a sandboxed database), `test/feed-lag-naming.test.js` (resolve from a cached analysis).
- The full suite takes about 50 s locally. The sports-events perf test failed once under load (FR-13): rerun before you
  suspect your change.
- Mark's other decisions on 27 Oct: keep the hot standby; live with TNT Sports 4's sound offset (FR-14); leave the two
  Save buttons on Settings → Recording as they are.
