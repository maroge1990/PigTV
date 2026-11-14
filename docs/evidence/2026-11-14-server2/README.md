# Server 2 (server 0596 to 0601): Status and sign-in; review, gates and the rig

Issues: #299, #300, #307 (Mark: name the provider), #61 (Mark: show warming).

| build | issue | change |
|---|---|---|
| 0596 | #299 | Status names a session's, recording's and problem's provider again (the name query had failed since 0175) |
| 0597 | #300 | deleting a user removes their paired devices and pending last-seen entries, in the same transaction |
| 0598 | #307 | session start, guide fetch and a stalled session's release name the provider, not its host and port |
| 0599 | #61 | Status's Playing now shows "Warming: N channels ready" when channels are warmed |
| 0600 | #307 | a failed probe logs a class of failure, not ffprobe's text (Codex medium: a DNS failure printed the host) |
| 0601 | #61 | the warming summary is in the default Status answer (Codex medium: it was detail-only) |

Each has a test that failed on the code before it.

## Review

Codex (0596 to 0599): 2 medium, fixed in 0600 and 0601; Codex's sign-off of both: approve, no findings. Filed on the way:
#315 (other log lines that can still print a provider's host: the proxy, ffmpeg's command line and stderr, quoted errors).

## Gates

`npm test` on 0601: only the four AAC-LC tests that fail on the WSL machine fail. `scripts/verify-build.sh`: all checks passed.

## The rig (fake providers only), 0595 against 0601

| check | 0595 | 0601 |
|---|---|---|
| #299: Playing now | "UK\| BBC ONE HD", no provider ([`status-before.png`](status-before.png)) | "UK\| BBC ONE HD (Fake A)" ([`status-after.png`](status-after.png)) |
| #61: one channel warmed | not shown | "Warming: 1 channel ready" ([`warming-after.png`](warming-after.png)) |
| #307: session start and guide fetch log lines | host and port | `provider "Fake A"`, no host |
| #300: delete a user with a paired device | not run | device token 401, no device rows left |

Not run: the failed-probe line on the rig (no probe failed on the fakes; T1 covers it). Raw notes: [`rig.txt`](rig.txt).
