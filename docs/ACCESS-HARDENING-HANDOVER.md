# PigTV access hardening — handover

Prepared 14 September 2026 for the original AI development client.

## Scope and starting point

This change builds on `main` at `d0d9a347784ac33c9440088ff8f01623ea1aba93` (3.4.0), including the recent guide, device pairing, optional stream authentication, and server-info work. Review branch: `codex/protect-source-settings`. It is intended for a draft PR and server testing before merge; no deployment or merge is part of this work.

The installation is Unraid Docker, built from GitHub, with M3U plus a separate EPG and a maximum of one provider stream. App data is on Unraid with weekly backups; recordings are on another bulk storage server. Tailscale access is planned. Keep these constraints when testing and designing later work.

## Changes and reasons

| Area | Change | Reason |
| --- | --- | --- |
| Source routes | All routes require authentication. Detail/status reads and every mutation, estimate, test and sync require an admin. | Anonymous clients could previously read or administer subscription sources and initiate upstream requests. |
| Source responses | Lists and create/update/toggle responses allowlist `id`, `type`, `name`, `enabled`. Admin detail includes URL, username and `hasPassword`, never the saved password. | Masking one password field left other credentials, including those in URLs, exposed in general browsing responses. |
| Settings routes | All reads require authentication; writes, reset and hardware inspection/refresh require an admin. | Viewers must not change global playback, storage or sync configuration. |
| Signing key | New `server/authSecret.js` supplies the same private key to Passport JWT, device tokens and Express sessions. | The former public fallback made signed tokens forgeable. |
| Browser source management | Password stays blank on edit; omitting it preserves the saved value. Source lists omit URLs. Source name, URL and username are escaped before insertion into form markup. | Match the restricted API without overwriting stored credentials or interpreting source text as HTML. |
| Browser authorization | Admin status polling starts after authentication. Viewer navigation to Settings redirects home. Hardware/sync requests use the authenticated API helper. A 401 clears the token, redirects to login and rejects the request. | Prevent unauthorized background requests and client errors when protected endpoints reject a request. Server middleware remains the authority. |
| Volume | Remembered volume is saved in browser local storage (`pigtv_last_volume`) and loaded when enabled. | Ordinary volume changes previously sent an entire settings snapshot to the server, conflicting with viewer permissions and potentially overwriting newer global settings. |
| Verification | Add `npm test` and GitHub Actions for Node 20 and 24. | Provide repeatable access and compatibility regression coverage. |

Primary implementation files: `server/routes/sources.js`, `server/routes/settings.js`, `server/authSecret.js`, `server/auth.js`, `server/services/deviceAuth.js`, `server/index.js`, and the corresponding browser files in `public/js`.

## API contract for browser and native clients

- Supply `Authorization: Bearer <token>` on source/settings requests. Anonymous requests return 401; signed-in viewers attempting admin operations return 403.
- `GET /api/sources` and `/api/sources/type/:type` return only source summaries. Never depend on a subscription URL or password in those results.
- `GET /api/sources/:id` is admin-only. `hasPassword` indicates a saved password; submit a new password only to replace it. The existing browser omits an empty password when editing. This change does not introduce a password-clearing workflow.
- Authenticated settings reads retain their existing shape, including operational fields. This PR does not introduce a separate public client-settings schema.
- Source and settings responses use `Cache-Control: no-store` after authentication.
- Existing guide, library, pairing and stream API shapes and API-version metadata are unchanged. Native clients should handle 401 by signing in/pairing again and 403 as insufficient privileges.

## Signing-key migration

If `JWT_SECRET` is absent, the server creates `data/auth-secret` from 48 random bytes encoded as 96 hex characters, using exclusive creation and mode 0600. Subsequent starts reuse it. The existing persistent `/app/data` mount must retain this file and include it in backups alongside the databases. A corrupt or unreadable key fails startup rather than silently invalidating every token by replacing it.

An explicitly configured `JWT_SECRET` takes precedence. It must be a private random value of at least 32 characters; the former public fallback and shorter values are rejected. Length validation cannot prove randomness. Keep an already suitable private value unchanged. If the deployment currently explicitly sets the public fallback or a short value, update the container configuration before rebuilding: remove that variable to use the persisted installation key, or supply a suitable private key through the existing secret configuration. Do not commit or paste that value into a handover.

Users whose tokens were issued with the old default must sign in again; existing device tokens must be replaced by pairing again. A retained valid custom key preserves otherwise valid tokens. No user/password, source, channel, EPG or recording database migration is introduced. Preserve `data/auth-secret` on restart, rebuild and rollback.

