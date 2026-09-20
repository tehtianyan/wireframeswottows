// The section engine: turning a configured section into rendered content.
//
// Every lookup goes through methodology config or the object registry, so
// this file contains no methodology vocabulary at all. A category_matrix
// produces one group per configured factor category — four for SWOT-TOWS, six
// for PESTLE. A pair_matrix produces one group per configured relationship
// type — four for SWOT-TOWS, none at all for PESTLE, which is exactly right
// because PESTLE has no relate stage.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/methodology"
	"swot-tows/pkg/objects"
	"swot-tows/pkg/weights"
)

// loadSections reads a report's section rows and resolves each one's content.
func loadSections(ctx context.Context, pool *pgxpool.Pool, m *methodology.Methodology,
	reportID, workshopID string) ([]ReportSection, error) {

	rows, err := pool.Query(ctx, `
		select id, section_key, title, section_type, sort_order, included, body, generated_by, source
		from public.report_sections
		where report_id = $1
		order by sort_order, created_at`, reportID)
	if err != nil {
		return nil, err
	}

	sections := []ReportSection{}
	for rows.Next() {
		var s ReportSection
		var srcRaw []byte
		if err := rows.Scan(&s.ID, &s.SectionKey, &s.Name, &s.SectionType, &s.SortOrder,
			&s.Included, &s.Body, &s.GeneratedBy, &srcRaw); err != nil {
			rows.Close()
			return nil, err
		}
		s.Source = map[string]interface{}{}
		if len(srcRaw) > 0 {
			_ = json.Unmarshal(srcRaw, &s.Source)
		}
		if sel, ok := s.Source["selectable"].(bool); ok {
			s.Selectable = sel
		}
		sections = append(sections, s)
	}
	rows.Close()

	for i := range sections {
		if err := resolveSection(ctx, pool, m, workshopID, &sections[i]); err != nil {
			return nil, err
		}
	}
	return sections, nil
}

// resolveSection fills in a section's content from its declared source.
func resolveSection(ctx context.Context, pool *pgxpool.Pool, m *methodology.Methodology,
	workshopID string, s *ReportSection) error {

	from, _ := s.Source["from"].(string)
	// A narrative's content is its stored body — written by AI, edited by a
	// human, or both. Nothing to resolve.
	if from == "ai" || s.SectionType == "narrative" {
		return nil
	}

	state, _ := s.Source["state"].(string)
	groupBy, _ := s.Source["group_by"].(string)
	weightKeys := stringList(s.Source["weights"])
	orderBy, _ := s.Source["order_by"].(string)

	switch s.SectionType {
	case "category_matrix", "appendix":
		groups, err := groupByCategory(ctx, pool, m, workshopID, state)
		if err != nil {
			return err
		}
		s.Groups = groups

	case "pair_matrix":
		groups, err := groupByRelationshipType(ctx, pool, m, workshopID, state)
		if err != nil {
			return err
		}
		s.Groups = groups

	case "evidence_chain":
		chains, err := buildEvidenceChains(ctx, pool, workshopID, from, state)
		if err != nil {
			return err
		}
		s.Chains = chains

	default: // bullet_list, object_list, table
		if groupBy == "factor_category" {
			groups, err := groupByCategory(ctx, pool, m, workshopID, state)
			if err != nil {
				return err
			}
			s.Groups = groups
			break
		}
		items, err := listItems(ctx, pool, from, workshopID, state)
		if err != nil {
			return err
		}
		s.Items = items
	}

	// Weights are attached after the content is resolved, so the same code
	// serves a flat list and a grouped matrix. A section that names none is
	// untouched and pays nothing.
	if len(weightKeys) > 0 {
		if err := attachWeights(ctx, pool, m, workshopID, s, weightKeys); err != nil {
			return err
		}
	}

	// "weight:<key>" ordering and grouping are how a rated register sorts
	// itself and how a roadmap buckets into waves, without either needing a
	// renderer of its own.
	if key, desc, ok := parseWeightRef(orderBy); ok {
		sortByWeight(s.Items, key, desc)
		for i := range s.Groups {
			sortByWeight(s.Groups[i].Items, key, desc)
		}
	}
	if key, _, ok := parseWeightRef(groupBy); ok && len(s.Items) > 0 {
		s.Groups = groupItemsByWeight(m, s.Items, key)
		s.Items = nil
	}
	return nil
}

