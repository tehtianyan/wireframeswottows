// Context assembly and output handling for the AI assistant.
//
// The important idea: what context a stage's AI needs is ALREADY declared in
// methodology config, by the same `factor_category_key` / `groups` / `cites`
// keys the Phase 2 evidence board reads. So nothing here needs a per-function
// list of inputs, and a new methodology's AI gets the right context for free.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/methodology"
	"swot-tows/pkg/objects"
)

// buildAIContext gathers only what the stage declares it works from, and only
// from this workshop (App Spec §12.24: the assistant may not see data outside
// the user's authorized workspace).
func buildAIContext(ctx context.Context, pool *pgxpool.Pool, m *methodology.Methodology,
	stage *methodology.Stage, workshopID string) (map[string]interface{}, error) {

	out := map[string]interface{}{}
	if stage == nil {
		// A global function (workshop summary, challenge) gets the headline
		// objects rather than a stage's narrow slice.
		factors, err := fetchFactorContext(ctx, pool, workshopID, "")
		if err != nil {
			return nil, err
		}
		out["factors"] = factors
		for _, kindKey := range []string{"synthesis", "insight", "recommendation"} {
			k, err := objects.ByKey(kindKey)
			if err != nil {
				continue
			}
			items, err := fetchObjectContext(ctx, pool, k, workshopID)
			if err != nil {
				return nil, err
			}
			out[k.Route] = items
		}
		return out, nil
	}

	// A capture stage works from what has already been captured in its own
	// category — that is what "don't duplicate these" means.
	if catKey, _ := stage.Config["factor_category_key"].(string); catKey != "" {
		factors, err := fetchFactorContext(ctx, pool, workshopID, catKey)
		if err != nil {
			return nil, err
		}
		out["existing_factors"] = factors
	}

	// Everything else works from what it is configured to cite.
	cites := citedKindKeys(stage)
	for _, citeKind := range cites {
		if citeKind == "factor" {
			factors, err := fetchFactorContext(ctx, pool, workshopID, "")
			if err != nil {
				return nil, err
			}
			out["factors"] = factors
			continue
		}
		k, err := objects.ByKey(citeKind)
		if err != nil {
			continue
		}
		items, err := fetchObjectContext(ctx, pool, k, workshopID)
		if err != nil {
			return nil, err
		}
		out[k.Route] = items
	}

	// A relate stage needs the factors to pair AND the pairing rules, both
	// from config.
	if stage.StageType == "relate" {
		factors, err := fetchFactorContext(ctx, pool, workshopID, "")
		if err != nil {
			return nil, err
		}
		out["factors"] = factors

		types := []map[string]interface{}{}
		for _, rt := range m.RelationshipTypes {
			entry := map[string]interface{}{"key": rt.Key, "name": rt.Name, "guidance": rt.GuidanceText}
			if c := m.CategoryByID(rt.SourceCategoryID); c != nil {
				entry["source_category"] = c.Key
			}
			if c := m.CategoryByID(rt.TargetCategoryID); c != nil {
				entry["target_category"] = c.Key
			}
			types = append(types, entry)
		}
		out["relationship_types"] = types
	}

	return out, nil
}

