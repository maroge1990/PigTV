# Apple settings and start-up, D-44 batch 6 (Apple 129–133)

Simulator screenshots (T3) of the offline fixtures, dark, JPEG at most 1400 px. Apple TV 4K (3rd generation),
iPad Pro 13-inch (M5), iPhone 17; tvOS/iOS 27.0. Boards: R5-Settings, R5-SetSport, R5-Account, R5-SignIn, R5-Offline.

- `before/`: Apple 127 (f003313). `after/`: Apple 133 (the batch's last commit).
- `*-settings` (`settings-sport`): before, one long list; after, the menu beside its page (TV: side by side; iPad: the
  split view; iPhone: the menu, each row pushing its page, versions underneath). Diagnostics is on the TV only.
- `*-settings-sport` (`PIGTV_UI_TEST_SETTINGS_PAGE=sport`): Hide scores and Score delay side by side, then your sports
  in order with their followed names (monogram discs: the fixture has no Sport front page loaded), the suggestion and
  Add a sport. Before shows the old Settings at the top of the tab.
- `after/*-account-signout` (`account`, `PIGTV_UI_TEST_SIGNOUT_CONFIRM=1`): Sign out confirming inside its row, Stay
  signed in focused (before: a system confirmation dialog, not captured by the launch-only script).
- `*-onboarding`: before, one form; after, Sign in's step 2: the server chip with Change and the two tiles.
  `after/*-signin-server` (`signin-server`): step 1, the server's address with Continue. `*-pairing`: the code card.
- `*-unreachable`: the pig inside the 20 s retry ring, Try now and Use a different server.

Checks (T1–T3, all on the Mac's simulators):

- `sh Tools/test.sh push` passed at Apple 133 (before the fixture-only screenshot switches were folded in); `visual`
  passed on tvOS at 133 with the review media, including BrandDepthUITests' sign-out step and player test, PigTVUITests
  and the launch tests. iOS (and tvOS) build passed at every commit.
- Failing before: SettingsUITests on 128 (no menu), its sign-out test on 129 (a dialog), its Sport page test on 130 (no
  Score delay), SignInUITests on 131, OfflineUITests on 132.
- Choices: on tvOS 27, `NavigationSplitView` inside the tab bar drew only its sidebar, so the TV lays out the two
  columns itself. Score delay appears only where the server has the `sportsDashboard` flag (C-O). Use a different
  server opens the same sign-out confirmation, then Sign in at the server. "Try now" as the board says.
- Not checked: device (T5): the TV's focus moving between the menu and the page; Sign in's Continue against a real
  server; pairing end to end.
