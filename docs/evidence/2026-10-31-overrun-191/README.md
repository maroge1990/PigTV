# 0386–0387: a live game that overruns its guide slot keeps Watch (#191)

**Change.** While the score feed says a game is live, at a break or suspended, a channel whose airing of it ended no
more than 4 h ago is reported as airing until now + 10 min (rolling, `overrun: true`): dashboard, front page (C-R), and
the F1, NFL and Cricket pages. One rule: `server/services/sportOverrun.js`. C-I's own answer is unchanged.

**Tests (T1, failing before).** `test/sport-overrun.test.js` (helper bounds, dashboard positives and negatives, each
page), `test/sport-front.test.js`, `test/sports-events.test.js` (ended airings never reach C-I), `test/sport-page-nfl.test.js`
(stale cache). Each failed on 0385's server code; all pass on 0387.

**Codex adversarial review, one round (D-38).** Verdict needs-attention, no high.

| Severity | Finding | Fixed |
|---|---|---|
| medium | A page's cached "live" status kept renewing Watch after its ESPN refreshes failed, for up to 4 h | 0387: pages extend only while their last good ESPN answer is ≤ 15 min old |

**Not covered.** T3 on the rig: the staging fixtures have no game overrunning a guide slot. T5: Mark watches a game run
past its slot (Test Round page).
