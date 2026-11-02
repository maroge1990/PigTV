# Apple shell batch (Apple 102–105): tab bar and Sport front page, before and after

Simulator screenshots (T3) of the offline Sport front fixture (`PIGTV_UI_TEST_SCREEN=front`,
`PigTVTests/Fixtures/sport-front-0381.json`), dark and light, resized to at most 1600 px.

- `before-*`: Apple 101 (3f6657f): tabs Sport · TV · TV Guide · Recordings · Settings.
- `after-*`: Apple 105 (42856e1): Sport · TV Guide · Recordings · Settings (#216, D-44); the system tab bar on
  every platform (tvOS top bar, iPad top bar, iPhone Liquid Glass bottom bar).
- Devices: Apple TV 4K (3rd generation), iPad Pro 13-inch (M5), iPhone 17; tvOS/iOS 27.0 simulators.

Tests: `Tools/test.sh push` passed on 105 (contract checks, unit tests, regression UI tests); the iOS build passed.
