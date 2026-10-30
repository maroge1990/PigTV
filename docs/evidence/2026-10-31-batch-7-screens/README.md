# Batch 7 on staging (T3)

31 Oct 2026, server 0371 on the Unraid staging rig (fake providers only). A device paired with
`X-PigTV-Client: PigTV/84 (tvOS 26.1; AppleTV14,1)` and named "Living room" played "UK| BBC ONE HD"; a second
device (`PigTV/84 (iPadOS 26.1; iPad13,4)`) asked to pair and was left pending. Headless Chromium, 1280 px wide.

- `status.png`: Playing now names "Living room (Apple TV, PigTV 84)" (#19, 0364); the build line ends with
  "ffmpeg 9.0.2 · ffprobe 9.0.2 (system)" (#61, 0366); details closed, so the page asked for `?details=0` (#129, 0370).
- `devices.png`: typing the pending code shows "Asking: PigTV iOS · iPad · iPadOS 26.1 · PigTV 84 · 3 min ago"
  before Approve (0365); each signed-in device shows kind, OS and app build (0363).

Also seen, not kept: Settings → Playback ends with "Re-detect GPU" (0367); Settings → Providers reads
"Last synced: Fake A 3 minutes ago · Fake B 3 minutes ago" (0368).
