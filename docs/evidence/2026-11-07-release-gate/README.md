# Release gate (#236, D-45), 7 Nov 2026

Production followed `:latest`, so a Force Update shipped whatever CI built last (0476 on 4 Nov, untested on devices).

**Change:** `docker-publish.yml` builds `:latest` and `:sha-<commit>` on green pushes to `main` only (no tag or release
trigger). `release.yml`, on a `v*` tag or a manual run, checks the commit is on `main` and CI built its image, records
the git tag, then points `:release` and `:v<build>` at that image. Nothing is rebuilt.

**T1 (verify-build.sh):** the #236 check fails on each reintroduced bug: a `release` tag in `docker-publish.yml`; a
`branches` trigger on `release.yml`; a `tags` trigger on `docker-publish.yml`; a `release` trigger on it; the
pre-review `release.yml` (loose names, promotion before the git tag).

**Codex round 1:** one medium, fixed in the batch: a name like `v0477.lock` (valid image tag, invalid git ref) moved
`:release` and then failed at `git tag`. Names are now `v` + digits, and promotion runs last. No high; no round 2.

**T4 (after Mark's go-ahead):** the first release run's summary, and `/api/version` unchanged by a Force Update with
untagged commits on `main`.
