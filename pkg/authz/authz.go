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

// ErrInsufficientRole is distinct from ErrForbidden: the caller IS a member of
// the workshop, but their role does not carry this authority. Both are 403 to
// the client, but conflating them produces a misleading message ("you do not
// have access to this workshop") for someone who plainly does have access.
var ErrInsufficientRole = errors.New("insufficient role")

// WorkshopRole returns the caller's role in the given workshop, or
// ErrForbidden if they are not a member.
//
// This enforces the FIRST TWO levels of App Spec §11.5's check —
// workspace membership, then workshop membership — by joining through to
// workspace_members rather than trusting the workshop_members row alone.
//
// That join is load-bearing, not defensive tidiness. Without it, removing
// someone from a workspace did not revoke their access to the workshops
// inside it: their stale workshop_members row kept working indefinitely.
// CLAUDE.md claimed the 3-level check was enforced while level 1 never was;
// the scoping test now proves it is.
// A disabled account is refused here too. "Disabled" used to be a column and
// nothing else: SetUserStatus wrote profiles.status, nothing read it, and
// pkg/supaadmin.SetUserBanned — written for exactly this — had no callers. So
// a disabled person kept every workshop they had, and could sign in again to
// get a fresh token. That is the same shape of bug as the missing
// workspace_members join above: a revocation that does not revoke.
//
// The join is LEFT with a coalesce rather than inner, so it denies only an
// account explicitly marked disabled. An inner join would additionally deny
// anyone whose profile row is missing for some unrelated reason, which is a
// lockout this check has no business causing.
func WorkshopRole(ctx context.Context, pool *pgxpool.Pool, userID, workshopID string) (string, error) {
	var role string
	err := pool.QueryRow(ctx, `
		select wm.role
		from public.workshop_members wm
		join public.workshops w on w.id = wm.workshop_id
		join public.workspace_members wsm
		     on wsm.workspace_id = w.workspace_id and wsm.user_id = wm.user_id
		left join public.profiles p on p.id = wm.user_id
		where wm.workshop_id = $1 and wm.user_id = $2
		  and coalesce(p.status, 'active') <> 'disabled'`,
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
	err := pool.QueryRow(ctx, `
		select wsm.role
		from public.workspace_members wsm
		left join public.profiles p on p.id = wsm.user_id
		where wsm.workspace_id = $1 and wsm.user_id = $2
		  and coalesce(p.status, 'active') <> 'disabled'`,
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
	return role, ErrInsufficientRole
}

// PlatformAdminRole is the ONE name for the platform administrator role.
//
// It was two names — 'admin' and 'platform_admin' — honoured by different
// checks, so the role worked on one screen and was refused on the next.
// Migration 20261026100000 narrowed the column's CHECK to match this constant;
// if you ever add a second name, these two must not be allowed to drift apart
// again, which is why there is one constant and one function below.
const PlatformAdminRole = "admin"

// IsPlatformAdmin is the single answer to "may this account administer the
// platform?" — held here rather than in pkg/handlers because two handler
// packages asked the question separately and answered it differently.
//
// An ACTIVE account is required. A disabled administrator who kept their
// powers would be the most consequential version of the cosmetic-disable bug
// described on WorkshopRole.
func IsPlatformAdmin(ctx context.Context, pool *pgxpool.Pool, userID string) (bool, error) {
	var ok bool
	err := pool.QueryRow(ctx, `
		select global_role = $2 and status = 'active'
		from public.profiles where id = $1`, userID, PlatformAdminRole).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("checking platform role: %w", err)
	}
	return ok, nil
}

// PlatformAdminCount counts the active platform administrators.
//
// Used on the REFUSAL path so that "administration is restricted" can say
// something useful when the answer is that nobody holds the role at all —
// otherwise the page tells you to ask an administrator who does not exist.
func PlatformAdminCount(ctx context.Context, pool *pgxpool.Pool) int {
	var n int
	if err := pool.QueryRow(ctx, `
		select count(*) from public.profiles
		where global_role = $1 and status = 'active'`, PlatformAdminRole).Scan(&n); err != nil {
		return -1 // unknown; callers must not read -1 as "none"
	}
	return n
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