// stringList reads a JSON array of strings out of a section's source.
func stringList(raw interface{}) []string {
	arr, ok := raw.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// parseWeightRef recognises "weight:impact" and "weight:impact desc".
// Anything else is left to the existing order_by handling.
func parseWeightRef(spec string) (key string, desc bool, ok bool) {
	if !strings.HasPrefix(spec, "weight:") {
		return "", false, false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(spec, "weight:"))
	if strings.HasSuffix(rest, " desc") {
		return strings.TrimSpace(strings.TrimSuffix(rest, " desc")), true, true
	}
	return rest, false, true
}

// attachWeights fills in the requested weights on every item the section
// resolved, flat or grouped. One query per weight, not one per item.
func attachWeights(ctx context.Context, pool *pgxpool.Pool, m *methodology.Methodology,
	workshopID string, s *ReportSection, keys []string) error {

	// Columns are declared from config before any row is looked at, because a
	// table with nothing approved yet still has columns — and a report shown
	// mid-workshop is exactly when that happens.
	defs := make([]*weights.Definition, 0, len(keys))
	for _, key := range keys {
		def := m.WeightByKey(key)
		if def == nil {
			// A methodology that does not define this weight simply has no
			// column for it, the way a pair_matrix renders nothing for a
			// methodology with no relationship types.
			continue
		}
		defs = append(defs, def)
		s.WeightColumns = append(s.WeightColumns, WeightColumn{Key: def.Key, Name: def.Name})
	}

	byID := map[string][]*SectionItem{}
	for i := range s.Items {
		byID[s.Items[i].ID] = append(byID[s.Items[i].ID], &s.Items[i])
	}
	for g := range s.Groups {
		for i := range s.Groups[g].Items {
			it := &s.Groups[g].Items[i]
			byID[it.ID] = append(byID[it.ID], it)
		}
	}
	if len(byID) == 0 {
		return nil
	}

	for _, def := range defs {
		aggs, err := weights.LoadAggregates(ctx, pool, workshopID, []weights.Definition{*def})
		if err != nil {
			return err
		}
		for _, a := range aggs {
			for _, item := range byID[a.ObjectID] {
				if item.Weights == nil {
					item.Weights = map[string]WeightCell{}
				}
				item.Weights[def.Key] = WeightCell{Name: def.Name, Value: a.Value, Label: a.Label}
			}
		}
	}
	return nil
}

func weightValue(it SectionItem, key string) (float64, bool) {
	c, ok := it.Weights[key]
	if !ok {
		return 0, false
	}
	return c.Value, true
}

// sortByWeight orders items by one weight. Items with no value sort last in
// either direction — an unrated row belongs at the bottom of a register, not
// at the top of it because zero is small.
func sortByWeight(items []SectionItem, key string, desc bool) {
	sort.SliceStable(items, func(i, j int) bool {
		a, aOK := weightValue(items[i], key)
		b, bOK := weightValue(items[j], key)
		if aOK != bOK {
			return aOK
		}
		if a == b {
			return false
		}
		if desc {
			return a > b
		}
		return a < b
	})
}

// groupItemsByWeight buckets items by a weight's value — how a transformation
// roadmap becomes waves without a timeline renderer. Buckets are ordered by
// value, and anything unrated collects in its own trailing group rather than
// disappearing.
func groupItemsByWeight(m *methodology.Methodology, items []SectionItem, key string) []SectionGroup {
	def := m.WeightByKey(key)
	name := key
	if def != nil {
		name = def.Name
	}

	buckets := map[float64][]SectionItem{}
	unrated := []SectionItem{}
	for _, it := range items {
		if v, ok := weightValue(it, key); ok {
			buckets[v] = append(buckets[v], it)
		} else {
			unrated = append(unrated, it)
		}
	}

	values := make([]float64, 0, len(buckets))
	for v := range buckets {
		values = append(values, v)
	}
	sort.Float64s(values)

	groups := make([]SectionGroup, 0, len(values)+1)
	for _, v := range values {
		label := ""
		if def != nil {
			label = def.Label(v)
		}
		title := fmt.Sprintf("%s %s", name, strconv.FormatFloat(v, 'f', -1, 64))
		if label != "" {
			title = fmt.Sprintf("%s — %s", title, label)
		}
		groups = append(groups, SectionGroup{
			Key:   fmt.Sprintf("%s-%s", key, strconv.FormatFloat(v, 'f', -1, 64)),
			Name:  title,
			Items: buckets[v],
		})
	}
	if len(unrated) > 0 {
		groups = append(groups, SectionGroup{
			Key:   key + "-unrated",
			Name:  "Not yet rated",
			Items: unrated,
		})
	}
	return groups
}

// groupByCategory renders one bucket per configured factor category. This is
// what a methodology's "matrix" actually is.
func groupByCategory(ctx context.Context, pool *pgxpool.Pool, m *methodology.Methodology,
	workshopID, state string) ([]SectionGroup, error) {

	factors, err := listFactorItems(ctx, pool, workshopID, state)
	if err != nil {
		return nil, err
	}
	byCat := map[string][]SectionItem{}
	for _, f := range factors {
		key, _ := f.Fields["category_key"].(string)
		byCat[key] = append(byCat[key], f)
	}

	groups := []SectionGroup{}
	for _, c := range m.FactorCategories {
		items := byCat[c.Key]
		if items == nil {
			items = []SectionItem{}
		}
		sort.SliceStable(items, func(i, j int) bool {
			vi, _ := items[i].Fields["votes"].(int)
			vj, _ := items[j].Fields["votes"].(int)
			return vi > vj
		})
		groups = append(groups, SectionGroup{
			Key: c.Key, Name: c.Name, ColorToken: c.ColorToken, Items: items,
		})
	}
	return groups, nil
}

// groupByRelationshipType renders one cell per configured relationship type.
// A methodology with none produces no groups, so the section renders empty
// rather than needing to be absent from the template.
func groupByRelationshipType(ctx context.Context, pool *pgxpool.Pool, m *methodology.Methodology,
	workshopID, state string) ([]SectionGroup, error) {

	if len(m.RelationshipTypes) == 0 {
		return []SectionGroup{}, nil
	}

	query := `
		select fr.id, coalesce(fr.title, ''), coalesce(fr.narrative, ''),
		       coalesce(fr.strategic_option, ''), fr.state, mrt.key,
		       coalesce(src.title, ''), coalesce(tgt.title, '')
		from public.factor_relationships fr
		join public.methodology_relationship_types mrt on mrt.id = fr.relationship_type_id
		left join public.factors src on src.id = fr.source_factor_id
		left join public.factors tgt on tgt.id = fr.target_factor_id
		where fr.workshop_id = $1`
	args := []interface{}{workshopID}
	if state != "" {
		args = append(args, state)
		query += ` and fr.state = $2`
	}
	query += ` order by fr.created_at`

	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	byType := map[string][]SectionItem{}
	for rows.Next() {
		var id, title, narrative, option, st, typeKey, srcTitle, tgtTitle string
		if err := rows.Scan(&id, &title, &narrative, &option, &st, &typeKey, &srcTitle, &tgtTitle); err != nil {
			rows.Close()
			return nil, err
		}
		if title == "" {
			title = srcTitle + " → " + tgtTitle
		}
		byType[typeKey] = append(byType[typeKey], SectionItem{
			ID: id, Kind: "factor_relationship", Title: title, Body: narrative,
			State: st, Included: true,
			Fields: map[string]interface{}{
				"strategic_option": option, "source": srcTitle, "target": tgtTitle,
			},
		})
	}
	rows.Close()

	groups := []SectionGroup{}
	for _, rt := range m.RelationshipTypes {
		items := byType[rt.Key]
		if items == nil {
			items = []SectionItem{}
		}
		g := SectionGroup{Key: rt.Key, Name: rt.Name, Items: items}
		if c := m.CategoryByID(rt.SourceCategoryID); c != nil {
			g.SourceName = c.Name
		}
		if c := m.CategoryByID(rt.TargetCategoryID); c != nil {
			g.TargetName = c.Name
		}
		groups = append(groups, g)
	}
	return groups, nil
}

func listFactorItems(ctx context.Context, pool *pgxpool.Pool, workshopID, state string) ([]SectionItem, error) {
	query := `
		select f.id, f.title, coalesce(f.description, ''), f.state, mfc.key,
		       coalesce((select sum(w.value) from public.weights w
		                 where w.object_id = f.id and w.weight_key = 'vote'), 0)::int
		from public.factors f
		join public.methodology_factor_categories mfc on mfc.id = f.factor_category_id
		where f.workshop_id = $1`
	args := []interface{}{workshopID}
	if state != "" {
		args = append(args, state)
		query += ` and f.state = $2`
	}
	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SectionItem{}
	for rows.Next() {
		var id, title, desc, st, catKey string
		var votes int
		if err := rows.Scan(&id, &title, &desc, &st, &catKey, &votes); err != nil {
			return nil, err
		}
		out = append(out, SectionItem{
			ID: id, Kind: "factor", Title: title, Body: desc, State: st, Included: true,
			Fields: map[string]interface{}{"category_key": catKey, "votes": votes},
		})
	}
	return out, nil
}

// listItems renders any registry object kind, reading its own extra fields
// from the registry rather than a hardcoded column list.
func listItems(ctx context.Context, pool *pgxpool.Pool, kindKey, workshopID, state string) ([]SectionItem, error) {
	if kindKey == "factor" {
		return listFactorItems(ctx, pool, workshopID, state)
	}
	kind, err := objects.ByKey(kindKey)
	if err != nil {
		return []SectionItem{}, nil
	}

	cols := []string{"id", "coalesce(title, '')"}
	if kind.HasDescription {
		cols = append(cols, "coalesce(description, '')")
	}
	cols = append(cols, "state")
	cols = append(cols, kind.FieldNames()...)

	query := fmt.Sprintf(`select %s from public.%s where workshop_id = $1`,
		strings.Join(cols, ", "), kind.Table)
	args := []interface{}{workshopID}
	if state != "" {
		args = append(args, state)
		query += ` and state = $2`
	}
	query += ` order by created_at`

	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SectionItem{}
	for rows.Next() {
		var id, title, st string
		var desc string
		fieldVals := make([]interface{}, len(kind.Fields))
		dest := []interface{}{&id, &title}
		if kind.HasDescription {
			dest = append(dest, &desc)
		}
		dest = append(dest, &st)
		for i := range kind.Fields {
			dest = append(dest, &fieldVals[i])
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		item := SectionItem{
			ID: id, Kind: kindKey, Title: title, Body: desc, State: st, Included: true,
			Fields: map[string]interface{}{},
		}
		for i, f := range kind.Fields {
			item.Fields[f.Name] = fieldVals[i]
		}
		out = append(out, item)
	}
	return out, nil
}

// buildEvidenceChains walks the registry's own Evidence links backwards from
// each root object — App Spec §14.15's "recommendation → insight → theme →
// factor" without naming any of them. A methodology whose insights cite
// something else produces a different chain from the same code.
func buildEvidenceChains(ctx context.Context, pool *pgxpool.Pool,
	workshopID, rootKind, state string) ([]EvidenceChain, error) {

	roots, err := listItems(ctx, pool, rootKind, workshopID, state)
	if err != nil {
		return nil, err
	}
	kind, err := objects.ByKey(rootKind)
	if err != nil {
		return []EvidenceChain{}, nil
	}

	chains := []EvidenceChain{}
	for _, root := range roots {
		chain := EvidenceChain{Root: root, Supports: map[string][]SectionItem{}}
		if err := expandEvidence(ctx, pool, workshopID, kind, root.ID, chain.Supports, 0); err != nil {
			return nil, err
		}
		chains = append(chains, chain)
	}
	return chains, nil
}

// expandEvidence follows one object's citations, then their citations, to a
// bounded depth. Depth is capped because a cycle in configuration would
// otherwise recurse forever.
func expandEvidence(ctx context.Context, pool *pgxpool.Pool, workshopID string,
	kind *objects.Kind, objectID string, out map[string][]SectionItem, depth int) error {

	if depth > 3 {
		return nil
	}
	for _, link := range kind.Evidence {
		rows, err := pool.Query(ctx, fmt.Sprintf(
			`select %s from public.%s where %s = $1`, link.OtherCol, link.Table, link.SelfCol), objectID)
		if err != nil {
			return err
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if len(ids) == 0 {
			continue
		}

		all, err := listItems(ctx, pool, link.CitesKind, workshopID, "")
		if err != nil {
			return err
		}
		byID := map[string]SectionItem{}
		for _, it := range all {
			byID[it.ID] = it
		}
		for _, id := range ids {
			it, ok := byID[id]
			if !ok {
				continue
			}
			if !containsItem(out[link.CitesKind], id) {
				out[link.CitesKind] = append(out[link.CitesKind], it)
			}
			if child, err := objects.ByKey(link.CitesKind); err == nil {
				if err := expandEvidence(ctx, pool, workshopID, child, id, out, depth+1); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func containsItem(items []SectionItem, id string) bool {
	for _, i := range items {
		if i.ID == id {
			return true
		}
	}
	return false
}
