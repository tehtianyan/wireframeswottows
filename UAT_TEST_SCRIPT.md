# SWOT-TOWS Intelligence Workspace — UAT Test Script

User-acceptance tests for the **live** application: React front end, Go API, Supabase
database. Every case here exercises real persistence — unlike `TEST_SCRIPT.md`, which
covers the earlier in-memory prototype screens and is still valid for those.

Each case cites the specification section it verifies, so a failure can be traced back
to a requirement rather than an opinion.

**Spec Ref key**
- `AS §x.y` — *SWOT-TOWS Application Specification.docx*
- `WF §x.y` — *SWOT-TOWS UX Wireframe Specification.docx*
- `CL` — *CLAUDE.md* architectural decision

Organised by build phase. Run a phase's suites once that phase lands; later phases are
listed with their cases withheld so the document stays a single source of truth.

**Phases 0-3 are testable now.** Phase 4 is not yet built.

---

## How to run

1. **Pause Dropbox syncing** before starting a dev server. Dropbox corrupts
   `node_modules/.vite` and the app then renders without any interactivity. This is an
   environment fault, not a defect — do not raise it as one. (`CL` → Environment gotchas)
2. Start the full stack: `npx vercel@59.5.0 dev` from `wireframeswottows/`.
   Plain `npm run dev` serves only the front end and every `/api/v1` call 404s.
3. Open http://localhost:3000 and sign in as the account named in the case's Role column.
4. Record PASS / FAIL per case using the defect template at the end.

### Test accounts

All demo accounts use password **`SwotDemo2026!`**.
All are members of workshop *Digital Transformation Strategy Workshop*
(`52efe15a-9f32-4a03-86c9-51bc5c929314`), referred to below as **WS-DT**.

| Role | Account | Use for |
| --- | --- | --- |
| Facilitator (**F**) | jane.smith@example.com | Full authority: create, review, vote |
| Analyst (**A**) | sarah.chen@example.com | Review authority, can vote |
| Analyst | alex.meyer@example.com | Second reviewer |
| Participant (**P**) | dana.whitfield@example.com | Capture + vote, no review authority |
| Participant | john.okafor@example.com | Second voter, for aggregate vote counts |
| Executive viewer (**E**) | ingrid.holm@example.com | Read-only; must see no edit controls |
| Executive viewer | ravi.menon@example.com | Second read-only account |

> Roles are **real server-side permissions**, not a UI switcher. To change role you sign
> out and sign in as a different account. Any case where a restricted role still succeeds
> is a **Critical** defect — Go is the trust boundary (`CL`, `AS §11.5`).

---

# Phase 0 — Generic engine foundation

## 0.1 Environment and API reachability

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| ENV-01 | F | Open `/api/v1/health` directly in the browser | JSON `{"success":true,...}`; **not** a 404 | `AS §11.6` |
| ENV-02 | F | Sign in, open devtools Network, load `/w` | `/api/v1/workshops` returns 200 with an `Authorization: Bearer` header sent | `AS §11.5` |
| ENV-03 | — | Open `/w` while signed out | Redirected to sign-in; no workshop data visible | `AS §11.5` |
| ENV-04 | F | Call `/api/v1/workshops` with devtools, deleting the Authorization header | `401` with `{"success":false,"error":{"code":"UNAUTHORIZED"}}` | `AS §11.7` |
| ENV-05 | F | Open devtools console on any screen | No red runtime errors | — |

## 0.2 Methodology loads as configuration

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| CFG-01 | F | Open WS-DT overview (`/w`, then the workshop) | Header names the methodology **SWOT-TOWS**; 10 stages listed in sequence | `CL`, `AS §2.9` |
| CFG-02 | F | Read the stage list order | Strength → Weakness → Opportunity → Threat → Prioritization → Theme Analysis → TOWS Matrix → Insight Generation → Recommendations → Reporting | `AS §4.7`–`§4.12` |
| CFG-03 | F | Inspect the `/api/v1/workshops/{id}` response in devtools | Contains `methodology.factor_categories`, `.stages`, `.relationship_types` | `CL` |
| CFG-04 | F | Search that same response for `ai_prompts` | **Absent.** AI prompt templates must never reach the browser | `AS §12`, `CL` |
| CFG-05 | F | Confirm `relationship_types` contains so / st / wo / wt | Four entries, each naming a source and target category | `AS §6.9` |

