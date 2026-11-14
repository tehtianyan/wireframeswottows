package handlers

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/methodology"
)

// How many stages the ROOM walks, and how many of those have been closed.
//
// UAT 2026-11-14: "Correct the Workshop Health to the actual stage of 6
// stages." The health panel read "0 of 10 stages complete" directly under a
// Stages panel that says six, and the four it counted on top are the
// facilitator's analysis TOOLS — screens used between steps, which nobody ever
// marks complete.
//
// SO THE SIGNAL COULD NOT REACH ITS OWN TARGET. A facilitator who finished the
// entire methodology would have read 6 of 10, and the health score — the mean
// of coverage, approval and progress — was capped at 80 for a SWOT-TOWS
// workshop that had been run to the end. That is the shape of a guard that
// cannot fire: a measure whose best case is a failing number says nothing.
//
// THE NUMERATOR MOVES WITH THE DENOMINATOR. A tool that somebody has marked
// complete is excluded from both, or a thorough facilitator reads 7 of 6.
//
// ONE RULE, THREE READERS. The health panel, the dashboard card and the
// executive portfolio all showed ten; fixing the one that was reported would
// have left the same misreading one screen away. `configIsFacilitatorOnly` is
// the only statement of it in Go, and `src/lib/stages.ts` holds the matching
// one for the client, which `tests/suites/participant-flow.js` pins against
// each other.
type stepCounts struct {
	Total    int
	Complete int
}

// configIsFacilitatorOnly reads `visible_to_roles` off a stage's config.
//
// A stage listing roles and NOT listing "participant" is a tool rather than a
// step in the room's path. An absent or empty list means everybody, which is
// why this asks for a non-empty list that excludes participants rather than
// for the key's mere presence — a stage declaring `["participant","analyst"]`
// is still something the room walks through, and counting it as a tool would
// drop a real step out of the denominator.
func configIsFacilitatorOnly(cfg map[string]interface{}) bool {
	raw, ok := cfg["visible_to_roles"].([]interface{})
	if !ok || len(raw) == 0 {
		return false
	}
	for _, v := range raw {
		if s, _ := v.(string); s == "participant" {
			return false
		}
	}
	return true
}

// stageIsFacilitatorOnly is the same question asked of a loaded stage.
func stageIsFacilitatorOnly(st methodology.Stage) bool {
	return configIsFacilitatorOnly(st.Config)
}

// loadStepCounts answers it for SEVERAL workshops in one query.
//
// The dashboard lists every workshop a person belongs to, so asking per
// workshop would add a query each — and loading each one's full methodology to
// reach the same answer would add six. The stage configs are small and the
// whole set comes back in a single round trip.
//
// COUNTED FROM `methodology_stages`, NOT FROM `activities`. The stages are what
// the methodology declares; `activities` is the per-workshop instance of them,
// and a workshop missing an activity row would otherwise report a smaller
// denominator than the screen beside it draws. A stage with no activity row has
// simply not been started.
func loadStepCounts(ctx context.Context, pool *pgxpool.Pool,
	workshopIDs []string) (map[string]stepCounts, error) {
	out := map[string]stepCounts{}
	if len(workshopIDs) == 0 {
		return out, nil
	}
	rows, err := pool.Query(ctx, `
		select w.id::text, ms.config, coalesce(a.status, 'not_started')
		from public.workshops w
		join public.methodology_stages ms on ms.methodology_id = w.methodology_id
		left join public.activities a on a.workshop_id = w.id and a.stage_id = ms.id
		where w.id = any($1::uuid[])`, workshopIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, status string
		var cfg map[string]interface{}
		if err := rows.Scan(&id, &cfg, &status); err != nil {
			return nil, err
		}
		if configIsFacilitatorOnly(cfg) {
			continue
		}
		c := out[id]
		c.Total++
		if status == "completed" {
			c.Complete++
		}
		out[id] = c
	}
	return out, rows.Err()
}
