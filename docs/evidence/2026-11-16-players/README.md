# Players batch: sport player's live games, Go to live on recordings (16 Nov 2026)

Server/web 0788–0797, Apple 256–261 (#334, #335; design D-67, score rule D-66).

## What was checked

- **T1:** server/web full suite (2804 pass; the 4 known WSL-only AAC failures in recording-segments-media);
  `verify-build.sh` clean. Apple PigTVTests on Apple TV 4K and iPhone 17 simulators (PlayerGamesTests,
  RecordingResumeTests, ZapListTests, SportSpoilersTests, BrandRulesTests, PlayerSharedTests, RealPlaybackTests).
  Every new test failed on the code before its change.
- **T3, Mark's condition ("all players look the same"):** simulator screenshots on Apple TV 4K, iPad Pro 13" and
  iPhone 17 (fixture screens `player-games`, `recording-player-golive`) and headless-browser screenshots of the web
  app (1440 and 430 wide, against the fake provider with fixture feeds): the games list uses each platform's channel
  list styling, dividers line up, every row is one height; Go to live is last, red, never focused first, and the Back
  notice restores the position. Screenshots stay off the repo (they show only fake-provider content).

## Codex rounds

- Server/web round 1: **high**, a failed household-recordings read let a recorded game's score through → the front
  withholds every score when the read fails (0791). **Medium**, Safari's native HLS never noticed a finished
  recording → a 30 s check of the active list (0792, 0794); sign-off found absence during recovery is not "finished"
  → it only hides and comes back (0795); approved.
- Apple round 1: **medium**, a cached game could be tuned after its airing ended → the existing playable check at
  selection (Apple), with the same guard on the web (0797); both approved.

## Not checked

T5 on devices (Mark): a live game from Sport on the Apple TV; Go to live on an in-progress recording.
