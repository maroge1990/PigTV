---
name: Bug, feature or finding
about: One item of work for the server, the web app or the Apple client
title: ''
labels: ''
assignees: ''
---

<!-- Labels: one of bug / feature / finding; one of P0 (broken for real use) / P1 (next) / P2 (soon) / P3 (someday);
     server / apple / web; needs-device-test when only a device or the real feed can settle it.
     Where it came from (Codex, audit, Mark, a live incident) goes in the text, not a label.
     Security matters (auth or redaction bypass): open a private security advisory instead, never a public issue. -->

**Symptom**

What happens, and what should happen instead.

**How to reproduce**

Steps, or the test or script that shows it.

**Evidence**

Link to `docs/evidence/YYYY-MM-DD-slug/`, a log excerpt (no provider URLs, logins or tokens) or a commit.

**Cause (if known)**

**Acceptance** (with test tier)

What proves it fixed, and at which tier (docs/TESTING.md): T1 automated, T2 real media offline, T3 end to end, T4
deployed read-only, T5 device and real feed (Mark).