## Verification performed

All 13 tests passed locally on Node 24.19.0. Tests use temporary data directories, real Express/Passport and SQLite, synthetic accounts and fixtures, and stubbed upstream/hardware work. They do not use the real subscription or server storage.

Coverage includes anonymous/viewer/admin route permissions, restricted source responses, admin login, password preservation/replacement, rejection of tokens signed with the old public key, current-user role enforcement, deleted users, paired-device revocation, form escaping and API 401 behavior. A synthetic 505-entry M3U exercises provider order, cross-listed entries across import batches, hidden groups and guide resolution from a separate EPG. Stream analysis fixtures retain the HE-AAC conversion decision and HEVC capability handling. Browser tests run JavaScript in a VM; they are not a rendered browser or actual playback test.

CI installs locked dependencies without install scripts, rebuilds `better-sqlite3`, and runs the suite on Linux Node 20 and 24. FFmpeg downloads are unnecessary for these tests. The container runtime and dependency versions are unchanged. CI does not gate the existing image-publishing workflow or configure branch protection. The local dependency install reported four existing audit findings (three moderate, one high); dependency remediation is separate work.

## Unraid acceptance checklist

1. Keep the current working image/tag and confirm the existing app-data backup is recoverable. Record the existing container configuration, mounts and environment without posting secrets.
2. Build the review branch using the existing Git-based build process. The exact Unraid template/build mechanism was not inspected. Select `codex/protect-source-settings` explicitly; rebuilding `main` will not include a draft PR. Preserve app-data/recording mounts, permissions, GPU device mappings and other existing settings.
3. Stop the original container before using its writable app data with the replacement. Do not run two containers against the same writable databases. Do not test simultaneous live streams: the provider allows one.
4. Start the updated container. If using the generated key, confirm `auth-secret` exists inside the persistent data mount without displaying its contents. Sign in again if upgrading from the old default key. Re-pair a device if its former token is rejected.
5. In a private browser without a login, `/api/sources` and `/api/settings` should return 401. A viewer should browse channels and guide successfully, but source changes and settings writes should return 403. Direct Settings navigation should return a viewer to Home.
6. As admin, inspect Sources and Settings. Edit a source name without entering a password; verify the existing source still works. Confirm hardware information and sync status load. Use the existing source rather than creating a second subscription test. Source changes may trigger a sync, as before.
7. Check M3U provider order, cross-listed channels, hidden categories and the separate EPG. Play one known channel, including a known HE-AAC channel if available. Stop playback before checking a different channel or starting a recording.
8. Change volume as a viewer and reload: with Remember Volume enabled, it should persist in that browser without settings-write errors. Exercise normal admin playback-settings changes as well.
9. Sequentially test one short DVR recording to the bulk-storage mount and playback of an existing recording. This PR does not validate a disconnected storage mount or alter recording behavior.
10. Restart the container and verify the new login/device token remains usable within its normal validity period. Rebuild once more if practical to confirm the data mount preserves the key. Report failures with sanitized logs, expected/actual behavior and the tested commit.

If acceptance fails, stop the new container and restore the retained image with the same mounts/configuration. No schema rollback is required by this PR. Keep the new key file. Old software using the old default retains its prior signing-key weakness; rollback is an operational recovery step, not a security resolution.

## Boundaries and follow-up work

This is source/settings access hardening, not a claim that every endpoint is ready for remote exposure. Existing optional `requireStreamAuth` behavior remains unchanged. Review media/proxy/recording authorization and credential-bearing playback URLs separately, including whether all media requests and clients work with enforcement enabled. Broader provider-content HTML rendering, source input validation, settings allowlisting and stale global-settings updates from the admin page remain outside this patch.

Preserve the recent nodecast-tv troubleshooting fixes: position-based channel identities, cross-listed entries, provider order, hidden categories, HE-AAC conversion, HEVC copy/VAAPI fallbacks, and independent EPG/DVR behavior. This PR adds selected regression fixtures; it does not reproduce real FFmpeg, GPU, provider or storage conditions.

Next work should be separate reviewed changes: media access and stream-session limits, recording/storage resilience, then native client integration using existing pairing, guide and server-info endpoints. A one-stream limit needs explicit coordination between live viewing and recording; this patch does not implement that coordinator. Native UI should derive content from M3U/EPG data and handle missing programme information gracefully. Light/dark Apple-native designs with fluorescent pink accents remain a separate design/app task.
