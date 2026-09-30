package handlers

import (
	"strings"
	"testing"

	"swot-tows/pkg/methodology"
)

// planCleanup is what makes "Merge and Fix" acceptable: it is the point where
// a model's proposal is refused rather than trusted. These tests exist because
// that refusal must be checkable WITHOUT a live model call — a safety rule
// that costs money to exercise is a safety rule nobody exercises.
//
// Each case states what would go wrong if the rule were dropped, because a
// test whose name only describes correct behaviour tends to get "simplified"
// back into the bug it was guarding.

func testMethodology() *methodology.Methodology {
	return &methodology.Methodology{
		Key:  "swot-tows",
		Name: "SWOT-TOWS",
		FactorCategories: []methodology.FactorCategory{
			{ID: "cat-s", Key: "strength", Name: "Strengths"},
			{ID: "cat-w", Key: "weakness", Name: "Weaknesses"},
		},
	}
}

func notes() []cleanupNote {
	return []cleanupNote{
		{ID: "f1", Category: "strength", Title: "Strong brand recognitoin", Desc: "", state: "submitted"},
		{ID: "f2", Category: "strength", Title: "Our brand is well known", Desc: "", state: "submitted"},
		{ID: "f3", Category: "strength", Title: "Legacy billing system", Desc: "", state: "submitted"},
		// Referenced three different ways — each must block a merge on its own.
		{ID: "cited", Category: "strength", Title: "Cited by a theme", state: "submitted",
			referenced: "is already cited by a theme"},
		{ID: "voted", Category: "strength", Title: "Carries votes", state: "submitted",
			referenced: "already carries votes or scores"},
		{ID: "paired", Category: "strength", Title: "In a relationship", state: "submitted",
			referenced: "is already used in a relationship"},
	}
}

func onlyPlan(t *testing.T, proposed ...proposedChange) ([]plannedChange, []CleanupSkip) {
	t.Helper()
	return planCleanup(testMethodology(), notes(), proposed)
}

func ptr(s string) *string { return &s }

// If this rule were dropped, a note that a theme cites — or that the workshop
// has already spent votes on — would silently disappear from the board, taking
// a traceability chain with it.
func TestPlanNeverMergesAReferencedNote(t *testing.T) {
	for _, id := range []string{"cited", "voted", "paired"} {
		plan, skipped := onlyPlan(t, proposedChange{
			Type: "merge", FactorID: id, IntoFactor: "f1", Reason: "duplicate",
		})
		if len(plan) != 0 {
			t.Fatalf("%s: merged a referenced note; plan = %+v", id, plan)
		}
		if len(skipped) != 1 {
			t.Fatalf("%s: expected one reported skip, got %d", id, len(skipped))
		}
		// The facilitator reads this sentence, so it has to read as one. The
		// reason is stored subject-less precisely so both phrasings work.
		if !strings.HasPrefix(skipped[0].Refused, "it ") {
			t.Fatalf("%s: unreadable refusal %q", id, skipped[0].Refused)
		}
	}
}

// The survivor matters too: whoever cited the duplicate cited THAT note, and
// folding a cited note into it would change what their citation points at.
func TestPlanNeverMergesINTOAReferencedNote(t *testing.T) {
	plan, skipped := onlyPlan(t, proposedChange{
		Type: "merge", FactorID: "f1", IntoFactor: "cited",
	})
	if len(plan) != 0 {
		t.Fatalf("merged into a referenced note; plan = %+v", plan)
	}
	if len(skipped) != 1 {
		t.Fatalf("expected one skip, got %d", len(skipped))
	}
	if skipped[0].Refused != "the note it would merge into is already cited by a theme" {
		t.Fatalf("the refusal does not read as a sentence: %q", skipped[0].Refused)
	}
}

