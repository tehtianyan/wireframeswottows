// Report lifecycle: read, edit, review, publish, version, export.
//
// The load-bearing rule is App Spec §14.24: publishing freezes a report. A
// draft renders live from current data so the builder always shows reality;
// publishing renders once and stores the result, and reads of a published
// report serve that snapshot. Without it, rejecting an insight next month
// would silently rewrite a report published today.
package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/response"
)

// GetReport — GET /workshops/{id}/reports/{reportId}
func GetReport(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	reportID := chi.URLParam(r2, "reportId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID); err != nil {
		writeAuthzErr(w, err)
		return
	}

	detail, errMsg, err := assembleReport(r2, reportID, workshopID)
	if errMsg != "" {
		response.Fail(w, response.CodeNotFound, errMsg)
		return
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	response.OK(w, detail)
}

// assembleReport returns a published report from its snapshot, and any other
// report rendered live.
func assembleReport(r *http.Request, reportID, workshopID string) (*ReportDetail, string, error) {
	pool, err := poolFor(r)
	if err != nil {
		return nil, "", err
	}

	summary, err := scanReportSummary(pool.QueryRow(r.Context(), fmt.Sprintf(
		`select %s from public.reports where id = $1 and workshop_id = $2`, reportCols),
		reportID, workshopID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "report not found in this workshop", nil
	}
	if err != nil {
		return nil, "", err
	}

	detail := &ReportDetail{ReportSummary: *summary}

	if summary.State == "published" || summary.State == "archived" {
		var snapRaw []byte
		if err := pool.QueryRow(r.Context(),
			`select snapshot from public.reports where id = $1`, reportID).Scan(&snapRaw); err != nil {
			return nil, "", err
		}
		if len(snapRaw) > 0 {
			var snap struct {
				Sections []ReportSection `json:"sections"`
			}
			if err := json.Unmarshal(snapRaw, &snap); err == nil {
				detail.Sections = snap.Sections
				detail.FromSnapshot = true
				return detail, "", nil
			}
		}
	}

	m, err := methodology.LoadForWorkshop(r.Context(), pool, workshopID)
	if err != nil {
		return nil, "", err
	}
	sections, err := loadSections(r.Context(), pool, m, reportID, workshopID)
	if err != nil {
		return nil, "", err
	}
	detail.Sections = sections
	return detail, "", nil
}

type updateSectionsBody struct {
	Sections []struct {
		ID        string `json:"id"`
		SortOrder int    `json:"sort_order"`
		Included  bool   `json:"included"`
	} `json:"sections"`
}

// UpdateReportSections — PUT /workshops/{id}/reports/{reportId}/sections
// Bulk reorder and include/exclude (App Spec §14.13).
func UpdateReportSections(w http.ResponseWriter, r *http.Request) {
	ctx, pool, user, workshopID, reportID, state, ok := loadReportForWrite(w, r)
	if !ok {
		return
	}
	if state == "published" || state == "archived" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"A published report cannot be edited — create a new version instead.")
		return
	}

	var body updateSectionsBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	for _, s := range body.Sections {
		if _, err := pool.Exec(ctx, `
			update public.report_sections set sort_order = $2, included = $3
			where id = $1 and report_id = $4`, s.ID, s.SortOrder, s.Included, reportID); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
	}
	audit.Record(ctx, pool, user.ID, "report.sections_updated", "report", reportID, state, state,
		map[string]interface{}{"workshop_id": workshopID, "count": len(body.Sections)})
	response.OK(w, map[string]string{"id": reportID})
}

type updateSectionBody struct {
	Body *string `json:"body"`
}

// UpdateReportSection — PATCH /workshops/{id}/reports/{reportId}/sections/{sectionId}
//
// Editing an AI-drafted narrative marks it `hybrid` and names the editor,
// which is what §14.13's "clearly distinguish between AI-generated content and
// human-edited content" needs to be renderable.
func UpdateReportSection(w http.ResponseWriter, r *http.Request) {
	ctx, pool, user, workshopID, reportID, state, ok := loadReportForWrite(w, r)
	if !ok {
		return
	}
	if state == "published" || state == "archived" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"A published report cannot be edited — create a new version instead.")
		return
	}
	sectionID := chi.URLParam(r, "sectionId")

	var body updateSectionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	var currentGeneratedBy string
	if err := pool.QueryRow(ctx,
		`select generated_by from public.report_sections where id = $1 and report_id = $2`,
		sectionID, reportID).Scan(&currentGeneratedBy); err != nil {
		response.Fail(w, response.CodeNotFound, "section not found in this report")
		return
	}

	// An AI draft a person changed is 'hybrid'; a section a person wrote from
	// nothing stays 'human'.
	newGeneratedBy := "human"
	if currentGeneratedBy == "ai" || currentGeneratedBy == "hybrid" {
		newGeneratedBy = "hybrid"
	}

	if _, err := pool.Exec(ctx, `
		update public.report_sections
		set body = $2, generated_by = $3, edited_by = $4, edited_at = now()
		where id = $1 and report_id = $5`,
		sectionID, body.Body, newGeneratedBy, user.ID, reportID); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(ctx, pool, user.ID, "report.section_edited", "report", reportID, state, state,
		map[string]interface{}{"workshop_id": workshopID, "section_id": sectionID,
			"generated_by": newGeneratedBy})
	response.OK(w, map[string]string{"id": sectionID, "generated_by": newGeneratedBy})
}

