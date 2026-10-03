// Participant management: who is in a workshop, what they may do, and how a
// real person gets in.
//
// These used to be direct PostgREST writes from src/lib/participants.ts, which
// made Postgres RLS the only gate — and that gate asked "are you a member of
// this workshop?", not "are you its facilitator?". A plain participant could
// therefore promote themselves to facilitator and delete the facilitator, both
// CONFIRMED EXPLOITABLE on dev before 20261003110000 removed the write
// policies. See that migration for the full account.
//
// Membership is a permission grant, so it belongs behind the same boundary as
// every other permission decision: one role check, the guards that a policy
// could not express (an invite must also grant workspace access; the last
// facilitator cannot be removed), and an audit row for each change.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/response"
	"swot-tows/pkg/supaadmin"
)

// Roles a workshop membership may carry. Taken from the workshop_members CHECK
// rather than invented here.
var workshopRoles = []string{"facilitator", "participant", "analyst", "executive_viewer", "observer"}

// Managing membership is the facilitator's job. A platform admin can also do
// it, which is what makes the admin screen able to service a workshop whose
// facilitator has left.
var participantAdminRoles = []string{"facilitator"}

type Participant struct {
	UserID    string  `json:"user_id"`
	Email     string  `json:"email"`
	Name      string  `json:"name"`
	Role      string  `json:"role"`
	InvitedAt *string `json:"invited_at"`
	JoinedAt  *string `json:"joined_at"`
	// HasSignedIn distinguishes "we created an account" from "they have
	// actually been here". The roster used to call everyone `active` because
	// the seed stamped joined_at for all of them, so the status told you
	// nothing.
	HasSignedIn    bool `json:"has_signed_in"`
	FactorsCreated int  `json:"factors_created"`
	WeightsSet     int  `json:"weights_set"`
	InWorkspace    bool `json:"in_workspace"`
}

// ListParticipants — GET /workshops/{id}/participants
func ListParticipants(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	ctx := r2.Context()
	user := httpctx.UserFromContext(ctx)
	workshopID := chi.URLParam(r2, "id")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(ctx, pool, user.ID, workshopID); err != nil {
		writeAuthzErr(w, err)
		return
	}

	people, err := loadParticipants(ctx, pool, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}
	response.OK(w, people)
}

