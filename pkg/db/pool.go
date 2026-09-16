// Package db owns the single privileged Postgres connection pool. Go is the
// trust boundary (per this session's architecture decision), so every query
// runs through this one pool and authorization is enforced in application
// code (internal/authz), not per-row via Postgres RLS.
package db

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	once sync.Once
	pool *pgxpool.Pool
	err  error
)

func Pool(ctx context.Context) (*pgxpool.Pool, error) {
	once.Do(func() {
		url := os.Getenv("DATABASE_URL")
		if url == "" {
			err = fmt.Errorf("DATABASE_URL is not set")
			return
		}
		cfg, parseErr := pgxpool.ParseConfig(url)
		if parseErr != nil {
			err = parseErr
			return
		}
		// The pooler (Supavisor, transaction mode on port 6543) routes each
		// query to a possibly-different backend connection, which breaks
		// pgx's default prepared-statement caching ("prepared statement
		// already exists"). Simple protocol avoids server-side prepare.
		cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
		pool, err = pgxpool.NewWithConfig(ctx, cfg)
	})
	return pool, err
}
