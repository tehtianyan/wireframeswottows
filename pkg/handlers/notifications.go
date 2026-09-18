// Notifications (App Spec §8.32, §11.27) and Administration (§11.29).
//
// §8.32: "State transitions generate events." A notification is addressed to
// one person, so the interesting part is deciding WHO — and the honest answer
// is almost always the person whose work was acted on, not everybody.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/response"
)

type Notification struct {
	ID         string  `json:"id"`
	Type       string  `json:"notification_type"`
	Title      string  `json:"title"`
	Body       *string `json:"body"`
	ObjectType *string `json:"object_type"`
	ObjectID   *string `json:"object_id"`
	WorkshopID *string `json:"workshop_id"`
	IsRead     bool    `json:"is_read"`
	CreatedAt  string  `json:"created_at"`
}

// Notify writes one notification. Best-effort, like audit: a notification
// failure must never fail the action that caused it — but it says so on
// stderr rather than disappearing, which is the lesson from audit_events
// having been silently empty for three phases.
//
// Never notifies someone about their own action.
func Notify(ctx context.Context, pool *pgxpool.Pool, recipientID, actorID, notificationType,
	title, body, objectType, objectID, workshopID string) {

	if recipientID == "" || recipientID == actorID {
		return
	}
	var bodyArg, objTypeArg, objIDArg, wsArg interface{}
	if body != "" {
		bodyArg = body
	}
	if objectType != "" {
		objTypeArg = objectType
	}
	if objectID != "" {
		objIDArg = objectID
	}
	if workshopID != "" {
		wsArg = workshopID
	}

	if _, err := pool.Exec(ctx, `
		insert into public.notifications
		  (recipient_id, actor_id, notification_type, title, body, object_type, object_id, workshop_id)
		values ($1, $2, $3, $4, $5, $6, $7, $8)`,
		recipientID, actorID, notificationType, title, bodyArg, objTypeArg, objIDArg, wsArg,
	); err != nil {
		fmt.Fprintf(os.Stderr, "notify: FAILED %s for %s: %v\n", notificationType, recipientID, err)
	}
}

// NotifyReviewDecision tells an author what happened to their work.
func NotifyReviewDecision(ctx context.Context, pool *pgxpool.Pool, actorID, kindLabel,
	objectType, objectID, workshopID, newState, note string) {

	var authorID *string
	table, _ := tableForKind(objectType)
	if table == "" {
		return
	}
	if err := pool.QueryRow(ctx, fmt.Sprintf(
		`select created_by::text from public.%s where id = $1`, table), objectID).Scan(&authorID); err != nil {
		return
	}
	if authorID == nil {
		return
	}

	verb := "approved"
	if newState == "rejected" {
		verb = "returned"
	}
	title := fmt.Sprintf("Your %s was %s", strings.ToLower(kindLabel), verb)
	Notify(ctx, pool, *authorID, actorID, "review."+newState, title, note, objectType, objectID, workshopID)
}

// NotifyWorkshop tells every member except the actor. Used sparingly — for
// things that genuinely concern the whole workshop, like a published report.
func NotifyWorkshop(ctx context.Context, pool *pgxpool.Pool, actorID, notificationType,
	title, body, objectType, objectID, workshopID string) {

	// Scoped to people who still have workspace access. Notifying someone who
	// has lost it would tell them a workshop they can no longer open is still
	// moving.
	rows, err := pool.Query(ctx, `
		select wm.user_id::text
		from public.workshop_members wm
		join public.workshops w on w.id = wm.workshop_id
		join public.workspace_members wsm
		     on wsm.workspace_id = w.workspace_id and wsm.user_id = wm.user_id
		where wm.workshop_id = $1`, workshopID)
	if err != nil {
		return
	}
	recipients := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			break
		}
		recipients = append(recipients, id)
	}
	rows.Close()

	for _, id := range recipients {
		Notify(ctx, pool, id, actorID, notificationType, title, body, objectType, objectID, workshopID)
	}
}