func loadParticipants(ctx context.Context, pool *pgxpool.Pool, workshopID string) ([]Participant, error) {
	rows, err := pool.Query(ctx, `
		select wm.user_id::text, p.email,
		       coalesce(nullif(trim(p.display_name), ''),
		                nullif(trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''),
		                p.email) as name,
		       wm.role, wm.invited_at, wm.joined_at,
		       (select count(*)::int from public.factors f
		        where f.workshop_id = wm.workshop_id and f.created_by = wm.user_id),
		       (select count(*)::int from public.weights wt
		        where wt.workshop_id = wm.workshop_id and wt.user_id = wm.user_id),
		       exists (select 1 from public.workspace_members wsm
		               join public.workshops ws on ws.id = wm.workshop_id
		               where wsm.workspace_id = ws.workspace_id and wsm.user_id = wm.user_id)
		from public.workshop_members wm
		join public.profiles p on p.id = wm.user_id
		where wm.workshop_id = $1
		order by name`, workshopID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Participant{}
	for rows.Next() {
		var p Participant
		var invitedAt, joinedAt *time.Time
		if err := rows.Scan(&p.UserID, &p.Email, &p.Name, &p.Role, &invitedAt, &joinedAt,
			&p.FactorsCreated, &p.WeightsSet, &p.InWorkspace); err != nil {
			return nil, err
		}
		if invitedAt != nil {
			s := invitedAt.Format(time.RFC3339)
			p.InvitedAt = &s
		}
		if joinedAt != nil {
			s := joinedAt.Format(time.RFC3339)
			p.JoinedAt = &s
			p.HasSignedIn = true
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

type inviteBody struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}

// InviteParticipant — POST /workshops/{id}/participants
//
// Returns a one-time invite link for the caller to pass on. Nothing is emailed:
// see pkg/supaadmin for why a minted link beats a mail Supabase may silently
// drop.
func InviteParticipant(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	ctx := r2.Context()
	actor := httpctx.UserFromContext(ctx)
	workshopID := chi.URLParam(r2, "id")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if !canManageParticipants(ctx, pool, w, actor.ID, workshopID) {
		return
	}

	var body inviteBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if _, err := mail.ParseAddress(email); err != nil {
		response.Fail(w, response.CodeValidationError, "That is not a valid email address.")
		return
	}
	role := strings.TrimSpace(body.Role)
	if role == "" {
		role = "participant"
	}
	if !contains(workshopRoles, role) {
		response.Fail(w, response.CodeValidationError,
			"Role must be one of: "+strings.Join(workshopRoles, ", "))
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = email
	}

	if !supaadmin.Configured() {
		response.Fail(w, response.CodeServerError, supaadmin.ErrNotConfigured.Error())
		return
	}

	var workspaceID, workshopName string
	if err := pool.QueryRow(ctx,
		`select workspace_id::text, name from public.workshops where id = $1`, workshopID,
	).Scan(&workspaceID, &workshopName); err != nil {
		response.Fail(w, response.CodeNotFound, "workshop not found")
		return
	}

	// An existing address is REUSED rather than refused. The previous version called
	// createUser unconditionally, so inviting somebody to their second
	// workshop failed with "already registered" and there was no way through.
	existing, err := supaadmin.FindUserByEmail(ctx, email)
	if err != nil {
		failDB(w, err)
		return
	}

	userID := ""
	isNew := false
	if existing != nil {
		userID = existing.ID
	} else {
		first, last := splitName(name)
		created, err := supaadmin.CreateUser(ctx, email, first, last, name)
		if errors.Is(err, supaadmin.ErrEmailExists) {
			// Raced with another invite, or the filter missed it. Look again
			// rather than failing the whole request.
			again, err2 := supaadmin.FindUserByEmail(ctx, email)
			if err2 != nil || again == nil {
				response.Fail(w, response.CodeValidationError, supaadmin.ErrEmailExists.Error())
				return
			}
			userID = again.ID
		} else if err != nil {
			failDB(w, err)
			return
		} else {
			userID, isNew = created.ID, true
		}
	}

	// The profile row is normally created by a trigger on auth.users; this
	// makes the handler independent of that trigger having fired yet, because
	// the membership insert below has a foreign key to it.
	if _, err := pool.Exec(ctx, `
		insert into public.profiles (id, email, display_name, first_name, last_name)
		values ($1, $2, $3, $4, $5)
		on conflict (id) do update set
		  email = excluded.email,
		  display_name = coalesce(nullif(trim(public.profiles.display_name), ''), excluded.display_name)`,
		userID, email, name, firstOf(name), lastOf(name)); err != nil {
		failDB(w, err)
		return
	}

	// BOTH memberships, in one transaction.
	//
	// The old invite inserted workshop_members ONLY. authz.RequireWorkshopRole
	// joins workspace_members (level 1 of App Spec §11.5's three-level check),
	// so every invited person was refused everywhere — invited successfully and
	// unable to see a thing. That is the "participants added but no access"
	// report, and it was never actually fixed, only moved.
	tx, err := pool.Begin(ctx)
	if err != nil {
		failDB(w, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		insert into public.workspace_members (workspace_id, user_id, role)
		values ($1, $2, 'member')
		on conflict (workspace_id, user_id) do nothing`, workspaceID, userID); err != nil {
		failDB(w, err)
		return
	}
	if _, err := tx.Exec(ctx, `
		insert into public.workshop_members (workshop_id, user_id, role, invited_at)
		values ($1, $2, $3, now())
		on conflict (workshop_id, user_id) do update set role = excluded.role`,
		workshopID, userID, role); err != nil {
		failDB(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failDB(w, err)
		return
	}

	link, linkType, linkErr := supaadmin.SignInLinkFor(ctx, email, siteURL(), isNew)

	audit.Record(ctx, pool, actor.ID, "participant.invited", "workshop_member", userID, "", role,
		map[string]interface{}{
			"workshop_id": workshopID, "email": email, "role": role, "new_account": isNew,
		})

	out := map[string]interface{}{
		"user_id": userID, "email": email, "role": role, "new_account": isNew,
	}
	if linkErr != nil {
		// The membership is real even when the link could not be minted, so
		// this says exactly that rather than implying the invite failed.
		out["link_error"] = "They now have access, but a sign-in link could not be generated: " + linkErr.Error()
	} else {
		out["invite_link"] = link
		out["link_type"] = string(linkType)
	}
	response.Created(w, out)
}

type setRoleBody struct {
	Role string `json:"role"`
}

// SetParticipantRole — PATCH /workshops/{id}/participants/{userId}
func SetParticipantRole(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	ctx := r2.Context()
	actor := httpctx.UserFromContext(ctx)
	workshopID := chi.URLParam(r2, "id")
	targetID := chi.URLParam(r2, "userId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if !canManageParticipants(ctx, pool, w, actor.ID, workshopID) {
		return
	}

	var body setRoleBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	role := strings.TrimSpace(body.Role)
	if !contains(workshopRoles, role) {
		response.Fail(w, response.CodeValidationError,
			"Role must be one of: "+strings.Join(workshopRoles, ", "))
		return
	}

	var current string
	err := pool.QueryRow(ctx,
		`select role from public.workshop_members where workshop_id = $1 and user_id = $2`,
		workshopID, targetID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "that person is not a member of this workshop")
		return
	}
	if err != nil {
		failDB(w, err)
		return
	}
	if current == role {
		response.OK(w, map[string]string{"user_id": targetID, "role": role})
		return
	}

	// Demoting the last facilitator would leave the workshop with nobody able
	// to review, publish or manage it — including nobody able to undo the
	// demotion. Mirrors the admin screen's last-admin guard.
	// You cannot take away your OWN facilitator role. Nothing else refuses it
	// — the last-facilitator guard below is happy as long as somebody else
	// holds the role — but a facilitator who demotes themselves immediately
	// loses the ability to undo it, and has to find another facilitator or an
	// administrator. Found by the IAM suite, which did exactly that and then
	// could not put itself back.
	if targetID == actor.ID && current == "facilitator" && role != "facilitator" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"You cannot remove your own facilitator role. Ask another facilitator or an administrator to change it.")
		return
	}

	if current == "facilitator" && role != "facilitator" {
		if last, err := isLastFacilitator(ctx, pool, workshopID, targetID); err != nil {
			failDB(w, err)
			return
		} else if last {
			response.Fail(w, response.CodeInvalidStateTransition,
				"This is the workshop's only facilitator. Make somebody else a facilitator first.")
			return
		}
	}

	if _, err := pool.Exec(ctx,
		`update public.workshop_members set role = $3 where workshop_id = $1 and user_id = $2`,
		workshopID, targetID, role); err != nil {
		failDB(w, err)
		return
	}

	audit.Record(ctx, pool, actor.ID, "participant.role_changed", "workshop_member", targetID, current, role,
		map[string]interface{}{"workshop_id": workshopID})
	response.OK(w, map[string]string{"user_id": targetID, "role": role})
}

// RevokeParticipant — DELETE /workshops/{id}/participants/{userId}
//
// Revokes access to this workshop. The account itself is untouched: disabling a
// person platform-wide is a separate, admin-only decision (POST
// /admin/users/{id}/status), because leaving one workshop is not leaving the
// organisation.
func RevokeParticipant(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	ctx := r2.Context()
	actor := httpctx.UserFromContext(ctx)
	workshopID := chi.URLParam(r2, "id")
	targetID := chi.URLParam(r2, "userId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if !canManageParticipants(ctx, pool, w, actor.ID, workshopID) {
		return
	}

	var role string
	err := pool.QueryRow(ctx,
		`select role from public.workshop_members where workshop_id = $1 and user_id = $2`,
		workshopID, targetID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "that person is not a member of this workshop")
		return
	}
	if err != nil {
		failDB(w, err)
		return
	}

	// Same reasoning as demoting yourself: leaving by your own hand is fine for
	// a participant, but a facilitator doing it cannot reverse it.
	if targetID == actor.ID && role == "facilitator" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"You cannot revoke your own facilitator access. Ask another facilitator or an administrator.")
		return
	}

	if role == "facilitator" {
		if last, err := isLastFacilitator(ctx, pool, workshopID, targetID); err != nil {
			failDB(w, err)
			return
		} else if last {
			response.Fail(w, response.CodeInvalidStateTransition,
				"This is the workshop's only facilitator. Appoint another facilitator before removing them.")
			return
		}
	}

	// What they contributed STAYS. Factors, votes, themes and reviews are the
	// workshop's record of what happened, and deleting them because somebody
	// left would rewrite history — and silently change every total the
	// prioritization and the report are built from.
	if _, err := pool.Exec(ctx,
		`delete from public.workshop_members where workshop_id = $1 and user_id = $2`,
		workshopID, targetID); err != nil {
		failDB(w, err)
		return
	}

	audit.Record(ctx, pool, actor.ID, "participant.revoked", "workshop_member", targetID, role, "removed",
		map[string]interface{}{"workshop_id": workshopID})
	response.OK(w, map[string]string{"user_id": targetID, "state": "removed"})
}

// ---- helpers ----

// canManageParticipants allows the workshop's facilitator or a platform admin,
// writing the error envelope and returning false otherwise.
func canManageParticipants(ctx context.Context, pool *pgxpool.Pool, w http.ResponseWriter,
	actorID, workshopID string) bool {

	_, err := authz.RequireWorkshopRole(ctx, pool, actorID, workshopID, participantAdminRoles...)
	if err == nil {
		return true
	}
	// A platform admin can service any workshop — including one whose
	// facilitator has left, which is the case the admin screen exists for.
	var isAdmin bool
	if qErr := pool.QueryRow(ctx,
		`select coalesce(global_role, '') = 'admin' from public.profiles where id = $1`,
		actorID).Scan(&isAdmin); qErr == nil && isAdmin {
		return true
	}
	writeAuthzErr(w, err)
	return false
}

func isLastFacilitator(ctx context.Context, pool *pgxpool.Pool, workshopID, exceptUserID string) (bool, error) {
	var others int
	err := pool.QueryRow(ctx, `
		select count(*)::int from public.workshop_members
		where workshop_id = $1 and role = 'facilitator' and user_id <> $2`,
		workshopID, exceptUserID).Scan(&others)
	return others == 0, err
}

// MarkJoined stamps joined_at the first time somebody actually opens a
// workshop.
//
// Before this, `joined_at` was written by the client (participants.ts called it
// "activate") and by the seed, so every single person read as joined and the
// roster's status meant nothing — which is what made the Participants panel
// claim everybody was in the room at all times. It is now a server-side fact:
// set once, on first real access, never by a client.
func MarkJoined(ctx context.Context, pool *pgxpool.Pool, workshopID, userID string) {
	_, err := pool.Exec(ctx, `
		update public.workshop_members set joined_at = now()
		where workshop_id = $1 and user_id = $2 and joined_at is null`, workshopID, userID)
	if err != nil {
		// Best effort, but it says so rather than failing silently — the
		// lesson from audit.Record swallowing errors for three phases.
		fmt.Fprintf(os.Stderr, "MarkJoined(%s, %s): %v\n", workshopID, userID, err)
	}
}

// siteURL is where an invite or reset link should land. Falls back to empty,
// which lets Supabase use the project's configured Site URL.
func siteURL() string {
	for _, k := range []string{"PUBLIC_SITE_URL", "VITE_SITE_URL"} {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return strings.TrimRight(v, "/") + "/auth/callback"
		}
	}
	return ""
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func splitName(full string) (string, string) {
	parts := strings.Fields(full)
	if len(parts) == 0 {
		return "", ""
	}
	return parts[0], strings.Join(parts[1:], " ")
}

func firstOf(full string) string { f, _ := splitName(full); return f }
func lastOf(full string) string  { _, l := splitName(full); return l }
