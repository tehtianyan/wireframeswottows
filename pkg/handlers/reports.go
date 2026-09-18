// Reporting (App Spec §14, wireframe §8).
//
// A report is a configured list of sections. The section engine renders each
// one from data the engine already has, addressed through the object registry
// — so "the SWOT matrix" is a category_matrix grouped by factor_category and
// "the TOWS matrix" is a pair_matrix grouped by relationship_type. Neither
// word appears in this file.
//
// Reports deliberately do NOT join pkg/objects' registry. That registry's
// contract is one table, flat fields, link-table evidence and one review
// decision; a report has ordered child sections, a publish transition, a
// version chain and immutability. Encoding those as per-kind flags would be
// special-casing wearing a registry costume. Instead reports CONSUME the
// registry: a section's `from` is a registry key, which is the correct
// coupling direction and means a sixth object kind becomes reportable for
// free.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/objects"
	"swot-tows/pkg/response"
)

// Publishing makes a report an organizational record, so it is facilitators
// only (App Spec §14.25 and wireframe §8.36). §3.22 says Executive publish is
// "Optional"; that conflict is resolved here in favour of the stricter rule.
var publisherRoles = []string{"facilitator"}

type ReportSummary struct {
	ID           string  `json:"id"`
	WorkshopID   string  `json:"workshop_id"`
	Title        string  `json:"title"`
	ReportType   string  `json:"report_type"`
	State        string  `json:"state"`
	Version      string  `json:"version"`
	RootID       string  `json:"root_id"`
	CreatedAt    string  `json:"created_at"`
	PublishedAt  *string `json:"published_at"`
	ReviewNote   *string `json:"review_note"`
}

// SectionItem is one rendered object inside a section.
type SectionItem struct {
	ID       string                 `json:"id"`
	Kind     string                 `json:"kind"`
	Title    string                 `json:"title"`
	Body     string                 `json:"body,omitempty"`
	State    string                 `json:"state"`
	Included bool                   `json:"included"`
	Fields   map[string]interface{} `json:"fields,omitempty"`
}

// SectionGroup is a labelled bucket — one factor category, or one
// relationship type. The grid a matrix renders is just these groups.
type SectionGroup struct {
	Key        string        `json:"key"`
	Name       string        `json:"name"`
	ColorToken string        `json:"color_token,omitempty"`
	SourceName string        `json:"source_name,omitempty"`
	TargetName string        `json:"target_name,omitempty"`
	Items      []SectionItem `json:"items"`
}

// EvidenceChain is §14.15's requirement made concrete: a root object and
// everything it rests on, walked through the registry's own links.
type EvidenceChain struct {
	Root     SectionItem              `json:"root"`
	Supports map[string][]SectionItem `json:"supports"`
}

type ReportSection struct {
	ID          string                 `json:"id"`
	SectionKey  string                 `json:"section_key"`
	Name        string                 `json:"name"`
	SectionType string                 `json:"section_type"`
	SortOrder   int                    `json:"sort_order"`
	Included    bool                   `json:"included"`
	Selectable  bool                   `json:"selectable"`
	Body        *string                `json:"body"`
	GeneratedBy string                 `json:"generated_by"`
	Source      map[string]interface{} `json:"source"`
	Groups      []SectionGroup         `json:"groups,omitempty"`
	Items       []SectionItem          `json:"items,omitempty"`
	Chains      []EvidenceChain        `json:"chains,omitempty"`
}

type ReportDetail struct {
	ReportSummary
	Sections []ReportSection `json:"sections"`
	// True when the content came from the publish-time snapshot rather than
	// from live data.
	FromSnapshot bool `json:"from_snapshot"`
}

// ---- report type config ----

type reportTypeConfig struct {
	Key         string                   `json:"key"`
	Name        string                   `json:"name"`
	Description string                   `json:"description"`
	Default     bool                     `json:"default"`
	Requires    []map[string]interface{} `json:"requires"`
	Sections    []map[string]interface{} `json:"sections"`
}