// citedKindKeys mirrors the front end's citedKinds(): `cites` as a list, or a
// synthesize stage's single `groups` value.
func citedKindKeys(stage *methodology.Stage) []string {
	if raw, ok := stage.Config["cites"].([]interface{}); ok {
		out := make([]string, 0, len(raw))
		for _, v := range raw {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	if s, ok := stage.Config["groups"].(string); ok && s != "" {
		return []string{s}
	}
	return nil
}

func fetchFactorContext(ctx context.Context, pool *pgxpool.Pool, workshopID, categoryKey string) ([]map[string]interface{}, error) {
	query := `
		select f.id, mfc.key, f.title, coalesce(f.description, ''), f.state,
		       coalesce((select sum(v.vote_value) from public.votes v where v.factor_id = f.id), 0)
		from public.factors f
		join public.methodology_factor_categories mfc on mfc.id = f.factor_category_id
		where f.workshop_id = $1 and f.state <> 'rejected'`
	args := []interface{}{workshopID}
	if categoryKey != "" {
		args = append(args, categoryKey)
		query += ` and mfc.key = $2`
	}
	query += ` order by 6 desc, f.created_at limit 200`

	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []map[string]interface{}{}
	for rows.Next() {
		var id, cat, title, desc, state string
		var votes int
		if err := rows.Scan(&id, &cat, &title, &desc, &state, &votes); err != nil {
			return nil, err
		}
		out = append(out, map[string]interface{}{
			"id": id, "category": cat, "title": title,
			"description": desc, "state": state, "votes": votes,
		})
	}
	return out, nil
}

func fetchObjectContext(ctx context.Context, pool *pgxpool.Pool, kind *objects.Kind, workshopID string) ([]map[string]interface{}, error) {
	cols := []string{"id", "title"}
	if kind.HasDescription {
		cols = append(cols, "description")
	}
	cols = append(cols, "state")
	rows, err := pool.Query(ctx, fmt.Sprintf(
		`select %s from public.%s where workshop_id = $1 and state <> 'rejected' order by created_at limit 200`,
		strings.Join(cols, ", "), kind.Table), workshopID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []map[string]interface{}{}
	for rows.Next() {
		var id string
		var title, desc *string
		var state string
		dest := []interface{}{&id, &title}
		if kind.HasDescription {
			dest = append(dest, &desc)
		}
		dest = append(dest, &state)
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		entry := map[string]interface{}{"id": id, "state": state}
		if title != nil {
			entry["title"] = *title
		}
		if desc != nil {
			entry["description"] = *desc
		}
		out = append(out, entry)
	}
	return out, nil
}

// buildUserPrompt renders the configured template and appends the context as
// JSON, with an explicit instruction to use only what is supplied.
func buildUserPrompt(prompt *methodology.AIPrompt, vars map[string]string, promptCtx map[string]interface{}) string {
	rendered := prompt.PromptTemplate
	for k, v := range vars {
		rendered = strings.ReplaceAll(rendered, "{{"+k+"}}", v)
	}

	ctxJSON, _ := json.MarshalIndent(promptCtx, "", "  ")
	var b strings.Builder
	b.WriteString(rendered)
	b.WriteString("\n\nWorkshop context (use ONLY this data; do not invent anything beyond it):\n")
	b.Write(ctxJSON)
	if prompt.OutputSchema != "" {
		b.WriteString("\n\nReturn a single JSON object matching this shape exactly, and nothing else:\n")
		b.WriteString(prompt.OutputSchema)
	}
	b.WriteString("\n\nEvery id you reference must come from the context above.")
	return b.String()
}

// validateAIOutput applies the §12.30 checklist that can be checked
// server-side: confidence scores in range, and every referenced id belongs to
// this workshop. Returns a non-empty reason when the output must be discarded.
func validateAIOutput(ctx context.Context, pool *pgxpool.Pool, workshopID string, content map[string]interface{}) string {
	if content == nil {
		return "empty output"
	}
	items := firstArray(content)

	for _, raw := range items {
		item, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		for key, v := range item {
			if key == "confidence_score" {
				if f, ok := v.(float64); ok && (f < 0 || f > 1) {
					return fmt.Sprintf("confidence_score %v is outside [0,1]", f)
				}
				continue
			}
			// Any *_id or *_ids value must name something in this workshop.
			if strings.HasSuffix(key, "_ids") {
				list, ok := v.([]interface{})
				if !ok {
					continue
				}
				for _, idRaw := range list {
					if id, ok := idRaw.(string); ok && id != "" {
						if !idInWorkshop(ctx, pool, workshopID, id) {
							return "output referenced an id that is not in this workshop"
						}
					}
				}
			} else if strings.HasSuffix(key, "_id") {
				if id, ok := v.(string); ok && id != "" {
					if !idInWorkshop(ctx, pool, workshopID, id) {
						return "output referenced an id that is not in this workshop"
					}
				}
			}
		}
	}
	return ""
}

// idInWorkshop checks an id against every table an AI output may legitimately
// reference. A model that invents a plausible UUID fails here.
func idInWorkshop(ctx context.Context, pool *pgxpool.Pool, workshopID, id string) bool {
	tables := []string{"factors", "syntheses", "factor_relationships", "insights", "recommendations"}
	for _, t := range tables {
		var exists bool
		if err := pool.QueryRow(ctx, fmt.Sprintf(
			`select exists(select 1 from public.%s where id::text = $1 and workshop_id = $2)`, t),
			id, workshopID).Scan(&exists); err == nil && exists {
			return true
		}
	}
	return false
}

// firstArray returns the first array value in the output object. Each seeded
// schema wraps its list under a single key ("suggestions", "themes",
// "relationships"...), so this avoids needing that key per function.
func firstArray(content map[string]interface{}) []interface{} {
	for _, v := range content {
		if arr, ok := v.([]interface{}); ok {
			return arr
		}
	}
	return nil
}

// suggestionToObjectInput maps one suggestion onto the generic object shape,
// using the kind's own field list rather than knowledge of the function.
//
// Convention in the seeded schemas: `title` and `description` are shared,
// anything matching a kind field name is that field, and `*_ids` keys name
// the evidence (supporting_factor_ids -> factor).
func suggestionToObjectInput(kind *objects.Kind, item map[string]interface{}) *writeObjectBody {
	body := &writeObjectBody{Fields: map[string]interface{}{}, Evidence: map[string][]string{}}

	if s, ok := item["title"].(string); ok && strings.TrimSpace(s) != "" {
		t := strings.TrimSpace(s)
		body.Title = &t
	}
	if s, ok := item["description"].(string); ok && strings.TrimSpace(s) != "" {
		d := strings.TrimSpace(s)
		body.Description = &d
	}

	for _, f := range kind.Fields {
		if v, ok := item[f.Name]; ok && v != nil {
			body.Fields[f.Name] = v
		}
	}

	for key, v := range item {
		if !strings.HasSuffix(key, "_ids") {
			continue
		}
		citeKind := strings.TrimSuffix(strings.TrimPrefix(key, "supporting_"), "_ids")
		if kind.EvidenceFor(citeKind) == nil {
			continue
		}
		list, ok := v.([]interface{})
		if !ok {
			continue
		}
		ids := []string{}
		for _, raw := range list {
			if id, ok := raw.(string); ok && id != "" {
				ids = append(ids, id)
			}
		}
		body.Evidence[citeKind] = ids
	}

	if kind.Pairing != nil {
		if s, ok := item["source_factor_id"].(string); ok && s != "" {
			body.SourceID = &s
		}
		if s, ok := item["target_factor_id"].(string); ok && s != "" {
			body.TargetID = &s
		}
		if s, ok := item["relationship_type_key"].(string); ok && s != "" {
			body.RelationshipTypeKey = &s
		}
	}
	return body
}

// applyOverrides lets a human edit a suggestion before accepting it — the
// difference between "accepted" and "edited" in App Spec §12.19.
func applyOverrides(base *writeObjectBody, ov *writeObjectBody) {
	if ov.Title != nil {
		base.Title = ov.Title
	}
	if ov.Description != nil {
		base.Description = ov.Description
	}
	for k, v := range ov.Fields {
		base.Fields[k] = v
	}
	for k, v := range ov.Evidence {
		base.Evidence[k] = v
	}
	if ov.SourceID != nil {
		base.SourceID = ov.SourceID
	}
	if ov.TargetID != nil {
		base.TargetID = ov.TargetID
	}
	if ov.RelationshipTypeKey != nil {
		base.RelationshipTypeKey = ov.RelationshipTypeKey
	}
}

// acceptAsFactor converts a capture-stage suggestion into a factor. Factors
// predate the object registry and have their own table, so they get this
// small dedicated path rather than an artificial registry entry.
func acceptAsFactor(ctx context.Context, pool *pgxpool.Pool, m *methodology.Methodology,
	stage *methodology.Stage, workshopID, userID string, item map[string]interface{},
	overrides *writeObjectBody, outputID string) (string, string) {

	catKey, _ := stage.Config["factor_category_key"].(string)
	if catKey == "" {
		return "", "This capture stage has no factor category configured."
	}
	cat := m.CategoryByKey(catKey)
	if cat == nil {
		return "", "Unknown factor category for this workshop's methodology."
	}

	title, _ := item["title"].(string)
	var description *string
	if s, ok := item["description"].(string); ok && strings.TrimSpace(s) != "" {
		d := strings.TrimSpace(s)
		description = &d
	}
	if overrides != nil {
		if overrides.Title != nil {
			title = *overrides.Title
		}
		if overrides.Description != nil {
			description = overrides.Description
		}
	}
	title = strings.TrimSpace(title)
	if msg := validateFactorTitle(title); msg != "" {
		return "", msg
	}

	var id string
	err := pool.QueryRow(ctx, `
		insert into public.factors
		  (workshop_id, factor_category_id, title, description, created_by, state, is_ai_generated, source_ai_output_id)
		values ($1, $2, $3, $4, $5, 'submitted', true, $6)
		returning id`,
		workshopID, cat.ID, title, description, userID, outputID,
	).Scan(&id)
	if err != nil {
		return "", err.Error()
	}
	return id, ""
}

func nullableString(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
