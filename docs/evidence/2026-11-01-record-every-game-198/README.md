# 0413–0417: suggested competitions, "Record every game", recordings on Sport cards (#198, D-41, D-42)

Server, 1 Nov 2026. Base `252a5f4`.

**0413:** `GET /api/sports/suggestions`, `POST /api/sports/suggestions/decline` (per account). Football from ESPN's
schedule of a club across competitions (`soccer/all/teams/<id>/schedule`, checked 1 Nov: Arsenal's Premier League and
Champions League fixtures; capture in `test/fixtures/espn/`), other sports from the collector's cards.
**0414:** recording rule kind `team` ("Record every game"): the team's fixture games in its maker's leagues, each on the
guide airing the dashboard joins to it (never a replay); rules name who set them. **0415:** C-R cards carry
`recording` with `clashesWith` when it waits (D-42 point 4).

**Tests (T1):** `test/sport-suggestions.test.js`, `test/recording-rules-team.test.js`, `test/sport-front.test.js`
(#198, 0416, 0417), each failing on the build before it. Full suite 1,617: 1,613 pass, the usual 4 fail only on the WSL
box (ffmpeg without HE-AAC). `verify-build.sh` passes.

**Codex adversarial review, round 1** (`--base 252a5f4`): fixed in 0416 with failing-before tests:

1. *High: team rules paired schedules by title,* so a same-named game in another league could take over a schedule
   (moved to its time, left on the wrong channel). Paired by the game's identity only.
2. *Medium: a card claimed a recording between staggered broadcasts.* Matched per channel airing.

**Round 2:** those hold; one high, fixed in 0417: the team rule used the guide event's merged bounds, so a game whose
coverage had begun on one channel was never recorded on another still to come. The keyword `sport` rule has the same
cause (older code): #207.

**Not covered:** T3 on the rig; the clients (web #199, Apple #200) that show suggestions, the switch and the card flag.
