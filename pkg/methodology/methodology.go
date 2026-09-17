// Package methodology loads a methodology's full configuration (stages,
// factor categories, relationship types, AI prompts) so every handler can
// behave generically instead of hardcoding SWOT-TOWS. This is what every
// other handler depends on.
package methodology

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type FactorCategory struct {
	ID           string `json:"id"`
	Key          string `json:"key"`
	Name         string `json:"name"`
	ColorToken   string `json:"color_token"`
	SortOrder    int    `json:"sort_order"`
	GuidanceText string `json:"guidance_text"`
}

type Stage struct {
	ID             string                 `json:"id"`
	Key            string                 `json:"key"`
	Name           string                 `json:"name"`
	SequenceNumber int                    `json:"sequence_number"`
	StageType      string                 `json:"stage_type"`
	Config         map[string]interface{} `json:"config"`
}

type RelationshipType struct {
	ID               string `json:"id"`
	Key              string `json:"key"`
	Name             string `json:"name"`
	SourceCategoryID string `json:"source_category_id"`
	TargetCategoryID string `json:"target_category_id"`
	GuidanceText     string `json:"guidance_text"`
}

type AIPrompt struct {
	ID          string  `json:"id"`
	FunctionKey string  `json:"function_key"`
	StageID     *string `json:"stage_id"`
	// StageType applies a prompt to every stage of that type, so one
	// `capture` prompt serves all four SWOT discovery stages and all six of
	// PESTLE's. Empty means the function is available workshop-wide.
	StageType      string `json:"stage_type"`
	Name           string `json:"name"`
	PromptTemplate string `json:"prompt_template"`
	OutputSchema   string `json:"output_schema"`
	PromptVersion  string `json:"prompt_version"`
}

type Methodology struct {
	ID                string             `json:"id"`
	Key               string             `json:"key"`
	Name              string             `json:"name"`
	FactorCategories  []FactorCategory   `json:"factor_categories"`
	Stages            []Stage            `json:"stages"`
	RelationshipTypes []RelationshipType `json:"relationship_types"`
	AIPrompts         []AIPrompt         `json:"-"` // never serialized to the client
}

func (m *Methodology) StageByKey(key string) *Stage {
	for i := range m.Stages {
		if m.Stages[i].Key == key {
			return &m.Stages[i]
		}
	}
	return nil
}

func (m *Methodology) CategoryByKey(key string) *FactorCategory {
	for i := range m.FactorCategories {
		if m.FactorCategories[i].Key == key {
			return &m.FactorCategories[i]
		}
	}
	return nil
}

func (m *Methodology) CategoryByID(id string) *FactorCategory {
	for i := range m.FactorCategories {
		if m.FactorCategories[i].ID == id {
			return &m.FactorCategories[i]
		}
	}
	return nil
}

func (m *Methodology) PromptByFunctionKey(key string) *AIPrompt {
	for i := range m.AIPrompts {
		if m.AIPrompts[i].FunctionKey == key {
			return &m.AIPrompts[i]
		}
	}
	return nil
}

// LoadForWorkshop resolves a workshop's methodology_id, then loads its full config.
func LoadForWorkshop(ctx context.Context, pool *pgxpool.Pool, workshopID string) (*Methodology, error) {
	var methodologyID string
	err := pool.QueryRow(ctx, `select methodology_id from public.workshops where id = $1`, workshopID).Scan(&methodologyID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("workshop not found")
		}
		return nil, fmt.Errorf("resolving workshop methodology: %w", err)
	}
	return Load(ctx, pool, methodologyID)
}

func Load(ctx context.Context, pool *pgxpool.Pool, methodologyID string) (*Methodology, error) {
	// Initialised rather than left nil: a nil slice marshals to JSON `null`,
	// and the client reads these as arrays. A methodology with no relationship
	// types (PESTLE has none) would otherwise crash the matrix on
	// `relationship_types.length`.
	m := &Methodology{
		FactorCategories:  []FactorCategory{},
		Stages:            []Stage{},
		RelationshipTypes: []RelationshipType{},
		AIPrompts:         []AIPrompt{},
	}
	err := pool.QueryRow(ctx,
		`select id, key, name from public.methodologies where id = $1`, methodologyID,
	).Scan(&m.ID, &m.Key, &m.Name)
	if err != nil {
		return nil, fmt.Errorf("loading methodology: %w", err)
	}

	catRows, err := pool.Query(ctx,
		`select id, key, name, coalesce(color_token,''), sort_order, coalesce(guidance_text,'')
		 from public.methodology_factor_categories where methodology_id = $1 order by sort_order`,
		methodologyID)
	if err != nil {
		return nil, fmt.Errorf("loading factor categories: %w", err)
	}
	defer catRows.Close()
	for catRows.Next() {
		var c FactorCategory
		if err := catRows.Scan(&c.ID, &c.Key, &c.Name, &c.ColorToken, &c.SortOrder, &c.GuidanceText); err != nil {
			return nil, err
		}
		m.FactorCategories = append(m.FactorCategories, c)
	}

	stageRows, err := pool.Query(ctx,
		`select id, key, name, sequence_number, stage_type, config
		 from public.methodology_stages where methodology_id = $1 order by sequence_number`,
		methodologyID)
	if err != nil {
		return nil, fmt.Errorf("loading stages: %w", err)
	}
	defer stageRows.Close()
	for stageRows.Next() {
		var s Stage
		var configRaw []byte
		if err := stageRows.Scan(&s.ID, &s.Key, &s.Name, &s.SequenceNumber, &s.StageType, &configRaw); err != nil {
			return nil, err
		}
		if len(configRaw) > 0 {
			_ = json.Unmarshal(configRaw, &s.Config)
		}
		m.Stages = append(m.Stages, s)
	}

	relRows, err := pool.Query(ctx,
		`select id, key, name, coalesce(source_category_id::text,''), coalesce(target_category_id::text,''), coalesce(guidance_text,'')
		 from public.methodology_relationship_types where methodology_id = $1`,
		methodologyID)
	if err != nil {
		return nil, fmt.Errorf("loading relationship types: %w", err)
	}
	defer relRows.Close()
	for relRows.Next() {
		var r RelationshipType
		if err := relRows.Scan(&r.ID, &r.Key, &r.Name, &r.SourceCategoryID, &r.TargetCategoryID, &r.GuidanceText); err != nil {
			return nil, err
		}
		m.RelationshipTypes = append(m.RelationshipTypes, r)
	}

	promptRows, err := pool.Query(ctx,
		`select id, function_key, stage_id::text, coalesce(stage_type, ''), name,
		        prompt_template, coalesce(output_schema::text, ''), coalesce(prompt_version, '')
		 from public.methodology_ai_prompts where methodology_id = $1 order by function_key`,
		methodologyID)
	if err != nil {
		return nil, fmt.Errorf("loading ai prompts: %w", err)
	}
	defer promptRows.Close()
	for promptRows.Next() {
		var p AIPrompt
		var stageID *string
		if err := promptRows.Scan(&p.ID, &p.FunctionKey, &stageID, &p.StageType, &p.Name,
			&p.PromptTemplate, &p.OutputSchema, &p.PromptVersion); err != nil {
			return nil, err
		}
		p.StageID = stageID
		m.AIPrompts = append(m.AIPrompts, p)
	}

	return m, nil
}
