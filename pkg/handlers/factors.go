// Factors: the generic replacement for SWOT "artifacts" — App Spec §6.6's
// SWOT Discovery screens, generalized to any methodology's capture stage.
//
// The Draft -> Review -> Approved/Rejected lifecycle implemented here is the
// governance state machine the App Spec applies to every object type, so the
// same rules will carry to syntheses, insights and recommendations in Phase 2.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/auth"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/response"
)

// Roles permitted to make review decisions. Naming them once keeps the
// authority model in a single place rather than scattered string literals.
var reviewerRoles = []string{"facilitator", "analyst"}

type Factor struct {
	ID          string  `json:"id"`
	WorkshopID  string  `json:"workshop_id"`
	CategoryKey string  `json:"category_key"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
	CreatedBy   *string `json:"created_by"`
	State       string  `json:"state"`
	Votes       int     `json:"votes"`
	ReviewedBy  *string `json:"reviewed_by"`
	ReviewedAt  *string `json:"reviewed_at"`
	ReviewNote  *string `json:"review_note"`
	CreatedAt   string  `json:"created_at"`
}

// ListFactors — GET /workshops/{id}/factors?category=strength&state=submitted
//
// Both filters are optional and neither is methodology-aware: `category` is
// matched against whatever categories the workshop's methodology defines.
func ListFactors(w http.ResponseWriter, r *http.Request) {
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

	query := `
		select f.id, f.workshop_id, mfc.key, f.title, f.description, f.created_by, f.state,
		       coalesce((select sum(v.vote_value) from public.votes v where v.factor_id = f.id), 0) as votes,
		       f.reviewed_by, f.reviewed_at, f.review_note,
		       f.created_at
		from public.factors f
		join public.methodology_factor_categories mfc on mfc.id = f.factor_category_id
		where f.workshop_id = $1`
	args := []interface{}{workshopID}

	if category := r2.URL.Query().Get("category"); category != "" {
		args = append(args, category)
		query += ` and mfc.key = $2`
	}
	if state := r2.URL.Query().Get("state"); state != "" {
		args = append(args, state)
		if len(args) == 2 {
			query += ` and f.state = $2`
		} else {
			query += ` and f.state = $3`
		}
	}

	// Highest-voted first so the prioritize stage gets a ranked list for free;
	// creation order breaks ties for the capture stage.
	query += ` order by votes desc, f.created_at desc`

	rows, err := pool.Query(r2.Context(), query, args...)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	factors := []Factor{}
	for rows.Next() {
		var f Factor
		var createdAt time.Time
		var reviewedAt *time.Time
		if err := rows.Scan(&f.ID, &f.WorkshopID, &f.CategoryKey, &f.Title, &f.Description, &f.CreatedBy,
			&f.State, &f.Votes, &f.ReviewedBy, &reviewedAt, &f.ReviewNote, &createdAt); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		f.CreatedAt = createdAt.Format(time.RFC3339)
		if reviewedAt != nil {
			s := reviewedAt.Format(time.RFC3339)
			f.ReviewedAt = &s
		}
		factors = append(factors, f)
	}
	response.OK(w, factors)
}

type createFactorBody struct {
	CategoryKey string  `json:"category_key"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
}

// CreateFactor — POST /workshops/{id}/factors. App Spec §3.17: Create=Yes for
// Participant+. Wireframe §2.11: title required, <=120 chars.
func CreateFactor(w http.ResponseWriter, r *http.Request) {
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

	var body createFactorBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	title := strings.TrimSpace(body.Title)
	if msg := validateFactorTitle(title); msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}

	var categoryID string
	err := pool.QueryRow(r2.Context(), `
		select mfc.id from public.methodology_factor_categories mfc
		join public.workshops w on w.methodology_id = mfc.methodology_id
		where w.id = $1 and mfc.key = $2`, workshopID, body.CategoryKey,
	).Scan(&categoryID)
	if err != nil {
		response.Fail(w, response.CodeValidationError, "unknown factor category for this workshop's methodology")
		return
	}

	// Resolve the open activity for this stage, if one exists, so the factor
	// is linked to it (mirrors the existing activities.stage_id relationship).
	var activityID *string
	pool.QueryRow(r2.Context(), `
		select a.id from public.activities a
		join public.methodology_stages ms on ms.id = a.stage_id
		join public.methodology_factor_categories mfc on mfc.key = $2 and mfc.methodology_id = ms.methodology_id
		where a.workshop_id = $1 and (ms.config->>'factor_category_key') = $2
		limit 1`, workshopID, body.CategoryKey,
	).Scan(&activityID)

	var id string
	err = pool.QueryRow(r2.Context(), `
		insert into public.factors (workshop_id, activity_id, factor_category_id, title, description, created_by, state)
		values ($1, $2, $3, $4, $5, $6, 'submitted')
		returning id`,
		workshopID, activityID, categoryID, title, body.Description, user.ID,
	).Scan(&id)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(r2.Context(), pool, user.ID, "factor.created", "factor", id, "", "submitted", map[string]interface{}{
		"workshop_id": workshopID, "category_key": body.CategoryKey,
	})
	response.Created(w, map[string]string{"id": id})
}

type updateFactorBody struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
}