// ReviewReport — POST /workshops/{id}/reports/{reportId}/review
func ReviewReport(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	reportID := chi.URLParam(r2, "reportId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID, reviewerRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var body reviewFactorBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	var newState string
	switch body.Action {
	case "submit":
		newState = "submitted"
	case "approve":
		newState = "approved"
	case "reject":
		newState = "rejected"
	default:
		response.Fail(w, response.CodeValidationError, `action must be "submit", "approve" or "reject"`)
		return
	}

	var current string
	if err := pool.QueryRow(r2.Context(),
		`select state from public.reports where id = $1 and workshop_id = $2`,
		reportID, workshopID).Scan(&current); err != nil {
		response.Fail(w, response.CodeNotFound, "report not found in this workshop")
		return
	}
	if current == "published" || current == "archived" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"A published report cannot be reviewed again — create a new version instead.")
		return
	}

	note := trimPtr(body.Note)
	if newState == "rejected" && note == nil {
		response.Fail(w, response.CodeValidationError, "A reason is required when returning a report for revision.")
		return
	}

	var err error
	if newState == "submitted" {
		_, err = pool.Exec(r2.Context(),
			`update public.reports set state = 'submitted' where id = $1`, reportID)
	} else {
		_, err = pool.Exec(r2.Context(), `
			update public.reports set state = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
			where id = $1`, reportID, newState, user.ID, note)
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(r2.Context(), pool, user.ID, "report."+newState, "report", reportID, current, newState,
		map[string]interface{}{"workshop_id": workshopID})
	response.OK(w, map[string]string{"id": reportID, "state": newState})
}

// PublishReport — POST /workshops/{id}/reports/{reportId}/publish
//
// Facilitators only (§14.25). Renders every section once and freezes the
// result, THEN flips the state — the other order makes the freeze trigger
// reject the rest of this transaction.
func PublishReport(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	reportID := chi.URLParam(r2, "reportId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID, publisherRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var current string
	if err := pool.QueryRow(r2.Context(),
		`select state from public.reports where id = $1 and workshop_id = $2`,
		reportID, workshopID).Scan(&current); err != nil {
		response.Fail(w, response.CodeNotFound, "report not found in this workshop")
		return
	}
	if current == "published" {
		response.Fail(w, response.CodeInvalidStateTransition, "This report is already published.")
		return
	}
	if current != "approved" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"A report must be approved before it can be published.")
		return
	}

	detail, errMsg, err := assembleReport(r2, reportID, workshopID)
	if errMsg != "" || err != nil || detail == nil {
		response.Fail(w, response.CodeServerError, "could not assemble the report for publication")
		return
	}

	m, err := methodology.LoadForWorkshop(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	snapshot := map[string]interface{}{
		"schema":       1,
		"published_at": time.Now().UTC().Format(time.RFC3339),
		"published_by": user.ID,
		"report_type":  detail.ReportType,
		"title":        detail.Title,
		"version":      detail.Version,
		// The methodology config that produced this report travels with it, so
		// later config edits cannot change how an already-published report
		// renders.
		"methodology": map[string]interface{}{
			"key": m.Key, "name": m.Name,
			"factor_categories":  m.FactorCategories,
			"relationship_types": m.RelationshipTypes,
		},
		"sections": detail.Sections,
	}
	snapJSON, err := json.Marshal(snapshot)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	// string(...) not []byte: under QueryExecModeSimpleProtocol pgx renders
	// []byte as a bytea literal, which cannot be assigned to jsonb. This is
	// the bug that silently emptied audit_events for three phases.
	if _, err := pool.Exec(r2.Context(), `
		update public.reports
		set snapshot = $2, snapshot_taken_at = now(),
		    state = 'published', published_by = $3, published_at = now()
		where id = $1`, reportID, string(snapJSON), user.ID); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(r2.Context(), pool, user.ID, "report.published", "report", reportID, current, "published",
		map[string]interface{}{"workshop_id": workshopID, "version": detail.Version,
			"sections": len(detail.Sections)})
	// One of the few things that genuinely concerns everyone in the workshop.
	NotifyWorkshop(r2.Context(), pool, user.ID, "report.published",
		detail.Title+" "+detail.Version+" was published",
		"The report is now an organizational record and can no longer be edited.",
		"report", reportID, workshopID)
	response.OK(w, map[string]interface{}{
		"id": reportID, "state": "published", "version": detail.Version,
	})
}

