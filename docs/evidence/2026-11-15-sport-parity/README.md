# Sport parity (server 0696 to 0711): the web Sport pages and cards look like iOS (#325, #326)

Mark, 15 Nov 2026, on production 0695: the Sport page used only 1440 px of a wide window, and a sport's page "isn't
anything like iOS" (two columns of rows, the left one empty on a day with nothing today). He chose to fill the window,
match iOS's look throughout (the iPad layout on wide windows, the iPhone one under 768 px), and keep the card's ⋯ on hover
with right-click for the same menu. The reference was 91 iPad and iPhone simulator screenshots of Apple build 246.

| build | change |
|---|---|
| 0696 | the page fills the window; card rails run to the window's edge (#325) |
| 0697 | cards take iOS's raised fill with no border; iOS sizes |
| 0698 | with a mouse the ⋯ shows on hover or focus; touch keeps it; right-click opens the menu |
| 0699 | on a wide window a sport's page embeds its league's page under the banner, as on iPad |
| 0700 | placeholders shaped like the cards while loading, not a spinner |
| 0701 | iOS status words: FINAL, LIVE, CANCELLED |
| 0702 | iPhone layout: short cricket and AFL scores, overs or goals.behinds under them on the carousel |
| 0703 | round and standings chips: accent tint and underline |
| 0704 | league-coloured discs and badges, team colours on fixture cards |
| 0705 | iPhone rows: a session titled by the session, three per sport |
| 0706 | iPhone carousel kicker grey, no "Your team" |
| 0707 to 0709 | cricket, events (tennis, golf, UFC, racing), standings, F1 notes, banner buttons and notices as iOS |
| 0710 | review (Opus, medium): an embedded league page that fails or is thin keeps the league's front-page games |
| 0711 | rig: a league without standings keeps its cards card-sized (an adaptive grid) |

Reviews: Codex round 1 found no high (one medium, a double F1 request); the Opus review found no high. Fixes 0710 and 0711
were signed off by Codex. Mediums and lows not fixed are listed on #326. Hidden scores: no score, short score, overs line,
batting side or winner reaches the page or its accessibility tree (tests per new place).

Rig T3 (fake providers, `PIGTV_RIG_SCORES=fake`), 1920, 1366 and 390 px: `front-1920.png`, `sport-page-1920.png`
(Football, the embedded EPL page), `sport-page-afl-1366.png`, `sport-page-phone.png`. The fake scores feed has no
standings or cricket and F1 fixtures, so those pages were checked only in their empty states on the rig; the device check
is on #326.