// UpdateFactor — PATCH /workshops/{id}/factors/{factorId}.
//
// An author may edit their own factor until it has been decided on; a
// reviewer may edit any factor in the workshop. Editing an approved factor is
// refused so an approval always refers to text somebody actually approved.
func UpdateFactor(w http.ResponseWriter, r *http.Request) {
	ctx, pool, user, f, ok := loadFactorForWrite(w, r)
	if !ok {
		return
	}

	var body updateFactorBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	if f.state == "approved" || f.state == "rejected" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"This factor has already been reviewed and can no longer be edited.")
		return
	}

	title := f.title
	if body.Title != nil {
		title = strings.TrimSpace(*body.Title)
		if msg := validateFactorTitle(title); msg != "" {
			response.Fail(w, response.CodeValidationError, msg)
			return
		}
	}
	description := f.description
	if body.Description != nil {
		trimmed := strings.TrimSpace(*body.Description)
		if trimmed == "" {
			description = nil
		} else {
			description = &trimmed
		}
	}

	if _, err := pool.Exec(ctx,
		`update public.factors set title = $2, description = $3 where id = $1`,
		f.id, title, description); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(ctx, pool, user.ID, "factor.updated", "factor", f.id, f.state, f.state, map[string]interface{}{
		"workshop_id": f.workshopID,
	})
	response.OK(w, map[string]string{"id": f.id})
}

// DeleteFactor — DELETE /workshops/{id}/factors/{factorId}. Same authority
// rule as editing; votes cascade away with the row.
func DeleteFactor(w http.ResponseWriter, r *http.Request) {
	ctx, pool, user, f, ok := loadFactorForWrite(w, r)
	if !ok {
		return
	}

	if f.state == "approved" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"Approved factors cannot be deleted — reject it instead so the decision stays on the record.")
		return
	}

	if _, err := pool.Exec(ctx, `delete from public.factors where id = $1`, f.id); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(ctx, pool, user.ID, "factor.deleted", "factor", f.id, f.state, "deleted", map[string]interface{}{
		"workshop_id": f.workshopID, "title": f.title,
	})
	response.OK(w, map[string]string{"id": f.id})
}

type reviewFactorBody struct {
	Action string  `json:"action"` // "approve" | "reject"
	Note   *string `json:"note"`
}

// ReviewFactor — POST /workshops/{id}/factors/{factorId}/review.
//
// The Review Board decision point. Reviewers only, and the decision is always
// attributed — the DB enforces that too (factors_review_attribution_check),
// because App Spec §12.19 requires that AI never approves anything.
func ReviewFactor(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	factorID := chi.URLParam(r2, "factorId")
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
	case "approve":
		newState = "approved"
	case "reject":
		newState = "rejected"
	default:
		response.Fail(w, response.CodeValidationError, `action must be "approve" or "reject"`)
		return
	}

	var currentState string
	err := pool.QueryRow(r2.Context(),
		`select state from public.factors where id = $1 and workshop_id = $2`,
		factorID, workshopID).Scan(&currentState)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "factor not found in this workshop")
		return
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if currentState == "draft" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"This factor is still a draft and has not been submitted for review.")
		return
	}

	note := body.Note
	if note != nil && strings.TrimSpace(*note) == "" {
		note = nil
	}
	if newState == "rejected" && note == nil {
		response.Fail(w, response.CodeValidationError, "A reason is required when rejecting a factor.")
		return
	}

	if _, err := pool.Exec(r2.Context(), `
		update public.factors
		set state = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
		where id = $1`, factorID, newState, user.ID, note); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(r2.Context(), pool, user.ID, "factor."+body.Action+"d", "factor", factorID,
		currentState, newState, map[string]interface{}{"workshop_id": workshopID})
	response.OK(w, map[string]string{"id": factorID, "state": newState})
}

// ---- shared helpers ----

func validateFactorTitle(title string) string {
	if title == "" {
		return "Title is required."
	}
	// Wireframe §2.11 caps titles at 120 characters; the App Spec says 250.
	// 120 wins — it matches the form already shipped (see the plan's spec
	// conflict table).
	if len([]rune(title)) > 120 {
		return "Title must be 120 characters or fewer."
	}
	return ""
}

type factorRow struct {
	id          string
	workshopID  string
	title       string
	description *string
	state       string
	createdBy   *string
}

// loadFactorForWrite resolves the factor named in the URL and authorizes the
// caller to modify it: reviewers may modify any factor, anyone else only
// their own. Writes the error envelope and returns ok=false on failure.
func loadFactorForWrite(w http.ResponseWriter, r *http.Request) (
	context.Context, *pgxpool.Pool, *auth.User, factorRow, bool,
) {
	var empty factorRow

	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return nil, nil, nil, empty, false
	}
	ctx := r2.Context()
	user := httpctx.UserFromContext(ctx)
	workshopID := chi.URLParam(r2, "id")
	factorID := chi.URLParam(r2, "factorId")

	pool := mustPool(r2, w)
	if pool == nil {
		return nil, nil, nil, empty, false
	}

	role, err := authz.RequireWorkshopRole(ctx, pool, user.ID, workshopID)
	if err != nil {
		writeAuthzErr(w, err)
		return nil, nil, nil, empty, false
	}

	var f factorRow
	err = pool.QueryRow(ctx, `
		select id, workshop_id, title, description, state, created_by
		from public.factors where id = $1 and workshop_id = $2`,
		factorID, workshopID,
	).Scan(&f.id, &f.workshopID, &f.title, &f.description, &f.state, &f.createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "factor not found in this workshop")
		return nil, nil, nil, empty, false
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return nil, nil, nil, empty, false
	}

	isReviewer := false
	for _, rr := range reviewerRoles {
		if role == rr {
			isReviewer = true
			break
		}
	}
	isAuthor := f.createdBy != nil && *f.createdBy == user.ID
	if !isReviewer && !isAuthor {
		response.Fail(w, response.CodeForbidden, "you can only modify factors you created")
		return nil, nil, nil, empty, false
	}

	return ctx, pool, user, f, true
}