---

# Phase 1 — Capture, review, prioritization, workshop creation

## 1.1 Capture — all four Discovery stages

The four Discovery stages are **one component driven by configuration**, so these cases
run identically for each category. Run the whole suite for Strength, then repeat CAP-02
and CAP-03 for Weakness, Opportunity and Threat.

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| CAP-01 | F | Open WS-DT → stage 1 *Strength Discovery* | Category badge reads "Strength" in the category's own colour; guidance panel shows the Strength guidance text | `WF §2.8`, `§2.9` |
| CAP-02 | P | Type a title, click **Add** | Factor appears in the list immediately, badged **In review** | `WF §2.11`, `AS §6.6` |
| CAP-03 | P | Reload the page | The factor is still there — it persisted to the database, not local state | `AS §6.6` |
| CAP-04 | P | Type 121 characters into the title | Input stops at 120; counter reads 120/120 | `WF §2.11` |
| CAP-05 | P | Submit with an empty title | Rejected with "Title is required"; nothing is created | `WF §2.11` |
| CAP-06 | P | Add a factor with a description | Description renders under the title | `WF §2.13` |
| CAP-07 | P | Click the pencil on **your own** factor, change the title, Save | Title updates; change survives a reload | `WF §2.14` |
| CAP-08 | P | Click the trash on your own factor | Factor is removed and stays removed after reload | `WF §2.14` |
| CAP-09 | P | Sign in as john.okafor and try to edit dana.whitfield's factor | No edit/delete controls offered. If forced via the API: `403 FORBIDDEN` | `AS §3.17` |
| CAP-10 | F | Edit another participant's factor | Allowed — facilitators may edit any factor | `AS §3.17`, `WF §2.29` |
| CAP-11 | E | Open any Discovery stage | Capture form replaced by "view-only" notice; no add, edit or delete controls | `WF §2.35` |
| CAP-12 | F | Switch between the four Discovery stages using the stage navigation | Each shows only its own category's factors; counts differ per category | `AS §6.6` |
| CAP-13 | F | Open a stage URL with a nonsense stage key, e.g. `/w/{id}/stage/nonsense` | Graceful not-found, not a crash | — |

## 1.2 Review Board

Review Mode is reached from the **Review mode** button in any stage header — per the
wireframe spec it is a mode available on every workspace, not a separate stage.

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| REV-01 | F | From any stage, click **Review mode** | Review board opens showing factors from **all four** categories, each with its category badge | `WF §2.30`, `AS §6.7` |
| REV-02 | F | Read the filter row | Filters for Awaiting review / Approved / Rejected / All, each with a live count | `AS §6.7` |
| REV-03 | F | Click **Awaiting review** | Only factors in the submitted state are listed | `AS §4.11` |
| REV-04 | F | Approve a factor (tick icon) | Badge changes to **Approved**; it leaves the Awaiting-review filter; survives reload | `AS §4.11` |
| REV-05 | F | Click reject (cross) on a factor, leave the reason empty | **Reject** button stays disabled — a reason is mandatory | `AS §4.11` |
| REV-06 | F | Reject with a reason | Badge becomes **Rejected**; the reason is displayed on the card as a reviewer note | `AS §4.11` |
| REV-07 | A | Repeat REV-04 as an analyst | Allowed — analysts hold review authority | `AS §3.17` |
| REV-08 | P | Open Review mode as a participant | Board is readable; a notice states approve/reject is facilitator/analyst only; no tick or cross icons | `WF §2.35` |
| REV-09 | P | Force a review call via the API as a participant | `403 FORBIDDEN`; factor state unchanged | `AS §11.5` |
| REV-10 | F | Try to edit a factor you already approved | No edit control; via API `409 INVALID_STATE_TRANSITION` | `AS §8` |
| REV-11 | F | Try to delete an approved factor | Refused — "reject it instead so the decision stays on the record" | `AS §8` |
| REV-12 | F | Approve a factor, then check it names a reviewer | Approval is attributed to the approving account, never to AI | `AS §12.19` |

