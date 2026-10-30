# PigTV server and web app: agent guide

A self-hosted IPTV server (Node 24, Express 5, SQLite, ffmpeg) with a web app (`public/`, no build step). The Apple client
is `../PigTV-Swift`. Work is tracked in [GitHub Issues](https://github.com/maroge1990/PigTV/issues) for both repos;
`docs/archive/` is frozen history, not instructions.

## Map of the docs

Repos (public): `github.com/maroge1990/PigTV` and `…/PigTV-Swift` (its own `AGENTS.md`); checkouts in WSL `~/code/PigTV{,-Swift}`, on the Mac `/Users/markrogers/Documents/GitHub/PigTV{,-Swift}` (Apple builds only).

| File | Holds |
|---|---|
| [`ROADMAP.md`](ROADMAP.md) | Current state (overwritten each session), Now / Next / Later by issue, how to pick work |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | What PigTV does per feature, where, status; non-goals; known limitations |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) + [`docs/architecture/`](docs/architecture/) | How it works and what to know before touching each area (playback, recording, ingest, sports) |
| [`docs/CLIENT-CONTRACT.md`](docs/CLIENT-CONTRACT.md) | The API the Apple client relies on: read it before changing anything the client can see |
| [`docs/DESIGN.md`](docs/DESIGN.md) | UX principles, platform patterns, brand (Pig-Branding is the source) |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Numbered decisions; added to, never rewritten |
| [`docs/TESTING.md`](docs/TESTING.md) | Test tiers T1–T5, who runs what, the tools, evidence rules |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Deploy, rollback, PUID/PGID, health, backup, restore |
| `docs/evidence/`, `.env.example` | Small public-safe evidence (`YYYY-MM-DD-slug/`); every environment variable |

## Commands

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # Node 24: the default node 26 can't build better-sqlite3 12
npm ci
npm test                          # every test file, in parallel (~70 s; PIGTV_SKIP_PERF=1 on a busy Mac)
node --test test/<name>.test.js   # one file
bash scripts/verify-build.sh .    # what tests can't check: placement, things that must not come back, image, CI, markup, doc sizes
npm start                         # http://localhost:3000
```

Tests that need ffmpeg skip without one. `PIGTV_SKIP_PERF=1` skips speed budgets (CI's gate; a separate `perf` job runs them).

## Session checklist

**Start:** `git status`; `git pull --rebase origin main`; read `ROADMAP.md`'s current state;
`gh issue list --label P0` and `gh issue list --label P1` before picking work. Tools that cannot read issues (Codex,
offline agents) get the issue text pasted into their prompt.

**End** (reported in every handover): docs touched (which); `ROADMAP.md` current state overwritten (yes/no); no new
handover or status files (yes/no); issues updated (which, with a comment for item-level handover); commits waiting
(`git log origin/main..main`); and, for every pushed-but-open issue, ask Mark whether it has been checked and resolved.
The story of a change goes in its commit message, not the docs.

## How changes ship

**Claude commits to `main` and pushes it once the batch has passed its reviews** (D-34). No feature branches.

1. Make each fix with its test and run the targeted tests; the full gates (`npm test`, `verify-build.sh`) run once
   before the batch's first review round and again before the push. If one can't run, say so in the commit and to Mark.
2. A functional commit bumps `build` in `server/version.js` **and** this row, and its subject starts with the number
   (`0208: what changed`). Docs-only and test-only commits have no number. Next build number: **0341**.
3. Commits write `Refs #n`, **never** `Fixes`/`Closes` (that would close the issue on push, before Mark's check).
4. **Push** (`git push origin main`) once the batch's gates and review rounds pass with no high finding left (D-34, D-35).
   CI then runs the tests (Node 22 and 24) and builds `ghcr.io/maroge1990/pigtv` **only if the tests pass**: watch it; if it
   goes red, fix it or `git revert` at once (`gh run view <id> --log-failed`).
5. Tell Mark what is committed, the build number, and numbered T5 steps ([`docs/TESTING.md`](docs/TESTING.md)) for
   anything that needs the real feed or a device. Nothing is *Verified* until he reports back. A release to production
   (deploy, rollback) needs Mark's go-ahead each time ([`docs/OPERATIONS.md`](docs/OPERATIONS.md) › Deployment).

## Work in batches (D-35)

