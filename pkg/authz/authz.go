// Package authz implements the 3-level authorization check from Application
// Specification §11.5: workspace membership -> workshop membership -> object
// permission. Since Go is the trust boundary, every mutating handler must
// call one of these before touching data; Postgres RLS is a secondary net,
// not the primary gate.
package authz

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrForbidden = errors.New("forbidden")
var ErrNotFound = errors.New("not found")

// WorkshopRole returns the caller's role in the given workshop, or
// ErrForbidden if they are not a member.
func WorkshopRole(ctx context.Context, pool *pgxpool.Pool, userID, workshopID string) (string, error) {
	var role string
	err := pool.QueryRow(ctx,
		`select role from public.workshop_members where workshop_id = $1 and user_id = $2`,
		workshopID, userID,
	).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrForbidden
	}
	if err != nil {
		return "", fmt.Errorf("checking workshop membership: %w", err)
	}
	return role, nil
}

// WorkspaceRole returns the caller's role in the given workspace, or
// ErrForbidden if they are not a member.
func WorkspaceRole(ctx context.Context, pool *pgxpool.Pool, userID, workspaceID string) (string, error) {
	var role string
	err := pool.QueryRow(ctx,
		`select role from public.workspace_members where workspace_id = $1 and user_id = $2`,
		workspaceID, userID,
	).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrForbidden
	}
	if err != nil {
		return "", fmt.Errorf("checking workspace membership: %w", err)
	}
	return role, nil
}

// RequireWorkshopRole ensures the caller is a workshop member whose role is
// one of allowed. Pass no roles to accept any member.
func RequireWorkshopRole(ctx context.Context, pool *pgxpool.Pool, userID, workshopID string, allowed ...string) (string, error) {
	role, err := WorkshopRole(ctx, pool, userID, workshopID)
	if err != nil {
		return "", err
	}
	if len(allowed) == 0 {
		return role, nil
	}
	for _, a := range allowed {
		if role == a {
			return role, nil
		}
	}
	return "", ErrForbidden
}

// WorkshopIDForActivity resolves the owning workshop for an activity, factor,
// synthesis, etc. — handlers on nested resources use this to run the same
// workshop-membership check without duplicating the join per table.
func WorkshopIDFromQuery(ctx context.Context, pool *pgxpool.Pool, query string, args ...interface{}) (string, error) {
	var id string
	err := pool.QueryRow(ctx, query, args...).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("resolving workshop id: %w", err)
	}
	return id, nil
}
