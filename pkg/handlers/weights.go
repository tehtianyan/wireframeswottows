// Weights — the generic mechanism behind voting and scoring.
//
// Nothing here knows what is being weighed or on what scale. The definitions
// come from the workshop's methodology, so a methodology that rates risks 1-5
// and one that spends 20 votes run through the same two handlers. See
// pkg/weights for why voting is expressed as a weight rather than beside one.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/objects"
	"swot-tows/pkg/response"
	"swot-tows/pkg/weights"
)

// WeightsResponse is everything the prioritization or scoring UI needs to
// render: what this methodology defines, what the caller has set, and what
// each object totals across everyone.
type WeightsResponse struct {
	Definitions []weights.Definition `json:"definitions"`
	Mine        []weights.Value      `json:"mine"`
	Totals      []weights.Aggregate  `json:"totals"`
	// Spent is the caller's used budget per budget-constrained weight key, so
	// the UI can show remaining without re-summing.
	Spent map[string]float64 `json:"spent"`
}

// weightTargetTable resolves the URL's {kind} segment — which is a route like
// "insights" on the generic object path, but "factors" on the factor path — to
// a table and a registry key. Factors are not in the object registry (they
// have their own handlers), so they are named here explicitly rather than
// being absent, which would make factors unweighable.
func weightTargetTable(kind string) (string, string, error) {
	if kind == "factor" || kind == "factors" {
		return "factors", "factor", nil
	}
	k, err := objects.ByRoute(kind)
	if err != nil {
		if k2, err2 := objects.ByKey(kind); err2 == nil {
			return k2.Table, k2.Key, nil
		}
		return "", "", err
	}
	return k.Table, k.Key, nil
}

// GetWeights — GET /workshops/{id}/weights
func GetWeights(w http.ResponseWriter, r *http.Request) {
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

	defs := applyWorkshopBudgetOverride(r2.Context(), pool, workshopID, m.Weights)

	mine, err := weights.LoadValues(r2.Context(), pool, workshopID, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	totals, err := weights.LoadAggregates(r2.Context(), pool, workshopID, defs)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	spent := map[string]float64{}
	for i := range defs {
		if defs[i].ConstraintType == weights.ConstraintBudget {
			spent[defs[i].Key] = 0
		}
	}
	for _, v := range mine {
		if _, isBudget := spent[v.WeightKey]; isBudget {
			spent[v.WeightKey] += v.Value
		}
	}

	response.OK(w, WeightsResponse{Definitions: defs, Mine: mine, Totals: totals, Spent: spent})
}

type setWeightBody struct {
	// A pointer so an explicit null clears the value. Zero is a legitimate
	// value on any scale whose minimum is zero, so it must not mean "clear".
	Value *float64 `json:"value"`
}

// SetWeight — PUT /workshops/{id}/{kind}/{objectId}/weights/{weightKey}
//
// Idempotent: the body carries the caller's total for this object, not an
// increment, so a double-submitted click cannot spend twice.
func SetWeight(w http.ResponseWriter, r *http.Request) {
	setWeightFor(w, r, chi.URLParam(r, "kind"), chi.URLParam(r, "objectId"))
}

// SetFactorWeight — PUT /workshops/{id}/factors/{factorId}/weights/{weightKey}
//
// Factors need their own entry point rather than falling through the {kind}
// wildcard: chi resolves the static "factors" segment first and never reaches
// the wildcard branch, and it refuses two different parameter names at the
// same position, so the id cannot simply be renamed.
func SetFactorWeight(w http.ResponseWriter, r *http.Request) {
	setWeightFor(w, r, "factors", chi.URLParam(r, "factorId"))
}

func setWeightFor(w http.ResponseWriter, r *http.Request, kindSegment, objectID string) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	weightKey := chi.URLParam(r2, "weightKey")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	table, kindKey, err := weightTargetTable(kindSegment)
	if err != nil {
		response.Fail(w, response.CodeNotFound, err.Error())
		return
	}

	var body setWeightBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	role, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID)
	if err != nil {
		writeAuthzErr(w, err)
		return
	}

	m, err := methodology.LoadForWorkshop(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defs := applyWorkshopBudgetOverride(r2.Context(), pool, workshopID, m.Weights)
	def := weights.ByKey(defs, weightKey)
	if def == nil {
		response.Fail(w, response.CodeNotFound,
			fmt.Sprintf("This workshop's methodology defines no %q weight.", weightKey))
		return
	}
	if def.AppliesTo != kindKey {
		response.Fail(w, response.CodeValidationError,
			fmt.Sprintf("%s applies to %s, not %s.", def.Name, def.AppliesTo, kindKey))
		return
	}
	if !def.AllowsRole(role) {
		response.Fail(w, response.CodeForbidden,
			fmt.Sprintf("your role in this workshop does not allow setting %s", def.Name))
		return
	}

	if msg := checkWeightTarget(r2, pool, table, objectID, workshopID); msg != "" {
		if msg == notFoundSentinel {
			response.Fail(w, response.CodeNotFound, "object not found in this workshop")
		} else {
			response.Fail(w, response.CodeInvalidStateTransition, msg)
		}
		return
	}

	if body.Value == nil {
		if err := weights.Clear(r2.Context(), pool, workshopID, def, objectID, user.ID); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		auditWeight(r2, pool, user.ID, kindKey, objectID, workshopID, weightKey, nil)
		writeWeightSummary(w, r2, pool, workshopID, user.ID, def)
		return
	}

	if msg := def.ValidateValue(*body.Value); msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}
	if msg, err := def.CheckBudget(r2.Context(), pool, workshopID, objectID, user.ID, *body.Value); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	} else if msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}

	if err := weights.Set(r2.Context(), pool, workshopID, def,
		kindKey, objectID, user.ID, *body.Value); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	auditWeight(r2, pool, user.ID, kindKey, objectID, workshopID, weightKey, body.Value)
	writeWeightSummary(w, r2, pool, workshopID, user.ID, def)
}

