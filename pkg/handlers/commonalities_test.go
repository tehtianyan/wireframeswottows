package handlers

import "testing"

// A LIST THAT MIXES CASE LOOKS BROKEN, and the first version produced one:
// most-common-spelling with an alphabetical tiebreak puts uppercase first in
// ASCII, so a real run showed "market", "base", "data", "Change", "Customer"
// in a single column and the capitals read as emphasis nobody intended.
func TestDisplayTermPrefersTheOrdinaryWord(t *testing.T) {
	cases := []struct {
		name      string
		spellings map[string]int
		want      string
	}{
		{
			// Written lower case even once: an ordinary noun that happened to
			// start a sentence elsewhere.
			name:      "sentence-initial capital does not win",
			spellings: map[string]int{"Customer": 3, "customer": 1},
			want:      "customer",
		},
		{
			name:      "already lower case",
			spellings: map[string]int{"market": 4},
			want:      "market",
		},
		{
			// ALWAYS capitalised: most likely a name, and lower-casing
			// "Singapore" would be worse than the inconsistency being fixed.
			name:      "a word that is always capitalised keeps its capital",
			spellings: map[string]int{"Singapore": 2},
			want:      "Singapore",
		},
		{
			// Two capitalisations of ONE word, equally common and neither
			// lower case. Go randomises map iteration, so without a tiebreak
			// the same data would render differently on different requests.
			name:      "a tie between capitalisations is resolved, not left to map order",
			spellings: map[string]int{"IAM": 2, "Iam": 2},
			want:      "IAM",
		},
	}
	for _, c := range cases {
		if got := displayTerm(c.spellings); got != c.want {
			t.Errorf("%s: displayTerm(%v) = %q, want %q", c.name, c.spellings, got, c.want)
		}
	}
}

// The stopword list is a judgement about English and will never be finished.
// What must hold is that it is applied at all, and that it does not swallow
// the short technical terms these workshops actually use.
func TestStopWordsKeepRealTerms(t *testing.T) {
	for _, w := range []string{"the", "and", "trying", "testing", "better", "thing"} {
		if !commonStopWords[w] {
			t.Errorf("%q should be a stop word — it tells a facilitator nothing", w)
		}
	}
	for _, w := range []string{"churn", "iam", "gtm", "partner", "pricing", "latency"} {
		if commonStopWords[w] {
			t.Errorf("%q is a real term in these workshops and must survive", w)
		}
		if len(w) < minCommonTermLen {
			t.Errorf("%q is shorter than the length floor and would be dropped", w)
		}
	}
}

func TestSplitWordsBreaksOnPunctuation(t *testing.T) {
	got := splitWords("Low-touch pricing, and the AE's margin (2026)")
	want := []string{"Low", "touch", "pricing", "and", "the", "AE", "s", "margin", "2026"}
	if len(got) != len(want) {
		t.Fatalf("splitWords gave %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("word %d was %q, want %q", i, got[i], want[i])
		}
	}
}
