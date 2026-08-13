# SWOT·TOWS Strategy Console — Test Script

Structured, executable test cases for the published prototype. Every case is
manual, black-box and self-contained. Reset state with a hard page reload
(F5 / Cmd-R) between suites — all data is in-memory and returns to seed values.

Legend: **P** = Participant, **A** = Analyst, **F** = Facilitator (default),
**E** = Executive. Role is switched from the avatar menu in the header.

---

## 0. Environment and entry

| ID | Steps | Expected result |
| --- | --- | --- |
| ENV-01 | Open the published URL | Workshop Dashboard loads; header, left nav and four dashboard zones render; no error page |
| ENV-02 | Open browser devtools console | No red runtime errors on load |
| ENV-03 | Load `/discovery/strengths` directly | Discovery Workspace for Strengths renders server-side (no blank flash, no 404) |
| ENV-04 | Load `/prioritization` directly | Prioritization Workspace renders |
| ENV-05 | Load `/discovery/nonsense` | Graceful "Activity unavailable" state, not a crash |
| ENV-06 | Load `/no-such-page` | 404 page with "Go home" link; link returns to dashboard |

---

## 1. Navigation and shell

| ID | Steps | Expected result |
| --- | --- | --- |
| NAV-01 | Click each left-nav item | Dashboard → `/`; Analysis → `/discovery/strengths`; Reports → `/prioritization`; Workshops/Knowledge/Administration → `/` |
| NAV-02 | Observe the active nav item after navigating | Exactly one item is highlighted and matches the current screen |
| NAV-03 | Click the Collapse toggle at the bottom of the nav | Nav shrinks to icons only; labels hidden; toggle chevron flips |
| NAV-04 | Click the logo/wordmark from any screen | Returns to the dashboard |
| NAV-05 | Open the notifications bell | Dropdown lists notification items; badge dot visible on the bell |
| NAV-06 | Type in the header search field | Text accepts input (placeholder demo control, no crash) |
| NAV-07 | Resize the window to ≤ 767px wide | Left nav becomes a bottom bar with 4 items + More; layout stays single-column and unclipped |

---

## 2. Roles and permissions

Run each row by switching role in the avatar menu, then visiting the named screen.

| ID | Role | Screen | Expected result |
| --- | --- | --- | --- |
| ROL-01 | F | Dashboard | Activity status dropdowns editable; Approval queue visible |
| ROL-02 | A | Dashboard | Approval queue hidden; activity status not editable |
| ROL-03 | P | Dashboard | Approval queue hidden; read-only activity table |
| ROL-04 | E | Dashboard | Approval queue hidden; no edit affordances anywhere |
| ROL-05 | P | Discovery | Create form and vote buttons available; Reclassify and Merge absent in the drawer |
| ROL-06 | A | Discovery | Merge available in the drawer; Reclassify and Delete absent |
| ROL-07 | F | Discovery | Create, vote, Merge, Reclassify and Delete all available |
| ROL-08 | E | Discovery | Create toolbar and vote buttons unavailable; comment box still works |
| ROL-09 | E | Prioritization | Vote controls unavailable; rankings and heat map still readable |
| ROL-10 | any | All | Header always shows the current role label next to the avatar |

---

## 3. Workshop Dashboard

| ID | Steps | Expected result |
| --- | --- | --- |
| DSH-01 | Inspect the overview zone | Shows WS-003, objective, facilitator, created date, tags, lifecycle state and health score 84 |
| DSH-02 | Inspect the methodology pipeline | Ten stages in order: Strengths → Weaknesses → Opportunities → Threats → Prioritization → Themes → TOWS → Insights → Recommendations → Reporting, each with a status |
| DSH-03 | As F, change one activity's status in the activity table | Selected status persists; the matching pipeline stage and the progress figure update immediately |
| DSH-04 | Read the metric tiles | Artifact counts per SWOT category, participant count and votes cast are all present and numeric |
| DSH-05 | Click a SWOT category tile | Navigates to that category's Discovery Workspace |
| DSH-06 | Click a pipeline stage for a SWOT category | Navigates to the matching Discovery Workspace |
| DSH-07 | Click the Prioritization shortcut | Opens `/prioritization` |
| DSH-08 | Inspect Themes / Insights / Recommendations / Risks cards | Each item shows its confidence, significance or priority label |
| DSH-09 | Inspect the participant roster | Presence dots render as online / idle / offline |
| DSH-10 | Inspect the activity feed | Chronological entries with actor and action text |

---

## 4. Discovery Workspace — artifact creation

Run on `/discovery/strengths` as **F** unless stated.

| ID | Steps | Expected result |
| --- | --- | --- |
| CRE-01 | Submit with an empty title | Rejected; no artifact created; clear feedback |
| CRE-02 | Submit with a whitespace-only title | Rejected the same way as CRE-01 |
| CRE-03 | Enter title "Test artifact A" + description, submit | Card appears at the top of the canvas: author "You", date "Today", 0 votes |
| CRE-04 | Type a tag and press Enter | Tag chip added below the input |
| CRE-05 | Type a tag and press comma | Tag chip added |
| CRE-06 | Click an existing tag chip | Chip removed |
| CRE-07 | Create an artifact with 3 tags | All 3 tags render on the card and in the drawer |
| CRE-08 | Paste a title longer than 120 characters | Input caps at 120 characters |
| CRE-09 | Create a title closely matching an existing artifact | AI panel shows "Possible duplicate · N% similar" |
| CRE-10 | After CRE-03, go to the dashboard | The Strengths artifact count is one higher |

