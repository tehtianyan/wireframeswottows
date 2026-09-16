// Workspaces: the container a workshop is created into (the Organization ->
// Workspace -> Workshop hierarchy in CLAUDE.md). The creation wizard needs
// this list to know where it is allowed to create.
package handlers

import (
	"net/http"

	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/response"
)

type Workspace struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	CanAdd bool   `json:"can_create_workshops"`
}

// ListWorkspaces — GET /workspaces. Only workspaces the caller belongs to.
func ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	rows, err := pool.Query(r2.Context(), `
		select ws.id, ws.name, wm.role
		from public.workspaces ws
		join public.workspace_members wm on wm.workspace_id = ws.id
		where wm.user_id = $1
		order by ws.name`, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	out := []Workspace{}
	for rows.Next() {
		var ws Workspace
		if err := rows.Scan(&ws.ID, &ws.Name, &ws.Role); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		// Mirrors the check in CreateWorkshop (App Spec §3.16).
		ws.CanAdd = ws.Role == "owner" || ws.Role == "admin" || ws.Role == "facilitator"
		out = append(out, ws)
	}
	response.OK(w, out)
}