## 1.3 Prioritization

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| PRI-01 | P | Open WS-DT → stage 5 *Prioritization* | One column per factor category — **four** for SWOT-TOWS — each listing its factors | `WF §3.13`, `AS §6.8` |
| PRI-02 | P | Read the vote budget panel | Shows **20** votes for SWOT-TOWS, with used/remaining and a progress bar | `WF §3.10`, `§3.6` |
| PRI-03 | P | Click **+** on a factor | Your allocation increments; remaining decrements; the factor's total vote count rises | `WF §3.15` |
| PRI-04 | P | Reload the page | Your allocation is unchanged — votes persisted | `WF §3.15` |
| PRI-05 | P | Click **−** back to zero | Allocation clears; remaining returns to 20 | `WF §3.15` |
| PRI-06 | P | Spend all 20 votes, then try to add one more | All **+** buttons disabled at zero remaining; forcing via API gives `400 VALIDATION_ERROR` | `WF §3.6` |
| PRI-07 | P | Put several votes on one factor | Permitted — the budget is per participant, not per factor | `WF §3.6` |
| PRI-08 | P+P | Vote as dana.whitfield, then sign in as john.okafor | Your own allocation starts at 0, but the factor's **total** includes both participants' votes | `WF §3.16` |
| PRI-09 | P | Observe factor ordering | Highest-voted factors sort first | `WF §3.19` |
| PRI-10 | E | Open Prioritization as an executive viewer | Rankings readable; vote controls disabled; notice explains the role is view-only | `WF §3.14`, `§2.35` |
| PRI-11 | F | Reject a factor in Review mode, return to Prioritization | The rejected factor is no longer votable | `AS §6.8` |
| PRI-12 | P | Double-click **+** rapidly | Allocation lands on a single correct value — vote writes are idempotent, never double-spent | `AS §11.6` |

## 1.4 Workshop Creation Wizard

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| WIZ-01 | F | Click **New workshop** from `/w` | Three-step wizard: Methodology → Details → Confirm | `AS §6.4` |
| WIZ-02 | F | Read step 1 | A methodology **picker**, not a fixed SWOT-TOWS form; each option shows its category and stage counts | `AS §6.4`, `CL` |
| WIZ-03 | F | Try **Next** without choosing a methodology | Disabled until a choice is made | `AS §6.4` |
| WIZ-04 | F | On step 2, leave the name blank | **Next** disabled | `AS §2.16` |
| WIZ-05 | F | Complete all steps and create | Lands on the new workshop's **stage 1**; a toast confirms creation | `AS §2.16` |
| WIZ-06 | F | Open the new workshop's overview | All 10 SWOT-TOWS stages present, status *not started*; you are listed as facilitator | `AS §2.16` |
| WIZ-07 | F | Check the new workshop's prioritization stage | Vote budget is 20, taken from methodology configuration | `CL` |
| WIZ-08 | P | Sign in as a participant and open `/w/new` | Either no eligible workspace is offered, or creation is refused — participants cannot create workshops | `AS §3.16` |
| WIZ-09 | F | Capture a factor in the **new** workshop | Appears only there; WS-DT's factors are unaffected | `AS §6.6` |

## 1.5 Genericity — the architecture's core claim

