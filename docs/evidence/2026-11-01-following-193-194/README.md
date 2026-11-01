# 0390–0393: following per account, games only from fixtures (#193, #194, D-41)

Server batch, 1 Nov 2026. Base `367fbb1`.

| Build | What | Issue |
|---|---|---|
| 0390 | The front page's games come only from fixtures; a guide listing never becomes a card | #194 |
| 0391 | Per-account follows grouped by sport (`sport_follows`, C-U `/api/sports/follows`, `/catalog`); C-P/C-R preferences become the account's view | #193 |
| 0392 | Front-page rails: leagues with a game on now first | #193 |
| 0393 | Codex round 1 fixes (below) | #193 |

**Tests (T1).** Each change's new tests fail on the code before it (0390: 3 failures; 0391: 8; 0392: 1; 0393: 2) and
pass after. Full suite: 1,558 pass; 4 fail only on the WSL box, whose ffmpeg 8.0.1 has no HE-AAC encoder
(`recording-segments-media`, untouched). `verify-build.sh`: all checks pass.

**Codex adversarial review, round 1** (`--base 367fbb1`): needs-attention, two medium, both fixed in 0393 with
failing-before tests (`test/sport-page-cricket.test.js`):

1. *Cold Cricket requests fall back to another account's page* (`sportPageCricket.js`): a follow list whose first
   refresh failed got the most recent other list's page. Now only its own page, else `{ available: false }`.
2. *Cricket follows read through the Cricket league alias* (`routes/sports.js`): an account following Cricket through
   IPL or BBL only lost its followed team. Now read from the Cricket sport's names.

No high finding; no second round (D-38).

**Not covered here:** T3 on the rig and T5 on a device (the Apple Settings screens are #200); AFLW and other leagues
without an ESPN fixture show nothing until #196.