---

## 5. Discovery Workspace — set operations

| ID | Steps | Expected result |
| --- | --- | --- |
| SET-01 | Toggle the view control | Switches between 2-column card canvas and compact list; artifact set is identical in both |
| SET-02 | Type a word present only in one artifact's title | Only that artifact remains |
| SET-03 | Search a word present only in a description | The owning artifact matches |
| SET-04 | Search a tag value | Artifacts carrying that tag match |
| SET-05 | Clear the search field | Full set restored |
| SET-06 | Search a nonsense string | Empty-state message, no crash |
| SET-07 | Sort by votes | Highest total votes first |
| SET-08 | Sort by recency | Newest first; a just-created artifact is at the top |
| SET-09 | Sort by author | Ordered by author name |
| SET-10 | Click a card | Detail drawer opens with full title, description, author, date, tags and vote totals |
| SET-11 | Close the drawer | Drawer dismisses; canvas unchanged |

---

## 6. Discovery Workspace — drawer actions

| ID | Steps | Expected result |
| --- | --- | --- |
| DRW-01 | Add a comment and submit | Appears instantly as "You / Just now" |
| DRW-02 | Submit an empty comment | Rejected; thread unchanged |
| DRW-03 | Navigate away and reopen the same artifact | The comment from DRW-01 is still there |
| DRW-04 | As F, Reclassify from Strengths to Opportunities | Artifact leaves Strengths and appears in `/discovery/opportunities`; both counts adjust |
| DRW-05 | As F or A, Merge artifact X into Y | Vote totals sum, tags de-duplicate, X is removed, Y survives |
| DRW-06 | After DRW-05, check the dashboard count | Category count decreased by one |
| DRW-07 | As F, Delete an artifact | Removed from the canvas and from the Prioritization grid |
| DRW-08 | Vote +1 on a card, reopen the drawer | Drawer total matches the card total |
| DRW-09 | Vote −1 below your own zero on an artifact | No negative personal allocation is recorded |

---

## 7. Prioritization Workspace

| ID | Steps | Expected result |
| --- | --- | --- |
| PRI-01 | Read the allocation banner | Shows 20 total with used and remaining values that sum to 20 |
| PRI-02 | Cast one vote | Used +1, remaining −1, artifact total +1, rankings re-sort if order changes |
| PRI-03 | Spend all 20 votes, attempt a 21st | Vote refused with a clear message; totals unchanged |
| PRI-04 | Remove a vote after PRI-03 | Remaining increases; a new vote is accepted again |
| PRI-05 | Inspect the voting grid | Every artifact from all four categories appears with its category tag, total and your own count |
| PRI-06 | Inspect the rankings panel | Ordered by total desc; labels read "1 vote" vs "N votes" correctly |
| PRI-07 | Switch to the heat map view | Density by category matches the numbers in the voting grid |
| PRI-08 | Read the AI assistant output | Flags consensus items, contested items and under-examined categories consistent with current votes |
| PRI-09 | As E, attempt to vote | Voting unavailable; the rest of the screen stays readable |

---

## 8. Cross-screen consistency

| ID | Steps | Expected result |
| --- | --- | --- |
| XSC-01 | Create an artifact in Discovery, open Prioritization | The new artifact is present in the voting grid |
| XSC-02 | Vote in Discovery, open Prioritization | Used allocation reflects the Discovery vote (single shared allocation) |
| XSC-03 | Vote in Prioritization, reopen the same card in Discovery | Totals match |
| XSC-04 | Reclassify in Discovery, open Prioritization | The artifact's category tag reflects the new category |
| XSC-05 | Change role mid-flow | No data is lost; only permissions change |
| XSC-06 | Hard reload the page | All data returns to seed state (expected prototype behaviour) |

---

## 9. AI Strategy Assistant

| ID | Steps | Expected result |
| --- | --- | --- |
| AIA-01 | Open Discovery, run "suggest artifacts" | Suggestions relevant to the current SWOT category |
| AIA-02 | Accept a suggestion | Added to the set with an AI badge |
| AIA-03 | Run duplicate detection with a near-duplicate present | Duplicate pair reported with a similarity percentage |
| AIA-04 | Run "summarise the set" | Summary reflects the current artifacts, not stale content |
| AIA-05 | Run "challenge blind spots" | Returns prompts about missing perspectives |
| AIA-06 | As E, use the assistant | Assistant remains usable (read-only role still has AI access) |

---

## 10. Defect reporting template

```
ID:          <test case ID>
Severity:    Blocker | Major | Minor | Cosmetic
Role:        Participant | Analyst | Facilitator | Executive
URL:         <exact path>
Steps:       1. ... 2. ... 3. ...
Expected:    ...
Actual:      ...
Console:     <any red error text>
Screenshot:  <attach>
```

---

## 11. Out of scope

No database, authentication or real-time multi-user sync; the role switcher is a
demo control rather than real authorisation; AI responses are scripted
heuristics; header search and the Workshops / Knowledge / Administration nav
items are placeholders; TOWS matrix, insight generation, recommendations and
reporting exist as dashboard summaries only.