> **Why this suite exists.** The platform's central design decision is that a new
> methodology needs *configuration only* — no new Go handlers, no new SQL, no new React
> components (`CL` → Generic Methodology Engine). These cases test that claim directly.
> A failure here is **Critical**: it means the engine has a methodology baked into it.

PESTLE is seeded as a deliberately inactive proof methodology with **six** factor
categories and a **six**-vote budget, both different from SWOT-TOWS. To run this suite,
ask the developer to activate it:
`update public.methodologies set is_active = true where key = 'pestle';`
Deactivate it again afterwards.

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| GEN-01 | F | Open the creation wizard with PESTLE active | **PESTLE appears in the picker** alongside SWOT-TOWS, with no code deployment | `CL` |
| GEN-02 | F | Read PESTLE's summary in the picker | 6 factor categories, 7 stages | `CL` |
| GEN-03 | F | Create a PESTLE workshop | Succeeds through the same wizard | `CL` |
| GEN-04 | F | Open its overview | Stages read Political, Economic, Social, Technological, Legal, Environmental Discovery, then Prioritization | `CL` |
| GEN-05 | F | Open *Environmental Discovery* | Renders as a normal capture stage with PESTLE's own guidance text — a category SWOT has no concept of | `CL` |
| GEN-06 | F | Capture a factor there | Saves and persists exactly as a SWOT factor does | `CL` |
| GEN-07 | F | Open Review mode in the PESTLE workshop | Review board shows **six** category badges, not four | `CL` |
| GEN-08 | F | Approve a PESTLE factor | Same governance lifecycle applies | `CL` |
| GEN-09 | F | Open PESTLE's Prioritization stage | **Six** columns, and a budget of **6** votes — not 20 | `CL` |
| GEN-10 | F | Spend all 6 votes, try a 7th | Refused at 6 — the budget came from PESTLE's config, not a constant | `CL` |
| GEN-11 | F | Confirm no SWOT vocabulary leaks into the PESTLE workshop | No "Strength", "Weakness", "SWOT" or "TOWS" text anywhere in it | `CL` |
| GEN-12 | F | Reopen WS-DT | Unchanged and unaffected by PESTLE being active | `CL` |

## 1.6 Cross-cutting: authorization and audit

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| AUZ-01 | P | Take WS-DT's id, sign in as a user who is not a member, request `/api/v1/workshops/{id}` | `403 FORBIDDEN` — membership is checked server-side | `AS §11.5` |
| AUZ-02 | P | Request a factor id from another workshop via WS-DT's URL | `404 NOT_FOUND`; no cross-workshop data leaks | `AS §11.5` |
| AUZ-03 | F | Vote, approve and create factors, then ask the developer to check `audit_events` | A row exists per mutating action, naming the actor | `AS §11.31` |
| AUZ-04 | E | Attempt any mutation as an executive viewer via the API | Refused with `403` | `AS §3.17` |

---

# Phase 2 — Synthesis, relationships, insights, recommendations

Four stages complete the chain `Factor → Theme → Relationship → Insight → Recommendation`.
All four are **analyst/facilitator work**: participants capture and vote, but shaping
factors into themes and insights is restricted (`AS §3.17`). Sign in as jane.smith (F) or
sarah.chen (A) for this phase; dana.whitfield (P) is used only to prove the restriction.

> **Traceability is the point of this phase.** Every object must cite the evidence beneath
> it, and the API refuses citations that break the chain. A case where unsupported evidence
> is accepted is a **Critical** defect.