// ListNotifications — GET /notifications?unread=true
func ListNotifications(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	query := `
		select id, notification_type, title, body, object_type, object_id::text, workshop_id::text,
		       is_read, created_at
		from public.notifications where recipient_id = $1`
	args := []interface{}{user.ID}
	if r2.URL.Query().Get("unread") == "true" {
		query += ` and is_read = false`
	}
	query += ` order by created_at desc limit 50`

	rows, err := pool.Query(r2.Context(), query, args...)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	out := []Notification{}
	for rows.Next() {
		var n Notification
		var createdAt time.Time
		if err := rows.Scan(&n.ID, &n.Type, &n.Title, &n.Body, &n.ObjectType, &n.ObjectID,
			&n.WorkshopID, &n.IsRead, &createdAt); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		n.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, n)
	}
	response.OK(w, out)
}

// MarkNotificationRead — POST /notifications/{notificationId}/read
func MarkNotificationRead(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	id := chi.URLParam(r2, "notificationId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	// recipient_id in the WHERE clause is the authorization: you can only
	// ever mark your own notifications read.
	tag, err := pool.Exec(r2.Context(), `
		update public.notifications set is_read = true, read_at = now()
		where id = $1 and recipient_id = $2`, id, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		response.Fail(w, response.CodeNotFound, "notification not found")
		return
	}
	response.OK(w, map[string]string{"id": id})
}

// MarkAllNotificationsRead — POST /notifications/read-all
func MarkAllNotificationsRead(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	tag, err := pool.Exec(r2.Context(), `
		update public.notifications set is_read = true, read_at = now()
		where recipient_id = $1 and is_read = false`, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	response.OK(w, map[string]int64{"marked": tag.RowsAffected()})
}

// DeleteNotification — DELETE /notifications/{notificationId}
func DeleteNotification(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	id := chi.URLParam(r2, "notificationId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	tag, err := pool.Exec(r2.Context(),
		`delete from public.notifications where id = $1 and recipient_id = $2`, id, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		response.Fail(w, response.CodeNotFound, "notification not found")
		return
	}
	response.OK(w, map[string]string{"id": id})
}

// ---- Administration (App Spec §11.29) ----

type AdminUser struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	DisplayName *string `json:"display_name"`
	GlobalRole  string  `json:"global_role"`
	Status      string  `json:"status"`
	Workshops   int     `json:"workshop_count"`
	CreatedAt   string  `json:"created_at"`
}

// requirePlatformAdmin gates the administration endpoints.
//
// Deliberately NOT a workshop role: these act across the whole platform, so
// they key off profiles.global_role. Go is the trust boundary, as everywhere
// else.
func requirePlatformAdmin(w http.ResponseWriter, r *http.Request) (*pgxpool.Pool, string, bool) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return nil, "", false
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return nil, "", false
	}
	var role string
	if err := pool.QueryRow(r2.Context(),
		`select global_role from public.profiles where id = $1`, user.ID).Scan(&role); err != nil {
		response.Fail(w, response.CodeForbidden, "administration is restricted")
		return nil, "", false
	}
	if role != "admin" && role != "platform_admin" {
		response.Fail(w, response.CodeForbidden, "administration is restricted to platform administrators")
		return nil, "", false
	}
	return pool, user.ID, true
}

// ListAdminUsers — GET /admin/users
func ListAdminUsers(w http.ResponseWriter, r *http.Request) {
	pool, _, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	rows, err := pool.Query(r.Context(), `
		select p.id, p.email, p.display_name, p.global_role, p.status,
		       (select count(*) from public.workshop_members wm where wm.user_id = p.id),
		       p.created_at
		from public.profiles p order by p.email`)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	out := []AdminUser{}
	for rows.Next() {
		var u AdminUser
		var createdAt time.Time
		if err := rows.Scan(&u.ID, &u.Email, &u.DisplayName, &u.GlobalRole, &u.Status,
			&u.Workshops, &createdAt); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		u.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, u)
	}
	response.OK(w, out)
}

type updateRoleBody struct {
	GlobalRole string `json:"global_role"`
}

