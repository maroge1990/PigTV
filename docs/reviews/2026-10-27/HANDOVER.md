# Handover, 27 October 2026

Supersedes [`../2026-10-18/HANDOVER.md`](../2026-10-18/HANDOVER.md). The prompt below is for the next agent session;
paste it as the first message.

---

## Prompt for the next agent

You are picking up PigTV, a self-hosted IPTV server (Node 24, Express 5, SQLite, ffmpeg; this repo) with an Apple client
in `../PigTV-Swift`. Mark owns both and tests on his Apple TV and an Unraid server.

**Read first, in this order:** `AGENTS.md` (rules: these override your defaults), `blueprint.md` (state line, §2 how
playback works, §3 "Stall watchdog" and "Shared ingest", §6), `docs/reviews/2026-10-27/ROADMAP.md` (the prioritised plan
and Mark's open questions Q1-Q7), `docs/FINDINGS.md` (FR-8 to FR-14 are this week's), and
`docs/CLIENT-CONTRACT.md` before changing anything the Apple client can see. `docs/archive/` is history, not
instructions.

**Rules that matter most here** (all in `AGENTS.md`):
- Commit to `main`, **never push**; Mark pushes. One logical change per commit. A functional commit bumps
  `server/version.js` and blueprint §1 "Next build number" (next is **0290**) and its subject starts with the number.
- Every functional change has a test that **fails on the old code**; prove it. `npm test` and
  `bash scripts/verify-build.sh .` both pass before a commit. Use Node 24:
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.
- **Capture before changing the playback path** (`scripts/stream-doctor.js`). No ffmpeg-flag or timing change on a
  hypothesis.
- **Ask Mark** before contacting the deployed server or taking a provider connection. When he allows it: `ssh passyflix`,
  container `PigTV`; reading `docker logs`, the database read-only and files in `/app/transcode-cache` takes no provider
  connection. Never print `provider_accounts` or any URL, login or token: query only the columns you need.
- A batch touching playback, provider routing/admission, recordings, caches, auth or the client contract, or over ~150
  lines, gets a **Codex adversarial review** before Mark is told it is ready. Mark types the command; give it to him with
  `--base` and a focus line. At most two rounds; after that only high findings block, the rest go into FINDINGS.
- End the session by updating the blueprint state line, §4 status and any durable fact. Tell Mark what is committed,
  the build numbers, and numbered device steps.

**State at handover:** server **0285** is deployed; **0286-0289 are pushed** (CI green, image built) but not deployed
(FR-11, `feed_lag`, the smaller Status page, and 0289 from the Codex review). Both Codex rounds on that batch are
done (round 2 approved). Apple client 57 is pushed and nothing is waiting there. R7 (0282-0284 with Apple 56-57)
fixed the stalls and provider switches on Chicago Sports Network Plus and NBC Sports Boston on the device.

**First thing to do:** ask Mark whether 0289 is deployed (`curl -s http://192.168.1.235:3000/api/version`) and
for his answers to Q1-Q7 in the roadmap. Then take the roadmap in order:
- **P0** the live checks after the deploy;
- **P1** R7 from `feed_lag` once about a week of data exists (FR-12, then reconnect-or-switch);
- **P2** FR-9 (a small, reproducible server fix) while waiting for the data, FR-14 once Mark has answered Q3.

Do not start P1 before there is a week of `feed_lag` data, and do not retire any of the relay or standby (B4) without
Q4's answer.

**Things that will save you time:**
- `feed_lag` rows come only from ingests that read live for at least a minute; the Status page shows them under
  Show details, "Feed lag (30 days)", with the configured limit.
- The relay logs "cannot join this stream (...)" when a backup's feed does not match; that channel then has no hot
  standby.
- `settings.get()` returns a frozen object; a fresh test DB needs `meta.app_data_migrated` set before the settings
  module first opens it, or the defaults are seeded over your values.
- The full suite takes about 50 s locally. The sports-events perf test failed once under load (FR-13); rerun before
  you suspect your change.
- The Settings → Recording tab has two Save buttons (section and Notifications); Mark chose to leave that for now.