## 2.1 Theme Analysis (synthesize)

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| THM-01 | F | Open WS-DT → stage 6 *Theme Analysis* | Board lists existing themes; **Add theme** available | `WF §4`, `AS §6.7` |
| THM-02 | F | Click **Add theme** | Form shows title, a description field, and a picker listing **all captured factors** across all four categories | `WF §4` |
| THM-03 | F | Create a theme citing 2+ factors | Theme appears badged **In review**, listing its cited factors under "Evidence" | `AS §6.7` |
| THM-04 | F | Reload | Theme and its citations persist | — |
| THM-05 | F | Edit the theme and change which factors it cites | Evidence list updates to match | `WF §4` |
| THM-06 | F | Check the factor picker | Rejected factors are **not** offered — a theme cannot rest on rejected evidence | `AS §6.7` |
| THM-07 | A | Approve a theme | State becomes **Approved**; attributed to you | `AS §12.19` |
| THM-08 | P | Open Theme Analysis as a participant | View-only notice; no Add/edit/approve controls | `AS §3.17` |
| THM-09 | P | Force a theme creation via the API | `403 FORBIDDEN` | `AS §11.5` |

## 2.2 TOWS Matrix (relate)

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| TWS-01 | F | Open WS-DT → stage 7 *TOWS Matrix* | **Four** cells: SO — Leverage, ST — Defend, WO — Improve, WT — Mitigate, each with its guidance and an × of two category names | `AS §6.9`, `WF §5` |
| TWS-02 | F | Click **Pair factors** in the SO cell | Source dropdown offers **only Strengths**; target offers **only Opportunities** | `AS §6.9` |
| TWS-03 | F | Create an SO relationship with a narrative and strategic option | Appears in the SO cell showing `source → target` | `AS §6.9` |
| TWS-04 | F | Open the WO cell | Source offers **only Weaknesses** — the same factor lists differ per cell because the methodology says so | `AS §6.9` |
| TWS-05 | F | Via the API, post a weakness as the source of an **SO** relationship | Refused: "The source factor's category is not valid for SO — Leverage." The rule comes from config, not code | `AS §6.9` |
| TWS-06 | F | Via the API, pair a factor with itself | Refused — a relationship joins two different factors | `AS §6.9` |
| TWS-07 | A | Approve a relationship | Same governance lifecycle as every other object | `AS §12.19` |
| TWS-08 | F | Check a cell whose categories have no captured factors | Explains both categories need factors first; does not offer an empty dropdown | `WF §5` |

## 2.3 Insight Generation (interpret)

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| INS-01 | F | Open WS-DT → stage 8 *Insight Generation* | Board with **Add insight** | `AS §6.10`, `WF §6` |
| INS-02 | F | Open the form | Two pickers: supporting **themes** and supporting **relationships** — the two things SWOT-TOWS insights may cite | `AS §6.10` |
| INS-03 | F | Create an insight citing at least one theme and one relationship | Saves; Evidence lists both | `AS §6.10` |
| INS-04 | F | Read the "Strategic significance" field | Present, per the insight's own field definition | `AS §6.10` |
| INS-05 | F | Before any theme exists (use a fresh workshop) | Board explains there is nothing to build on and hides **Add** | `WF §6` |
| INS-06 | F | Approve an insight, then try to edit it | Refused — a decided object is frozen so an approval refers to text somebody approved | `AS §8` |
| INS-07 | F | Approve an insight, then try to delete it | Refused — reject it instead, keeping the decision on the record | `AS §8` |

## 2.4 Recommendation Workspace (recommend)

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| REC-01 | F | Open WS-DT → stage 9 *Recommendations* | Board with **Add recommendation** | `AS §6.12`, `WF §7` |
| REC-02 | F | Open the form | Fields: priority (critical/high/medium/low), expected benefits, risks, impact, feasibility — and a picker of **insights only** | `AS §6.12` |
| REC-03 | F | Create a recommendation citing an insight | Saves; priority and scores display on the card | `AS §6.12` |
| REC-04 | F | Via the API, post a recommendation citing a **theme** | Refused — a recommendation cites insights, not themes | `AS §6.12` |
| REC-05 | F | Follow one recommendation back through its insight to its themes to its factors | Every link is present — the full chain is traceable | `CL` (Traceability First) |

