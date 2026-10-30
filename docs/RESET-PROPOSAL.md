# Reset proposal: documentation and testing (steps 2–3)

**Approved by Mark, 30 Oct 2026**, with eight amendments (marked ⓐ). Step 4 migrates everything into this shape; this
file is then deleted and its rules move into `AGENTS.md`, `docs/TESTING.md` and the issue template.

## 1. Documentation

### Rules

1. **One home per fact.** If two files say the same thing, one of them links to the other instead.
2. **Docs describe the present.** They are edited in place. No dated status paragraphs; the story of a change goes in
   its commit message, and the artefacts that prove it go in `docs/evidence/`.
3. **Work lives in GitHub Issues**, not in docs. A doc may link to an issue; it never lists open work itself.
4. **Size budgets warn, never fail** ⓐ. `verify-build.sh` warns when `AGENTS.md` passes 120 lines, `ROADMAP.md` 150,
   an evidence README 40, or any other doc 600. A warning means something probably belongs elsewhere; it is never a
   reason to cut useful detail.
5. **Handovers are not documents.** Item-level handover is an issue comment; session-level handover is the overwritten
   "Current state" in `ROADMAP.md`.
6. **End-of-session check** ⓐ, reported in every handover: docs touched (which), `ROADMAP.md` state overwritten (yes/no),
   no new handover or status files (yes/no), issues updated (which).

### Server repo (also home of everything shared by both apps)

| File | Holds | Comes from |
|---|---|---|
| `AGENTS.md` | Commands, how changes ship, rules, session start/end checklist, map of the docs | today's AGENTS.md |
| `README.md` | What it is and how to install it, for people | today's README |
| `ROADMAP.md` | Current state (≤ 10 lines, overwritten); Now / Next / Later naming issues; how to pick work | blueprint top + §4, the four roadmaps |
| `docs/PRODUCT.md` | What PigTV does, per feature: what it does, where (web / tvOS / iOS), status (shipped / gated / planned), non-goals | blueprint §1, §6, `SPORT-VISION.md` |
| `docs/ARCHITECTURE.md` | Components and how they talk; the playback path; ownership, admission and accounting; storage; background jobs | blueprint §2–3, SHARED-INGEST, MEDIA-TOOLCHAIN |
| `docs/architecture/<area>.md` | Only where an area needs > ~100 lines: playback, recording, ingest, EPG, sports | blueprint §3 subsections |
| `docs/CLIENT-CONTRACT.md` | The API the Apple client uses (unchanged role) | as is |
| `docs/DESIGN.md` | UX principles, per-platform patterns (remote, touch, web), brand rules; links to Pig-Branding | brand-standard, sports design UX parts |
| `docs/DECISIONS.md` | Numbered decisions: context, choice, consequence. Added to, never rewritten | blueprint §5, DISPATCHARR-REVIEW conclusions |
| `docs/TESTING.md` | The protocol in section 2 below, plus the tools (stream doctor, relay rig, avsync harness, fake provider) | AGENTS, blueprint, review READMEs |
| `docs/OPERATIONS.md` | Deploy, rollback, backup, health (unchanged role) | as is |
| `docs/evidence/YYYY-MM-DD-slug/` | Small text evidence only: before/after outputs, summaries, screenshots. Written once, linked from an issue or commit | `docs/reviews/` renamed |
| `docs/archive/` | Frozen history, never instructions | as is, plus retired files |

**Evidence stays small and public-safe** ⓐ. The repos are public: raw captures, media, full logs and anything naming
provider internals stay out of Git (local disk or the Unraid test share), referenced by path and hash only.

### Migration safeguard ⓐ

Step 4 starts with a **mapping table**: every section of every current doc (blueprint §1–§6, FINDINGS, the roadmaps,
each `docs/reviews/` folder) → its new home, or "archive only". Mark reviews the table, not the prose. Every retired
file is moved word for word into `docs/archive/`, so nothing is lost even if a summary drops a detail. The "what to know
before touching each area" lessons (blueprint §3) move intact, not condensed.

