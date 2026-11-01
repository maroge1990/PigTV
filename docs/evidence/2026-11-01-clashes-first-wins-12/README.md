# 0410–0412: in a recording clash the one scheduled first wins (#12, D-42)

Server, 1 Nov 2026. Base `f7f0e9b`. Builds on 0324–0326 (clash list, slot reason; docs/evidence/2026-10-30-recording-clashes).

**0410:** connections go out in rank order at each overloaded moment (running, then chosen, then earliest made); a
loser carries `beatenBy` and waits whole with the winner named; missed says "Not recorded. …"; `POST
/api/recordings/scheduled/:id/choose` ("Record this one instead"); the web Recordings list says which records and which
waits, with the button. Before, whichever started first took the connection.

**Tests (T1):** `test/recording-clashes.test.js` (real engine, coordinator and shared ingest on a fake MPEG-TS provider):
eight new, two updated, each failing on the build before it. Full suite 1,609: 1,605 pass, the usual 4 fail only on the
WSL box (ffmpeg without HE-AAC). `verify-build.sh` passes.

**Codex adversarial review, round 1** (`--base f7f0e9b`): three high, fixed in 0411 with failing-before tests:

1. *Holds used the provider pools,* so a recording a backup could carry waited. Holds count the recording limit only
   (the engine's own start rule); `conflictsWith` keeps the cautious pool warning.
2. *A loser was released into a part recording* when its winner ended first. It keeps its winner (`clash_winner`) until
   that is cancelled, deleted or missed, or it is chosen.
3. *A choice made while the other one was starting was ignored.* A start under way re-checks after any choice.

**Round 2:** those hold; one high, fixed in 0412: both due in one tick, the other chosen mid-start, the two held each
other. The tick recomputes after a choice; a stored hold never points back at one this schedule beats.

**Not covered:** the flag on a game's sport card (comes with #198, which links recordings to games); T3 on the rig;
Apple's Recordings (#200). The web button is untested in a browser (T3).