func TestPlanMergesAnUnreferencedDuplicate(t *testing.T) {
	plan, skipped := onlyPlan(t, proposedChange{
		Type: "merge", FactorID: "f2", IntoFactor: "f1", Reason: "same point as f1",
	})
	if len(skipped) != 0 {
		t.Fatalf("refused a legitimate merge: %+v", skipped)
	}
	if len(plan) != 1 {
		t.Fatalf("expected one planned change, got %d", len(plan))
	}
	// Archived, not deleted — otherwise undo would have nothing to restore.
	if plan[0].After["state"] != "archived" {
		t.Fatalf("a merge must archive rather than delete: %+v", plan[0].After)
	}
	if plan[0].Before["state"] != "submitted" {
		t.Fatalf("the before-state must be recorded, or undo cannot restore it: %+v", plan[0].Before)
	}
	if plan[0].MergeInto != "f1" {
		t.Fatalf("the survivor was not recorded: %+v", plan[0])
	}
}

// Without the before-state there is no undo, so this asserts the exact shape
// undoOne reads back.
func TestPlanRewordRecordsBothFields(t *testing.T) {
	plan, _ := onlyPlan(t, proposedChange{
		Type: "reword", FactorID: "f1", Title: "Strong brand recognition",
		Description: ptr("Unprompted awareness leads the category."), Reason: "typo",
	})
	if len(plan) != 1 {
		t.Fatalf("expected one change, got %d", len(plan))
	}
	if plan[0].Before["title"] != "Strong brand recognitoin" {
		t.Fatalf("before.title missing: %+v", plan[0].Before)
	}
	if _, ok := plan[0].Before["description"]; !ok {
		t.Fatalf("before.description missing, so an undo would lose the description: %+v", plan[0].Before)
	}
	if plan[0].After["title"] != "Strong brand recognition" {
		t.Fatalf("after.title wrong: %+v", plan[0].After)
	}
}

func TestPlanMoveResolvesTheCategoryAndRefusesAnUnknownOne(t *testing.T) {
	plan, skipped := onlyPlan(t,
		proposedChange{Type: "move", FactorID: "f3", CategoryKey: "weakness"},
		proposedChange{Type: "move", FactorID: "f1", CategoryKey: "political"},
	)
	if len(plan) != 1 || plan[0].CategoryID != "cat-w" {
		t.Fatalf("the valid move did not resolve its category: %+v", plan)
	}
	if plan[0].Before["category_key"] != "strength" {
		t.Fatalf("before.category_key missing: %+v", plan[0].Before)
	}
	// "political" is a PESTLE category. Accepting it would put a note in a
	// category this workshop's methodology does not have.
	if len(skipped) != 1 || !strings.Contains(skipped[0].Refused, "not a category") {
		t.Fatalf("a category from another methodology was not refused: %+v", skipped)
	}
}

// A model that invents a plausible UUID, or echoes one from another workshop,
// must not reach the database. cleanupCandidates only offers draft and
// submitted notes of THIS workshop, so "not in the list" covers both.
func TestPlanRefusesNotesThatAreNotOnTheBoard(t *testing.T) {
	plan, skipped := onlyPlan(t,
		proposedChange{Type: "reword", FactorID: "00000000-0000-0000-0000-000000000000", Title: "x"},
		proposedChange{Type: "merge", FactorID: "f1", IntoFactor: "not-here"},
	)
	if len(plan) != 0 {
		t.Fatalf("a change against an unknown note was planned: %+v", plan)
	}
	if len(skipped) != 2 {
		t.Fatalf("expected both to be reported, got %d", len(skipped))
	}
}

// One bad item used to bin the whole output. Keeping the rest is the same
// choice sanitizeAIOutput makes, for the same reason.
func TestPlanKeepsTheGoodChangesAlongsideABadOne(t *testing.T) {
	plan, skipped := onlyPlan(t,
		proposedChange{Type: "reword", FactorID: "f1", Title: "Strong brand recognition"},
		proposedChange{Type: "merge", FactorID: "cited", IntoFactor: "f1"},
		proposedChange{Type: "move", FactorID: "f3", CategoryKey: "weakness"},
	)
	if len(plan) != 2 {
		t.Fatalf("expected the two good changes to survive, got %d", len(plan))
	}
	if len(skipped) != 1 {
		t.Fatalf("expected exactly one skip, got %d", len(skipped))
	}
}

