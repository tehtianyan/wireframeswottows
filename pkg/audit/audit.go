// Package audit writes audit_events rows, per App Spec §11.31's list of
// actions that must be recorded and §8.34's required fields.
package audit

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Record(ctx context.Context, pool *pgxpool.Pool, actorID, action, objectType, objectID, previousState, newState string, metadata map[string]interface{}) {
	var metaJSON []byte
	if metadata != nil {
		metaJSON, _ = json.Marshal(metadata)
	}
	// Best-effort: an audit-write failure should never block the caller's
	// actual request, but is worth having return an error to log in the
	// handler if needed.
	_, _ = pool.Exec(ctx,
		`insert into public.audit_events (actor_id, action, object_type, object_id, previous_state, new_state, metadata)
		 values ($1, $2, $3, $4, nullif($5, ''), nullif($6, ''), $7)`,
		actorID, action, objectType, objectID, previousState, newState, metaJSON,
	)
}
