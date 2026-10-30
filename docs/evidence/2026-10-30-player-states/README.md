# Live player states on tvOS (Apple 64–65, #6), 30 Oct 2026

T3, headless: build 68 in the tvOS 27 simulator (Apple TV 4K, 3rd generation), launched with `simctl` and the DEBUG
player fixtures, screenshots with `simctl io screenshot` (the live simulator panel was not available to this session).
No server, provider or device.

- `player-starting.jpg` (`PIGTV_UI_TEST_SCREEN=player-starting`): an installed player with no picture yet. The tuning
  card covers it, with its Cancel focused (#132: the card owns the remote until the first picture).
- `player-buffering.jpg` (`player-buffering`): after the first picture, a wait for data shows the "Buffering…" pill.

Behaviour (timeouts, recovery, focus hand-over at the first picture) is covered by RealPlaybackTests and
PlayerTuningUITests; the hand-over at a real first picture is part of Mark's T5 check.