// Two edits to one note would make undo ambiguous: the second change's
// before-state is the first change's after-state, so undoing them out of order
// would restore text that never existed.
func TestPlanAllowsOnlyOneChangePerNote(t *testing.T) {
	plan, skipped := onlyPlan(t,
		proposedChange{Type: "reword", FactorID: "f1", Title: "Strong brand recognition"},
		proposedChange{Type: "move", FactorID: "f1", CategoryKey: "weakness"},
	)
	if len(plan) != 1 {
		t.Fatalf("expected one change to win, got %d", len(plan))
	}
	if len(skipped) != 1 {
		t.Fatalf("the second change was dropped without saying so: %+v", skipped)
	}
}

// A merge whose survivor was itself just archived would leave the duplicate
// pointing at nothing visible.
func TestPlanRefusesAChainedMerge(t *testing.T) {
	plan, skipped := onlyPlan(t,
		proposedChange{Type: "merge", FactorID: "f2", IntoFactor: "f1"},
		proposedChange{Type: "merge", FactorID: "f3", IntoFactor: "f2"},
	)
	if len(plan) != 1 {
		t.Fatalf("a chained merge was allowed: %+v", plan)
	}
	if len(skipped) != 1 {
		t.Fatalf("the chained merge was dropped silently: %+v", skipped)
	}
}

// The first live run against the model produced exactly this pair — fix the
// typo on the surviving note, then fold the duplicate into it — and an earlier
// rule refused the merge because the survivor had "already been changed".
// They are independent edits with independent before-states: the reword's is
// the survivor's old text, the merge's is the duplicate's old state.
func TestPlanAllowsMergingIntoANoteItJustReworded(t *testing.T) {
	plan, skipped := onlyPlan(t,
		proposedChange{Type: "reword", FactorID: "f1", Title: "Strong brand recognition", Reason: "typo"},
		proposedChange{Type: "merge", FactorID: "f2", IntoFactor: "f1", Reason: "same point"},
	)
	if len(skipped) != 0 {
		t.Fatalf("refused a legitimate reword-then-merge pair: %+v", skipped)
	}
	if len(plan) != 2 {
		t.Fatalf("expected both changes, got %d", len(plan))
	}
}

// Two duplicates folding into one survivor is the ordinary case for three
// people writing the same idea, and must keep working.
func TestPlanAllowsTwoDuplicatesIntoOneSurvivor(t *testing.T) {
	plan, skipped := onlyPlan(t,
		proposedChange{Type: "merge", FactorID: "f2", IntoFactor: "f1"},
		proposedChange{Type: "merge", FactorID: "f3", IntoFactor: "f1"},
	)
	if len(skipped) != 0 {
		t.Fatalf("refused a second duplicate into the same survivor: %+v", skipped)
	}
	if len(plan) != 2 {
		t.Fatalf("expected both merges, got %d", len(plan))
	}
}

// The mirror of the chain: a note that has absorbed a duplicate must not then
// be merged away, or the first merge names a survivor that is off the board.
func TestPlanRefusesMergingAwayASurvivor(t *testing.T) {
	plan, skipped := onlyPlan(t,
		proposedChange{Type: "merge", FactorID: "f2", IntoFactor: "f1"},
		proposedChange{Type: "merge", FactorID: "f1", IntoFactor: "f3"},
	)
	if len(plan) != 1 {
		t.Fatalf("a survivor was merged away: %+v", plan)
	}
	if len(skipped) != 1 {
		t.Fatalf("it was dropped silently: %+v", skipped)
	}
}