type newVersionBody struct {
	Bump string `json:"bump"` // "minor" (default) | "major"
}

// CreateReportVersion — POST /workshops/{id}/reports/{reportId}/versions
//
// §14.24: a published report is never overwritten; editing it creates a new
// version. The bump is the facilitator's choice — the spec gives v1.0/v1.1/v2.0
// with no rule for inferring which, so guessing from a diff would be inventing
// a requirement.
func CreateReportVersion(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	reportID := chi.URLParam(r2, "reportId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID, contributorRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var body newVersionBody
	_ = json.NewDecoder(r2.Body).Decode(&body)

	var rootID, title, reportType, state string
	var major, minor int
	if err := pool.QueryRow(r2.Context(), `
		select root_id, title, report_type, state, version_major, version_minor
		from public.reports where id = $1 and workshop_id = $2`, reportID, workshopID,
	).Scan(&rootID, &title, &reportType, &state, &major, &minor); err != nil {
		response.Fail(w, response.CodeNotFound, "report not found in this workshop")
		return
	}

	var openVersions int
	pool.QueryRow(r2.Context(),
		`select count(*) from public.reports where root_id = $1 and state in ('draft','submitted','approved')`,
		rootID).Scan(&openVersions)
	if openVersions > 0 {
		response.Fail(w, response.CodeInvalidStateTransition,
			"This report already has an unpublished version in progress.")
		return
	}

	var newMajor, newMinor int
	if err := pool.QueryRow(r2.Context(),
		`select max(version_major), max(version_minor) from public.reports
		 where root_id = $1 and version_major = (select max(version_major) from public.reports where root_id = $1)`,
		rootID).Scan(&newMajor, &newMinor); err != nil {
		newMajor, newMinor = major, minor
	}
	if body.Bump == "major" {
		newMajor, newMinor = newMajor+1, 0
	} else {
		newMinor = newMinor + 1
	}

	var newID string
	if err := pool.QueryRow(r2.Context(), `
		insert into public.reports
		  (workshop_id, title, report_type, state, created_by, generated_by,
		   root_id, supersedes_id, version_major, version_minor)
		values ($1, $2, $3, 'draft', $4, 'human', $5, $6, $7, $8)
		returning id`,
		workshopID, title, reportType, user.ID, rootID, reportID, newMajor, newMinor,
	).Scan(&newID); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	// Copy the previous version's sections, including any edited narrative
	// text, so a new version starts from what was published rather than blank.
	if _, err := pool.Exec(r2.Context(), `
		insert into public.report_sections
		  (report_id, workshop_id, title, section_key, section_type, sort_order, included,
		   source, body, generated_by, source_ai_output_id, edited_by, edited_at)
		select $1, workshop_id, title, section_key, section_type, sort_order, included,
		       source, body, generated_by, source_ai_output_id, edited_by, edited_at
		from public.report_sections where report_id = $2`, newID, reportID); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	version := fmt.Sprintf("v%d.%d", newMajor, newMinor)
	audit.Record(r2.Context(), pool, user.ID, "report.versioned", "report", newID, "", "draft",
		map[string]interface{}{"workshop_id": workshopID, "supersedes": reportID, "version": version})
	response.Created(w, map[string]string{"id": newID, "state": "draft", "version": version})
}

// ExportReportHTML — GET /workshops/{id}/reports/{reportId}/export.html
//
// The second export format alongside browser-printed PDF: a self-contained,
// archivable HTML file with inlined styles and no external requests. Rendered
// with html/template, which escapes by default.
func ExportReportHTML(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	reportID := chi.URLParam(r2, "reportId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID); err != nil {
		writeAuthzErr(w, err)
		return
	}

	detail, errMsg, err := assembleReport(r2, reportID, workshopID)
	if errMsg != "" {
		response.Fail(w, response.CodeNotFound, errMsg)
		return
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	var workshopName string
	_ = pool.QueryRow(r2.Context(), `select name from public.workshops where id = $1`, workshopID).Scan(&workshopName)

	tmpl, err := template.New("report").Parse(reportHTMLTemplate)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	filename := strings.ReplaceAll(strings.ToLower(detail.Title), " ", "-")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s-%s.html"`, filename, detail.Version))

	data := map[string]interface{}{
		"Report":      detail,
		"Workshop":    workshopName,
		"GeneratedAt": time.Now().UTC().Format("2 January 2006"),
	}
	if err := tmpl.Execute(w, data); err != nil {
		// Headers are already sent; nothing useful to return to the client.
		return
	}
}