### Apple repo

`AGENTS.md`, `README.md`, `TESTING.md` (client suites and fixtures; points to the server's `docs/TESTING.md` for the
protocol), `docs/ARCHITECTURE.md` (client structure, player, focus model). Its roadmap, findings and contract live in
the server repo; `blueprint.md` is split between these and retired.

### Work tracking: GitHub Issues in `maroge1990/PigTV`, for both repos

- **Labels (kept small)** ⓐ: `bug` · `feature` · `finding` (from a review); `P0` (broken for real use) · `P1` (next) ·
  `P2` (soon) · `P3` (someday); `server` · `apple` · `web`; `needs-device-test`. Where an item came from (Codex, audit,
  Mark, a live incident) is written in its body, not a label.
- **Issue body (template):** symptom · how to reproduce · evidence link · cause (once known) · acceptance: what proves it
  fixed and at which test tier.
- **Only Mark closes issues** ⓐ. Agents write `Refs #n` in commits, never `Fixes`/`Closes` (which would close the issue
  the moment Mark pushes, before any device check). When an agent's tiers fully prove a fix, it comments so and adds no
  `needs-device-test`; Mark closes it on review.
- **Issues are read at the start of every session** ⓐ: `gh issue list --label P0` and `--label P1` before picking work.
  Tools that cannot read issues (Codex reviews, offline agents) get the relevant issue text pasted into their prompt.
- **Codex reviews:** each finding becomes an issue (`finding`), linked from the fix. The two-round stopping rule is
  unchanged; medium/low findings after round two are simply open issues.
- **Public repos:** anything that would help someone attack an exposed server (auth or redaction bypass) goes in a private
  security advisory instead of a public issue.
- `docs/FINDINGS.md` is retired: each open finding becomes an issue, closed ones are archived.

## 2. Testing protocol

| Tier | What | Who | Required for |
|---|---|---|---|
| T1 Automated | `npm test`, `verify-build.sh`; Apple `Tools/test.sh push`, iOS build | Claude | Every functional commit |
| T2 Real media, offline | ffmpeg fixture tests, relay rig, stream doctor and avsync harness on saved captures, AVPlayer over loopback | Claude | Any change to playback, recording or ingest |
| T3 End to end | Server against the fake provider; web app driven in the browser pane; the real Apple app in tvOS and iOS simulators against that server; before/after screenshots of every changed screen as evidence | Claude | Any change a user can see or touch — **once the test rig is live** ⓐ |
| T4 Deployed, read-only | `/api/version`, health, logs; no provider connection | Claude | Diagnosing a live report |
| T5 Device and real feed | Physical Apple TV / iPad / iPhone; real provider over time; A/V sync, picture, how the remote feels; deploy | Mark | Anything labelled `needs-device-test` |

- **T3 is not live yet** ⓐ. It needs the fake provider (being built) and the Unraid test containers. Until both exist,
  UI acceptance stays with Mark as today, and handoffs say which T3 checks could not run.
- **Machines:** this Mac runs Claude, Xcode and one simulator at a time. Heavy work (fake provider, staging server, full
  test runs, real-media tests) runs in CPU-capped containers on the Unraid server (≤ 3 cores, low priority, ≤ 6 GB,
  ≤ 20 GB under `appdata/pigtv-test`). Claude may create, rebuild and remove those test containers and read production
  status; anything that changes the production container or opens a real provider connection still needs Mark's yes.
- **Status words:** *Implemented* (code done) → *Locally verified* (T1–T3 pass, evidence linked) → *Verified* (Mark's T5
  report). Claude never writes *Verified*.
- **Claude's default is to test, not to ask.** T1–T3 touch no real provider, so Claude runs them without asking,
  including driving the simulators (replacing the Apple TESTING.md rule "ask before driving the simulator UI by hand").
- **Mark's checklist** in each handoff lists only T5 items: numbered steps, each with the expected result and what to
  report (app build, server build, device, channel, approximate time).
