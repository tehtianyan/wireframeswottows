// Identity and access management: archiving a workshop, and the platform-admin
// operations needed to actually service a user.
//
// Before this there was no way to reset somebody's password, no way to create
// an account for a real email address that the person could then sign in to,
// and no way to archive a workshop at all — `archived` was legal in the status
// CHECK and unreachable from anywhere.
package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/response"
	"swot-tows/pkg/supaadmin"
)

// ---- Archiving ----

// ArchiveWorkshop — POST /workshops/{id}/archive
//
// Freezes the workshop read-only and leaves it listed. Writes to its content
// are then refused by a database trigger, not merely hidden by the UI; see
// 20261003120000.
func ArchiveWorkshop(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	ctx := r2.Context()
	user := httpctx.UserFromContext(ctx)
	id := chi.URLParam(r2, "id")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	// Archiving ends the working life of a workshop, so it is the
	// facilitator's call — or a platform admin's, for a workshop whose
	// facilitator has moved on.
	if !canManageParticipants(ctx, pool, w, user.ID, id) {
		return
	}

	var current string
	if err := pool.QueryRow(ctx,
		`select status from public.workshops where id = $1`, id).Scan(&current); err != nil {
		response.Fail(w, response.CodeNotFound, "workshop not found")
		return
	}
	if current == "archived" {
		response.OK(w, map[string]string{"id": id, "status": "archived"})
		return
	}

	// archived_at and archived_by are set in the same statement as the status,
	// because workshops_archived_status_check makes any other combination
	// unrepresentable.
	if _, err := pool.Exec(ctx, `
		update public.workshops
		set status = 'archived', archived_at = now(), archived_by = $2
		where id = $1`, id, user.ID); err != nil {
		failDB(w, err)
		return
	}

	audit.Record(ctx, pool, user.ID, "workshop.archived", "workshop", id, current, "archived", nil)
	response.OK(w, map[string]string{"id": id, "status": "archived"})
}

type unarchiveBody struct {
	// Status to return to. Defaults to `completed`, because a workshop is
	// normally archived at the end of its life and that is where it came from.
	Status string `json:"status"`
}

// UnarchiveWorkshop — POST /workshops/{id}/unarchive
//
// The escape hatch that makes archiving a reversible decision rather than a
// one-way door, which is why archiving needs no confirmation ritual.
func UnarchiveWorkshop(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	ctx := r2.Context()
	user := httpctx.UserFromContext(ctx)
	id := chi.URLParam(r2, "id")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if !canManageParticipants(ctx, pool, w, user.ID, id) {
		return
	}

	var body unarchiveBody
	_ = json.NewDecoder(r2.Body).Decode(&body)
	target := strings.TrimSpace(body.Status)
	if target == "" {
		target = "completed"
	}
	if target == "archived" || !contains(
		[]string{"draft", "configured", "active", "analysis", "reporting", "completed"}, target) {
		response.Fail(w, response.CodeValidationError,
			"Un-archive to one of: draft, configured, active, analysis, reporting, completed.")
		return
	}

	var current string
	if err := pool.QueryRow(ctx,
		`select status from public.workshops where id = $1`, id).Scan(&current); err != nil {
		response.Fail(w, response.CodeNotFound, "workshop not found")
		return
	}
	if current != "archived" {
		response.Fail(w, response.CodeInvalidStateTransition, "That workshop is not archived.")
		return
	}

	if _, err := pool.Exec(ctx, `
		update public.workshops
		set status = $2, archived_at = null, archived_by = null
		where id = $1`, id, target); err != nil {
		failDB(w, err)
		return
	}

	audit.Record(ctx, pool, user.ID, "workshop.unarchived", "workshop", id, "archived", target, nil)
	response.OK(w, map[string]string{"id": id, "status": target})
}

// ---- Platform IAM (admin only) ----

type createUserBody struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	// GlobalRole is optional; defaults to the ordinary `user`.
	GlobalRole string `json:"global_role"`
}

