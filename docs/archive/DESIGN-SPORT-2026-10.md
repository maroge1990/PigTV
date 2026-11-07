# Sport pages: the October design notes (archived 7 Nov 2026)

Frozen history: the notes `docs/DESIGN.md` › Sport pages held before D-43 (1 Nov) and D-44 (2 Nov) replaced the page
layouts. What still holds is restated there; this file is not instructions.

## Sport pages (as of 31 Oct 2026)

From the F1 mock-up review (30 Oct), for the sport rebuild (#21):

- Stat values (lap length, lap record) never wrap onto a second line.
- Lists that sit side by side are symmetric: ten results beside the top ten drivers and the top ten constructors.
- Spacing and alignment are checked on the real screens at build time; the mock-ups are not pixel-final. Save
  vertical space: paired actions (e.g. "Watch at kick-off" and "Record every Packers game") sit on one line.
- No redundant labels: the current week or session is evident from its content ("Week 8", not "Week 8 · this week").
- No section tabs on a sport page (Mark, 30 Oct): the championship already sits on the main page, so F1 has no
  Race weekend / Championship / Calendar tabs, and no season calendar either: the next race weekend is enough. The
  mock-ups' spacing and overlaps are fixed at build time, on the real screens.
- Fixture sports open on the current round, with rounds in chronological order (last round, then this one). Standings
  sit on the right with Division, Conference and Overall views: the whole column without a followed team, below the
  team card with one.
- Approved by Mark on 31 Oct (canvas "PigTV Sport mock-ups"): **Cricket · Apple TV** (the followed team's match leads:
  day and session, both innings, the lead, who is batting, the five days, Watch / Channels / Record; the whole tour on the
  right; other competitions today and next below), **Formula 1 · iPhone** (one scrolling column; whether it should be
  split into pages is open, #177) and **· iPad** (the Apple TV layout in landscape, one column in portrait), and **Web ·
  channel changes** (held smaller lists, New on the provider, Show all / Hide all with a confirm and Undo).
- **Sport front page, approved 31 Oct (D-39, canvas "Blend 1"):** the app's tabs stay on screen; followed sports as
  tiles at the top; a hero band (hero left, the followed teams and drivers as a flip list right, compact rows beyond
  three); a rail per followed sport below, live cards first. Team badges beside every score; the monogram disc only as
  a fallback. Spoiler-free keeps neutral progress (Q4, 2nd session) and hides scores, situations and results; without
  the scores feed the page says so once and shows the guide's channels and start times. Never invent a clock, a leader
  or 0–0. Since 1 Nov the tiles are gone and the hero band is the banner below (D-43).
- Channel quality labels: today the server reads UHD / HD / SD from the channel's name (FHD counts as HD). The build
  should distinguish FHD from HD and, where a channel has been played, confirm the label from the measured stream
  (resolution, frame rate, HDR), never by probing channels in the background.