// A model that restates only the title is not asking for the description to be
// erased. Treating the zero value as "clear it" wiped a note's body whenever
// the rewrite touched only its title — found by a real run against the model.
func TestPlanKeepsADescriptionThePropositionDidNotMention(t *testing.T) {
	withDesc := []cleanupNote{
		{ID: "f1", Category: "strength", Title: "Strong brand recognitoin",
			Desc: "Unprompted awareness leads the category.", state: "submitted"},
	}
	plan, _ := planCleanup(testMethodology(), withDesc, []proposedChange{
		{Type: "reword", FactorID: "f1", Title: "Strong brand recognition"},
	})
	if len(plan) != 1 {
		t.Fatalf("expected the reword, got %d", len(plan))
	}
	if plan[0].After["description"] != "Unprompted awareness leads the category." {
		t.Fatalf("the description was erased: %+v", plan[0].After)
	}

	// An explicit empty string still clears it — absent and empty differ.
	plan, _ = planCleanup(testMethodology(), withDesc, []proposedChange{
		{Type: "reword", FactorID: "f1", Title: "Strong brand recognition", Description: ptr("")},
	})
	if plan[0].After["description"] != "" {
		t.Fatalf("an explicit clear was ignored: %+v", plan[0].After)
	}
}

func TestPlanRefusesSelfMergeAndNoOpRewrite(t *testing.T) {
	plan, skipped := onlyPlan(t,
		proposedChange{Type: "merge", FactorID: "f1", IntoFactor: "f1"},
		proposedChange{Type: "reword", FactorID: "f2", Title: "Our brand is well known"},
		proposedChange{Type: "move", FactorID: "f3", CategoryKey: "strength"},
	)
	if len(plan) != 0 {
		t.Fatalf("a no-op was recorded as a change: %+v", plan)
	}
	if len(skipped) != 3 {
		t.Fatalf("expected all three reported, got %d", len(skipped))
	}
}

// 120 characters is the cap CreateFactor and UpdateFactor apply. The AI path
// has to obey the same rule, or it becomes a way round validation.
func TestPlanAppliesTheSameTitleRuleAsAHuman(t *testing.T) {
	plan, skipped := onlyPlan(t, proposedChange{
		Type: "reword", FactorID: "f1", Title: strings.Repeat("a", 121),
	})
	if len(plan) != 0 {
		t.Fatalf("an over-long title was accepted from the AI path: %+v", plan)
	}
	if len(skipped) != 1 || !strings.Contains(skipped[0].Refused, "120") {
		t.Fatalf("the refusal does not say what the limit is: %+v", skipped)
	}
}

func TestPlanRefusesAnUnknownChangeType(t *testing.T) {
	plan, skipped := onlyPlan(t, proposedChange{Type: "delete", FactorID: "f1"})
	if len(plan) != 0 {
		t.Fatalf("an unknown change type was planned: %+v", plan)
	}
	if len(skipped) != 1 {
		t.Fatalf("expected it to be reported, got %d", len(skipped))
	}
}

// proposedChanges reads the declared "changes" key rather than "whichever
// array the map happens to yield first" — Go randomises map iteration order,
// which is the bug suggestionsArray was written to fix.
func TestProposedChangesReadsTheDeclaredKey(t *testing.T) {
	content := map[string]interface{}{
		"notes":   []interface{}{map[string]interface{}{"type": "reword"}},
		"changes": []interface{}{map[string]interface{}{"type": "move", "factor_id": "f1", "category_key": "weakness"}},
		"zzz":     []interface{}{map[string]interface{}{"type": "merge"}},
	}
	for i := 0; i < 200; i++ {
		got := proposedChanges(content)
		if len(got) != 1 || got[0].Type != "move" || got[0].CategoryKey != "weakness" {
			t.Fatalf("iteration %d read the wrong array: %+v", i, got)
		}
	}
}
