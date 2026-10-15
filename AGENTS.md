# PigTV server and web app: agent guide

A self-hosted IPTV server (Node 24, Express 5, SQLite, ffmpeg) with a web app (`public/`, no build step). The Apple client
is `../PigTV-Swift`. Read [`blueprint.md`](blueprint.md) for how things work and the roadmap, and
[`docs/CLIENT-CONTRACT.md`](docs/CLIENT-CONTRACT.md) before changing anything the Apple client can see. `docs/archive/` is
frozen history, not instructions.

## Commands

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # Node 24: the default node 26 can't build better-sqlite3 12
npm ci
npm test                          # every test file, in parallel (~35 s on the MacBook)
node --test test/<name>.test.js   # one file
bash scripts/verify-build.sh .    # what tests can't check: placement, things that must not come back, image, CI, markup
npm start                         # http://localhost:3000
```

Tests that need ffmpeg skip without one (Homebrew `ffmpeg` is installed). Speed budgets are skipped when `PIGTV_SKIP_PERF=1`
(CI's gate); CI runs them in a separate, non-blocking `perf` job.

## How changes ship

**Claude commits to `main` but never pushes** (Mark, 16 Oct; replaces the 23 Sept push-to-main rule). No feature branches;
one logical change per commit. Mark reviews and pushes.

1. `git status`, then `git pull --rebase origin main` (fetching is fine; pushing is not).
2. Make the change with its test. `npm test` and `verify-build.sh` must both pass before a commit; if either can't run, say
   so in the commit message and to Mark.
3. A functional commit bumps `build` in `server/version.js` **and** "Next build number" in `blueprint.md` §1, and its
   subject starts with the number (`0208: what changed`). Docs-only and test-only commits have no number.
4. **Don't `git push`.** Leave the commits local and tell Mark which commits are waiting (`git log origin/main..main`).
   When Mark pushes, CI runs the tests (Node 22 and 24) and builds `ghcr.io/maroge1990/pigtv` **only if the tests pass**.
   If CI goes red, fix it or `git revert` at once (`gh run view <id> --log-failed`), again as a local commit.
5. Tell Mark what is committed, the build number, and numbered live-test steps for anything that needs the real feed or a
   device. Nothing is *Verified* until he reports back.

**Deploy (Mark):** Unraid → Docker → PigTV → Force Update, then `curl -s http://192.168.1.235:3000/api/version`. A redeploy
ends every session. Rollback: point the container at `ghcr.io/maroge1990/pigtv:sha-<short>` of the last good build, then
`git revert`. Operations (PUID/PGID, health, backup, restore): `docs/OPERATIONS.md`.

## Rules

- **Capture before changing anything on the playback path** (`scripts/stream-doctor.js`, blueprint §3). No ffmpeg-flag or
  timestamp patch ships on a hypothesis: 0085 did, and broke every even feed.
- Every functional change has a test that **fails on the old code** (prove it). Add a `verify-build.sh` check only for what a
  test can't say, and prove it by reintroducing the bug.
- A change the Apple client can see goes into `docs/CLIENT-CONTRACT.md` in the same commit; a new endpoint it calls goes into
  `APPLE_CLIENT_ROUTES` in `test/api-404.test.js`.
- Never return or log a provider URL, password or token (`redact()`, opaque handles, C-B error texts).
- Ask Mark before contacting the deployed server or running anything that takes the provider connection.
- The lead session may delegate to sub-agents (never Haiku) and reviews every diff before committing.
- At the end of a session update `blueprint.md`: the state line, the §4 roadmap status, and any durable fact in §2/§3. The
  story goes in the commit message, not the docs.

## Gotchas

- CI runs every test file at once on 2 vCPUs: keep timing margins ≥ 1 s, or poll.
- Query `epg_live`, never `epg_programs`. A row that has a `stable_id` must never fall back to its stored `pos_N`.
- Ingest-time changes only show after a sync (Settings → the source's ⟳, "Sync now"); a redeploy skips sources synced in the
  last 24 h.
- `settings.get()` returns a deep-frozen object: copy before changing.
- Express 5: wildcards are `/{*splat}`; `res.sendFile` needs `dotfiles: 'allow'` under a dot-folder.
- No local Docker: the image is only built by CI. The tree is LF. `verify-build.sh` uses the system `python3`.
- Environment variables are listed in `.env.example`; never commit real values or secrets.
