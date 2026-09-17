// Package audit writes audit_events rows, per App Spec §11.31's list of
// actions that must be recorded and §8.34's required fields.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Record writes one audit row.
//
// Two bugs were fixed here after the table was found completely empty despite
// every mutating handler calling this since Phase 0:
//
//  1. metadata was passed as []byte. The pool runs in
//     QueryExecModeSimpleProtocol (required by the Supabase transaction
//     pooler), where pgx must render parameters as SQL literals — and it
//     renders []byte as a bytea hex literal, which cannot be assigned to a
//     jsonb column. Passing a string makes it a json literal instead.
//  2. The error was discarded with `_, _ =`, so the failure was invisible.
//     An audit write that silently does nothing is worse than one that fails
//     loudly: the system claims a trail it does not have.
//
// It stays best-effort — an audit failure must not fail the user's request —
// but it now says so on stderr, which reaches the Vercel function logs.
func Record(ctx context.Context, pool *pgxpool.Pool, actorID, action, objectType, objectID, previousState, newState string, metadata map[string]interface{}) {
	var meta interface{} // nil -> SQL NULL
	if metadata != nil {
		b, err := json.Marshal(metadata)
		if err != nil {
			fmt.Fprintf(os.Stderr, "audit: could not encode metadata for %s: %v\n", action, err)
		} else {
			meta = string(b)
		}
	}

	var objID interface{} // object_id is a uuid column; "" is not a valid uuid
	if objectID != "" {
		objID = objectID
	}

	if _, err := pool.Exec(ctx,
		`insert into public.audit_events (actor_id, action, object_type, object_id, previous_state, new_state, metadata)
		 values ($1, $2, $3, $4, nullif($5, ''), nullif($6, ''), $7)`,
		actorID, action, objectType, objID, previousState, newState, meta,
	); err != nil {
		fmt.Fprintf(os.Stderr, "audit: FAILED to record %s on %s/%s: %v\n", action, objectType, objectID, err)
	}
}
