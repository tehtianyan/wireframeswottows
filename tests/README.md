# API test suites

Integration tests for the Go API. They run against a **real server and a real
database**, signing in as the seeded demo accounts.

There is deliberately no mocking. The things most worth testing here — row-level
security, role enforcement, database CHECK constraints and triggers, and the
claim that a new methodology needs no code — only exist when the real database
is involved. A mocked version of these tests would pass while the product was
broken.

## Running them

```bash
# Start the full stack first (Go API + frontend). Plain `npm run dev`
# serves only the frontend and every /api/v1 call 404s.
npx vercel@59.5.0 dev

# Then, in another terminal:
node tests/run-all.js                         # local
node tests/run-all.js https://your-deployment # a deployment
node tests/run-all.js --with-ai               # include the AI suite

# Or one suite at a time:
node tests/suites/objects.js
node tests/suites/scoping.js https://your-deployment
```

**Pause Dropbox syncing before starting a dev server.** It corrupts
`node_modules/.vite` and the app then renders without any interactivity. This is
an environment fault, not a defect — see `CLAUDE.md`.

## Configuration

Everything is read from `wireframeswottows/.env`; no secrets are committed here.
Required: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`.

The demo accounts all use the password in `lib/harness.js`, which is the same
one documented in `UAT_TEST_SCRIPT.md`.

## The suites

| Suite | What it protects |
| --- | --- |
| `objects` | The analysis chain, the governance lifecycle shared by every object kind, and two rules that are easy to regress: TOWS pairing comes from methodology config, and citations cannot cross a workshop boundary. |
| `reporting` | Publishing freezes a report, so an exported PDF stays reproducible when the insights beneath it change. Also the workshop completion gate, which silently stopped enforcing anything for three phases. |
| `knowledge` | Knowledge promotion is deliberate and analyst-only, notifications reach the author and nobody else, and administration is gated on `global_role`. |
| `scoping` | **The security one.** Proves empirically that removing a user's workspace membership drops their search results to zero — scoping is in the query, not a filter applied afterwards. |
| `genericity` | **The architecture one.** Activates the inactive PESTLE stub and drives it through capture, synthesis, interpretation and reporting, asserting no SWOT vocabulary leaks. Has caught nine real leaks. |
| `ai` | AI never approves, accepted suggestions land in `submitted`, and rate limits are checked *before* any provider call. Opt-in: real calls cost money. |

## Writing a new suite

Use `lib/harness.js`. It provides authenticated API clients per demo role, a
database connection, assertion helpers, and cleanup that knows how to get past
the published-report immutability trigger.

```js
const { runSuite, clients, cleanup } = require("../lib/harness");

runSuite("my-suite", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F } = await clients(baseUrl, ["facilitator"]);
  try {
    r.section("what I am checking");
    const res = await F("GET", `/workshops/${WS}/factors`);
    r.ok(res.success, "factors load", res.data?.length);
  } finally {
    await cleanup(c, { titlePrefixes: ["MYTEST"] });
  }
});
```

Two conventions worth keeping:

- **Always clean up in a `finally`.** Suites share one database; a suite that
  dies mid-run and leaves approved fixtures behind will make the *next* run
  fail confusingly. That has happened.
- **Verify by round trip, not just by write.** A create-only test once let a
  broken `GET /recommendations` reach production. If you add a create, add the
  matching list.
