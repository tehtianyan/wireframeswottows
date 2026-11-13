package handlers

import (
	"encoding/csv"
	"strings"
	"testing"

	"swot-tows/pkg/methodology"
	"swot-tows/pkg/weights"
)

// renderJiraCSV is pure so the FILE FORMAT can be checked here rather than by
// uploading it to Jira — which is a check that happens once, by hand, and
// never again. Each case below states what Jira does with a wrong answer,
// because "the CSV looked fine" is not the failure mode: the failure mode is
// Jira silently skipping a row or attaching a story to the wrong epic.

func sampleBoard() *DeliveryBoard {
	sales, brand := "init-sales", "init-brand"
	return &DeliveryBoard{
		Kind: "recommendation", Label: "Delivery board", ItemLabel: "Action",
		GroupKind: "initiative",
		States: []DeliveryState{
			{Key: "todo", Name: "To Do"},
			{Key: "in_progress", Name: "In Progress"},
			{Key: "done", Name: "Done"},
		},
		Exports: []string{"jira"},
		Groups: []DeliveryGroup{
			{ID: sales, Title: "Invest in partners", TypeKey: "so", TypeName: "Strengths x Opportunities"},
			{ID: brand, Title: "Invest in partners", TypeKey: "wo", TypeName: "Weaknesses x Opportunities"},
		},
		Items: []DeliveryItem{
			{ID: "a1", Title: "Build AI messaging", Description: "All competitors claim the same things.",
				State: "in_progress", ObjectState: "approved", GroupID: &sales,
				GroupTitle: "Invest in partners", TypeKey: "so",
				TypeName: "Strengths x Opportunities", Rank: 0, Priority: "critical"},
			{ID: "a2", Title: "Refresh the FSI pitch", State: "todo", ObjectState: "submitted",
				GroupID: &brand, GroupTitle: "Invest in partners", TypeKey: "wo",
				TypeName: "Weaknesses x Opportunities", Rank: 1, Priority: ""},
		},
		WeightKey: "action_priority",
	}
}

