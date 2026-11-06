package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/response"
)

type Activity struct {
	ID       string `json:"id"`
	StageKey string `json:"stage_key"`
	Title    string `json:"title"`
	// The status to SHOW: not_started | in_progress | completed. Derived from
	// content except when a facilitator has closed the stage. See
	// stage_status.go for why progress is derived and completion is not.
	Status string `json:"status"`
	// Whether a facilitator has explicitly closed this stage. Separate from
	// Status so a client can tell "the room has finished with this" from "this
	// happens to be empty" — and so the control knows which way it toggles.
	MarkedComplete bool `json:"marked_complete"`
	// How many things exist in this stage. Returned because the status is
	// derived FROM it: a badge saying IN PROGRESS beside a count of zero would
	// be unexplainable, and this is what makes the derivation legible.
	ContentCount int `json:"content_count"`
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

	m, err := methodology.LoadForWorkshop(r2.Context(), pool, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}
	stageByKey := map[string]methodology.Stage{}
	for _, s := range m.Stages {
		stageByKey[s.Key] = s
	}

	counts, err := loadStageCounts(r2.Context(), pool, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}

	rows, err := pool.Query(r2.Context(), `
		select a.id, ms.key, a.title, a.status
		from public.activities a
		join public.methodology_stages ms on ms.id = a.stage_id
		where a.workshop_id = $1
		order by ms.sequence_number`, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}
	defer rows.Close()

	activities := []Activity{}
	for rows.Next() {
		var a Activity
		var stored string
		if err := rows.Scan(&a.ID, &a.StageKey, &a.Title, &stored); err != nil {
			failDB(w, err)
			return
		}
		stage, known := stageByKey[a.StageKey]
		if known {
			a.ContentCount = counts.contentFor(stage)
		}
		a.MarkedComplete = stored == stageCompleted
		a.Status = stageStatus(stored, a.ContentCount)
		activities = append(activities, a)
	}
	if err := rows.Err(); err != nil {
		failDB(w, err)
		return
	}
	response.OK(w, activities)
}

type stageCompleteBody struct {
	// Pointer so "absent" is distinguishable from "false". A request that
	// forgot the field must be refused rather than silently re-opening a stage
	// the facilitator meant to close — the same reason reviewAIBody.Index is a
	// pointer.
	Complete *bool `json:"complete"`
}

// SetStageComplete — PUT /workshops/{id}/stages/{stageKey}/complete
//
// FACILITATOR ONLY, AND THAT IS A BOUNDARY rather than an affordance. Closing a
// stage is a statement about the whole room's work: it feeds the workshop health
// score, the executive dashboard and App Spec §8.30's gate on completing the
// workshop. Contrast `visible_to_roles`, which only removes clutter and is
// deliberately bypassable by pasting a URL.
//
// Re-openable on purpose. A facilitator who closes Strengths and then finds the
// room has more to say must be able to go back, which is the same reasoning
// that keeps the capture board's three-step readout a signpost and not a lock.
func SetStageComplete(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	stageKey := chi.URLParam(r2, "stageKey")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	// Role enforcement is the authz package's, with the allowed roles passed in
	// — the same idiom as the factor-order endpoint, which is facilitator-only
	// for the closely related reason that rearranging the wall is an edit to
	// what the whole room is looking at.
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID, "facilitator"); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var body stageCompleteBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil || body.Complete == nil {
		response.Fail(w, response.CodeValidationError,
			"complete must be true or false")
		return
	}

	status := stageNotStarted
	if *body.Complete {
		status = stageCompleted
	}

	// `completed_at` is set and cleared with the status so the two cannot
	// disagree — a row reading not_started with a completion timestamp on it
	// is the kind of self-contradicting record the audit trail exists to avoid.
	var activityID string
	err := pool.QueryRow(r2.Context(), `
		update public.activities a
		   set status = $3,
		       completed_at = case when $3 = 'completed' then now() else null end,
		       updated_at = now()
		 where a.workshop_id = $1
		   and a.stage_id = (select id from public.methodology_stages where key = $2
		                      and methodology_id = (select methodology_id from public.workshops where id = $1))
		returning a.id`, workshopID, stageKey, status).Scan(&activityID)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "no such stage in this workshop")
		return
	}
	if err != nil {
		failDB(w, err)
		return
	}

	action := "activity.reopened"
	if *body.Complete {
		action = "activity.completed"
	}
	audit.Record(r2.Context(), pool, user.ID, action, "activity", activityID, "", status, nil)

	response.OK(w, map[string]any{
		"id":        activityID,
		"stage_key": stageKey,
		"status":    status,
	})
}
