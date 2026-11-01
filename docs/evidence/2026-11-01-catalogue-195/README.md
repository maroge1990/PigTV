# 0394–0399: the curated catalogue and International groups (#195, D-41, D-42)

Server batch, 1 Nov 2026. Base `37802b0`.

| Build | What |
|---|---|
| 0394 | The admin keyword list is retired: the leagues any account follows decide what is sport (D-42) |
| 0395 | Football: Champions/Europa/Conference League split; League Cup, Scottish Premiership, Eredivisie, WSL, A-League Women; Internationals groups |
| 0396 | Rugby union: Rugby Championship, Six Nations, Rugby World Cup, Premiership Rugby, Top 14, Champions Cup |
| 0397 | Cricket: men's and women's International groups by ESPN's international class; WBBL, SA20, The Hundred, Shield, One-Day Cup, WNCL; the Cricket page holds only followed competitions (the WBBL lead) |
| 0398 | International groups: tournaments in full, other games only for followed nations |
| 0399 | The catalogue with labels and headings (C-U) |

**ESPN checks (1 Nov):** every football international feed answered but `fifa.wwcq.uefa`; the six rugby ids and
The Hundred's (19601) answered. Six months of cricket series (#195 issue) set the class rule (1–3 men, 8–10 women).

**Tests (T1).** Each change's new tests fail before it and pass after. Full suite: 1,565 pass; the same 4 fail only
on the WSL box (ffmpeg without HE-AAC, `recording-segments-media`). `verify-build.sh` passes; its keyword-save check
became "never present" and was proven by reintroducing the call.

**Codex adversarial review, round 1** (`--base 37802b0`): needs-attention, one high and one medium, both fixed in 0400
with failing-before tests:

1. *High: missing cricket class metadata counted as "no group"* (`sportsFixturesEspn.js`): a scorepanel entry without
   its international class made discovery complete, so a refresh could replace a group's stored games. Unknown class is
   now an incomplete discovery: the games and coverage are kept (`test/sports-fixtures.test.js` › 0400).
2. *Medium: football's qualifier aliases took cricket titles* (`sportsClassify.js`): "ICC Women's Cricket World Cup
   Qualifier" filed as football. A title naming another sport (cricket, ICC, rugby…) is never football's internationals
   (`test/sports-classify.test.js` › 0400).

One high in round 1, so a second round runs (D-38).

**Not covered:** T3 on the rig; real guide titles for the new leagues (spellings come from broadcasters' usual
names, to be checked in the combined test); The Hundred and WNCL are off-season.
