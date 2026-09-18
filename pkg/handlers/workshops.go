// Package handlers implements the /api/v1 REST surface from Application
// Specification §11. This file: workshops + their lifecycle state machine
// (§8.5-8.7, §8.30, §11 workshop endpoints).
package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/db"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/response"
)

type Workshop struct {
	ID                   string  `json:"id"`
	WorkspaceID          string  `json:"workspace_id"`
	MethodologyID        string  `json:"methodology_id"`
	Name                 string  `json:"name"`
	Description          *string `json:"description"`
	Objective            *string `json:"objective"`
	FacilitatorID        *string `json:"facilitator_id"`
	Status               string  `json:"status"`
	VotesPerParticipant  int     `json:"votes_per_participant"`
	CreatedAt            string  `json:"created_at"`
}

type WorkshopDetail struct {
	Workshop
	Methodology *methodology.Methodology `json:"methodology"`
	// The caller's own role, so the UI can hide controls it would be
	// refused anyway. Go still enforces every one of them server-side.
	MyRole string `json:"my_role"`
}

// forward-only lifecycle per App Spec §8.7
var nextStatus = map[string]string{
	"draft":      "configured",
	"configured": "active",
	"active":     "analysis",
	"analysis":   "reporting",
	"reporting":  "completed",
}