## 2.5 Cross-cutting Phase 2 rules

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| CHN-01 | F | Via the API, cite evidence belonging to **another** workshop | Refused: "does not belong to this workshop" | `AS §11.5` |
| CHN-02 | F | Via the API, have a theme cite an insight | Refused — citation direction is fixed by the registry | `CL` |
| CHN-03 | F | Reject an object without a reason | Refused for every kind, exactly as for factors | `AS §4.11` |
| CHN-04 | P | Attempt to approve an insight | `403`, message says your **role** does not allow it (not that you lack workshop access) | `AS §11.5` |
| CHN-05 | F | Delete a theme that an insight cites, then reopen the insight | Insight still loads; the missing citation reads "(no longer available)" rather than crashing | — |
| CHN-06 | F | Check `GET /api/v1/object-kinds` in devtools | Returns field definitions for all four kinds — the UI builds its forms from this, not from hardcoded screens | `CL` |

## 2.6 Genericity — Phase 2

> Same rules as §1.5. Activate PESTLE, run these, deactivate it afterwards.
> PESTLE deliberately has **no relate stage** and its insights cite **only themes**.

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| GEN-20 | F | Create a PESTLE workshop and open its stage list | Includes *Driver Analysis* (synthesize) and *Implications* (interpret). **No TOWS matrix, no relate stage at all** | `CL` |
| GEN-21 | F | Open *Driver Analysis* | Same board as SWOT-TOWS Theme Analysis, offering PESTLE's six categories of factors | `CL` |
| GEN-22 | F | Group two PESTLE factors into a driver | Works through the identical endpoint | `CL` |
| GEN-23 | F | Open *Implications* and read the pickers | **One** picker (themes). No relationships picker, because PESTLE's config does not cite them | `CL` |
| GEN-24 | F | Create and approve a PESTLE insight | Same governance lifecycle | `CL` |
| GEN-25 | F | Via the API, try to create a relationship in the PESTLE workshop | Refused: "Unknown relationship type for this workshop's methodology" | `CL` |
| GEN-26 | F | Confirm no SWOT/TOWS vocabulary appears anywhere in the PESTLE workshop | None | `CL` |

# Phase 3 — AI Strategy Assistant

The assistant appears as a panel beside every stage. Which actions it offers comes from
methodology configuration, so the list differs per stage and per methodology.

> **The governance rules are the point of this phase, not the quality of the suggestions.**
> AI must never approve anything, never add anything without a human accepting it, and never
> be required in order to continue. Any case where AI content reaches an approved state
> without a person approving it is a **Critical** defect.

## 3.1 Availability and configuration

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| AI-01 | F | Open any Discovery stage | An **AI assistant** panel appears beside the main content | `WF §2.21` |
| AI-02 | F | Read the action list on *Strength Discovery* | Includes "Generate Artifact Suggestions" and "Detect Duplicates" | `AS §13` |
| AI-03 | F | Open *Weakness*, *Opportunity* and *Threat* Discovery | The **same** actions are offered on all four — capture prompts apply per stage type, not per stage | `CL` |
| AI-04 | F | Open *Theme Analysis* | Offers "Generate Themes"; does **not** offer the capture-only actions | `AS §13` |
| AI-05 | F | Open *TOWS Matrix* and *Recommendations* | Each offers its own generation action | `AS §13` |
| AI-06 | F | Read the panel header | Shows remaining requests this hour | `AS §12.21` |
| AI-07 | F | Open devtools and inspect `/api/v1/workshops/{id}/ai` | Returns function keys and names only — **no prompt text**. Searching the response for "You are the AI" finds nothing | `AS §12`, `CL` |

