// Factors: the generic replacement for SWOT "artifacts" — App Spec §6.6's
// SWOT Discovery screens, generalized to any methodology's capture stage.
package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/response"
)

type Factor struct {
	ID          string  `json:"id"`
	WorkshopID  string  `json:"workshop_id"`
	CategoryKey string  `json:"category_key"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
	CreatedBy   *string `json:"created_by"`
	State       string  `json:"state"`
	Votes       int     `json:"votes"`
	CreatedAt   string  `json:"created_at"`
}

// ListFactors — GET /workshops/{id}/factors?category=strength
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

	category := r2.URL.Query().Get("category")

	query := `
		select f.id, f.workshop_id, mfc.key, f.title, f.description, f.created_by, f.state,
		       coalesce((select count(*) from public.votes v where v.artifact_id = f.id), 0) as votes,
		       f.created_at
		from public.factors f
		join public.methodology_factor_categories mfc on mfc.id = f.factor_category_id
		where f.workshop_id = $1`
	args := []interface{}{workshopID}
	if category != "" {
		query += ` and mfc.key = $2`
		args = append(args, category)
	}
	query += ` order by f.created_at desc`

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
		if err := rows.Scan(&f.ID, &f.WorkshopID, &f.CategoryKey, &f.Title, &f.Description, &f.CreatedBy, &f.State, &f.Votes, &createdAt); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		f.CreatedAt = createdAt.Format(time.RFC3339)
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
	if title == "" {
		response.Fail(w, response.CodeValidationError, "Title is required.")
		return
	}
	if len(title) > 120 {
		response.Fail(w, response.CodeValidationError, "Title must be 120 characters or fewer.")
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
