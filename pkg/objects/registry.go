// Package objects is the registry of reviewable object kinds — synthesis,
// factor_relationship, insight, recommendation.
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

import "fmt"

// Field is a kind-specific column beyond the shared ones. The UI renders its
// form from these rather than hardcoding what a recommendation looks like.
type Field struct {
	Name     string `json:"name"`
	Label    string `json:"label"`
	Type     string `json:"type"` // text | textarea | enum | int
	Required bool   `json:"required"`
	Options  []string `json:"options,omitempty"`
	Help     string `json:"help,omitempty"`
}

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
// columns rather than a link table — a TOWS relationship pairs one factor
// with another under a relationship type. Kinds without a Pairing simply
// leave it nil and the generic handlers skip those columns entirely.
type Pairing struct {
	SourceCol  string `json:"-"`
	TargetCol  string `json:"-"`
	TypeCol    string `json:"-"`
	PairsTable string `json:"-"` // table both endpoints live in
	PairsKind  string `json:"pairs_kind"`
}

type Kind struct {
	Key   string `json:"key"`
	Table string `json:"-"`
	// Plural URL segment under /workshops/{id}/.
	Route string `json:"route"`
	Label string `json:"label"`
	// Which stage_type renders this kind. The route dispatches on stage type,
	// so this is how a stage finds its object kind without naming it.
	StageType string `json:"stage_type"`
	// TitleRequired is false for kinds whose title is optional (a relationship
	// may be identified by its endpoints alone).
	TitleRequired bool `json:"title_required"`
	// HasDescription is false for kinds with no `description` column at all.
	// factor_relationships carries `narrative` instead, so the generic SQL
	// must not select or insert a description for it.
	HasDescription   bool           `json:"has_description"`
	DescriptionLabel string         `json:"description_label"`
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
		StageType:        "synthesize",
		TitleRequired:    true,
		DescriptionLabel: "What this theme says",
		Fields:           []Field{},
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
			SourceCol:  "source_factor_id",
			TargetCol:  "target_factor_id",
			TypeCol:    "relationship_type_id",
			PairsTable: "factors",
			PairsKind:  "factor",
		},
	},
	"insight": {
		Key:              "insight",
		HasDescription:   true,
		Table:            "insights",
		Route:            "insights",
		Label:            "Insight",
		StageType:        "interpret",
		TitleRequired:    true,
		DescriptionLabel: "What this insight says",
		Fields: []Field{
			{Name: "strategic_significance", Label: "Strategic significance", Type: "textarea",
				Help: "Why this matters to the objective."},
		},
		Evidence: []EvidenceLink{
			{CitesKind: "synthesis", Table: "insight_syntheses", SelfCol: "insight_id", OtherCol: "synthesis_id", OtherTable: "syntheses"},
			{CitesKind: "factor_relationship", Table: "insight_factor_relationships", SelfCol: "insight_id", OtherCol: "factor_relationship_id", OtherTable: "factor_relationships"},
		},
	},
	"recommendation": {
		Key:              "recommendation",
		HasDescription:   true,
		Table:            "recommendations",
		Route:            "recommendations",
		Label:            "Recommendation",
		StageType:        "recommend",
		TitleRequired:    true,
		DescriptionLabel: "What to do",
		Fields: []Field{
			{Name: "priority", Label: "Priority", Type: "enum", Required: true,
				Options: []string{"critical", "high", "medium", "low"}},
			{Name: "benefits", Label: "Expected benefits", Type: "textarea"},
			{Name: "risks", Label: "Risks", Type: "textarea"},
			{Name: "impact_score", Label: "Impact (1-10)", Type: "int"},
			{Name: "feasibility_score", Label: "Feasibility (1-10)", Type: "int"},
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

// ByStageType finds the kind a stage of this type produces.
func ByStageType(stageType string) (*Kind, error) {
	for _, k := range registry {
		if k.StageType == stageType {
			return k, nil
		}
	}
	return nil, fmt.Errorf("no object kind for stage type %q", stageType)
}

// All returns every kind, for the /object-kinds catalogue the UI renders
// its forms from.
func All() []*Kind {
	out := make([]*Kind, 0, len(registry))
	// Stable order so the catalogue response doesn't churn between calls.
	for _, key := range []string{"synthesis", "factor_relationship", "insight", "recommendation"} {
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
