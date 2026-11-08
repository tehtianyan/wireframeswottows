// Package objects is the registry of reviewable object kinds — synthesis,
// factor_relationship, initiative, insight, recommendation.
//
// Phase 1 showed that a factor's list/create/edit/delete/review handlers are
// almost entirely shape-independent: what varies is the table, a handful of
// columns, and what the object may cite as evidence. Rather than write that
// same code four more times, the variation is described as data here and one
// generic handler set reads it.
//
// Everything in this file is a platform-level constant, NOT methodology
// config. A methodology decides WHICH stages exist and what they cite (that
// lives in methodology_stages.config); this registry describes what an
// insight *is*. Table and column names are therefore fixed identifiers from
// this file and never request input — the generic SQL builder relies on that.
package objects

import (
	"fmt"
	"sort"
)

// Field is a kind-specific column beyond the shared ones. The UI renders its
// form from these rather than hardcoding what a recommendation looks like.
type Field struct {
	Name     string `json:"name"`
	Label    string `json:"label"`
	Type     string `json:"type"` // text | textarea | enum | int
	Required bool   `json:"required"`
	Options  []string `json:"options,omitempty"`
	Help     string `json:"help,omitempty"`
	// Min and Max bound an `int` field. They used to live only inside the
	// label — "Impact (1-10)" — so nothing enforced them and a recommendation
	// could be scored 500 from the form or the API. Sent to the client so the
	// input carries the same bounds the server checks.
	Min *int `json:"min,omitempty"`
	Max *int `json:"max,omitempty"`
}

func intPtr(n int) *int { return &n }

// EvidenceLink is a many-to-many table joining this kind to the kind it cites.
// This is what makes traceability (CLAUDE.md: "Traceability First") structural
// rather than advisory — an insight's supporting themes are rows, not prose.
type EvidenceLink struct {
	CitesKind  string `json:"cites_kind"`
	Table      string `json:"-"`
	SelfCol    string `json:"-"`
	OtherCol   string `json:"-"`
	OtherTable string `json:"-"`
}

// Pairing describes a kind whose evidence is an ordered pair held in its own
// columns rather than a link table — a TOWS relationship pairs one thing
// with another under a relationship type. Kinds without a Pairing simply
// leave it nil and the generic handlers skip those columns entirely.
//
// WHAT IT PAIRS IS METHODOLOGY CONFIGURATION (DECIDED 2026-11-06).
//
// UAT asked for the TOWS matrix to pair THEMES rather than individual factors,
// which follows the participant flow: the room captures strengths, groups them
// into themes and rates those themes, so the thing worth pairing against an
// opportunity theme is a strength theme, not one sticky note.
//
// It could not become the engine's new behaviour, because two other configured
// methodologies use a relate stage over factors — Business Model Canvas pairs
// revenue streams with cost structures, and Transformation Planning declares an
// any-to-any dependency between factors. Changing the engine would have
// silently rewritten both. So `Targets` lists what a relationship MAY join and
// the relate stage's own config picks one with `"pairs": "<registry key>"`,
// defaulting to `DefaultTarget`. A new methodology still needs no code.
type Pairing struct {
	TypeCol string `json:"-"`
	// Keyed by object registry key: "factor", "synthesis".
	Targets map[string]PairTarget `json:"-"`
	// Used when the relate stage's config declares no `pairs`.
	DefaultTarget string `json:"default_target"`
}

// PairTarget is one kind of thing a relationship may join, with the columns
// that hold it and the SQL that answers "which factor category is this?".
type PairTarget struct {
	SourceCol string
	TargetCol string
	// Table holding the endpoints, for the belongs-to-this-workshop check.
	Table string
	// Noun used in validation messages the user reads ("factor", "theme").
	Noun string
	// CategoriesSQL takes ($1 = object id, $2 = workshop id) and returns zero
	// or more factor category ids.
	//
	// A factor HAS a category, so it returns exactly one row. A theme does
	// NOT — `syntheses` has no category column, deliberately: whether a theme
	// may span categories is a methodology question the engine refuses to
	// answer, so the category is DERIVED from the notes the theme cites. That
	// also means it stays correct when notes are regrouped, which a column
	// stamped at creation would not.
	//
	// More than one row is therefore a real state and not an error: a theme
	// holding both strengths and weaknesses has no single category, so it
	// cannot sit in an SO cell. resolvePairing refuses it and says which
	// categories it found, rather than picking one.
	CategoriesSQL string
}