// CreateAdminUser — POST /admin/users
//
// Creates a login-capable account for a real email address and returns a
// one-time invite link to pass on. The person sets their own password when they
// open it; no shared password is ever issued.
func CreateAdminUser(w http.ResponseWriter, r *http.Request) {
	pool, actor, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	var body createUserBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if _, err := mail.ParseAddress(email); err != nil {
		response.Fail(w, response.CodeValidationError, "That is not a valid email address.")
		return
	}
	role := strings.TrimSpace(body.GlobalRole)
	if role == "" {
		role = "user"
	}
	if !contains([]string{"user", "admin"}, role) {
		response.Fail(w, response.CodeValidationError, "global_role must be user or admin")
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

	existing, err := supaadmin.FindUserByEmail(ctx, email)
	if err != nil {
		failDB(w, err)
		return
	}
	isNew := existing == nil
	userID := ""
	if existing != nil {
		userID = existing.ID
	} else {
		first, last := splitName(name)
		created, cErr := supaadmin.CreateUser(ctx, email, first, last, name)
		if errors.Is(cErr, supaadmin.ErrEmailExists) {
			response.Fail(w, response.CodeValidationError, supaadmin.ErrEmailExists.Error())
			return
		}
		if cErr != nil {
			failDB(w, cErr)
			return
		}
		userID = created.ID
	}

	if _, err := pool.Exec(ctx, `
		insert into public.profiles (id, email, display_name, first_name, last_name, global_role)
		values ($1, $2, $3, $4, $5, $6)
		on conflict (id) do update set email = excluded.email`,
		userID, email, name, firstOf(name), lastOf(name), role); err != nil {
		failDB(w, err)
		return
	}

	link, linkType, linkErr := supaadmin.SignInLinkFor(ctx, email, siteURL(), isNew)

	audit.Record(ctx, pool, actor, "user.created", "profile", userID, "", role,
		map[string]interface{}{"email": email, "new_account": isNew})

	out := map[string]interface{}{
		"id": userID, "email": email, "global_role": role, "new_account": isNew,
	}
	if linkErr != nil {
		out["link_error"] = "The account exists, but a sign-in link could not be generated: " + linkErr.Error()
	} else {
		out["invite_link"] = link
		out["link_type"] = string(linkType)
	}
	response.Created(w, out)
}

// ResetUserPassword — POST /admin/users/{userId}/reset-password
//
// Mints a one-time recovery link for an admin to pass on. It deliberately does
// NOT set a password: an admin who chooses somebody's password knows their
// password, and the person cannot tell whether it was ever used. The link lets
// them set their own.
func ResetUserPassword(w http.ResponseWriter, r *http.Request) {
	pool, actor, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	targetID := chi.URLParam(r, "userId")

	var email, status string
	err := pool.QueryRow(ctx,
		`select email, coalesce(status, 'active') from public.profiles where id = $1`, targetID,
	).Scan(&email, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "user not found")
		return
	}
	if err != nil {
		failDB(w, err)
		return
	}
	// A reset link for a disabled account would hand back access that was
	// deliberately withdrawn.
	if status != "active" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"That account is disabled. Re-enable it before sending a reset link.")
		return
	}
	if !supaadmin.Configured() {
		response.Fail(w, response.CodeServerError, supaadmin.ErrNotConfigured.Error())
		return
	}

	link, err := supaadmin.GenerateLink(ctx, supaadmin.LinkRecovery, email, siteURL())
	if err != nil {
		failDB(w, err)
		return
	}

	// The LINK IS NOT LOGGED — it is a bearer credential for that account, and
	// an audit trail readable by every admin is the wrong place for one. Only
	// the fact of the reset is recorded.
	audit.Record(ctx, pool, actor, "user.password_reset_issued", "profile", targetID, "", "",
		map[string]interface{}{"email": email})

	response.OK(w, map[string]interface{}{
		"id": targetID, "email": email, "reset_link": link,
		"expires_note": "This link can be used once, and expires according to the project's auth settings.",
	})
}

// ---- Workshops an admin may service ----

type AdminWorkshop struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Status        string  `json:"status"`
	WorkspaceName string  `json:"workspace_name"`
	Methodology   string  `json:"methodology"`
	Facilitators  int     `json:"facilitators"`
	Members       int     `json:"members"`
	ArchivedAt    *string `json:"archived_at"`
	CreatedAt     string  `json:"created_at"`
}

// ListAdminWorkshops — GET /admin/workshops
//
// Every workshop on the platform, so an admin can archive one or fix its
// membership. Deliberately NOT scoped to the caller's own memberships, which is
// the whole point of an admin screen — and exactly why it is gated on
// profiles.global_role rather than on workshop role.
func ListAdminWorkshops(w http.ResponseWriter, r *http.Request) {
	pool, _, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	rows, err := pool.Query(r.Context(), `
		select w.id::text, w.name, w.status, ws.name, m.name,
		       (select count(*)::int from public.workshop_members wm
		        where wm.workshop_id = w.id and wm.role = 'facilitator'),
		       (select count(*)::int from public.workshop_members wm where wm.workshop_id = w.id),
		       w.archived_at, w.created_at
		from public.workshops w
		join public.workspaces ws on ws.id = w.workspace_id
		join public.methodologies m on m.id = w.methodology_id
		order by w.status = 'archived', w.created_at desc`)
	if err != nil {
		failDB(w, err)
		return
	}
	defer rows.Close()

	out := []AdminWorkshop{}
	for rows.Next() {
		var a AdminWorkshop
		var archivedAt *time.Time
		var createdAt time.Time
		if err := rows.Scan(&a.ID, &a.Name, &a.Status, &a.WorkspaceName, &a.Methodology,
			&a.Facilitators, &a.Members, &archivedAt, &createdAt); err != nil {
			failDB(w, err)
			return
		}
		if archivedAt != nil {
			s := archivedAt.Format(time.RFC3339)
			a.ArchivedAt = &s
		}
		a.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, a)
	}
	response.OK(w, out)
}

// ListAdminWorkshopParticipants — GET /admin/workshops/{id}/participants
//
// The same roster the facilitator sees, reachable by an admin who is not a
// member of the workshop. Separate from the workshop-scoped route because that
// one requires membership, and requiring an admin to join a workshop in order
// to fix its membership would be the problem rather than the fix.
func ListAdminWorkshopParticipants(w http.ResponseWriter, r *http.Request) {
	pool, _, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	people, err := loadParticipants(r.Context(), pool, chi.URLParam(r, "id"))
	if err != nil {
		failDB(w, err)
		return
	}
	response.OK(w, people)
}
