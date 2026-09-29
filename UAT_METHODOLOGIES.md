# Methodology UAT — the seven new methodologies and the weight control

> **This script runs against the DEVELOPMENT database only.**
>
> `UAT_TEST_SCRIPT.md` is the script for the live site and is **unchanged**.
> If you are testing https://wireframeswottows.vercel.app, you are on that
> script, not this one. Nothing here has been deployed.

The platform's central claim is that a new methodology needs **configuration
only** — no new Go handlers, no new SQL, no new React components. Seven
methodologies were configured to test that claim, and this script is how a
person confirms it on screen rather than through an API.

Each case cites what it is testing. A failure in the **GEN-\*** cases is
**Critical**: it means a methodology has been baked into the engine.

---

## How to run

Two terminals. **Pause Dropbox first** — it corrupts `node_modules/.vite` and
the app then renders with nothing interactive. That is an environment fault,
not a defect.

**Both terminals must be in `wireframeswottows/`**, not the folder above it.
That is where `go.mod` and `.env.dev` live; running from the parent gives
`go: go.mod file not found in current directory or any parent directory`.

```bash
# terminal 1 — the API, against the development database
cd "<repo>/20260825 session on claude for UI/wireframeswottows"
go run ./cmd/devserver -env .env.dev -port 3001

# terminal 2 — the UI, loading .env.dev for its own variables
cd "<repo>/20260825 session on claude for UI/wireframeswottows"
npx vite dev --mode dev
```

