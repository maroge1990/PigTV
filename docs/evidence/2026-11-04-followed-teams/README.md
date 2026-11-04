# Followed teams: next game at any date, follow badges (Batch 2, server 0450–0451)

Issues: #223 (next game beyond 72 h), #213 (server side: follow badges). Pushed 953d40a, CI green; not deployed.

## Causes
- #223: the front page keeps 72 hours; #218's look-ahead works per league and is skipped when any game of the league is
  due, so a team on a bye (Arizona Cardinals, 4 Nov) never got its next game.
- #213: production's stored rosters (read-only T4, 4 Nov): NFL 32, AFL 19, NBA 30, MLB 30, EPL 20 teams, **0 with a
  badge**, saved 3 Nov by a build before 0433 and refreshed only daily. ESPN's own lists have all of them.

## Fix
- 0450: each followed team with nothing on or due asks ESPN's schedule for that team (roster id; football's fixture
  list, its own competition only); its next unplayed game is a `nextRound` card. A roster without ids is refetched.
- 0451 (Codex round 1, medium): asked again every 6 hours while the game is past the window; unlisted games forgotten.

## Checks
- T1: 4 new tests, each failing on the build before. `npm test`: 1704/1708 (the 4 failures are this machine's
  ffmpeg 8.0.1 without HE-AAC, as on 0449; CI passes them). `verify-build.sh` passed.
- T2 (live ESPN, no provider): Cardinals → Seahawks v Cardinals 8 Nov; Arsenal → v Hull City 7 Nov; Cubs → none.
- Codex: one round; one medium, fixed in 0451; no high.
- Not run: T3 on the rig (its fake score source has no team schedules). T5: Mark, after the deploy.