const notFoundSentinel = "\x00notfound"

// checkWeightTarget confirms the object belongs to this workshop — otherwise a
// caller could weigh another workshop's objects through their own membership —
// and refuses rejected ones.
func checkWeightTarget(r *http.Request, pool *pgxpool.Pool, table, objectID, workshopID string) string {
	var state string
	err := pool.QueryRow(r.Context(), fmt.Sprintf(
		`select coalesce(state, '') from public.%s where id = $1 and workshop_id = $2`, table),
		objectID, workshopID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFoundSentinel
	}
	if err != nil {
		return err.Error()
	}
	if state == "rejected" {
		return "Rejected items cannot be weighted."
	}
	return ""
}

func auditWeight(r *http.Request, pool *pgxpool.Pool, userID, kindKey, objectID,
	workshopID, weightKey string, value *float64) {

	meta := map[string]interface{}{"workshop_id": workshopID, "weight_key": weightKey}
	if value != nil {
		meta["value"] = *value
	} else {
		meta["cleared"] = true
	}
	// Voting keeps its original event name so existing audit assertions and
	// the activity feed's vocabulary do not change under the refactor.
	action := kindKey + ".weighted"
	if weightKey == "vote" {
		action = "factor.voted"
		if value != nil {
			meta["vote_value"] = *value
		}
	}
	audit.Record(r.Context(), pool, userID, action, kindKey, objectID, "", "", meta)
}

// writeWeightSummary answers with the caller's position on this one weight,
// which is what a control needs to re-render after a click.
func writeWeightSummary(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool,
	workshopID, userID string, def *weights.Definition) {

	var used float64
	if err := pool.QueryRow(r.Context(), `
		select coalesce(sum(value), 0) from public.weights
		where workshop_id = $1 and weight_key = $2 and user_id = $3`,
		workshopID, def.Key, userID).Scan(&used); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	out := map[string]interface{}{
		"weight_key": def.Key,
		"used":       used,
	}
	if def.ConstraintTotal != nil {
		out["budget"] = *def.ConstraintTotal
		out["remaining"] = *def.ConstraintTotal - used
	}
	response.OK(w, out)
}

// applyWorkshopBudgetOverride honours workshops.votes_per_participant, the
// per-workshop override a facilitator can set. It predates weights and applies
// only to the vote budget, so it is applied here rather than being baked into
// the definitions every caller loads.
func applyWorkshopBudgetOverride(ctx context.Context, pool *pgxpool.Pool, workshopID string,
	defs []weights.Definition) []weights.Definition {

	var override float64
	if err := pool.QueryRow(ctx,
		`select coalesce(votes_per_participant, 0) from public.workshops where id = $1`,
		workshopID).Scan(&override); err != nil || override <= 0 {
		return defs
	}
	out := make([]weights.Definition, len(defs))
	copy(out, defs)
	for i := range out {
		if out[i].Key == "vote" {
			total := override
			out[i].ConstraintTotal = &total
		}
	}
	return out
}