// TargetKeys returns every pair target's registry key in a STABLE order.
//
// Go map iteration is randomised, and the generic SQL builder selects these
// columns positionally — the read path's column list and the scanner's
// destination list have to agree every time or a relationship comes back with
// its endpoints swapped between kinds, intermittently. Sorted, so the order is
// a property of the registry rather than of one process's hash seed.
func (p *Pairing) TargetKeys() []string {
	keys := make([]string, 0, len(p.Targets))
	for k := range p.Targets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// TargetFor returns the pair target a relate stage's config selects.
//
// An unknown `pairs` value falls back to the default rather than failing: the
// value comes from methodology config, and a typo there should not make the
// stage unusable — but it must not invent a table either, which is why only
// registry keys resolve.
func (p *Pairing) TargetFor(pairs string) PairTarget {
	if t, ok := p.Targets[pairs]; ok {
		return t
	}
	return p.Targets[p.DefaultTarget]
}

// ParentRef is CONTAINMENT, and it is deliberately not an EvidenceLink.
//
// The distinction is load-bearing. Evidence is citation: many-to-many, "this
// insight is supported by those themes", and what the traceability chain and
// the report's evidence_chain walk. A parent is structure: one-to-many, "this
// action is part of that initiative", held in a column on the child.
//
// Modelling containment as a link table would have been cheaper — the generic
// machinery already handles those — and wrong in a way that only shows up
// later: a link table cannot say "exactly one", so an action could be filed
// under two initiatives and the matrix would draw it twice, which is the bug
// a factor cited by two themes already has on the capture board.
type ParentRef struct {
	// Column on THIS kind's table.
	Column string `json:"column"`
	// Registry key of the containing kind.
	Kind string `json:"kind"`
	// The parent's table, for the belongs-to-this-workshop check.
	Table string `json:"-"`
}

// HostedRule is "a stage of this type, which declares this config key".
//
// THE CONFIG KEY IS THE POINT, not decoration. Two other methodologies have
// relate stages — Business Model Canvas and Transformation Planning — and
// neither asked for actions inside their cells. A bare "hosted by a relate
// stage" would have silently given both of them a kind they never declared,
// which is the genericity leak this engine's test suite exists to find. With
// `RequiresConfigKey`, hosting is something a methodology OPTS INTO in the
// same jsonb that drives the rest of the screen.
type HostedRule struct {
	StageType string `json:"stage_type"`
	// A key the hosting stage's config must declare. Empty means any stage of
	// that type will do.
	RequiresConfigKey string `json:"requires_config_key,omitempty"`
}

type Kind struct {
	Key   string `json:"key"`
	Table string `json:"-"`
	// Plural URL segment under /workshops/{id}/.
	Route string `json:"route"`
	Label string `json:"label"`
	// Which stage_type renders this kind. The route dispatches on stage type,
	// so this is how a stage finds its object kind without naming it.
	//
	// EMPTY IS A REAL VALUE: `initiative` is created inside another kind's
	// stage and no stage produces it. ByStageType must therefore never match
	// on "" — see the guard there.
	StageType string `json:"stage_type"`
	// HostedBy names stages where this kind may be created even though none
	// of them PRODUCES it. requireStageForKind accepts any of these in
	// addition to StageType.
	HostedBy []HostedRule `json:"hosted_by,omitempty"`
	// TypeCol scopes the kind to a methodology config row, for a kind that is
	// not a Pairing. `initiative` lives in one relationship type — one TOWS
	// quadrant — so it carries the same relationship_type_id a relationship
	// does, without the pair of endpoints.
	TypeCol string `json:"type_col,omitempty"`
	// Ordered means the kind carries `board_position`: a hand-set order a
	// facilitator drags into place. See SetObjectOrder for why that order is
	// authoritative here and is NOT on the capture board.
	Ordered bool `json:"ordered"`
	// Parent is the kind this one is contained by, if any.
	Parent *ParentRef `json:"parent,omitempty"`
	// TitleRequired is false for kinds whose title is optional (a relationship
	// may be identified by its endpoints alone).
	TitleRequired bool `json:"title_required"`
	// HasDescription is false for kinds with no `description` column at all.
	// factor_relationships carries `narrative` instead, so the generic SQL
	// must not select or insert a description for it.
	HasDescription bool `json:"has_description"`
	// DescriptionRequired mirrors the COLUMN's nullability, and it is NOT
	// uniform across the kinds that have one: `insights.description` and
	// `recommendations.description` are `not null`, while
	// `syntheses.description` is nullable (canonical schema). insertObject
	// used to require a description from every kind with HasDescription,
	// justified as "it is NOT NULL for every kind that has one" — which was
	// true of two kinds out of three. The cost landed on the capture board,
	// where stacking two notes asks only for a NAME and could therefore never
	// succeed: "What this theme says is required." A rule the database does
	// not have must not be invented here.
	DescriptionRequired bool   `json:"description_required"`
	DescriptionLabel    string `json:"description_label"`
	Fields           []Field        `json:"fields"`
	Evidence         []EvidenceLink `json:"evidence"`
	Pairing          *Pairing       `json:"pairing,omitempty"`
}

// registry is keyed by Kind.Key.
var registry = map[string]*Kind{
	"synthesis": {
		Key:              "synthesis",
		HasDescription:   true,
		Table:            "syntheses",
		Route:            "syntheses",
		Label:            "Theme",
		StageType:     "synthesize",
		TitleRequired: true,
		// A theme's NAME is the claim ("these notes are the same thing"); the
		// description elaborates on it. The column is nullable and so is this,
		// which is what lets a theme be made by stacking two notes on the
		// capture board with nothing but a name.
		DescriptionRequired: false,
		DescriptionLabel:    "What this theme says",
		Fields:              []Field{},
		Evidence: []EvidenceLink{
			{CitesKind: "factor", Table: "synthesis_factors", SelfCol: "synthesis_id", OtherCol: "factor_id", OtherTable: "factors"},
		},
	},
	"factor_relationship": {
		Key:              "factor_relationship",
		Table:            "factor_relationships",
		Route:            "relationships",
		Label:            "Relationship",
		StageType:        "relate",
		TitleRequired:    false,
		DescriptionLabel: "",
		Fields: []Field{
			{Name: "narrative", Label: "Strategic narrative", Type: "textarea",
				Help: "Why pairing these two factors matters."},
			{Name: "strategic_option", Label: "Strategic option", Type: "textarea",
				Help: "The move this pairing suggests."},
		},
		// A relationship's evidence is the ordered pair in its own columns,
		// not a link table, so it declares a Pairing instead.
		Evidence: []EvidenceLink{},
		Pairing: &Pairing{
			TypeCol:       "relationship_type_id",
			DefaultTarget: "factor",
			Targets: map[string]PairTarget{
				"factor": {
					SourceCol: "source_factor_id",
					TargetCol: "target_factor_id",
					Table:     "factors",
					Noun:      "factor",
					CategoriesSQL: `select factor_category_id::text from public.factors
						where id = $1 and workshop_id = $2`,
				},
				"synthesis": {
					SourceCol: "source_synthesis_id",
					TargetCol: "target_synthesis_id",
					Table:     "syntheses",
					Noun:      "theme",
					// DERIVED, because `syntheses` has no category column. One
					// row means the theme's notes all share a category; several
					// mean it spans them, which resolvePairing reports rather
					// than resolving — see PairTarget.CategoriesSQL.
					CategoriesSQL: `select distinct f.factor_category_id::text
						from public.synthesis_factors sf
						join public.factors f on f.id = sf.factor_id
						where sf.synthesis_id = $1 and f.workshop_id = $2`,
				},
			},
		},
	},
	"insight": {
		Key:              "insight",
		HasDescription:   true,
		Table:            "insights",
		Route:            "insights",
		Label:            "Insight",
		StageType:     "interpret",
		TitleRequired: true,
		// `insights.description` is `not null`.
		DescriptionRequired: true,
		DescriptionLabel:    "What this insight says",
		Fields: []Field{
			{Name: "strategic_significance", Label: "Strategic significance", Type: "textarea",
				Help: "Why this matters to the objective."},
		},
		Evidence: []EvidenceLink{
			{CitesKind: "synthesis", Table: "insight_syntheses", SelfCol: "insight_id", OtherCol: "synthesis_id", OtherTable: "syntheses"},
			{CitesKind: "factor_relationship", Table: "insight_factor_relationships", SelfCol: "insight_id", OtherCol: "factor_relationship_id", OtherTable: "factor_relationships"},
		},
	},
	// A heading in one TOWS quadrant, under which that quadrant's actions sit
	// — "INVEST IN PARTNERS", "BUILD OUT NEW FOCUSSED SALES CAMPAIGNS".
	//
	// ONE PER QUADRANT. The same name appearing in SO and in WO is two
	// initiatives, which is what makes "which quadrant produced this
	// programme" answerable at all.
	//
	// It has no stage of its own: it is created inside the relate stage, so
	// its StageType is empty and HostedBy carries the rule instead. A second
	// kind claiming StageType "relate" would have been the obvious shortcut
	// and is a live bug — ByStageType scans a MAP, whose iteration order Go
	// randomises, so the relate stage would have resolved to a relationship
	// on some requests and to an initiative on others.
	"initiative": {
		Key:            "initiative",
		HasDescription: true,
		Table:          "initiatives",
		Route:          "initiatives",
		Label:          "Initiative",
		StageType:      "",
		HostedBy:       []HostedRule{{StageType: "relate", RequiresConfigKey: "actions"}},
		TypeCol:        "relationship_type_id",
		Ordered:        true,
		TitleRequired:  true,
		// `initiatives.description` is nullable, like `syntheses.description`.
		// The heading IS the claim; the cell collects a name in one keystroke
		// and must not be refused for want of a paragraph.
		DescriptionRequired: false,
		DescriptionLabel:    "What this initiative covers",
		Fields:              []Field{},
		Evidence:            []EvidenceLink{},
	},
	"recommendation": {
		Key:              "recommendation",
		HasDescription:   true,
		Table:            "recommendations",
		Route:            "recommendations",
		Label:            "Recommendation",
		StageType:     "recommend",
		// Created from the matrix cell as well as from the Recommendations
		// stage. The relate rule requires the stage to DECLARE `actions`, so
		// Business Model Canvas and Transformation Planning — both of which
		// have relate stages and neither of which asked for this — are
		// untouched.
		HostedBy:      []HostedRule{{StageType: "relate", RequiresConfigKey: "actions"}},
		Ordered:       true,
		Parent:        &ParentRef{Column: "initiative_id", Kind: "initiative", Table: "initiatives"},
		TitleRequired: true,
		// `recommendations.description` is `not null`.
		DescriptionRequired: true,
		DescriptionLabel:    "What to do",
		Fields: []Field{
			{Name: "priority", Label: "Priority", Type: "enum", Required: true,
				Options: []string{"critical", "high", "medium", "low"}},
			{Name: "benefits", Label: "Expected benefits", Type: "textarea"},
			{Name: "risks", Label: "Risks", Type: "textarea"},
			{Name: "impact_score", Label: "Impact (1-10)", Type: "int",
				Min: intPtr(1), Max: intPtr(10)},
			{Name: "feasibility_score", Label: "Feasibility (1-10)", Type: "int",
				Min: intPtr(1), Max: intPtr(10)},
		},
		Evidence: []EvidenceLink{
			{CitesKind: "insight", Table: "recommendation_insights", SelfCol: "recommendation_id", OtherCol: "insight_id", OtherTable: "insights"},
		},
	},
}

func ByKey(key string) (*Kind, error) {
	k, ok := registry[key]
	if !ok {
		return nil, fmt.Errorf("unknown object kind %q", key)
	}
	return k, nil
}

func ByRoute(route string) (*Kind, error) {
	for _, k := range registry {
		if k.Route == route {
			return k, nil
		}
	}
	return nil, fmt.Errorf("unknown object route %q", route)
}

// ByStageType finds the kind a stage of this type PRODUCES.
//
// Produces, not hosts: a relate stage produces relationships and hosts
// initiatives and actions, and the three callers (AI context, the dashboard
// and derived stage status) all want the first. HostedBy is deliberately not
// consulted here.
//
// The empty stage type matches nothing. `initiative` declares StageType "",
// and without this guard a lookup for a stage type no kind produces would
// return it — from a map, so intermittently.
func ByStageType(stageType string) (*Kind, error) {
	if stageType == "" {
		return nil, fmt.Errorf("no object kind for an empty stage type")
	}
	for _, k := range registry {
		if k.StageType == stageType {
			return k, nil
		}
	}
	return nil, fmt.Errorf("no object kind for stage type %q", stageType)
}

// StageRules lists every way this kind may reach a stage: the type that
// produces it (with no config condition), plus each hosting rule.
func (k *Kind) StageRules() []HostedRule {
	out := []HostedRule{}
	if k.StageType != "" {
		out = append(out, HostedRule{StageType: k.StageType})
	}
	return append(out, k.HostedBy...)
}

// StageTypeNames is the human list for a refusal message.
func (k *Kind) StageTypeNames() []string {
	seen := map[string]bool{}
	out := []string{}
	for _, rule := range k.StageRules() {
		if seen[rule.StageType] {
			continue
		}
		seen[rule.StageType] = true
		out = append(out, rule.StageType)
	}
	return out
}

// All returns every kind, for the /object-kinds catalogue the UI renders
// its forms from.
func All() []*Kind {
	out := make([]*Kind, 0, len(registry))
	// Stable order so the catalogue response doesn't churn between calls.
	for _, key := range []string{"synthesis", "factor_relationship", "initiative", "insight", "recommendation"} {
		if k, ok := registry[key]; ok {
			out = append(out, k)
		}
	}
	return out
}

// EvidenceFor returns the link definition by cited kind, if this kind may
// cite it at all.
func (k *Kind) EvidenceFor(citesKind string) *EvidenceLink {
	for i := range k.Evidence {
		if k.Evidence[i].CitesKind == citesKind {
			return &k.Evidence[i]
		}
	}
	return nil
}

// FieldNames lists the kind-specific column names, for SELECT and INSERT.
func (k *Kind) FieldNames() []string {
	out := make([]string, 0, len(k.Fields))
	for _, f := range k.Fields {
		out = append(out, f.Name)
	}
	return out
}

func (k *Kind) Field(name string) *Field {
	for i := range k.Fields {
		if k.Fields[i].Name == name {
			return &k.Fields[i]
		}
	}
	return nil
}
