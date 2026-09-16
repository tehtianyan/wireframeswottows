package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/response"
)

type Activity struct {
	ID       string `json:"id"`
	StageKey string `json:"stage_key"`
	Title    string `json:"title"`
	Status   string `json:"status"`
}

// ListActivities — GET /workshops/{id}/activities
func ListActivities(w http.ResponseWriter, r *http.Request) {
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

	rows, err := pool.Query(r2.Context(), `
		select a.id, ms.key, a.title, a.status
		from public.activities a
		join public.methodology_stages ms on ms.id = a.stage_id
		where a.workshop_id = $1
		order by ms.sequence_number`, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	activities := []Activity{}
	for rows.Next() {
		var a Activity
		if err := rows.Scan(&a.ID, &a.StageKey, &a.Title, &a.Status); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		activities = append(activities, a)
	}
	response.OK(w, activities)
}
