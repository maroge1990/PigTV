# Web Sport windows (server 0724 to 0734): rail arrows, game details, record page, ESPN end (#327, #217)

Mark, 15 Nov 2026: sideways scrolling a card rail is hard with a mouse (keep one row, add arrows), and a card's ⋯ had no
way to choose the channel to watch or record (recreate iOS's windows). Also: recordings from the web use ESPN's end, as iOS.

| build | change |
|---|---|
| 0724 | ‹ › at a rail's ends on a wide window, only while it runs on; phones keep swiping |
| 0725 | iOS's game details (each channel, Watch revalidated at the press, Record on that channel) and record page (this game, every team game, every league game; When it stops; Start early / Finish late; Record on; Change recording by PUT) |
| test | every Sport record path sends the card's `gameId`, so the recording stops when ESPN says the game is over (#217) |
| 0726 | review (Codex high): Save re-reads the schedules and changes a recording made meanwhile instead of making a second one |
| 0727 | review (Codex medium): "Every <team> game" is always a team rule, its sport from the catalogue |
| 0728 to 0732 | review (Opus): Watch on a chosen channel is checked as the game's own; Change recording re-reads at Save; an ended channel is never swapped silently; Record on another channel moves the recording (new first, old cancelled after); Cancel takes the recording off at once |
| 0733 | sign-off (Codex high, Mark's go-ahead): a game's schedule is found by channel identity, never a stored position |
| 0734 | rig: ‹ stays hidden when the row rests on its 4 px padding |

Codex signed off 0726 to 0732 (one high, 0733) and 0733. Lows left on #327 (choice buttons' arrow keys, focus opener);
#329 (a server-side guard against two schedules of one game).

Rig T3 (fake providers and scores, 1920, 1366, 390 px): arrows only on the rail that overflows, a page per press, hidden
at each end, Tab-reachable (`rails-1920-start.png`); details from a card or ⋯, Watch plays, Escape returns focus
(`details-live-1920.png`, `phone-details-390.png`); the record page shows "When the game ends (ESPN)" and saved pre 5 /
post 15 with `endsWith: "event"` (`record-page-padded-1920.png`); Change recording sent `PUT {"postBufferMin":30}`; a team
rule from "Every Everton game"; a game scheduled through the API while the page was open stayed one schedule. Hide scores:
no score in either window's text or labels (the live game was 0-0, so a weak check). Not checked: a game on two channels
(the fake feed airs it on one); a finished game has no details window.
