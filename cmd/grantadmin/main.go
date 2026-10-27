// grantadmin designates the FIRST platform administrator.
//
// Why this exists: the platform role is granted from the administration page,
// which is itself restricted to platform administrators. With none designated,
// there is no way in — and that was production's real state, fifteen accounts
// and not one administrator among them, with the page correctly telling every
// single person to go and ask an administrator.
//
// It is deliberately NOT an escalation tool, and closes behind itself:
//
//   - it REFUSES once an active administrator exists, so it can bootstrap and
//     nothing else. Every later grant goes through /admin, where it is a
//     normal authorised action with an actor attached.
//   - it needs DATABASE_URL, i.e. the privileged connection string, so it
//     grants nothing that whoever runs it could not already do with psql.
//     The point is that it does it correctly rather than by hand.
//   - it writes an audit_events row, attributed to the grantee, with the
//     action name "user.role_bootstrapped" — distinguishable in the trail
//     from an ordinary role change, because it had no human authoriser.
//
// Usage:
//
//	go run ./cmd/grantadmin -email someone@example.com              # .env
//	go run ./cmd/grantadmin -env .env.dev -email a@b.com            # dev
//	go run ./cmd/grantadmin -email a@b.com -force                   # see below
//
// -force exists for the one legitimate case the refusal would otherwise block:
// every administrator account has been lost. It still requires the privileged
// connection string and still writes the audit row.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/db"
	"swot-tows/pkg/envfile"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "grantadmin:", err)
		os.Exit(1)
	}
}

func run() error {
	envPath := flag.String("env", ".env", "env file holding DATABASE_URL")
	email := flag.String("email", "", "email address of the account to make a platform administrator")
	force := flag.Bool("force", false, "grant even though an administrator already exists (recovery only)")
	flag.Parse()

	addr := strings.ToLower(strings.TrimSpace(*email))
	if addr == "" {
		return errors.New("-email is required")
	}

	if _, err := envfile.Load(*envPath); err != nil {
		return fmt.Errorf("reading %s: %w", *envPath, err)
	}
	if strings.TrimSpace(os.Getenv("DATABASE_URL")) == "" {
		return fmt.Errorf("no DATABASE_URL in %s", *envPath)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := db.Pool(ctx)
	if err != nil {
		return fmt.Errorf("connecting: %w", err)
	}
	defer pool.Close()

	// Say which database this is before changing anything on it. The whole
	// project runs two, and the one you did not mean is a short typo away.
	var dbName string
	if err := pool.QueryRow(ctx, `select current_database()`).Scan(&dbName); err != nil {
		return fmt.Errorf("probing database: %w", err)
	}
	host := os.Getenv("SUPABASE_URL")
	fmt.Printf("database %s (%s) via %s\n", dbName, host, *envPath)

	existing := authz.PlatformAdminCount(ctx, pool)
	if existing < 0 {
		return errors.New("could not count existing administrators")
	}
	if existing > 0 && !*force {
		return fmt.Errorf("%d platform administrator(s) already exist — grant the role from the administration page instead, or pass -force to recover from losing every administrator account", existing)
	}

	var id, status, current string
	err = pool.QueryRow(ctx,
		`select id, status, global_role from public.profiles where lower(email) = $1`, addr).
		Scan(&id, &status, &current)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("no account with the email %s — they must sign in once before the role can be granted", addr)
	}
	if err != nil {
		return fmt.Errorf("looking up %s: %w", addr, err)
	}
	if status != "active" {
		return fmt.Errorf("%s is disabled — re-enable the account before granting the role", addr)
	}
	if current == authz.PlatformAdminRole {
		fmt.Printf("%s is already a platform administrator — nothing to do\n", addr)
		return nil
	}

	if _, err := pool.Exec(ctx,
		`update public.profiles set global_role = $2 where id = $1`,
		id, authz.PlatformAdminRole); err != nil {
		return fmt.Errorf("granting the role: %w", err)
	}

	// Attributed to the grantee, because there is no authorising human to
	// attribute it to — that is the whole nature of a bootstrap, and the
	// trail should show it as such rather than as an ordinary change.
	audit.Record(ctx, pool, id, "user.role_bootstrapped", "profile", id,
		current, authz.PlatformAdminRole, nil)

	fmt.Printf("%s is now a platform administrator. Sign out and back in, then open /admin.\n", addr)
	return nil
}