func parseCSV(t *testing.T, body string) ([]string, [][]string) {
	t.Helper()
	rows, err := csv.NewReader(strings.NewReader(body)).ReadAll()
	if err != nil {
		t.Fatalf("the export is not valid CSV: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("the export is empty")
	}
	return rows[0], rows[1:]
}

func column(header []string, name string) int {
	for i, h := range header {
		if h == name {
			return i
		}
	}
	return -1
}

// TWO EPICS WITH ONE NAME MAKES JIRA LINK THE WRONG STORIES. Jira matches Epic
// Link to Epic Name by TEXT, and "one initiative per quadrant" means the same
// programme name legitimately appears twice. Without disambiguation both
// quadrants' stories land under whichever epic Jira imported first, and
// nothing reports a problem.
func TestJiraCSVDisambiguatesCollidingEpicNames(t *testing.T) {
	body, err := renderJiraCSV(sampleBoard(), map[string]weights.Aggregate{}, 0,
		"ET-Test", "SWOT-TOWS")
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	header, rows := parseCSV(t, body)
	typeCol, nameCol, linkCol := column(header, "Issue Type"), column(header, "Epic Name"), column(header, "Epic Link")

	epics := map[string]bool{}
	for _, r := range rows {
		if r[typeCol] == "Epic" {
			if epics[r[nameCol]] {
				t.Fatalf("two epics share the name %q — Jira would merge their stories", r[nameCol])
			}
			epics[r[nameCol]] = true
		}
	}
	if len(epics) != 2 {
		t.Fatalf("expected two epics, got %d: %v", len(epics), epics)
	}

	// And every story's link names an epic that is actually in the file.
	stories := 0
	for _, r := range rows {
		if r[typeCol] != "Story" {
			continue
		}
		stories++
		if !epics[r[linkCol]] {
			t.Fatalf("story %q links to %q, which is not an epic in this file", r[column(header, "Summary")], r[linkCol])
		}
	}
	if stories != 2 {
		t.Fatalf("expected two stories, got %d", stories)
	}
}

// THE QUADRANT SUFFIX IS NOT ENOUGH ON ITS OWN, which the first version
// assumed. "One initiative per quadrant" is a convention, not a constraint, so
// two headings can legitimately share a title AND a quadrant — and then the
// suffix makes both names longer and still identical, Jira merges their
// stories, and the import reports success. Found by printing a real export,
// not by this file, whose fixture collided across quadrants: the exact shape
// the code had been written for.
func TestJiraCSVEpicNamesAreUniqueEvenWithinOneQuadrant(t *testing.T) {
	board := sampleBoard()
	// Four headings, one name, one quadrant.
	board.Groups = nil
	ids := []string{"g1", "g2", "g3", "g4"}
	for _, id := range ids {
		board.Groups = append(board.Groups, DeliveryGroup{
			ID: id, Title: "Invest in partners", TypeKey: "so", TypeName: "Strengths x Opportunities",
		})
	}
	board.Items = nil
	for i, id := range ids {
		gid := id
		board.Items = append(board.Items, DeliveryItem{
			ID: "a" + gid, Title: "Action " + gid, State: "todo", ObjectState: "approved",
			GroupID: &gid, GroupTitle: "Invest in partners", TypeKey: "so", Rank: i, Priority: "medium",
		})
	}

	body, err := renderJiraCSV(board, map[string]weights.Aggregate{}, 0, "ET-Test", "SWOT-TOWS")
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	header, rows := parseCSV(t, body)
	typeCol, nameCol, linkCol := column(header, "Issue Type"), column(header, "Epic Name"), column(header, "Epic Link")

	epics := map[string]bool{}
	for _, r := range rows {
		if r[typeCol] != "Epic" {
			continue
		}
		if epics[r[nameCol]] {
			t.Fatalf("two epics in the same quadrant share the name %q — Jira would merge their stories", r[nameCol])
		}
		epics[r[nameCol]] = true
	}
	if len(epics) != len(ids) {
		t.Fatalf("expected %d distinct epic names, got %d: %v", len(ids), len(epics), epics)
	}

	// Each story must still reach its OWN epic, or unique names bought
	// nothing: four distinct epics with all four stories under one of them is
	// the same wrong outcome.
	linked := map[string]int{}
	for _, r := range rows {
		if r[typeCol] == "Story" {
			linked[r[linkCol]]++
		}
	}
	if len(linked) != len(ids) {
		t.Fatalf("the stories did not spread across the epics: %v", linked)
	}
}

// A unique name must NOT be decorated. The quadrant suffix exists to resolve a
// collision; applying it unconditionally would rename every epic the room
// recognises, which is a cost paid in the common case for a rare problem.
func TestJiraCSVLeavesAUniqueEpicNameAlone(t *testing.T) {
	board := sampleBoard()
	board.Groups[1].Title = "Build out new focussed sales campaigns"
	body, err := renderJiraCSV(board, map[string]weights.Aggregate{}, 0, "ET-Test", "SWOT-TOWS")
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	if !strings.Contains(body, "Invest in partners,") && !strings.Contains(body, `"Invest in partners"`) {
		t.Fatalf("a unique epic name was decorated; body:\n%s", body)
	}
	if strings.Contains(body, "Invest in partners [SO]") {
		t.Fatalf("a unique epic name was suffixed anyway:\n%s", body)
	}
}

// THE STATUS IS THE CONFIGURED NAME, NOT THE KEY. Jira's importer matches a
// status by its display name, so exporting "in_progress" would leave every
// card in the default status and lose the board's whole state.
func TestJiraCSVExportsConfiguredStateNames(t *testing.T) {
	body, _ := renderJiraCSV(sampleBoard(), map[string]weights.Aggregate{}, 0, "ET-Test", "SWOT-TOWS")
	header, rows := parseCSV(t, body)
	statusCol, typeCol := column(header, "Status"), column(header, "Issue Type")
	seen := map[string]bool{}
	for _, r := range rows {
		if r[typeCol] == "Story" {
			seen[r[statusCol]] = true
		}
	}
	if !seen["In Progress"] || !seen["To Do"] {
		t.Fatalf("the configured state names did not reach the export: %v", seen)
	}
	if seen["in_progress"] || seen["todo"] {
		t.Fatalf("state KEYS were exported instead of names: %v", seen)
	}
}

// The state names come from config, so a methodology that calls them something
// else must export those words. A literal "To Do" anywhere in the renderer
// would be the same bug the weights package forbids for scale bounds.
func TestJiraCSVFollowsRenamedStates(t *testing.T) {
	board := sampleBoard()
	board.States = []DeliveryState{
		{Key: "todo", Name: "Backlog"},
		{Key: "in_progress", Name: "Underway"},
		{Key: "done", Name: "Shipped"},
	}
	body, _ := renderJiraCSV(board, map[string]weights.Aggregate{}, 0, "ET-Test", "SWOT-TOWS")
	if !strings.Contains(body, "Underway") || !strings.Contains(body, "Backlog") {
		t.Fatalf("renamed states did not reach the export:\n%s", body)
	}
	if strings.Contains(body, "In Progress") {
		t.Fatalf("a hardcoded state name survived a rename:\n%s", body)
	}
}

// AN UNMAPPED PRIORITY MUST NOT BE BLANK. Jira rejects a row whose priority it
// does not recognise, and a rejected row is an action that silently never
// arrives — far worse than one that arrives as Medium.
func TestJiraCSVNeverExportsAnEmptyPriority(t *testing.T) {
	body, _ := renderJiraCSV(sampleBoard(), map[string]weights.Aggregate{}, 0, "ET-Test", "SWOT-TOWS")
	header, rows := parseCSV(t, body)
	pCol := column(header, "Priority")
	for _, r := range rows {
		if strings.TrimSpace(r[pCol]) == "" {
			t.Fatalf("a row carries no priority: %v", r)
		}
	}
	// "critical" is this platform's word and "Highest" is Jira's.
	if !strings.Contains(body, "Highest") {
		t.Fatalf("critical did not map onto Jira's scheme:\n%s", body)
	}
}

// TWO NUMBERS, NEVER ONE — the rule every other surface follows, at the point
// the figure travels furthest from the room that produced it. A bare "4.5" in
// a Jira ticket reads as the workshop's agreement when one person produced it.
func TestJiraCSVCarriesTheRatingWithItsVoterCount(t *testing.T) {
	ratings := map[string]weights.Aggregate{
		"a1": {WeightKey: "action_priority", ObjectID: "a1", Value: 4.5, Voters: 2},
	}
	body, _ := renderJiraCSV(sampleBoard(), ratings, 5, "ET-Test", "SWOT-TOWS")
	if !strings.Contains(body, "4.5") {
		t.Fatalf("the rating is missing:\n%s", body)
	}
	if !strings.Contains(body, "2 of 5") {
		t.Fatalf("the rating travelled without its denominator:\n%s", body)
	}
	// An unrated action says so rather than implying zero.
	if !strings.Contains(body, "not yet rated") {
		t.Fatalf("an unrated action did not say so:\n%s", body)
	}
}

// A whole-number mean must not arrive as "4.00".
func TestTrimFloat(t *testing.T) {
	for in, want := range map[float64]string{4: "4", 4.5: "4.5", 4.25: "4.25", 0: "0"} {
		if got := trimFloat(in); got != want {
			t.Fatalf("trimFloat(%v) = %q, want %q", in, got, want)
		}
	}
}

// PROVENANCE TRAVELS WITH THE ISSUE. An action arriving in Jira stripped of
// where it came from is an action nobody can argue about six months later,
// which is the thing this whole product exists to prevent.
func TestJiraCSVDescriptionCarriesProvenance(t *testing.T) {
	body, _ := renderJiraCSV(sampleBoard(), map[string]weights.Aggregate{}, 0, "ET-Test", "SWOT-TOWS")
	for _, want := range []string{"ET-Test", "Strengths x Opportunities", "Invest in partners"} {
		if !strings.Contains(body, want) {
			t.Fatalf("the export does not say %q:\n%s", want, body)
		}
	}
	// An action nobody has approved says so, so a reader in Jira is not
	// handed unagreed work as if the room had signed it off.
	if !strings.Contains(body, "not yet approved") {
		t.Fatalf("an unapproved action was exported without saying so:\n%s", body)
	}
}

// A Jira label may not contain spaces, and one that does takes its whole row
// down with it.
func TestJiraLabelsAreLegal(t *testing.T) {
	body, _ := renderJiraCSV(sampleBoard(), map[string]weights.Aggregate{}, 0,
		"ET-Test", "Porter's Five Forces")
	header, rows := parseCSV(t, body)
	for i, h := range header {
		if h != "Labels" {
			continue
		}
		for _, r := range rows {
			if strings.ContainsAny(r[i], " \t") {
				t.Fatalf("label %q contains whitespace — Jira rejects the row", r[i])
			}
		}
	}
	if jiraLabel("Porter's Five Forces") != "Porter-s-Five-Forces" {
		t.Fatalf("unexpected label slug: %q", jiraLabel("Porter's Five Forces"))
	}
}

// The header is what Jira maps its fields from, so its presence is the one
// thing an import cannot recover from.
func TestJiraCSVHeaderNamesEveryFieldUsed(t *testing.T) {
	body, _ := renderJiraCSV(sampleBoard(), map[string]weights.Aggregate{}, 0, "ET-Test", "SWOT-TOWS")
	header, rows := parseCSV(t, body)
	for _, want := range []string{"Issue Type", "Summary", "Description", "Status", "Priority", "Epic Name", "Epic Link"} {
		if column(header, want) < 0 {
			t.Fatalf("the header has no %q column: %v", want, header)
		}
	}
	// Two Labels columns, which is how Jira's CSV importer takes several
	// values for one field.
	labels := 0
	for _, h := range header {
		if h == "Labels" {
			labels++
		}
	}
	if labels != 2 {
		t.Fatalf("expected two Labels columns, got %d", labels)
	}
	for _, r := range rows {
		if len(r) != len(header) {
			t.Fatalf("a row has %d fields against %d headers: %v", len(r), len(header), r)
		}
	}
}

// readDeliveryConfig is the opt-in. A stage that declares nothing gets no
// board, which is how the other seven methodologies are unaffected.
func TestReadDeliveryConfigIsOptIn(t *testing.T) {
	if cfg := readDeliveryConfig(nil); cfg != nil {
		t.Fatal("a nil stage produced a board")
	}
	if cfg := readDeliveryConfig(&methodology.Stage{Config: map[string]interface{}{}}); cfg != nil {
		t.Fatal("a stage declaring nothing produced a board")
	}
	// A declaration with no states is incomplete, not a one-column board.
	empty := map[string]interface{}{"delivery": map[string]interface{}{
		"kind": "recommendation", "states": []interface{}{}}}
	if cfg := readDeliveryConfig(&methodology.Stage{Config: empty}); cfg != nil {
		t.Fatal("a board with no columns was accepted")
	}
	good := map[string]interface{}{"delivery": map[string]interface{}{
		"kind": "recommendation",
		"states": []interface{}{
			map[string]interface{}{"key": "todo", "name": "To Do"},
			map[string]interface{}{"key": "done"},
		},
		"exports": []interface{}{"jira"},
	}}
	cfg := readDeliveryConfig(&methodology.Stage{Config: good})
	if cfg == nil || len(cfg.States) != 2 {
		t.Fatalf("a valid declaration was rejected: %+v", cfg)
	}
	// A state with no name falls back to its key rather than rendering a
	// blank column header.
	if cfg.States[1].Name != "done" {
		t.Fatalf("a nameless state did not fall back to its key: %+v", cfg.States[1])
	}
	if !cfg.offersExport("jira") || cfg.offersExport("csv") {
		t.Fatalf("exports resolved wrongly: %+v", cfg.Exports)
	}
}

// A kind with no delivery column cannot be tracked, and the refusal has to say
// which kind rather than drawing an empty board.
func TestDeliverableKindRefusesAKindWithNoDeliveryColumn(t *testing.T) {
	if _, msg := deliverableKind(&deliveryConfig{Kind: "synthesis"}); msg == "" {
		t.Fatal("a theme was accepted onto a delivery board")
	}
	if _, msg := deliverableKind(&deliveryConfig{Kind: "nonsense"}); !strings.Contains(msg, "nonsense") {
		t.Fatalf("the refusal does not name the kind: %q", msg)
	}
	if k, msg := deliverableKind(&deliveryConfig{Kind: "recommendation"}); msg != "" || k.DeliveryCol == "" {
		t.Fatalf("a recommendation was refused: %q", msg)
	}
}

// ---------------------------------------------------------------------------
// What it takes to deliver it (UAT 2026-11-14)
// ---------------------------------------------------------------------------

func days(f float64) *float64 { return &f }

// boardWithPlan is sampleBoard with the delivery detail filled in two
// different ways: one action owned by a real account, one by a typed name.
func boardWithPlan() *DeliveryBoard {
	b := sampleBoard()
	start, end := "2026-03-02", "2026-06-30"
	uid := "user-1"
	b.Items[0].OwnerUserID = &uid
	b.Items[0].OwnerName = "Jane Smith"
	b.Items[0].OwnerEmail = "jane.smith@example.com"
	b.Items[0].StartDate = &start
	b.Items[0].EndDate = &end
	b.Items[0].EffortPersonDays = days(12.5)
	b.Items[0].ValueAmount = days(450000)
	b.Items[0].ValueUnit = "money_annual"
	b.Items[0].ValueBasis = "3% churn reduction on $15M ARR"

	b.Items[1].OwnerName = "Head of Sales Ops"
	return b
}

// A BARE NUMBER IN Original Estimate IS READ AS SECONDS. A 12.5-day estimate
// arriving as 12.5 seconds imports without complaint and is only discovered
// when somebody plans a sprint against it.
func TestJiraCSVEstimateCarriesItsUnit(t *testing.T) {
	body, err := renderJiraCSV(boardWithPlan(), map[string]weights.Aggregate{}, 0, "Q1", "SWOT-TOWS")
	if err != nil {
		t.Fatal(err)
	}
	header, rows := parseCSV(t, body)
	est, typeCol := column(header, "Original Estimate"), column(header, "Issue Type")
	if est < 0 {
		t.Fatal("no Original Estimate column")
	}
	var seen []string
	for _, r := range rows {
		if r[typeCol] == "Story" {
			seen = append(seen, r[est])
		}
	}
	if len(seen) != 2 {
		t.Fatalf("expected two stories, got %d", len(seen))
	}
	if seen[0] != "12.5d" {
		t.Errorf("estimate exported as %q, want \"12.5d\" — a bare number is seconds to Jira", seen[0])
	}
	// AN ABSENT ESTIMATE IS AN EMPTY CELL, NOT "0d". Zero is a claim nobody
	// made, and it would plan as free work.
	if seen[1] != "" {
		t.Errorf("an action with no estimate exported %q, want empty", seen[1])
	}
}

// THE OWNER REACHES JIRA AS AN EMAIL OR NOT AT ALL. Jira matches a person on
// their account, so a display name in Assignee resolves to nobody — and an
// action owned by somebody who was never in the workshop has no account to
// name. Sending the name anyway would look assigned and not be.
func TestJiraCSVAssignsOnlyRealAccounts(t *testing.T) {
	body, err := renderJiraCSV(boardWithPlan(), map[string]weights.Aggregate{}, 0, "Q1", "SWOT-TOWS")
	if err != nil {
		t.Fatal(err)
	}
	header, rows := parseCSV(t, body)
	a, d, typeCol := column(header, "Assignee"), column(header, "Description"), column(header, "Issue Type")
	var stories [][]string
	for _, r := range rows {
		if r[typeCol] == "Story" {
			stories = append(stories, r)
		}
	}
	if stories[0][a] != "jane.smith@example.com" {
		t.Errorf("Assignee was %q, want the account's email", stories[0][a])
	}
	if stories[1][a] != "" {
		t.Errorf("a typed-name owner exported Assignee %q, want empty", stories[1][a])
	}
	// ...and the name is not simply lost: it goes in the description, saying
	// why the ticket arrived unassigned.
	if !strings.Contains(stories[1][d], "Head of Sales Ops") {
		t.Error("the typed owner's name is missing from the description")
	}
	if !strings.Contains(stories[1][d], "not assigned here") {
		t.Error("an unassignable owner should say so, or the ticket looks dropped")
	}
}

// THE VALUE ARRIVES AS WORDS, NOT AS A STORED KEY. A ticket reading
// "450000 money_annual" is the kind of thing somebody has to explain in a
// steering meeting. The labels come from the registry, so there is one list.
func TestJiraCSVValueReadsAsWords(t *testing.T) {
	body, err := renderJiraCSV(boardWithPlan(), map[string]weights.Aggregate{}, 0, "Q1", "SWOT-TOWS")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(body, "money_annual") {
		t.Error("the stored unit key reached the export; it should be the registry's label")
	}
	if !strings.Contains(body, "Money, per year") {
		t.Error("the unit's label is missing from the export")
	}
	// The basis travels with the figure, or it cannot be argued with later.
	if !strings.Contains(body, "3% churn reduction on $15M ARR") {
		t.Error("the basis for the value did not travel with it")
	}
	// Dates: the due date is a column of its own AND the range is readable.
	if !strings.Contains(body, "2026-03-02") || !strings.Contains(body, "2026-06-30") {
		t.Error("the dates did not reach the export")
	}
}

// An action with none of it filled in must export exactly as it did before —
// these fields are optional, and a facilitator who skipped them has not
// produced a broken ticket.
func TestJiraCSVUnplannedActionExportsCleanly(t *testing.T) {
	body, err := renderJiraCSV(sampleBoard(), map[string]weights.Aggregate{}, 0, "Q1", "SWOT-TOWS")
	if err != nil {
		t.Fatal(err)
	}
	header, rows := parseCSV(t, body)
	for _, name := range []string{"Assignee", "Due Date", "Original Estimate"} {
		c := column(header, name)
		for _, r := range rows {
			if r[c] != "" {
				t.Errorf("%s was %q on a board with no delivery detail", name, r[c])
			}
		}
	}
	if strings.Contains(body, "Owner:") || strings.Contains(body, "Effort:") {
		t.Error("a plan line was written for an action that has no plan")
	}
}

func TestGroupDigits(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"0", "0"},
		{"450", "450"},
		{"1000", "1,000"},
		{"450000", "450,000"},
		{"12.5", "12.5"},
		{"1234567.25", "1,234,567.25"},
		{"-4500", "-4,500"},
	} {
		if got := groupDigits(c.in); got != c.want {
			t.Errorf("groupDigits(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