// reportTypesFor reads the report stage's configured types.
func reportTypesFor(m *methodology.Methodology) ([]reportTypeConfig, *methodology.Stage) {
	for i := range m.Stages {
		s := &m.Stages[i]
		if s.StageType != "report" {
			continue
		}
		raw, ok := s.Config["report_types"]
		if !ok {
			return nil, s
		}
		b, err := json.Marshal(raw)
		if err != nil {
			return nil, s
		}
		var out []reportTypeConfig
		if err := json.Unmarshal(b, &out); err != nil {
			return nil, s
		}
		return out, s
	}
	return nil, nil
}

// ListReportTypes — GET /workshops/{id}/report-types
//
// Includes whether each type's required inputs are satisfied (§14.12), so the
// UI can explain why a report cannot be generated yet rather than failing at
// the point of creation.
func ListReportTypes(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID); err != nil {
		writeAuthzErr(w, err)
		return
	}
	m, err := methodology.LoadForWorkshop(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	types, _ := reportTypesFor(m)

	out := []map[string]interface{}{}
	for _, t := range types {
		missing := unmetRequirements(r2.Context(), pool, workshopID, t.Requires)
		out = append(out, map[string]interface{}{
			"key": t.Key, "name": t.Name, "description": t.Description,
			"default": t.Default, "section_count": len(t.Sections),
			"can_generate": len(missing) == 0, "missing": missing,
		})
	}
	response.OK(w, out)
}

// unmetRequirements implements §14.12 generically: each requirement is a
// count of one object kind in one state.
func unmetRequirements(ctx context.Context, pool *pgxpool.Pool, workshopID string,
	reqs []map[string]interface{}) []string {

	missing := []string{}
	for _, req := range reqs {
		kindKey, _ := req["kind"].(string)
		state, _ := req["state"].(string)
		min := 1
		if f, ok := req["min"].(float64); ok {
			min = int(f)
		}
		table, label := tableForKind(kindKey)
		if table == "" {
			continue
		}
		var n int
		if err := pool.QueryRow(ctx, fmt.Sprintf(
			`select count(*) from public.%s where workshop_id = $1 and state = $2`, table),
			workshopID, state).Scan(&n); err != nil {
			continue
		}
		if n < min {
			plural := "s"
			if min == 1 {
				plural = ""
			}
			missing = append(missing, fmt.Sprintf("at least %d %s %s%s", min, state, label, plural))
		}
	}
	return missing
}

// tableForKind maps a citation vocabulary key to its table. Factors predate
// the object registry and have their own table; everything else comes from
// the registry, so a new object kind needs no change here.
func tableForKind(kindKey string) (table, label string) {
	if kindKey == "factor" {
		return "factors", "factor"
	}
	k, err := objects.ByKey(kindKey)
	if err != nil {
		return "", ""
	}
	return k.Table, strings.ToLower(k.Label)
}

// ---- listing and creation ----

func scanReportSummary(row pgx.Row) (*ReportSummary, error) {
	var s ReportSummary
	var createdAt time.Time
	var publishedAt *time.Time
	var major, minor int
	if err := row.Scan(&s.ID, &s.WorkshopID, &s.Title, &s.ReportType, &s.State,
		&major, &minor, &s.RootID, &createdAt, &publishedAt, &s.ReviewNote); err != nil {
		return nil, err
	}
	s.Version = fmt.Sprintf("v%d.%d", major, minor)
	s.CreatedAt = createdAt.Format(time.RFC3339)
	if publishedAt != nil {
		p := publishedAt.Format(time.RFC3339)
		s.PublishedAt = &p
	}
	return &s, nil
}

const reportCols = `id, workshop_id, title, report_type, state, version_major, version_minor,
	root_id, created_at, published_at, review_note`

