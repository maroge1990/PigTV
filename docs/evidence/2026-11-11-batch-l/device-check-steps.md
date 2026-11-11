# Device check for Mark (T5), on a TestFlight build from 208 (Apple 204 to 208, issue #280)

Order: Apple TV, then iPad, then iPhone. Each step is one screen. "Pulse" means the grey shapes fade slightly in and out.

## Apple TV

1. **Cold start, Sport.** Quit PigTV, open it. Sport should show grey page-shaped blocks that pulse gently, then fill with your games. Nothing should jump or move once the games appear.
2. **Cold start, TV Guide and Recordings.** Go to each tab. Each should show its own grey shapes first (a grid for the Guide, cards for Recordings), then fill. Moving along the tab bar should never be interrupted by anything taking over the highlight.
3. **Server off.** Switch your server off (or unplug its network), then open Sport. You should see the pig inside a ring that counts down ("Trying again in N seconds"), what still works, and a "Try again" button. Press Down to reach it; it should not grab focus while you are on the tab bar. Switch the server on and press "Try again": the page should fill.
4. **Out-of-date notice.** With games already showing, switch the server off and wait a minute. The games should stay, with a thin notice at the top saying "Couldn't update. Showing what you had at ..." and "Try again". The list should not flicker or jump each minute. Do the same on Recordings.
5. **Nothing to show.** If you can: open Recordings with none, or Sport with nothing followed. You should see the small pig, a title, one sentence and one button ("Open the TV Guide" or "Choose your sport"), centred. The button should work.
6. **A league that isn't available.** Open a league page (for example AFL) while the server's sports feed is down. It should say "AFL isn't available right now" with "Try again", never a spinner for ever. Moving to it should not drag you off the list you were on.
7. **Launch.** Sign out from Settings. Quit and reopen: you should go straight to sign-in with no pig splash. Sign in, quit and reopen: the splash should show only briefly, until you are signed in.
8. **Settings › Sport.** Check it reads "Hide scores" (not "spoiler") and, when on, the Sport page shows "Scores hidden". Open "Your sport" and Score delay; Score delay opens its own page with a real -10 and +10 you can land on.

## iPad

9. **Cold start and states.** Open Sport, TV Guide and Recordings from a cold start: grey shapes pulse, then fill, nothing jumps. In portrait the shapes fit the screen and the header is whole (they ran off the edges before build 208).
10. **Wi-Fi off.** Turn Wi-Fi off and open Recordings: the pig in the ring and "Try again". With recordings already shown, turn Wi-Fi off and wait a minute: the list stays under the notice. Turn Wi-Fi on and press "Try again".
11. **Wrong password.** Sign out, then sign in with a wrong password. A note should appear on the form ("That username or password wasn't accepted"), with no pop-up, and what you typed should still be there.

## iPhone

12. **Cold start and states.** Open Sport, TV Guide and Recordings from cold: shapes pulse, then fill, with no jumping. Then turn Wi-Fi and mobile data off and open each: the pig in the ring and "Try again". Turn them on and press it.
13. **Wrong password and launch.** Sign out and sign in with a wrong password: the note on the form, no pop-up, typed text kept. Quit and reopen signed out (no splash) and signed in (a brief splash).
14. **The follow card.** On Sport, look at a game with long team names on both sides (for example Chicago Bulls v San Antonio Spurs). "Remind me" and "Record" should sit fully inside the card.
15. **Large text.** Settings (iPhone) > Display & Brightness > Text Size, or Accessibility > Larger Text, set to the largest. The card should grow and its buttons stack one above the other. The "Sport" header and section titles will still break ("S... We..."); that is known, not new.
16. **Increase Contrast.** Settings > Accessibility > Display & Text Size > Increase Contrast on. Open Recordings and Settings › Sport: borders and grey text should be clearly stronger. Turn it off again afterwards.
17. **Haptics.** Record a programme, follow a team, then delete a recording: each should give a small tap.
18. **Settings and the guide marks.** Settings › Sport: Hide scores and Your sport at the top, Score delay as a row that opens its own page. In the TV Guide, a channel with a problem shows a warning triangle and a recording shows a record dot, each with words.

Please tell me any step that looked or behaved differently from what is written, with the step number.