Open issues touching the same code and risk (one subsystem, one platform) go in one batch, which pays once for its two
Codex rounds, push and CI build; a release bundles a few batches. Each fix stays its own commit with its own failing-before
test. Never batch unrelated areas to save time; a fix whose live effect must be proven alone ships where it can be told apart.

## Work tracking

- Issues in `maroge1990/PigTV` for both repos. Labels: `bug` · `feature` · `finding`; `P0` (broken for real use) · `P1`
  (next) · `P2` (soon) · `P3` (someday); `server` · `apple` · `web`; `needs-device-test`. Where an item came from goes in
  its body, not a label.
- Body (template in `.github/ISSUE_TEMPLATE/`): symptom · how to reproduce · evidence link · cause (once known) ·
  acceptance with its test tier.
- **An issue is closed by an agent only after Mark confirms the fix was checked**, with a comment quoting him.
- Anything that would help someone attack an exposed server (auth or redaction bypass) is a **private security
  advisory**, never a public issue, commit text or doc.
- Docs never list open work; they may link an issue. Size budgets warn, never fail (`verify-build.sh`): `AGENTS.md` 120
  lines, `ROADMAP.md` 150, an evidence README 40, any other doc 600.

## Rules

- **Capture before changing anything on the playback path** (`scripts/stream-doctor.js`,
  [`docs/architecture/playback.md`](docs/architecture/playback.md)). No ffmpeg-flag or timestamp patch ships on a
  hypothesis: 0085 did, and broke every even feed.
- Every functional change has a test that **fails on the old code** (prove it). Add a `verify-build.sh` check only for
  what a test can't say, and prove it by reintroducing the bug.
- **Test, don't ask:** T1–T3 touch no real provider, so run them. T3 (the Unraid rig's fake provider, browser pane,
  simulators, before/after screenshots) is required for user-visible changes; say which T3 checks could not run.
- A change the Apple client can see goes into `docs/CLIENT-CONTRACT.md` in the same commit; a new endpoint it calls goes
  into `APPLE_CLIENT_ROUTES` in `test/api-404.test.js`.
- Never return or log a provider URL, password or token (`redact()`, opaque handles, C-B error texts).
- Ask Mark before changing the production container or opening a real provider connection (a capture, a probe, a play);
  read-only production status (T4) is fine.
- **Questions to Mark: one at a time**, each with options and a marked recommendation.
- The lead session may delegate to sub-agents (never Haiku) and reviews every diff before committing.

## Reviews (Codex adversarial review)

Required before a batch is pushed (D-34) if it makes any functional change to recording/DVR, recording rules, the
playback path, provider routing or admission, caches or other shared ownership/accounting, auth/redaction, or anything
in `docs/CLIENT-CONTRACT.md`; fixes a review finding; or changes more than ~150 non-test lines (D-17). Docs-only and
test-only commits are exempt. **Claude launches it itself** in each repo touched: `node ~/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs adversarial-review --wait
--base <the commit before the batch> "<focus: the batch, its issues, its first commit>"` (Bash in the background, output to the scratchpad). It needs
`codex login`; if it cannot run, say so and give Mark the command and focus. **At most two rounds per batch**
(the first review, and one of the fixes it prompted; D-19). Every finding becomes an issue labelled `finding` (security
ones a private advisory), fixed with its own failing-before test or answered; after round two only **high** findings
block the push, and mediums and lows stay open as issues. The handoff lists each finding with its disposition.

## Gotchas

- CI runs every test file at once on 2 vCPUs: keep timing margins ≥ 1 s, or poll.
- Query `epg_live`, never `epg_programs`; a row that has a `stable_id` must never fall back to its stored `pos_N`
  ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) › Channel identity, Guide and EPG).
- Ingest-time changes only show after a sync (Settings → the source's ⟳, "Sync now"); a redeploy skips sources synced in
  the last 24 h.
- `settings.get()` returns a deep-frozen object: copy before changing. Express 5: wildcards are `/{*splat}`;
  `res.sendFile` needs `dotfiles: 'allow'` under a dot-folder.
- Some tests copy only `server/` into a sandbox, without `package.json`: anything `getDb()` requires at open must be
  fail-safe (`version.js` needs `package.json`).
- No local Docker: the image is only built by CI. The tree is LF. `verify-build.sh` uses the system `python3`.
- Never commit real values or secrets; environment variables are documented in `.env.example`.