// ListReports — GET /workshops/{id}/reports
func ListReports(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID); err != nil {
		writeAuthzErr(w, err)
		return
	}
	rows, err := pool.Query(r2.Context(), fmt.Sprintf(
		`select %s from public.reports where workshop_id = $1
		 order by root_id, version_major desc, version_minor desc`, reportCols), workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	out := []ReportSummary{}
	for rows.Next() {
		s, err := scanReportSummary(rows)
		if err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		out = append(out, *s)
	}
	response.OK(w, out)
}

type createReportBody struct {
	ReportType string `json:"report_type"`
	Title      string `json:"title"`
}

// CreateReport — POST /workshops/{id}/reports
//
// Seeds one report_sections row per configured section, so ordering and
// inclusion are editable from the moment the report exists.
func CreateReport(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID, contributorRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var body createReportBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	m, err := methodology.LoadForWorkshop(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	types, _ := reportTypesFor(m)

	var chosen *reportTypeConfig
	for i := range types {
		if types[i].Key == body.ReportType || (body.ReportType == "" && types[i].Default) {
			chosen = &types[i]
			break
		}
	}
	if chosen == nil {
		response.Fail(w, response.CodeValidationError,
			"That report type is not configured for this workshop's methodology.")
		return
	}

	// §14.12 — refuse to generate without the required inputs.
	if missing := unmetRequirements(r2.Context(), pool, workshopID, chosen.Requires); len(missing) > 0 {
		response.Fail(w, response.CodeInvalidStateTransition,
			"This report needs "+strings.Join(missing, ", ")+" before it can be generated.")
		return
	}

	title := strings.TrimSpace(body.Title)
	if title == "" {
		title = chosen.Name
	}

	// root_id is NOT NULL and a v1.0 report is its own version root, so the id
	// is generated first and used for both — an insert-then-update would trip
	// the not-null constraint in between.
	var reportID string
	err = pool.QueryRow(r2.Context(), `
		with fresh as (select gen_random_uuid() as id)
		insert into public.reports (id, root_id, workshop_id, title, report_type, state, created_by, generated_by)
		select fresh.id, fresh.id, $1, $2, $3, 'draft', $4, 'human' from fresh
		returning id`, workshopID, title, chosen.Key, user.ID).Scan(&reportID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	if err := seedSections(r2.Context(), pool, reportID, workshopID, chosen); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(r2.Context(), pool, user.ID, "report.created", "report", reportID, "", "draft",
		map[string]interface{}{"workshop_id": workshopID, "report_type": chosen.Key})
	response.Created(w, map[string]string{"id": reportID, "state": "draft"})
}

func seedSections(ctx context.Context, pool *pgxpool.Pool, reportID, workshopID string, t *reportTypeConfig) error {
	for i, sec := range t.Sections {
		key, _ := sec["key"].(string)
		name, _ := sec["name"].(string)
		sectionType, _ := sec["section_type"].(string)
		included := true
		if v, ok := sec["included_by_default"].(bool); ok {
			included = v
		}
		source := map[string]interface{}{}
		if s, ok := sec["source"].(map[string]interface{}); ok {
			source = s
		}
		if sel, ok := sec["selectable"].(bool); ok {
			source["selectable"] = sel
		}
		srcJSON, err := json.Marshal(source)
		if err != nil {
			return err
		}
		// string, not []byte: the pool runs QueryExecModeSimpleProtocol, where
		// pgx renders []byte as a bytea literal that cannot go into jsonb.
		if _, err := pool.Exec(ctx, `
			insert into public.report_sections
			  (report_id, workshop_id, title, section_key, section_type, sort_order, included, source, generated_by)
			values ($1, $2, $3, $4, $5, $6, $7, $8, 'human')`,
			reportID, workshopID, name, key, sectionType, (i+1)*10, included, string(srcJSON)); err != nil {
			return err
		}
	}
	return nil
}
