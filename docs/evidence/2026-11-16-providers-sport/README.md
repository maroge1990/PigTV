# Providers and sport batch, 16 Nov 2026 (server 0758 to 0765)

**Issues:** #319 (squad identity in the sport nickname join), #268 server half (av-desync mark), #315 (no provider
host in log lines), #330 (test a provider before saving it).

**T1:** `PIGTV_SKIP_PERF=1 npm test` on the integrated tree: 2736 pass, 4 fail (the known WSL-only AAC failures in
`recording-segments-media.test.js`); `verify-build.sh` passed. Every new test failed on the old code.

**T3 (rig, staging on 0765, fake provider, API only):**
- `POST /api/sources/test`: the fake's login passes with the account fields; a wrong password fails with "The provider
  rejected the login" (no address or password in the reply); a refused port fails with a plain sentence; no token: 401;
  the sources count is unchanged (nothing written).
- `client-event av-desync`: 204, one log line `[Player] av-desync t=1200.5s buffered=1230.1s behind=29.6s rate=0.97
  catching-up=true stalls=2 watched=1250s from=user:1 relay=none`.
- Not run: the web screens (add-provider form, Status row) in a browser: no browser pane in this session.

**Codex (adversarial review):**
- Sport batch: one medium (bufferedEnd dropped from the av-desync line), fixed in 0761. The lead's 0760 (an unmarked
  guide title still joins a women's/youth game, for WBBL) was added after round one. Sign-off of both: approve.
- Providers batch: one high (a malformed provider reply's text, possibly a login, could reach the test's reply and log)
  and one medium (an error response containing a playlist or XML marker passed), both fixed in 0765. Sign-off: approve.
