# Batch 1, 4 Nov 2026: football event slots match their ESPN game (#222), and the cricket finding (#212)

Server 0447–0449. Found in Mark's test of 0446: "UEFA | 06 - Bodo/Glimt vs Lille 8:00pm" was matched to nothing.

**Cause, three parts (0447):** a slash inside a name ("Bodo/Glimt") made the side unreadable; the kick-off time's colon
split the title and left "Lille 8"; and with "UEFA" naming no competition the league could only come from the stored
rosters, where ESPN names every football club by its place alone (36 of 36 in `soccer/uefa.europa`, fetched 4 Nov) and
the #24 guard dropped any name equal to the place. ESPN's AFL, NFL and NBA teams all have a nickname besides the place.

**Fix:** a slash joins one club's name; team tokens fold marked letters (ø, ö, é); clock times are dropped before the
split; in club football only, a club named by its place is known by it.

**Codex rounds (two, both high, both fixed in the batch):**
1. 0448: a club's place admitted "Toulouse v Lyon" to Ligue 1 although Top 14 has teams from both towns. Every stored
   team's place is now a possible reading; inference needs exactly one possible league; another code's category blocks it.
2. 0449: the guard read only categories, so "Rugby: Toulouse v Lyon" with no rugby roster stored was still Ligue 1. The
   title and the event slot's name are checked too.

**T1:** `test/sports-classify.test.js` › #222 (four tests, each fails on the build before it). Full gates on 0449:
`npm test` 1700 pass, 4 fail (`recording-segments-media`: this machine's ffmpeg has no HE-AAC encoder; the same 4 fail
on 08de8ce), `verify-build.sh` passed. **T3 not run:** the rig's fake provider has no event-slot football titles.
**T5:** Mark, at the next UEFA round (an event slot's game shows its channel).

**#212 (no server change):** `sportPageCricket.build` on live ESPN data, International (men's) followed: only men's
internationals (NZ v India lead; UAE v Oman, Bangladesh v West Indies, Afghanistan v Zimbabwe). With every cricket league
followed, each match carries its `league`. The WBBL matches on the International page come from the Apple page's
"Your other cricket today" section, a design choice for Mark (Batch 3).
