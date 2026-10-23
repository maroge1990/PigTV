# Apple fix review — 23 October 2026

Reviewed Swift HEAD ac7f1867d623672127dc019d0f1584ae1b3e9e99 (build 47), against build 46 and original A1–A5 acceptance. No application edits, simulator runs, provider access or deployed-server access.

## Verdict

**A1 is addressed in the implementation. No new actionable defect found in this diff.** All production resume readers/writers now share `APIClient.localResumeKey`, incorporating canonical server URL, authenticated account ID and recording ID. Both authentication installation paths (restore and accept) construct clients with the resolved user ID. Pre-authentication clients have no account ID and cannot read/save local resume state. Player prompt, periodic/save-on-stop writes and BrowseModel progress (also Home) use the same scope. Existing clients keep their immutable account identity, so a delayed old-player write stays in the old account's namespace.

Legacy ID-only keys are removed during AppModel initialization and no production reader falls back to them. Leaving scoped values on logout is compatible with account isolation and allows the same account to resume after signing in again. Canonicalization normalizes scheme, host, default port and trailing slash before hashing.

Evidence: `PigTV/PrivateCaches.swift:28`, `PigTV/APIClient.swift:94`, `PigTV/APIClient.swift:116`, `PigTV/AppModel.swift:79`, `PigTV/AppModel.swift:150`, `PigTV/RecordingPlayback.swift:71`, `PigTV/RecordingPlayback.swift:176`, `PigTV/BrowseModel.swift:677`.

## Validation and remaining acceptance

- Existing reviewer log `/tmp/pigtv-review47-contracts.log` ends with **243 API/model contract checks passed**. These checks compile the changed helper, but do not themselves exercise the new resume-isolation XCTest cases; do not describe 243 as 243 A1 regressions.
- Inspected new `RecordingResumeTests` assertions for different servers/accounts, equivalent canonical addresses, missing account identity, legacy cleanup and account-isolated list progress.
- Inspected new `RealPlaybackTests.testLocalResumeFallbackIsScopedToTheAccount`: failed server-position GET (404) with positions enabled checks another account gets no resume prompt and the owning account gets 600 seconds.
- Commit records successful push-tier and iOS build, plus an earlier ChannelWarmer timing failure that passed on rerun. These are author-reported results, not rerun independently in this pass.
- Full original acceptance is not demonstrated by these additions: no dedicated end-to-end two-server playback, timed-out lookup, sign-out/re-login, or disabled-feature playback isolation case. Shared source paths support the intended behavior, so this is residual verification coverage rather than an identified implementation failure.
- The commit explicitly admits no old-code failing proof: new API tests do not compile on build 46. For the server repository's fail-on-old-code standard and the handoff request, a mutation/baseline behavioral proof is still desirable (temporarily restore ID-only key generation behind the current helper, observe isolation assertions fail, then restore the fix).
- No physical-device acceptance established. The original iPhone Tuning and AUS v SA issues are unaffected by this change.

## Remaining Apple findings

**A2, A3, A4 and A5 are not addressed by build 47.** Top Shelf logout publication race, hidden rule mutation errors, same-shape guide correction invalidation, and launch-only artwork disk pruning remain open. Build 47's scope is A1 only.

Minor documentation follow-up: `RecordingResume.swift:5` still describes the obsolete `pigtv.resume.<id>` key; this does not affect execution.
