# Golden API answers and 0430–0431: logos and artwork through the logo cache (#52)

Server, 1 Nov 2026. Base `c4131fd`.

**Test-only (86abc80):** `test/contract-golden.test.js` boots the real routers on a sandbox (fake Xtream provider,
ESPN seams with stored samples, no off-machine fetch) and writes 37 answers the Apple client relies on to
`test/golden/` (`GOLDEN_UPDATE=1`); every run compares their shape (keys, types, a field only ever null) and fails
naming the route and path. Proven by changing `recordingArtwork` to a string and renaming `retryAfterSec`.

**0430:** channel logos in sport events (also a build made right after a sync) and in rule-made schedules and their
recordings go through the logo cache. **0431:** one serialiser (`withImage`) for every schedule and recording row a route
sends, so `image_url` is never sent; `GET /active` gains `image`. The golden test asserts the source's address appears
in no answer; both fail on the build before.

**Codex adversarial review, round 1:** one *high*, fixed in 0431: schedule, duplicate and cancel answers still sent
`image_url`. **Round 2:** approve, no findings. Also found while building the goldens: #209 (unknown channel answers 500).

`npm test`: all pass but the 4 HE-AAC tests (this box's ffmpeg). The Apple side decodes `test/golden/` next.
