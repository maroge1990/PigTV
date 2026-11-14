# Sport order by drag, Apple 242 and 243 (#317)

Mark's three requests from TestFlight 239, 14 Nov 2026:

1. Settings › Sport has no Edit order. On iPhone and iPad a sport is pressed and dragged at any time, and the drop is saved at once.
2. A sport's own page has no Move up / Move down, for the sport or its leagues, on any device. Leagues are dragged like the sports (iPhone, iPad). By Mark's choice the Apple TV can no longer reorder.
3. The iPhone Sport carousel's position line reads "1 of 4" (no "· yours, then live").
4. (243, Mark's follow-up) Every sport and league shows the usual line handles (≡), with no words. Both Forms are always in edit mode, and the rows that open a page are buttons, because a NavigationLink does not open in edit mode.

## Evidence

- `iphone-sport-drag.png`: iPhone 17 simulator, offline fixture, 243: after Cricket was dragged above Football by its handle.
- `iphone-league-drag.png`: Football's page after Champions League was dragged above Premier League by its handle.
- `ipad-sport-handles.png`, `ipad-league-handles.png`: iPad Pro 13 (scratch test), with the handles on the sports and leagues (the cropped-off sidebar showed the fixture's server address).
- Tests: `TouchLayoutUITests.testPhoneSportsAndLeaguesAreReorderedByDraggingWithoutEditOrder` (iPhone: the handles, both drags, and each row that opens a page; 3 runs of 3) and `SportSettingsUITests` (tvOS: no Move up / Move down) passed. `Tools/test.sh fast` passed, and so did the unit tests for `orderLeagues` and the position line.
- No review was needed: the change is sport UI, under 150 lines, and outside the client contract.
- T5, Mark: on the iPhone and the iPad, drag a sport in Settings › Sport and a league on a sport's page, leave and come back, and check that the Sport page follows the new order.
