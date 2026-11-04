# Apple layout fixes (Batches 3–4, Apple 144–149)

From Mark's test of Apple 143 (4 Nov). PigTV-Swift 7bfa333..1279cd8. Held off main while Codex was out of usage
(Mark: commit, hold the push); one Codex round on 4 Nov approved all six with no findings, then pushed.

| Build | Issue | Change | Proof (fails on the build before) |
|---|---|---|---|
| 144 | #212 | A cricket league page shows only that league (no "Your other cricket today") | CricketLeagueTests (unit) |
| 145 | #225 | iPhone card: Remind me/Watch and **Record**, same size; Record opens the record page | UI on iPhone 17 (`225-…`) |
| 146 | #228 | iPad standings: values 28 pt, table 460 pt, scores fixed-size | SportFixtureTests; UI on iPad Pro 11" landscape |
| 147 | #226 | One header everywhere: Sport's 34×28 pig, 22 pt semibold title | UI: Sport title 40.7 pt at x 60 vs Guide 24 pt at x 88 before; equal after (`226-…`) |
| 148 | #227 | iPad Settings: no page title beside the menu; first rows level | UI: 224.5 vs 160 pt before; 160/160 after (`227-…`) |
| 149 | #229 | iPhone Recordings: cards at one 16 pt edge; placeholder while loading, fade-in | UI on iPhone 17 (`229-…`) |

Gates: `Tools/test.sh fast` and the iOS build passed after each; `push` passed for 144–146 and again for 144–149
together before the push. Not checked on a simulator: Recordings' empty state and loading placeholder (the fixture always has
recordings); the iPad standings screenshot is clipped by the simulator in landscape (the test's frame checks passed).
T5 (Mark, on TestFlight once released): each issue's own steps in its comment.
