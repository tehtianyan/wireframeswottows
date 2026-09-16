// Votes: the prioritize stage's mechanism (App Spec §6.7, Wireframe §3).
//
// Nothing here knows what is being prioritized. The vote budget comes from
// the methodology's prioritize stage config, so a methodology that gives each
// participant 5 votes instead of 20 is a config edit, not a code change.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/response"
)

// Roles that carry a vote. Executive viewers and observers attend without
// influencing the ranking.
var votingRoles = []string{"facilitator", "participant", "analyst"}

type VoteAllocation struct {
	FactorID  string `json:"factor_id"`
	VoteValue int    `json:"vote_value"`
}

type VoteSummary struct {
	Budget      int              `json:"budget"`
	Used        int              `json:"used"`
	Remaining   int              `json:"remaining"`
	Allocations []VoteAllocation `json:"allocations"`
}

// voteBudget resolves how many votes each participant gets in this workshop.
//
// The workshop column is the per-workshop override a facilitator can set; the
// prioritize stage's config is the methodology's own default and the only
// thing consulted when no override applies. The literal 20 that SWOT-TOWS
// uses lives in a config row, not here.
func voteBudget(ctx context.Context, pool *pgxpool.Pool, workshopID string) (int, error) {
	var override int
	if err := pool.QueryRow(ctx,
		`select coalesce(votes_per_participant, 0) from public.workshops where id = $1`,
		workshopID).Scan(&override); err != nil {
		return 0, err
	}
	if override > 0 {
		return override, nil
	}

	m, err := methodology.LoadForWorkshop(ctx, pool, workshopID)
	if err != nil {
		return 0, err
	}
	for _, s := range m.Stages {
		if s.StageType != "prioritize" {
			continue
		}
		if raw, ok := s.Config["votes_per_participant"]; ok {
			if n, ok := raw.(float64); ok && n > 0 {
				return int(n), nil
			}
		}
	}
	// A methodology with no prioritize stage has no budget — voting is simply
	// not part of it, and every allocation attempt will be refused.
	return 0, nil
}

// GetVotes — GET /workshops/{id}/votes. The caller's own budget and
// allocations, which is all the prioritization UI needs to render.
func GetVotes(w http.ResponseWriter, r *http.Request) {
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

	budget, err := voteBudget(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	rows, err := pool.Query(r2.Context(),
		`select factor_id, vote_value from public.votes where workshop_id = $1 and user_id = $2`,
		workshopID, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	summary := VoteSummary{Budget: budget, Allocations: []VoteAllocation{}}
	for rows.Next() {
		var a VoteAllocation
		if err := rows.Scan(&a.FactorID, &a.VoteValue); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		summary.Used += a.VoteValue
		summary.Allocations = append(summary.Allocations, a)
	}
	summary.Remaining = budget - summary.Used
	response.OK(w, summary)
}

type setVoteBody struct {
	Value int `json:"value"`
}

// SetVote — PUT /workshops/{id}/factors/{factorId}/vote.
//
// Idempotent: the body carries the participant's total allocation to this
// factor, not an increment, so a double-submitted click cannot silently spend
// twice. Zero clears the allocation.
func SetVote(w http.ResponseWriter, r *http.Request) {
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

	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID, votingRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var body setVoteBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	if body.Value < 0 {
		response.Fail(w, response.CodeValidationError, "Vote value cannot be negative.")
		return
	}

	// The factor must belong to this workshop — otherwise a caller could spend
	// votes against another workshop's factors through their own membership.
	var factorState string
	err := pool.QueryRow(r2.Context(),
		`select state from public.factors where id = $1 and workshop_id = $2`,
		factorID, workshopID).Scan(&factorState)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "factor not found in this workshop")
		return
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if factorState == "rejected" {
		response.Fail(w, response.CodeInvalidStateTransition, "Rejected factors cannot be voted on.")
		return
	}

	budget, err := voteBudget(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if budget == 0 {
		response.Fail(w, response.CodeInvalidStateTransition,
			"This methodology has no prioritization stage, so there are no votes to allocate.")
		return
	}

	var usedElsewhere int
	if err := pool.QueryRow(r2.Context(), `
		select coalesce(sum(vote_value), 0) from public.votes
		where workshop_id = $1 and user_id = $2 and factor_id <> $3`,
		workshopID, user.ID, factorID).Scan(&usedElsewhere); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if usedElsewhere+body.Value > budget {
		response.Fail(w, response.CodeValidationError,
			"That would exceed your vote budget for this workshop.")
		return
	}

	if body.Value == 0 {
		if _, err := pool.Exec(r2.Context(),
			`delete from public.votes where factor_id = $1 and user_id = $2`,
			factorID, user.ID); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
	} else {
		if _, err := pool.Exec(r2.Context(), `
			insert into public.votes (factor_id, workshop_id, user_id, vote_value)
			values ($1, $2, $3, $4)
			on conflict (factor_id, user_id) do update set vote_value = excluded.vote_value`,
			factorID, workshopID, user.ID, body.Value); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
	}

	audit.Record(r2.Context(), pool, user.ID, "factor.voted", "factor", factorID, "", "", map[string]interface{}{
		"workshop_id": workshopID, "vote_value": body.Value,
	})

	response.OK(w, VoteSummary{
		Budget:    budget,
		Used:      usedElsewhere + body.Value,
		Remaining: budget - (usedElsewhere + body.Value),
	})
}