## 3.2 Generating and reviewing suggestions

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| AI-10 | F | Click "Generate Artifact Suggestions" | Suggestions appear, each badged **AI generated** with a confidence score | `AS §12.19` |
| AI-11 | F | Check the workshop's factor list | **Nothing was added.** Suggestions are proposals until accepted | `AS §12.19` |
| AI-12 | F | Click **Add for review** on one suggestion | It becomes a real factor badged **In review** — *not* Approved | `AS §12.19` |
| AI-13 | F | Open the Review board | The accepted item is waiting there like any human-created one | `AS §12.19` |
| AI-14 | F | Click **Dismiss all** | Suggestions clear; nothing is added | `AS §12.22` |
| AI-15 | F | Generate suggestions, then try to accept the same output twice | Refused — an output is reviewed once | `AS §12.20` |
| AI-16 | P | Open a stage as a participant and generate suggestions | Panel visible, but **Add for review** is unavailable — participants cannot convert AI output into workshop content | `AS §3.17` |
| AI-17 | F | Run "Generate Themes" on Theme Analysis and accept one | Theme is created citing the factors the AI referenced, as real evidence rows | `AS §12` (traceability) |
| AI-18 | F | Ask the developer to check the accepted item in the database | `generated_by = 'ai'` and `source_ai_output_id` points at the AI output | `AS §12.20` |

## 3.3 Limits, failure and the "you can always continue" rule

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| AI-20 | P | Have the developer set your hourly usage to 20, then generate | Refused with a clear message saying you can continue without AI. **No provider call is made** | `AS §12.21` |
| AI-21 | F | Confirm your own limit | Facilitators and analysts get 100/hour, everyone else 20 | `AS §12.21` |
| AI-22 | F | Have the developer temporarily unset `ANTHROPIC_API_KEY` and reload | The AI panel **does not appear at all** — no buttons that cannot work | `AS §12.22` |
| AI-23 | F | With AI unavailable, complete a full stage by hand | Everything works normally. AI is never required | `AS §12.22` |
| AI-24 | F | Have the developer force a provider failure | Message reads exactly: "AI could not complete this request. Please try again or continue manually." and the workshop is unchanged | `AS §12.22` |
| AI-25 | F | After any AI use, have the developer check `ai_sessions` and `audit_events` | A session row per request (including failures) and an `ai.*` audit row per action | `AS §12.20`, `§12.32` |

## 3.4 Genericity — Phase 3

| ID | Role | Steps | Expected result | Spec Ref |
| --- | --- | --- | --- | --- |
| GEN-30 | F | Activate PESTLE, open a PESTLE capture stage | The AI panel offers the same capture actions — PESTLE inherits them from stage type with no PESTLE-specific prompt rows | `CL` |
| GEN-31 | F | Generate suggestions there | Suggestions are about that PESTLE category, and the assistant refers to the **PESTLE** methodology by name, not SWOT | `CL` |
| GEN-32 | F | Accept one | Becomes a PESTLE factor through the identical path | `CL` |

# Phase 4 — Reporting and export

**Not yet built — do not test.** `WF §8`, `AS §6.13`.

---

## Out of scope for this release

Marketplace, AI Consulting Team, Knowledge Graph analytics, Enterprise Integration Packs,
Industry Solution Packs, the separate Executive Dashboard (`WF §10`), Administration
screens, and Notifications Center. Do not raise defects against these.

The dashboard at `/` is still the **earlier prototype screen running on in-memory demo
data** and is not part of this script — use `TEST_SCRIPT.md` for it. Live, API-backed
workshop functionality starts at `/w`.

---

## Defect template

```
ID:            (the case ID that failed, e.g. PRI-06)
Severity:      Critical | Major | Minor | Cosmetic
Spec Ref:      (copied from the case row)
Role/account:  (which account you were signed in as)
Environment:   local dev | preview | production
Steps:         (exactly what you did)
Expected:      (from the Expected result column)
Actual:        (what happened instead)
Evidence:      (screenshot; devtools console and network output if an API call failed)
```

**Severity guide**
- **Critical** — data loss, a permission that does not hold, or any Genericity (GEN-*)
  failure.
- **Major** — a specified capability does not work, or a state transition is wrong.
- **Minor** — wrong text, count or ordering, with the underlying action still correct.
- **Cosmetic** — spacing, colour or wording.
