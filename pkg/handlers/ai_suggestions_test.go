package handlers

import "testing"

// suggestionsArray must be DETERMINISTIC.
//
// It replaced a version that ranged over the map and took the first array it
// happened to see. Go randomises map iteration order, so with more than one
// array-valued key the answer differed between calls — and the accept path
// resolves the user's clicked INDEX against this array, so the server could
// index a different array than the client displayed and create the wrong
// object. It also made AI failures look intermittent.
//
// 1000 iterations because a non-deterministic version passes a single run
// roughly half the time, which is exactly how this survived before.
func TestSuggestionsArrayIsDeterministic(t *testing.T) {
	content := map[string]interface{}{
		"alpha":  []interface{}{"a1", "a2"},
		"beta":   []interface{}{"b1"},
		"gamma":  []interface{}{"g1", "g2", "g3"},
		"notes":  "a string, not an array",
		"nested": map[string]interface{}{"x": 1},
	}

	first := suggestionsArray(content)
	firstKey := suggestionsKey(content)
	for i := 0; i < 1000; i++ {
		got := suggestionsArray(content)
		if len(got) != len(first) {
			t.Fatalf("iteration %d returned a different array: len %d, want %d", i, len(got), len(first))
		}
		if k := suggestionsKey(content); k != firstKey {
			t.Fatalf("iteration %d chose key %q, want %q", i, k, firstKey)
		}
	}
	// Lexicographically first array key, so both sides can agree without
	// exchanging anything.
	if firstKey != "alpha" {
		t.Errorf("chose %q, want the lexicographically first array key", firstKey)
	}
}

// The client's aiSuggestions applies the same rule; if these two ever
// disagree, accepting a suggestion creates a different one than was shown.
func TestSuggestionsKeyMatchesTheClientRule(t *testing.T) {
	cases := []struct {
		name    string
		content map[string]interface{}
		want    string
	}{
		{"single array", map[string]interface{}{"themes": []interface{}{}}, "themes"},
		{"array plus scalars", map[string]interface{}{
			"relationships": []interface{}{}, "model": "x", "count": 3,
		}, "relationships"},
		{"several arrays picks the first by name", map[string]interface{}{
			"zeta": []interface{}{}, "delta": []interface{}{},
		}, "delta"},
		{"no arrays at all", map[string]interface{}{
			"executive_summary": map[string]interface{}{"title": ""},
		}, ""},
		{"empty object", map[string]interface{}{}, ""},
	}
	for _, c := range cases {
		if got := suggestionsKey(c.content); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// A narrative output has no suggestion array, and must not be treated as an
// empty list of suggestions — that is the executive summary's shape.
func TestSuggestionsArrayOnNarrativeOutput(t *testing.T) {
	content := map[string]interface{}{
		"executive_summary": map[string]interface{}{
			"title": "Q3", "situation_summary": "…",
		},
	}
	if got := suggestionsArray(content); got != nil {
		t.Errorf("got %v, want nil for a narrative output", got)
	}
}
