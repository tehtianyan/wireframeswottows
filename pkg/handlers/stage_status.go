package handlers

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/methodology"
	"swot-tows/pkg/objects"
)

// WHAT A STAGE'S STATUS MEANS, AND WHY IT IS COMPUTED HERE (DECIDED 2026-11-06)
//
// UAT: "the status of the Stage still says NOT STARTED even though there has
// been activity." It was worse than a stale label. `activities.status` was
// written EXACTLY ONCE — `'not_started'` at workshop creation — and nothing in
// the codebase ever updated it. Dev held 121 `not_started` and 10 `pending`,
// and zero `completed`, after months of use.
//
// Four readers depended on that column, so the damage was not only cosmetic:
//   * the overview's stage badges (the reported symptom);
//   * the dashboard's `stages_complete`, hence the workshop health score's
//     stage-progress signal, which was therefore permanently zero;
//   * the executive dashboard's completed-activity counts;
//   * CompleteWorkshop's App Spec §8.30 gate, which refuses while any activity
//     is not `completed` — so NO WORKSHOP COULD EVER BE COMPLETED. A hard gate
//     against a condition nothing could satisfy.
//
// THE SPLIT: PROGRESS IS DERIVED, COMPLETION IS DECIDED.
//
// `not_started` vs `in_progress` is a fact about content — has anybody put
// anything in this stage — so it is computed from the content every time and
// never stored. That follows the rule already settled for the capture board's
// three-step readout: "the step reached is DERIVED, never stored", because a
// stored phase is a column, an endpoint, a permission rule and an audit event
// enforcing an order the room can already see.
//
// `completed` is NOT derivable. There is no count that means "the room is done
// talking about strengths" — a stage with three notes may be finished and one
// with thirty may not be. It is a facilitator's judgement, so it is an explicit
// decision, stored on `activities.status`, attributed and audited. That also
// restores §8.30: the gate reads the same column, and a facilitator closing
// each stage is exactly what it was written to check.
//
// NOTHING HERE NAMES A METHODOLOGY. The count for a stage comes from the object
// kind registry, looked up by the stage's TYPE — so a `synthesize` stage counts
// whatever `pkg/objects` says a synthesize stage produces. A methodology with a
// stage type this does not know scores zero and reads `not_started`, which is
// honest rather than wrong.

const (
	stageNotStarted = "not_started"
	stageInProgress = "in_progress"
	stageCompleted  = "completed"
)

// stageCounts holds one workshop's content totals, enough to answer
// "has anything happened in this stage?" for every stage type.
type stageCounts struct {
	// factors per category_key, for capture stages.
	factorsByCategory map[string]int
	// Rows per object table, for the kinds the registry knows.
	byTable map[string]int
	// Weight values recorded in the workshop, for prioritize stages.
	weights int
	// Reports, for report stages.
	reports int
}

// loadStageCounts gathers every total in a handful of aggregate queries rather
// than one per stage — a ten-stage methodology would otherwise cost ten round
// trips to draw one list.
func loadStageCounts(
	ctx context.Context,
	pool *pgxpool.Pool,
	workshopID string,
) (*stageCounts, error) {
	c := &stageCounts{
		factorsByCategory: map[string]int{},
		byTable:           map[string]int{},
	}

	// Capture: factors by category KEY, which is what a capture stage's config
	// names. `factors` stores `factor_category_id` — the key lives on
	// methodology_factor_categories, so this joins rather than assuming a
	// `category_key` column the API only ever exposed through a join.
	//
	// `archived` and `rejected` are excluded — a stage whose only notes were
	// thrown away has nothing in it, and the capture board hides them for the
	// same reason.
	rows, err := pool.Query(ctx, `
		select c.key, count(*)::int
		from public.factors f
		join public.methodology_factor_categories c on c.id = f.factor_category_id
		where f.workshop_id = $1 and f.state not in ('archived', 'rejected')
		group by c.key`, workshopID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var key string
		var n int
		if err := rows.Scan(&key, &n); err != nil {
			rows.Close()
			return nil, err
		}
		c.factorsByCategory[key] = n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Every object kind the registry declares, counted in its own table.
	//
	// The table name comes from the registry, which holds fixed identifiers and
	// never request input — the same property the generic SQL builder in
	// pkg/handlers/objects.go depends on. That is what makes this interpolation
	// safe, and it is the reason the registry forbids caller-supplied names.
	for _, kind := range objects.All() {
		var n int
		q := fmt.Sprintf(`select count(*)::int from public.%s
			where workshop_id = $1 and state not in ('archived', 'rejected')`, kind.Table)
		if err := pool.QueryRow(ctx, q, workshopID).Scan(&n); err != nil {
			return nil, err
		}
		c.byTable[kind.Table] = n
	}

	// Prioritize: any weight recorded in the workshop. Deliberately not
	// filtered to a particular weight key — the stage's own config may declare
	// one, and that is applied per stage in stageStatus rather than assumed
	// here, so a methodology with two weights on one stage still counts.
	if err := pool.QueryRow(ctx,
		`select count(*)::int from public.weights where workshop_id = $1`, workshopID,
	).Scan(&c.weights); err != nil {
		return nil, err
	}

	if err := pool.QueryRow(ctx,
		`select count(*)::int from public.reports where workshop_id = $1`, workshopID,
	).Scan(&c.reports); err != nil {
		return nil, err
	}

	return c, nil
}

// contentFor returns how many things exist in this stage.
func (c *stageCounts) contentFor(stage methodology.Stage) int {
	switch stage.StageType {
	case "capture":
		// The category this capture stage collects, from its own config. A
		// capture stage with no category configured is a misconfiguration the
		// stage renderer already reports, so it counts nothing here rather
		// than silently summing the whole workshop.
		if key, ok := stage.Config["factor_category_key"].(string); ok {
			return c.factorsByCategory[key]
		}
		return 0
	case "prioritize":
		return c.weights
	case "report":
		return c.reports
	default:
		// Registry-driven: whatever kind this stage type produces. An unknown
		// stage type is not an error here — it scores zero and reads
		// `not_started`, which is honest rather than wrong.
		if kind, err := objects.ByStageType(stage.StageType); err == nil && kind != nil {
			return c.byTable[kind.Table]
		}
		return 0
	}
}

// stageStatus is the status one stage reports.
//
// `stored` is the row's own `activities.status`. Only `completed` is honoured
// from it: that is the facilitator's decision and it outranks the content,
// because a stage can be closed with little in it. Every other stored value —
// including the legacy `pending` rows that predate this and the
// `not_started` every row was created with — is ignored in favour of the
// derived answer, which is what stops a dead column from speaking again.
func stageStatus(stored string, content int) string {
	if stored == stageCompleted {
		return stageCompleted
	}
	if content > 0 {
		return stageInProgress
	}
	return stageNotStarted
}
