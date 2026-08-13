# SWOT·TOWS Strategy Console — User Guide

A test-ready walkthrough of every screen, control and behaviour in the prototype.
All data is in-memory mock state: changes persist while the tab stays open and
reset on a full page reload.

---

## 1. Getting oriented

### Global header (all screens)
| Control | What it does |
| --- | --- |
| Logo / wordmark (top left) | Returns to the Workshop Dashboard (`/`). |
| Workshop title chip | Shows the active workshop (WS-003, Digital Transformation Strategy Workshop) and its lifecycle state. |
| Search field | Type-ahead search box for artifacts (visual/demo). |
| Notifications bell | Badge shows pending items. |
| Avatar menu | **Role switcher** — the most important test control (see §2). |

### Left navigation
Collapsible via the chevron/toggle. On mobile it becomes a bottom bar.

| Item | Destination |
| --- | --- |
| Dashboard | `/` — Workshop Dashboard |
| Workshops | `/` |
| Analysis | `/discovery/strengths` — Discovery Workspace |
| Reports | `/prioritization` — Prioritization Workspace |
| Knowledge | `/` |
| Administration | `/` |

Direct URLs you can test:
- `/`
- `/discovery/strengths`, `/discovery/weaknesses`, `/discovery/opportunities`, `/discovery/threats`
- `/discovery/<anything-else>` → graceful "Activity unavailable" state
- `/prioritization`

---

## 2. Roles and permissions

Open the avatar menu in the header and pick a role. The whole UI reacts
immediately — buttons disappear or become disabled rather than failing.

| Role | Can do |
| --- | --- |
| **Participant** | Create artifacts, vote, comment, use AI assistant |
| **Analyst** | Everything above + merge duplicates, review themes |
| **Facilitator** (default) | Everything above + edit workshop, invite, close activities, reclassify artifacts, approve themes/insights/recommendations |
| **Executive** | Read-only, plus comment and AI assistant |

**Test suggestion:** create an artifact as Facilitator, switch to Executive, and
confirm creation/merge/voting controls are gone while comments still work.

---

## 3. Workshop Dashboard (`/`)

Four zones, matching the wireframe spec.

1. **Workshop overview** — objective, facilitator, created date, tags, lifecycle
   state, and a health-score gauge (84).
2. **Methodology progress** — the ten-stage pipeline (Strengths → Weaknesses →
   Opportunities → Threats → Prioritization → Themes → TOWS → Insights →
   Recommendations → Reporting) with per-stage status.
3. **Activity status table** — each activity with status, owner and due date.
   As Facilitator you can change an activity's status; the pipeline and progress
   figures update live.
4. **Intelligence + operations column** —
   - Metric tiles (artifact counts by category, participants, votes cast)
   - Themes with confidence scores
   - Insights with significance
   - Recommendations with priority
   - Emerging risks
   - Approval queue (Facilitator only)
   - Live activity feed
   - Participant roster with presence dots (online / idle / offline)

Clicking a SWOT category tile or stage takes you into the matching Discovery
Workspace. A shortcut button opens the Prioritization Workspace.

**Test checklist**
- [ ] Change an activity status → stage pipeline reflects it
- [ ] Category counts increase after adding an artifact in Discovery
- [ ] Approval queue hidden for Participant/Executive

---

## 4. Discovery Workspace (`/discovery/{category}`)

One workspace per SWOT category. The header shows the category label, the
activity name, the methodology guidance text for that category, and live counts.

### Creating an artifact
1. Enter a **title** (required, trimmed, max 120 chars).
2. Add a **description**.
3. Add **tags** — type and press Enter/comma; click a tag chip to remove it.
4. Submit. The artifact appears at the top of the canvas, authored by "You",
   dated "Today", with 0 votes.

Empty titles are rejected. Duplicate-looking titles trigger an AI
**"Possible duplicate · N% similar"** hint in the assistant panel.

### Working with the artifact set
| Control | Behaviour |
| --- | --- |
| View toggle | Card canvas (2-column grid) ↔ compact list |
| Search / filter | Filters by title, description and tags |
| Sort | By votes, recency, or author |
| Card click | Opens the detail drawer |
| Vote buttons on a card | +1 / −1 against your personal allocation |

### Detail drawer
- Full title, description, author, created date, tags, vote totals
- **Comment thread** — add a comment; it appears instantly as "You / Just now"
- **Reclassify** (Facilitator) — move the artifact to another SWOT category; it
  disappears from this workspace and appears in the target one
- **Merge** (Analyst/Facilitator) — pick another artifact to fold in; votes are
  summed, tags are de-duplicated, the merged artifact is removed
- **Delete** (Facilitator)

### AI Strategy Assistant (right panel)
Methodology-aware quick actions: suggest artifacts for the current category,
detect duplicates, summarise the set, and challenge blind spots. Suggested
artifacts are marked with an AI badge when accepted into the set.

**Test checklist**
- [ ] Create → appears immediately, counts update on the dashboard
- [ ] Search narrows the set; clearing restores it
- [ ] Reclassify moves the artifact across categories
- [ ] Merge sums votes and keeps the surviving card
- [ ] Comment posts and persists while navigating away and back
- [ ] As Executive: creation toolbar and vote buttons are unavailable

---

## 5. Prioritization Workspace (`/prioritization`)

Convergent phase across all four categories at once.

- **Vote allocation banner** — 20 votes per participant, showing used and
  remaining. Voting stops at the cap and you get a clear message; remove a vote
  to free allocation back up.
- **Voting grid** — every artifact with its category tag, current total, and
  your own vote count.
- **Live rankings** — ordered leaderboard that re-sorts as votes change, with
  correct singular/plural vote labels.
- **Heat map view** — density view of votes by category, so you can see where
  consensus is concentrating.
- **AI assistant** — reads the current distribution and flags consensus,
  contested items, and under-examined categories.

**Test checklist**
- [ ] Spend all 20 votes → further votes are refused with feedback
- [ ] Remove a vote → allocation frees up and rankings re-sort
- [ ] Heat map matches the numbers in the voting grid
- [ ] As Executive: voting is unavailable, rankings still readable

---

## 6. Cross-screen behaviours to verify

- **Consistency**: an artifact created in Discovery shows up in the
  Prioritization grid and in dashboard counts.
- **Vote consistency**: votes cast in Discovery and Prioritization share one
  allocation.
- **Deep links**: every URL in §1 loads directly (SSR), not just via in-app nav.
- **Responsive**: at narrow widths the left nav becomes a bottom bar, the AI
  panel stacks below content, and the card canvas becomes a single column.
- **Reset**: a hard reload returns all mock data to seed state — expected.

---

## 7. Known prototype limits

- No database, auth or real-time sync — state is per-browser-tab and in-memory.
- The role switcher is a demo control, not real authorisation.
- AI assistant responses are scripted heuristics over the local artifact set.
- Search in the global header, plus Workshops/Knowledge/Administration nav
  items, are placeholders that route to the dashboard.
- TOWS matrix, insight generation, recommendations and reporting appear as
  status/summary content on the dashboard; they are not yet full workspaces.

Say the word and I can wire persistence, real authentication, multi-user
presence and the remaining TOWS/Reporting workspaces onto Lovable Cloud.
