package weights

import "testing"

func ptr(f float64) *float64 { return &f }

// The engine must not assume a range. These are the scales the seven seeded
// methodologies use plus two deliberately awkward ones, and every bound here
// comes from a config column rather than a constant in the code.
func TestValidateValueAcrossScales(t *testing.T) {
	vote := &Definition{Name: "Priority votes", ScaleMin: 0, ScaleMax: nil, ScaleStep: 1}
	maturity := &Definition{Name: "Current maturity", ScaleMin: 1, ScaleMax: ptr(5), ScaleStep: 1}
	percent := &Definition{Name: "Coverage", ScaleMin: 0, ScaleMax: ptr(100), ScaleStep: 5}
	bipolar := &Definition{Name: "Alignment", ScaleMin: -3, ScaleMax: ptr(3), ScaleStep: 1}
	fractional := &Definition{Name: "Weighting", ScaleMin: 0, ScaleMax: ptr(1), ScaleStep: 0.1}

	cases := []struct {
		name string
		def  *Definition
		val  float64
		ok   bool
	}{
		{"an unbounded vote accepts a large allocation", vote, 17, true},
		{"a vote cannot go below its minimum", vote, -1, false},

		{"maturity accepts its lower bound", maturity, 1, true},
		{"maturity accepts its upper bound", maturity, 5, true},
		{"maturity refuses zero, because its scale starts at one", maturity, 0, false},
		{"maturity refuses six", maturity, 6, false},
		{"maturity refuses a half step", maturity, 2.5, false},

		{"a percentage accepts a value on its step", percent, 65, true},
		{"a percentage accepts its upper bound", percent, 100, true},
		{"a percentage refuses a value between steps", percent, 67, false},

		{"a bipolar scale accepts a negative value", bipolar, -3, true},
		{"a bipolar scale accepts zero", bipolar, 0, true},
		{"a bipolar scale refuses beyond its bound", bipolar, 4, false},

		// Binary floating point makes 0.3 an awkward case; the step check is
		// relative rather than exact for exactly this reason.
		{"a fractional step accepts 0.3", fractional, 0.3, true},
		{"a fractional step accepts 0.7", fractional, 0.7, true},
		{"a fractional step refuses 0.35", fractional, 0.35, false},
	}

	for _, c := range cases {
		msg := c.def.ValidateValue(c.val)
		if c.ok && msg != "" {
			t.Errorf("%s: rejected %v with %q", c.name, c.val, msg)
		}
		if !c.ok && msg == "" {
			t.Errorf("%s: accepted %v, should have been refused", c.name, c.val)
		}
	}
}

// An error a person reads must quote the configured bound, not a number the
// code invented, and must not gain decimal places the config never had.
func TestValidateValueMessagesQuoteTheConfiguredBounds(t *testing.T) {
	d := &Definition{Name: "Likelihood", ScaleMin: 1, ScaleMax: ptr(5), ScaleStep: 1}
	if got, want := d.ValidateValue(9), "Likelihood cannot be above 5."; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got, want := d.ValidateValue(0), "Likelihood cannot be below 1."; got != want {
		t.Errorf("got %q, want %q", got, want)
	}

	step := &Definition{Name: "Coverage", ScaleMin: 0, ScaleMax: ptr(100), ScaleStep: 2.5}
	if got, want := step.ValidateValue(3), "Coverage moves in steps of 2.5."; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestSteps(t *testing.T) {
	cases := []struct {
		def  *Definition
		want int
	}{
		{&Definition{ScaleMin: 1, ScaleMax: ptr(5), ScaleStep: 1}, 5},
		{&Definition{ScaleMin: 0, ScaleMax: ptr(100), ScaleStep: 5}, 21},
		{&Definition{ScaleMin: -3, ScaleMax: ptr(3), ScaleStep: 1}, 7},
		// Unbounded: a vote has no step count, which is how the UI knows to
		// render a stepper rather than a scale picker.
		{&Definition{ScaleMin: 0, ScaleMax: nil, ScaleStep: 1}, 0},
	}
	for _, c := range cases {
		if got := c.def.Steps(); got != c.want {
			t.Errorf("Steps() = %d, want %d", got, c.want)
		}
	}
}

// Ordinal labels are how ISO 31000's Rare..Almost certain reaches the screen
// without the code knowing the words or how many there are.
func TestLabel(t *testing.T) {
	d := &Definition{
		ScaleMin: 1, ScaleMax: ptr(5), ScaleStep: 1,
		ScaleLabels: []string{"Rare", "Unlikely", "Possible", "Likely", "Almost certain"},
	}
	if got := d.Label(1); got != "Rare" {
		t.Errorf("Label(1) = %q, want Rare", got)
	}
	if got := d.Label(5); got != "Almost certain" {
		t.Errorf("Label(5) = %q, want Almost certain", got)
	}
	if got := d.Label(9); got != "" {
		t.Errorf("Label(9) = %q, want empty for an out-of-range value", got)
	}

	unlabelled := &Definition{ScaleMin: 0, ScaleStep: 1}
	if got := unlabelled.Label(2); got != "" {
		t.Errorf("Label on an unlabelled scale = %q, want empty", got)
	}
}

// A scale that starts below zero must still label correctly, since the offset
// is from the minimum rather than from zero.
func TestLabelOnANegativeScale(t *testing.T) {
	d := &Definition{
		ScaleMin: -2, ScaleMax: ptr(2), ScaleStep: 1,
		ScaleLabels: []string{"Much worse", "Worse", "Same", "Better", "Much better"},
	}
	if got := d.Label(-2); got != "Much worse" {
		t.Errorf("Label(-2) = %q, want Much worse", got)
	}
	if got := d.Label(0); got != "Same" {
		t.Errorf("Label(0) = %q, want Same", got)
	}
}

func TestAllowsRole(t *testing.T) {
	vote := &Definition{AllowedRoles: []string{"facilitator", "participant", "analyst"}}
	rating := &Definition{AllowedRoles: []string{"facilitator", "analyst"}}

	if !vote.AllowsRole("participant") {
		t.Error("participants must be able to vote")
	}
	if rating.AllowsRole("participant") {
		t.Error("a rating restricted to facilitators and analysts must refuse a participant")
	}
	if rating.AllowsRole("executive") {
		t.Error("executive viewers must never set a weight")
	}
}

// ForKind is what lets one stage render only the weights its objects carry.
func TestForKind(t *testing.T) {
	defs := []Definition{
		{Key: "vote", AppliesTo: "factor"},
		{Key: "likelihood", AppliesTo: "factor"},
		{Key: "intensity", AppliesTo: "synthesis"},
	}
	if got := len(ForKind(defs, "factor")); got != 2 {
		t.Errorf("ForKind(factor) returned %d, want 2", got)
	}
	if got := len(ForKind(defs, "synthesis")); got != 1 {
		t.Errorf("ForKind(synthesis) returned %d, want 1", got)
	}
	// A kind with no weights must yield an empty slice, not nil: a nil slice
	// marshals to JSON null and the client reads this as an array.
	empty := ForKind(defs, "insight")
	if empty == nil {
		t.Error("ForKind returned nil, which marshals to null and breaks the client")
	}
	if len(empty) != 0 {
		t.Errorf("ForKind(insight) returned %d, want 0", len(empty))
	}
}
