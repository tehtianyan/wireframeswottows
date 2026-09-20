// Votes: the prioritize stage's mechanism (App Spec §6.7, Wireframe §3).
//
// These two handlers are now ADAPTERS over pkg/weights. A vote turned out to
// be one instance of a general idea — a constrained number attached to an
// object on a configured scale — and voting is now expressed through that
// mechanism rather than beside it. See pkg/weights for the reasoning.
//
// The endpoints, the response shape and the `factor.voted` audit event all
// stay exactly as they were, because people are running UAT against the
// prioritization screens. This file is the compatibility surface; delete it
// only once nothing calls /votes.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/response"
	"swot-tows/pkg/weights"
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

// voteDefinition resolves the 'vote' weight for this workshop, with the
// per-workshop override applied.
//
// The override column is the budget a facilitator can set for one workshop;
// the methodology's own default arrives in the weight definition, seeded from
// the prioritize stage's config. The literal 20 that SWOT-TOWS uses lives in a
// config row, not here — and neither does any other number.
func voteDefinition(ctx context.Context, pool *pgxpool.Pool, workshopID string) (*weights.Definition, error) {
	m, err := methodology.LoadForWorkshop(ctx, pool, workshopID)
	if err != nil {
		return nil, err
	}
	defs := applyWorkshopBudgetOverride(ctx, pool, workshopID, m.Weights)
	return weights.ByKey(defs, "vote"), nil
}

// voteBudget is the caller's budget as a whole number, which is the shape the
// prioritization UI has always been given.
//
// A methodology with no prioritize stage defines no vote weight, so voting is
// simply not part of it and every allocation attempt is refused.
func voteBudget(ctx context.Context, pool *pgxpool.Pool, workshopID string) (int, error) {
	def, err := voteDefinition(ctx, pool, workshopID)
	if err != nil {
		return 0, err
	}
	if def == nil || def.ConstraintTotal == nil {
		return 0, nil
	}
	return int(*def.ConstraintTotal), nil
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

	// Reads weights, not votes: the vote rows were copied across in
	// 20260920100000_weight_abstraction.sql and this is now the only source.
	rows, err := pool.Query(r2.Context(), `
		select object_id::text, value from public.weights
		where workshop_id = $1 and user_id = $2 and weight_key = 'vote'`,
		workshopID, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	summary := VoteSummary{Budget: budget, Allocations: []VoteAllocation{}}
	for rows.Next() {
		var a VoteAllocation
		var value float64
		if err := rows.Scan(&a.FactorID, &value); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		// A vote's scale is integral by configuration, and this endpoint's
		// contract has always been whole numbers.
		a.VoteValue = int(value)
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

	def, err := voteDefinition(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if def == nil || def.ConstraintTotal == nil {
		response.Fail(w, response.CodeInvalidStateTransition,
			"This methodology has no prioritization stage, so there are no votes to allocate.")
		return
	}
	budget := int(*def.ConstraintTotal)

	value := float64(body.Value)
	if msg := def.ValidateValue(value); msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}
	if msg, err := def.CheckBudget(r2.Context(), pool, workshopID, factorID, user.ID, value); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	} else if msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}

	// Zero clears, which is this endpoint's long-standing contract. The
	// generic weight endpoint uses an explicit null instead, because zero is a
	// legitimate value on a scale that starts at zero.
	if body.Value == 0 {
		err = weights.Clear(r2.Context(), pool, workshopID, def, factorID, user.ID)
	} else {
		err = weights.Set(r2.Context(), pool, workshopID, def, "factor", factorID, user.ID, value)
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	auditWeight(r2, pool, user.ID, "factor", factorID, workshopID, "vote", &value)

	var used float64
	if err := pool.QueryRow(r2.Context(), `
		select coalesce(sum(value), 0) from public.weights
		where workshop_id = $1 and user_id = $2 and weight_key = 'vote'`,
		workshopID, user.ID).Scan(&used); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	response.OK(w, VoteSummary{
		Budget:    budget,
		Used:      int(used),
		Remaining: budget - int(used),
	})
}
