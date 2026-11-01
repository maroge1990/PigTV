# Golden API answers (#52)

What the server's real handlers answer to the routes the Apple client calls, one JSON file per answer (the body only;
`routes.json` gives each file's method, route and status). `test/contract-golden.test.js` makes them: the real routers on
a sandboxed database, a real sync of the fake provider (`scripts/fake-provider.js`), ESPN through the sport pages'
fetcher seams with the stored samples in `test/fixtures/`. Nothing leaves the machine.

Normalised: times moved onto 1 Nov 2026 00:00 UTC (the sport pages keep their samples' own dates), session ids,
handles, tokens, logo keys and build fields replaced by `<placeholders>`, arrays cut to the elements that show every
key and type the whole array has. No provider URL, login or token appears (the test asserts it).

- `npm test` compares each fresh answer's **shape** to its file: keys and value types, recursively; an array by the
  merged shape of its elements; `null` fits the golden's type and `[]` any array, but a field the golden only has as
  `null` takes no other type (so the goldens send every field). A changed shape fails, naming the route and path.
- After an intended change: `GOLDEN_UPDATE=1 node --test test/contract-golden.test.js`, commit the files with the change,
  and write it into `docs/CLIENT-CONTRACT.md`.
- The Apple repo's contract checks (`PigTV-Swift` `Tools/test-contracts.sh`) decode these files from this folder, so a
  shape the client cannot decode fails there too. The resolve 200/409/provider-error files need ffmpeg to regenerate.
