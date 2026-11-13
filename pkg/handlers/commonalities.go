// What keeps coming up across a person's workshops.
//
// UAT 2026-11-14: "The Dashboard page should show commonalities across
// Workshops." A facilitator who runs six sessions a quarter has no way to see
// that four of them raised the same thing — the Knowledge workspace can be
// SEARCHED for a term, which only answers a question you already knew to ask.
//
// IT IS COUNTED, NOT INTERPRETED. A term that appears in the titles of live
// themes and notes in two or more workshops is a fact, and the rows below say
// exactly which workshops and give an example from each. Calling the pattern
// "a systemic capability gap" is a reading, and a reading belongs to the
// assistant under review — the same line this product draws everywhere else.
//
// THE SCOPE IS THE SAME THREE-LEVEL CHECK AS EVERYTHING ELSE. This is a query
// that spans workshops, which is the exact shape of the five leaks found on
// 2026-09-18: Go connects as `postgres` and bypasses RLS, so the scope has to
// be IN the query. It joins BOTH workshop_members and workspace_members, and
// scoping.js asserts that removing a workspace membership empties it.
package handlers

import (
	"context"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Commonality is one thing that came up in more than one workshop.
type Commonality struct {
	// Term is the word the workshops share, as it was most often written.
	Term string `json:"term"`
	// Workshops that raised it, newest first. The LIST, not a count: "four
	// workshops" invites the question "which?", and the answer is right here.
	Workshops []CommonalityWorkshop `json:"workshops"`
	// Mentions across all of them, which distinguishes a passing reference
	// from something a room kept returning to.
	Mentions int `json:"mentions"`
}

type CommonalityWorkshop struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Example is one thing that workshop actually said, so the term is never
	// presented without the words it came from.
	Example string `json:"example"`
}

// commonStopWords are words that say nothing about a workshop's subject.
//
// DELIBERATELY NOT A CLEVER TOKENISER. Stemming, bigrams and tf-idf would all
// be defensible and all be harder to explain to a facilitator who asks why
// "customers" and "customer" counted separately. A plain stopword list and a
// length floor give a result that can be read off the board and checked, and
// when it is wrong it is wrong in an obvious way rather than a subtle one.
var commonStopWords = map[string]bool{
	"the": true, "and": true, "for": true, "with": true, "our": true, "are": true,
	"not": true, "but": true, "that": true, "this": true, "have": true, "has": true,
	"from": true, "they": true, "their": true, "them": true, "can": true, "will": true,
	"more": true, "most": true, "less": true, "some": true, "all": true, "any": true,
	"very": true, "too": true, "than": true, "then": true, "when": true, "what": true,
	"which": true, "who": true, "how": true, "why": true, "into": true, "onto": true,
	"over": true, "under": true, "across": true, "about": true, "being": true,
	"been": true, "was": true, "were": true, "should": true, "would": true,
	"could": true, "may": true, "might": true, "must": true, "need": true, "needs": true,
	"lack": true, "lacks": true, "lot": true, "lots": true, "new": true, "good": true,
	"bad": true, "high": true, "low": true, "many": true, "much": true, "well": true,
	"also": true, "only": true, "still": true, "yet": true, "out": true, "off": true,
	"its": true, "it's": true, "we": true, "us": true, "you": true, "your": true,

	// VERBS AND VAGUE NOUNS THAT CARRY NO SUBJECT MATTER. Added after reading
	// a real run: "Trying out value proposition" and "Trying times for
	// Singapore transformation" shared only "trying", which satisfies the rule
	// and tells a facilitator nothing. The rule is doing its job; the word is
	// not carrying content.
	//
	// This list will never be finished and is not meant to be. It is a
	// judgement about English, kept deliberately short and obvious so that a
	// wrong entry is visible here rather than buried in a scoring function
	// nobody can read.
	"trying": true, "using": true, "making": true, "getting": true, "doing": true,
	"going": true, "take": true, "takes": true, "taking": true, "give": true,
	"gives": true, "put": true, "puts": true, "keep": true, "keeps": true,
	"come": true, "comes": true, "coming": true, "work": true, "works": true,
	"thing": true, "things": true, "way": true, "ways": true, "time": true,
	"times": true, "better": true, "best": true, "worse": true, "worst": true,
	"big": true, "small": true, "large": true, "little": true, "long": true,
	"short": true, "here": true, "there": true, "where": true, "now": true,
	"other": true, "others": true, "same": true, "different": true,
	"testing": true, "test": true, "tests": true,
}

// minCommonTermLen drops "ai" and "it" along with every two-letter fragment.
// Three is low enough to keep "gtm" and "iam" — real terms in these
// workshops — and high enough to drop the noise.
const minCommonTermLen = 3