func ListWorkshops(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool, err := db.Pool(r2.Context())
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	rows, err := pool.Query(r2.Context(), `
		select w.id, w.workspace_id, w.methodology_id, w.name, w.description, w.objective,
		       w.facilitator_id, w.status, w.votes_per_participant, w.created_at
		from public.workshops w
		join public.workshop_members wm on wm.workshop_id = w.id
		where wm.user_id = $1
		order by w.created_at desc`, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	workshops := []Workshop{}
	for rows.Next() {
		var wk Workshop
		var createdAt time.Time
		if err := rows.Scan(&wk.ID, &wk.WorkspaceID, &wk.MethodologyID, &wk.Name, &wk.Description,
			&wk.Objective, &wk.FacilitatorID, &wk.Status, &wk.VotesPerParticipant, &createdAt); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		wk.CreatedAt = createdAt.Format(time.RFC3339)
		workshops = append(workshops, wk)
	}
	response.OK(w, workshops)
}

func GetWorkshop(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	id := chi.URLParam(r2, "id")

	myRole, err := authz.RequireWorkshopRole(r2.Context(), mustPool(r2, w), user.ID, id)
	if err != nil {
		writeAuthzErr(w, err)
		return
	}

	pool, _ := db.Pool(r2.Context())
	var wk Workshop
	var createdAt time.Time
	err = pool.QueryRow(r2.Context(), `
		select id, workspace_id, methodology_id, name, description, objective,
		       facilitator_id, status, votes_per_participant, created_at
		from public.workshops where id = $1`, id,
	).Scan(&wk.ID, &wk.WorkspaceID, &wk.MethodologyID, &wk.Name, &wk.Description,
		&wk.Objective, &wk.FacilitatorID, &wk.Status, &wk.VotesPerParticipant, &createdAt)
	if err != nil {
		response.Fail(w, response.CodeNotFound, "workshop not found")
		return
	}
	wk.CreatedAt = createdAt.Format(time.RFC3339)

	m, err := methodology.Load(r2.Context(), pool, wk.MethodologyID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	response.OK(w, WorkshopDetail{Workshop: wk, Methodology: m, MyRole: myRole})
}

type createWorkshopBody struct {
	WorkspaceID     string  `json:"workspace_id"`
	Name            string  `json:"name"`
	Description     *string `json:"description"`
	Objective       *string `json:"objective"`
	MethodologyKey  string  `json:"methodology_key"`
}

// CreateWorkshop — App Spec §3.16: Administrator/Facilitator only.
func CreateWorkshop(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	var body createWorkshopBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	if body.Name == "" {
		response.Fail(w, response.CodeValidationError, "Workshop name is required.")
		return
	}
	// No default methodology. The engine must not privilege one methodology
	// over another — the caller says which one it wants.
	if body.MethodologyKey == "" {
		response.Fail(w, response.CodeValidationError, "A methodology must be selected.")
		return
	}

	role, err := authz.WorkspaceRole(r2.Context(), pool, user.ID, body.WorkspaceID)
	if err != nil || (role != "owner" && role != "admin" && role != "facilitator") {
		response.Fail(w, response.CodeForbidden, "only a facilitator can create a workshop")
		return
	}

	var methodologyID string
	if err := pool.QueryRow(r2.Context(),
		`select id from public.methodologies where key = $1 and is_active = true`, body.MethodologyKey,
	).Scan(&methodologyID); err != nil {
		response.Fail(w, response.CodeValidationError, "unknown or inactive methodology")
		return
	}

	m, err := methodology.Load(r2.Context(), pool, methodologyID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	// The vote budget is the methodology's, taken from its prioritize stage.
	// A methodology with no prioritize stage gets 0 and simply has no voting.
	votesPerParticipant := 0
	for _, s := range m.Stages {
		if s.StageType != "prioritize" {
			continue
		}
		if n, ok := s.Config["votes_per_participant"].(float64); ok && n > 0 {
			votesPerParticipant = int(n)
		}
	}

	var id string
	err = pool.QueryRow(r2.Context(), `
		insert into public.workshops (workspace_id, methodology_id, name, description, objective, facilitator_id, created_by, status, votes_per_participant)
		values ($1, $2, $3, $4, $5, $6, $6, 'draft', $7)
		returning id`,
		body.WorkspaceID, methodologyID, body.Name, body.Description, body.Objective, user.ID, votesPerParticipant,
	).Scan(&id)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	_, err = pool.Exec(r2.Context(), `
		insert into public.workshop_members (workshop_id, user_id, role, joined_at)
		values ($1, $2, 'facilitator', now())`, id, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	// Seed one activity per configured stage. This is what makes a new
	// methodology's workshop run end to end without any code: a PESTLE
	// workshop gets PESTLE's six capture stages here, in its own order.
	for _, s := range m.Stages {
		if _, err := pool.Exec(r2.Context(), `
			insert into public.activities (workshop_id, stage_id, title, sequence_number, status)
			values ($1, $2, $3, $4, 'not_started')`,
			id, s.ID, s.Name, s.SequenceNumber); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
	}

	audit.Record(r2.Context(), pool, user.ID, "workshop.created", "workshop", id, "", "draft", map[string]interface{}{
		"methodology_key": m.Key, "stages_seeded": len(m.Stages),
	})
	response.Created(w, map[string]string{"id": id, "status": "draft"})
}

// TransitionWorkshop handles the explicit state-transition endpoints:
// configure, start, analysis, reporting. complete has its own handler
// because of the §8.30 completion gate.
func TransitionWorkshop(toStatusOverride string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r2, ok := httpctx.RequireAuth(w, r)
		if !ok {
			return
		}
		user := httpctx.UserFromContext(r2.Context())
		id := chi.URLParam(r2, "id")
		pool := mustPool(r2, w)
		if pool == nil {
			return
		}

		if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, id, "facilitator"); err != nil {
			writeAuthzErr(w, err)
			return
		}

		var current string
		if err := pool.QueryRow(r2.Context(), `select status from public.workshops where id = $1`, id).Scan(&current); err != nil {
			response.Fail(w, response.CodeNotFound, "workshop not found")
			return
		}

		target := toStatusOverride
		if target == "" {
			var ok2 bool
			target, ok2 = nextStatus[current]
			if !ok2 {
				response.Fail(w, response.CodeInvalidStateTransition, "workshop has no forward transition from "+current)
				return
			}
		} else if nextStatus[current] != target {
			response.Fail(w, response.CodeInvalidStateTransition, "cannot move from "+current+" to "+target)
			return
		}

		_, err := pool.Exec(r2.Context(), `update public.workshops set status = $1, updated_at = now() where id = $2`, target, id)
		if err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}

		audit.Record(r2.Context(), pool, user.ID, "workshop.status_changed", "workshop", id, current, target, nil)
		response.OK(w, map[string]string{"id": id, "status": target})
	}
}

// CompleteWorkshop enforces the §8.30 hard gate: all activities completed AND
// syntheses approved AND insights approved AND recommendations approved AND
// a report published.
func CompleteWorkshop(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	id := chi.URLParam(r2, "id")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, id, "facilitator"); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var current string
	if err := pool.QueryRow(r2.Context(), `select status from public.workshops where id = $1`, id).Scan(&current); err != nil {
		response.Fail(w, response.CodeNotFound, "workshop not found")
		return
	}
	if current != "reporting" {
		response.Fail(w, response.CodeInvalidStateTransition, "workshop must be in reporting status to complete")
		return
	}

	// These three checks were comparing against state = 'review', a value the
	// Phase 2 migration removed when it unified the governance vocabulary onto
	// draft|submitted|approved|rejected|archived. They could therefore never
	// match, and the §8.30 gate silently stopped checking for unapproved
	// content — masked only because no report could be published yet. Phase 4
	// removes that mask, so this has to be right now.
	//
	// `state <> 'approved'` is the correct test: it catches draft and
	// submitted, while archived and rejected content is deliberately excluded
	// from the count below by not blocking on it.
	var incompleteActivities, unapprovedSyntheses, unapprovedInsights, unapprovedRecs, publishedReports int
	pool.QueryRow(r2.Context(), `select count(*) from public.activities where workshop_id = $1 and status <> 'completed'`, id).Scan(&incompleteActivities)
	pool.QueryRow(r2.Context(), `select count(*) from public.syntheses where workshop_id = $1 and state in ('draft','submitted')`, id).Scan(&unapprovedSyntheses)
	pool.QueryRow(r2.Context(), `select count(*) from public.insights where workshop_id = $1 and state in ('draft','submitted')`, id).Scan(&unapprovedInsights)
	pool.QueryRow(r2.Context(), `select count(*) from public.recommendations where workshop_id = $1 and state in ('draft','submitted')`, id).Scan(&unapprovedRecs)
	pool.QueryRow(r2.Context(), `select count(*) from public.reports where workshop_id = $1 and state = 'published'`, id).Scan(&publishedReports)

	if incompleteActivities > 0 || unapprovedSyntheses > 0 || unapprovedInsights > 0 || unapprovedRecs > 0 || publishedReports == 0 {
		response.Fail(w, response.CodeInvalidStateTransition,
			"workshop is not ready to complete: all activities must be completed, all syntheses/insights/recommendations approved, and a report published")
		return
	}

	_, err := pool.Exec(r2.Context(), `update public.workshops set status = 'completed', updated_at = now() where id = $1`, id)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(r2.Context(), pool, user.ID, "workshop.completed", "workshop", id, "reporting", "completed", nil)
	response.OK(w, map[string]string{"id": id, "status": "completed"})
}
