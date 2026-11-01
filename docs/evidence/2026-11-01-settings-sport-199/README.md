# 0418–0419: web Settings › Sports › "Your sport" (#199, D-41)

Server and web, 1 Nov 2026. Base `0f1ad18`.

**0418:** `GET /api/sports/names?league=` (what can be followed in a league). **0419:** `SportSettings.js`, the panel.

**Tests (T1):** `test/sport-page-prefs.test.js` › #199 (names), `test/web-sport-settings.test.js` (the model; the panel
through a fake API: headings, suggestions, Record every game "set by", escaping; saving the whole list; unfollowing a team
with a rule asks, OK keeps it and Cancel deletes it). Each fails on the build before it.

**T3:** this tree on `localhost:3000` (a fresh data folder, no provider), real ESPN rosters and Arsenal's schedule:

- `desktop-suggestion.jpg`: Football (EPL, Arsenal) and Tennis (ATP Tour); "Champions League has Arsenal games too
  (the first Thu 5 Nov)" from ESPN's club schedule.
- `desktop-added-recording.jpg`: after "Add Champions League" (the suggestion gone) and "Record every game" on Arsenal.
- `phone-390.png`: the panel at 390 px wide: no sideways scroll (page width 386 = viewport).

Not exercised in the browser: the confirm dialogs (removing a league or sport, unfollowing with a rule), which the unit
tests cover; the rig (its staging is on a LAN address, so no login was typed there).