Open the URL Vite prints (usually http://localhost:3000).

**Why not `vercel dev`?** It reads `.env`, which points at production. Running
the API separately means the two environments stay addressable at once and
nobody has to swap `.env` back and forth — the kind of thing that works until
the day it is left swapped. `VITE_API_BASE` in `.env.dev` points the UI at port
3001.

### Confirm you are on the right database before you start

| ID | Steps | Expected result |
| --- | --- | --- |
| ENV-10 | Open `http://localhost:3001/api/v1/health` | `{"success":true,...}` |
| ENV-11 | Sign in, open devtools → Network, load any page | Requests go to **localhost:3001**, not to `vercel.app` |
| ENV-12 | Check the terminal running devserver | It names the **gjeatgmgjkhxfrfonkit** project, not `azbqapefetexjqefcdep` |

If ENV-12 shows the production project, **stop** and tell the developer.

### Test accounts

Same seven accounts and the same password as the live script,
**`SwotDemo2026!`** — they were recreated on the dev database.

| Role | Account |
| --- | --- |
| Facilitator (**F**) | jane.smith@example.com |
| Analyst (**A**) | sarah.chen@example.com |
| Participant (**P**) | dana.whitfield@example.com |
| Executive viewer (**E**) | ingrid.holm@example.com |

### Activating a methodology

All eight are currently **active on the development database**, so they appear
in the workshop picker with no further steps. If you need to hide one while
testing something else, or a colleague has switched one off:

```sql
update public.methodologies set is_active = true  where key = 'risk-iso31000';
-- ... test ...
update public.methodologies set is_active = false where key = 'risk-iso31000';
```

Keys: `pestle`, `five-forces`, `capability`, `operating-model`,
`risk-iso31000`, `business-model`, `transformation`.

The test suites record which methodologies are active before they run and put
that back afterwards, so running them will not switch anything off under you.

---

# Part A — The weight control

A **weight** is a number attached to something on a scale the methodology
defines. Voting turned out to be one instance of it — a budget spread across
factors — and a maturity or likelihood rating is another. Both now run through
the same control.

> **The scale is configuration.** Nothing on screen may assume 1–5. If a
> control shows five buttons for a scale configured 1–4, that is a defect.

## A.1 Voting still behaves exactly as it did

Run these on **SWOT-TOWS**, which is active by default. They are the
prioritization cases from the live script, repeated here because voting was
rewritten underneath and must be indistinguishable.

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| WGT-01 | P | Open a SWOT-TOWS workshop → Prioritization | A budget panel reading **20** votes, and +/− steppers per factor |
| WGT-02 | P | Click **+** three times on one factor | Your allocation reads 3; remaining reads 17 |
| WGT-03 | P | Reload | Unchanged — it persisted |
| WGT-04 | P | Click **−** back to zero | Allocation clears; remaining returns to 20 |
| WGT-05 | P | Spend all 20, then try one more | Every **+** disabled at zero remaining |
| WGT-06 | P | Double-click **+** rapidly | Lands on one correct value, never double-spent |
| WGT-07 | E | Open Prioritization as an executive viewer | Controls disabled; a notice says the role is view-only |
| WGT-08 | F | Open the **Participants** panel | "Votes used" shows votes **spent**, not the number of factors voted on — a participant who spent all 20 across 3 factors reads 20/20, not 3/20 |

> WGT-08 is a deliberate correction. The old view counted rows while the label
> said votes.

## A.2 Rating scales

Run these on **Risk**, which has four weights on two different scales.

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| WGT-10 | F | Activate `risk-iso31000`, create a workshop, capture a risk, open **Risk Analysis** | Four labelled rating rows: Likelihood and Consequence, inherent and residual |
| WGT-11 | F | Read one row | **Five** steps numbered 1–5 — no +/− stepper, because this is not a budget |
| WGT-12 | F | Click step 4 on Likelihood (inherent) | It selects, and the ordinal name **Likely** appears under it |
| WGT-13 | F | Click the selected step again | It clears — the only way to unset a scale with no natural zero |
| WGT-14 | F | Reload | Selections persist |
| WGT-15 | **P** | Sign in as a participant and open the same stage | Ratings are **read-only**. A risk rating is an assessment, not a poll |
| WGT-16 | F | Open **Transformation** → Value and Effort → the **Wave** row | **Four** steps, not five. The scale is 1–4 because that methodology says so |

> WGT-16 is the single most important case in Part A. Five steps here would
> mean the control has a constant in it.

---

# Part B — The seven methodologies

Each methodology gets the same shape of test. Activate it, create a workshop,
walk its own chain, read its own report.

## B.1 PESTLE — `pestle`

Six external lenses, rated for impact and likelihood, distilled into drivers.

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| PST-01 | F | Create a PESTLE workshop and read the stage list | Political, Economic, Social, Technological, Legal, Environmental, then Prioritization, Driver Analysis, Implications, Driver Report |
| PST-02 | F | Look for a TOWS matrix or a Recommendations stage | **Neither exists.** PESTLE ends at implications, by design |
| PST-03 | F | Open Prioritization | A 6-vote budget, **plus** Impact and Likelihood rating rows |
| PST-04 | F | Open the Driver Report | A six-lens overview, then a **Rated Scan** table with Impact and Likelihood columns, sorted by impact |
| GEN-50 | F | Search the whole workshop for SWOT vocabulary | No "SWOT", "TOWS", "strength" or "weakness" anywhere |

## B.2 Porter's Five Forces — `five-forces`

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| P5F-01 | F | Create a workshop and read the stage list | Five capture stages named for the forces, then Force Assessment, Industry Attractiveness, Positioning Moves, Industry Report |
| P5F-02 | F | Look for a Prioritization stage | **There is none.** Five Forces does not vote |
| P5F-03 | F | Capture under *Buyer Power* | Guidance names concentration, switching costs, price sensitivity — determinants, not the force itself |
| P5F-04 | F | Open **Force Assessment**, create an assessment citing two determinants | It saves, and carries a **Force intensity** rating — on the assessment, not on a determinant |
| P5F-05 | F | Rate it | Five steps, Very weak … Very strong |
| P5F-06 | F | Open the Industry Report | "The Five Forces, Rated" as a table ordered by intensity, then determinants grouped by force |
| GEN-51 | F | Search for vocabulary from other methodologies | None — no "maturity", "canvas", "wave", "residual" |

## B.3 Capability Assessment — `capability`

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| CAP-20 | F | Create a workshop and open **Maturity Rating** | **Two** rating rows per capability: Current and Target |
| CAP-21 | F | Read the step names | The CMMI ladder: Initial, Managed, Defined, Quantitatively managed, Optimizing |
| CAP-22 | F | Rate a capability current 2, target 4 | Both persist and display side by side |
| CAP-23 | F | Open the Capability Report | A maturity table with both columns, so the gap is readable at a glance |
| CAP-24 | F | Look for a stored "gap" figure | **There is none, by design.** Gap is current minus target; storing it would be a second source of truth |

## B.4 Operating Model — `operating-model`

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| OPM-01 | F | Create a workshop and read the stage list | Processes, Organisation, Locations, Information, Suppliers, Management System — Ashridge's POLISM |
| OPM-02 | F | Open **Pain Severity** | One rating row: Irritant … Critical |
| OPM-03 | F | Open the Operating Model Report | It **opens with a Value Proposition narrative** you write yourself, before the six elements |
| OPM-04 | F | Check "Where It Hurts" | A table ordered by severity, worst first |

## B.5 Risk (ISO 31000) — `risk-iso31000`

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| RSK-01 | F | Create a workshop and read the categories | Strategic, Operational, Financial, Compliance and Legal, Technology and Cyber, People |
| RSK-02 | F | Rate a risk inherent **and** residual | Four values stored independently |
| RSK-03 | F | Open the Risk Report | **Two** register tables — Inherent and Residual — so the treatment's effect is visible |
| RSK-04 | F | Look for a 5×5 heat map | **There is none. Known gap, not a defect.** The decision was to compose the existing renderers rather than add one; the register carries the same information sorted |
| RSK-05 | F | Read a likelihood label | ISO's own words: Rare, Unlikely, Possible, Likely, Almost certain |

## B.6 Business Model Canvas — `business-model`

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| BMC-01 | F | Create a workshop and count the capture stages | **Nine**, one per canvas block |
| BMC-02 | F | Look at the block colours | Nine distinct colours, none repeated. (The neutral palette was extended from six to twelve for this) |
| BMC-03 | F | Open **Fit Tests** | **Two** cells — Proposition Fit and Economic Fit — not four |
| BMC-04 | F | Open Proposition Fit and read the pickers | Source offers **only Value Propositions**; target offers **only Customer Segments** |
| BMC-05 | F | Open Economic Fit | Source offers **only Revenue Streams**; target **only Cost Structure** — different categories, same renderer as the TOWS matrix |
| BMC-06 | F | Look for any rating control | **There is none.** The canvas is a structural assessment, not a rated one |
| GEN-52 | F | Search for "TOWS" or "strength" | None, including in the fit matrix |

## B.7 Transformation Planning — `transformation`

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| TRF-01 | F | Create a workshop and open **Value and Effort** | Three rating rows: Value (1–5), Effort (1–5), **Wave (1–4)** |
| TRF-02 | F | Open **Dependencies** and pick any two initiatives | Both dropdowns offer **every** initiative regardless of workstream — a dependency is any-to-any |
| TRF-03 | F | Create a dependency | It saves as `source → target` |
| TRF-04 | F | Open the Roadmap Report → **Roadmap by Wave** | Initiatives **grouped into waves**, each group named for its wave, highest value first inside each |
| TRF-05 | F | Leave one initiative unrated for wave | It appears under **"Not yet rated"** rather than disappearing |

---

# Part C — Cross-cutting

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| GEN-60 | F | With two methodologies active, open the wizard | Both appear, with their own category and stage counts |
| GEN-61 | F | Create one workshop of each and switch between them | Each shows only its own stages, categories and weights |
| GEN-62 | F | In any methodology with no recommend stage, try to reach Recommendations | The stage does not exist, and forcing it via the API is refused: "This workshop's methodology has no recommend stage" |
| GEN-63 | F | Publish a report in each methodology and export the HTML | Every one names its own sections and no other methodology's |
| GEN-64 | F | Open the AI panel on a capture stage in any methodology | It offers the capture actions. A methodology with no relate stage offers **no** relationship action |
| GEN-65 | F | Ask the developer to confirm what was written for these seven | **Seven SQL files of configuration. No Go, no React, no schema.** If anything else was needed, that is the defect |

> GEN-65 is the whole point of this script.

---

# Part D — Defects reported against production

Eight defects were reported on the live build and fixed here. The API-level
ones are covered by `tests/suites/defects.js`; these are the four that only a
person clicking can confirm, plus the AI one, which needs a real API key.

## D.1 The participants roster

> **What was wrong.** The panel called a leftover helper that fetched *the
> first workshop row in the table*, whichever that happened to be. So a new
> workshop showed the demo workshop's roster — people who are not members and
> have no access. The unseen half was worse: changing a role, marking someone
> joined, or removing them all wrote to that other workshop.

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| DEF-01 | F | Create a brand-new workshop and open its overview | The Participants panel lists **only you**, as facilitator — not the demo workshop's seven people |
| DEF-02 | F | Open the demo workshop's overview in another tab | It still lists its own seven. The two rosters are independent |
| DEF-03 | F | In the **new** workshop, invite someone, change their role, then remove them | Every change lands in the new workshop. Re-open the demo workshop and confirm **its** roster is untouched |

## D.2 The status dot did not mean "online"

> **What was wrong.** Each person carried a green dot labelled "active". There
> is no presence in this product — no realtime at all — and "active" came from
> `joined_at`. It read as "online now".

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| DEF-04 | F | Read the Participants panel headings and each person's status | It says **joined** / **invited**. Nothing anywhere claims a person is online or currently present |

## D.3 The HTML export

> **What was wrong.** The button was a plain link. The endpoint requires an
> `Authorization: Bearer` header, which a browser navigation does not send, so
> the server answered 401 and Chrome reported "Failed — Needs authorisation".

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| DEF-05 | F | Open a report → **HTML** | A `.html` file downloads. No "Needs authorisation" error |
| DEF-05a | F | Open the downloaded file with the network disconnected | It renders fully — self-contained, no external requests |

## D.4 Getting back to the report types

> **What was wrong.** The type chooser rendered only when a workshop had *no*
> reports. After creating the Executive Summary there was no way back to it, so
> a second report of a different type could never be created.

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| DEF-06 | F | Create one report, then look at the report header | A **New report** button sits beside the report selector |
| DEF-06a | F | Click it | The full list of report types appears, each with its own requirements, without leaving the report you were on |
| DEF-06b | F | Create a second report of a different type | Both exist; the selector switches between them and the first is unchanged |

## D.5 The AI assistant worked only sometimes

> **What was wrong.** Two things. A single suggestion that referenced a
> mangled id caused the **whole** output to be discarded, so six good
> suggestions vanished with one bad one — and whether that happened depended on
> the model, which is why it looked intermittent. Separately, the code that
> picked the suggestions out of the response iterated a Go map, whose order is
> randomised, so the server could index a different list than the screen showed.
>
> **The AI assistant is now configured on dev**, running `claude-haiku-4-5` —
> the cheapest and fastest model, about half a cent per call. These cases make
> real, paid requests, so run them deliberately rather than by habit.

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| DEF-07 | F | Run **Generate Themes** on Theme Analysis, several times | Suggestions appear each time. If some were dropped as unusable, the rest still arrive |
| DEF-07a | F | Run **Generate TOWS Relationships** on the TOWS Matrix | Same — suggestions arrive rather than a blanket "AI could not complete this request" |
| DEF-07b | F | Accept the **third** suggestion in a list | The object created is the one you clicked, not a different one |
| DEF-07c | F | Ask the developer to check `ai_sessions` after a run | A run with dropped suggestions records how many and why, rather than discarding them silently |
| DEF-07d | F | Open devtools → Network on `/api/v1/workshops/{id}/ai` | The response names the model in use (`claude-haiku-4-5`) — and carries **no** prompt text |

---

# Part E — The capture board

The four Discovery stages now show the whole wall at once: every factor category as a panel
of sticky notes, filling in live as people contribute.

> **The grid is not a SWOT quadrant.** It is laid out from the number of categories the
> methodology declares — four give the 2×2, PESTLE's six give 3×2, the Business Model
> Canvas's nine give 3×3 — from one component that names no methodology. Only SWOT-TOWS has
> the board switched on; the rest keep the single-category view until someone decides
> otherwise.

## E.1 The board itself

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| BRD-01 | F | Open a SWOT-TOWS workshop → Strength Discovery | **Four panels in a 2×2**, one per category, each in its own colour |
| BRD-02 | F | Look at the Strength panel | It is the **focused** one — coloured top edge, "this stage" label, and its guidance text. The others show notes only |
| BRD-03 | F | Move to Weakness Discovery | The same board; the focus moves to Weakness. The wall does not reload or change shape |
| BRD-04 | F | Count notes against the Review board | The same factors, same counts. The board is a view of the data, not a second store |
| BRD-05 | F | Enable PESTLE and open one of its capture stages | Single-column capture, **not** a board — it has not opted in. Confirms the layout is config |

## E.2 Sticky notes

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| BRD-10 | P | Click the "Add a note…" box in the focused panel, type, press Enter | The note posts immediately and the box clears, ready for the next. No dialog |
| BRD-11 | P | Read your note | It carries the panel's colour and **your initials** bottom-right |
| BRD-12 | P | Add a note, then look at its state | It shows **in review** — the governance lifecycle is visible on the wall, not hidden |
| BRD-13 | P | Click a note you can edit, change the text, press Enter | It saves in place. Escape cancels |
| BRD-14 | F | Approve a note in Review mode, return to the board | The approved note no longer shows a state pill and can no longer be edited |

## E.3 Moving a note

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| BRD-20 | F | Drag a note from Strength onto Opportunity | It moves. The target panel highlights while dragging |
| BRD-21 | F | Check the Review board | The note is now in Opportunity there too |
| BRD-22 | F | Try to drag an **approved** note | Refused: "A reviewed note cannot be moved. Reject it instead…" |
| BRD-23 | F | Use the **"Move a note to…"** picker at the foot of a panel | Same result without a mouse — dragging must not be the only way |

## E.4 Live collaboration

> Two browsers, two different accounts, the same workshop and stage. A second browser
> profile or a private window is enough.

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| BRD-30 | F+P | Open the board in both | Both show **Live — notes appear as people add them**, and "In the room" lists both people's initials |
| BRD-31 | P | Add a note in one browser | It appears in the other **without a refresh**, within about a second |
| BRD-32 | F | Drag a note to another panel in one browser | It moves in the other too |
| BRD-33 | F | Close one browser | That person drops out of "In the room" in the other |
| BRD-34 | F | Ask the developer to block the websocket, then reload | It says **"Live updates unavailable — refreshing every few seconds instead"** and still works. It must never claim to be live when it is not |

## E.5 Who may write where

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| BRD-40 | F | Look at all four panels as a facilitator | Every panel has an add box, and the header says "You can add to any panel" |
| BRD-41 | P | Look at the same board as a participant | Only the **focused** panel has an add box |
| BRD-42 | E | Open the board as an executive viewer | No add boxes anywhere, and notes cannot be dragged |

> BRD-41 is an **affordance, not a boundary**. The create endpoint has never been scoped to a
> stage, so a participant posting to another category through the API is allowed today and
> stays allowed. Do not raise that as a defect against this release.

## E.6 Access, which Realtime now depends on

> **The one case worth testing carefully.** Live updates are authorised by Postgres RLS
> alone, not by the Go API — the only place in the product where that is true.

| ID | Role | Steps | Expected result |
| --- | --- | --- | --- |
| BRD-50 | F | Have the developer remove your **workspace** membership while leaving workshop membership, then watch the board | Live updates stop and the workshop becomes inaccessible. If notes keep arriving, that is **Critical** |
| BRD-51 | F | Restore membership | The board works again |

---

## Known gaps, stated up front

Do not raise defects against these — they were decided, not overlooked.

- **No risk heat map, no capability gap-bar chart, no roadmap Gantt.** The
  decision was to compose the eight existing report renderers rather than add
  new ones. The same information is present as sorted tables and grouped lists.
- **Gap is not stored** for Capability; it is current minus target, read off
  two adjacent columns.
- **The AI assistant runs `claude-haiku-4-5` on dev**, chosen for being the
  cheapest and fastest model rather than the most capable. Judge the governance
  — that nothing is added without you accepting it, and that suggestions arrive
  at all — not the literary quality of the suggestions. The model is
  `ANTHROPIC_MODEL` in `.env.dev` and can be raised to `claude-sonnet-5` or
  `claude-opus-5` if you want to compare.
- Everything already listed as out of scope in `UAT_TEST_SCRIPT.md`.

## Defect template

Use the template and severity guide at the end of `UAT_TEST_SCRIPT.md`, and add
one line:

```
Methodology:   (which one was active, e.g. risk-iso31000)
Environment:   dev database (gjeatgmgjkhxfrfonkit)
```

**Severity:** any **GEN-\*** failure is **Critical** — it means a methodology
has been hardcoded into the platform, which is the one thing this architecture
exists to prevent.
