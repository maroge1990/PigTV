# Recording clashes on the web Recordings page (0324, #12), 30 Oct 2026

T3: server 0324 from the working tree on the Mac (`localhost:3000`, fresh data folder), the fake provider profile a
(`scripts/fake-provider.js`) as its only source, default settings (one recording at a time, one provider connection).
Two schedules made through `POST /api/recordings/schedule` for the same hour on two channels: the first answered with no
`conflictsWith`, the second with `conflictsWith: [1]`.

`web-recordings-clash.jpg`: the Recordings page in the desktop app's browser pane. Each schedule says which one it
clashes with and that one will wait or be missed. No real provider, device or production server was involved.