// loadCommonalities finds terms shared by two or more of the caller's
// workshops.
func loadCommonalities(ctx context.Context, pool *pgxpool.Pool, userID string,
	limit int) ([]Commonality, error) {

	// Live content only. A rejected note is one the room decided against, and
	// counting it would report the opposite of what the workshop concluded.
	rows, err := pool.Query(ctx, `
		select w.id::text, w.name, t.title
		from public.workshops w
		join public.workshop_members wm on wm.workshop_id = w.id and wm.user_id = $1
		join public.workspace_members wsm
		     on wsm.workspace_id = w.workspace_id and wsm.user_id = $1
		join (
		  select workshop_id, title from public.syntheses
		  where state in ('draft','submitted','approved') and title is not null
		  union all
		  select workshop_id, title from public.factors
		  where state in ('draft','submitted','approved')
		) t on t.workshop_id = w.id
		where w.status <> 'archived'`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type termStat struct {
		// Spellings counts how the term was written, so the row shows the
		// form the rooms actually used rather than a lowercased stem.
		spellings map[string]int
		// byWorkshop keeps one example per workshop, and the workshop's name.
		byWorkshop map[string]*CommonalityWorkshop
		order      []string
		mentions   int
	}
	stats := map[string]*termStat{}

	for rows.Next() {
		var wsID, wsName, title string
		if err := rows.Scan(&wsID, &wsName, &title); err != nil {
			return nil, err
		}
		seen := map[string]bool{}
		for _, raw := range splitWords(title) {
			key := strings.ToLower(raw)
			if len(key) < minCommonTermLen || commonStopWords[key] {
				continue
			}
			st, ok := stats[key]
			if !ok {
				st = &termStat{
					spellings:  map[string]int{},
					byWorkshop: map[string]*CommonalityWorkshop{},
				}
				stats[key] = st
			}
			st.spellings[raw]++
			// ONE MENTION PER TITLE. A note repeating a word three times is
			// one thing somebody said, not three.
			if !seen[key] {
				seen[key] = true
				st.mentions++
				if _, have := st.byWorkshop[wsID]; !have {
					st.byWorkshop[wsID] = &CommonalityWorkshop{
						ID: wsID, Name: wsName, Example: title,
					}
					st.order = append(st.order, wsID)
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := []Commonality{}
	for _, st := range stats {
		// TWO WORKSHOPS IS THE WHOLE POINT. A term in one workshop is not a
		// commonality, it is that workshop's content.
		if len(st.byWorkshop) < 2 {
			continue
		}
		c := Commonality{Term: displayTerm(st.spellings), Mentions: st.mentions}
		for _, id := range st.order {
			c.Workshops = append(c.Workshops, *st.byWorkshop[id])
		}
		out = append(out, c)
	}

	// Ranked by how many workshops raised it, then by how often. A term in
	// four workshops is a stronger finding than one mentioned forty times in
	// two — which is the same "two numbers, never one" argument the weights
	// carry, applied to a different pair.
	sort.Slice(out, func(i, j int) bool {
		if len(out[i].Workshops) != len(out[j].Workshops) {
			return len(out[i].Workshops) > len(out[j].Workshops)
		}
		if out[i].Mentions != out[j].Mentions {
			return out[i].Mentions > out[j].Mentions
		}
		return out[i].Term < out[j].Term
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// displayTerm picks how a shared word should be written in the list.
//
// A LIST THAT MIXES CASE LOOKS BROKEN. The first version took the most common
// spelling and broke ties alphabetically, which puts uppercase first in ASCII
// — so a real run produced "market", "base", "data", "Change", "Customer" in
// one column, and the capitals read as emphasis nobody intended.
//
// The rule: if the word is ever written in lower case it is an ordinary noun
// and is shown that way, whatever a sentence-initial capital did to it. A word
// that is capitalised EVERY time it appears is most likely a name — Singapore,
// Jira — and keeps its capital.
func displayTerm(spellings map[string]int) string {
	bestLower, bestLowerN := "", 0
	bestAny, bestAnyN := "", 0
	for spelling, n := range spellings {
		if n > bestAnyN || (n == bestAnyN && spelling < bestAny) {
			bestAny, bestAnyN = spelling, n
		}
		if r := []rune(spelling); len(r) > 0 && !(r[0] >= 'A' && r[0] <= 'Z') {
			if n > bestLowerN || (n == bestLowerN && spelling < bestLower) {
				bestLower, bestLowerN = spelling, n
			}
		}
	}
	if bestLower != "" {
		return bestLower
	}
	return bestAny
}

// splitWords breaks a title into words, keeping intra-word apostrophes and
// hyphens out of the way.
func splitWords(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return false
		}
		return true
	})
}