// UpdateUserRole — PUT /admin/users/{userId}/role
func UpdateUserRole(w http.ResponseWriter, r *http.Request) {
	pool, actorID, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "userId")

	var body updateRoleBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	switch body.GlobalRole {
	case "user", "admin", "platform_admin":
	default:
		response.Fail(w, response.CodeValidationError,
			`global_role must be "user", "admin" or "platform_admin"`)
		return
	}

	// An admin demoting themselves could leave the platform with none.
	if userID == actorID && body.GlobalRole == "user" {
		var otherAdmins int
		pool.QueryRow(r.Context(), `
			select count(*) from public.profiles
			where global_role in ('admin','platform_admin') and id <> $1`, actorID).Scan(&otherAdmins)
		if otherAdmins == 0 {
			response.Fail(w, response.CodeValidationError,
				"You are the only administrator — promote someone else before removing your own access.")
			return
		}
	}

	var previous string
	pool.QueryRow(r.Context(), `select global_role from public.profiles where id = $1`, userID).Scan(&previous)

	tag, err := pool.Exec(r.Context(),
		`update public.profiles set global_role = $2 where id = $1`, userID, body.GlobalRole)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		response.Fail(w, response.CodeNotFound, "user not found")
		return
	}

	audit.Record(r.Context(), pool, actorID, "user.role_changed", "profile", userID,
		previous, body.GlobalRole, nil)
	response.OK(w, map[string]string{"id": userID, "global_role": body.GlobalRole})
}

type setStatusBody struct {
	Status string `json:"status"`
}

// SetUserStatus — POST /admin/users/{userId}/status
//
// The spec names a "Disable User" endpoint; this does both directions,
// because an account that can be disabled and never re-enabled is a support
// ticket waiting to happen.
func SetUserStatus(w http.ResponseWriter, r *http.Request) {
	pool, actorID, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "userId")

	var body setStatusBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	if body.Status != "active" && body.Status != "disabled" {
		response.Fail(w, response.CodeValidationError, `status must be "active" or "disabled"`)
		return
	}
	if userID == actorID && body.Status == "disabled" {
		response.Fail(w, response.CodeValidationError, "You cannot disable your own account.")
		return
	}

	var previous string
	pool.QueryRow(r.Context(), `select status from public.profiles where id = $1`, userID).Scan(&previous)

	tag, err := pool.Exec(r.Context(),
		`update public.profiles set status = $2 where id = $1`, userID, body.Status)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		response.Fail(w, response.CodeNotFound, "user not found")
		return
	}

	audit.Record(r.Context(), pool, actorID, "user.status_changed", "profile", userID,
		previous, body.Status, nil)
	response.OK(w, map[string]string{"id": userID, "status": body.Status})
}

// ListAuditEvents — GET /audit-events?object_type=&object_id=&actor_id=
// App Spec §11.28. Platform administrators only: the audit trail spans every
// workshop, so it is not workshop-scoped data.
func ListAuditEvents(w http.ResponseWriter, r *http.Request) {
	pool, _, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}

	query := `
		select a.action, a.object_type, coalesce(p.display_name, p.email, 'Unknown'),
		       a.new_state, a.created_at
		from public.audit_events a
		left join public.profiles p on p.id = a.actor_id
		where true`
	args := []interface{}{}
	for _, f := range []struct{ param, col string }{
		{"object_type", "a.object_type"}, {"object_id", "a.object_id"}, {"actor_id", "a.actor_id"},
	} {
		if v := r.URL.Query().Get(f.param); v != "" {
			args = append(args, v)
			cast := ""
			if f.param != "object_type" {
				cast = "::text"
			}
			query += fmt.Sprintf(" and %s%s = $%d", f.col, cast, len(args))
		}
	}
	query += ` order by a.created_at desc limit 200`

	rows, err := pool.Query(r.Context(), query, args...)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	out := []ActivityEvent{}
	for rows.Next() {
		var e ActivityEvent
		var createdAt time.Time
		if err := rows.Scan(&e.Action, &e.ObjectType, &e.ActorName, &e.NewState, &createdAt); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		e.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, e)
	}
	response.OK(w, out)
}
