// Methodologies: the catalogue the Workshop Creation Wizard picks from.
//
// This endpoint is the reason the wizard does not hardcode SWOT-TOWS. It
// returns whatever is marked active in the config tables, so activating
// PESTLE is an UPDATE statement, not a front-end release.
package handlers

import (
	"net/http"

	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/response"
)

type MethodologySummary struct {
	ID            string `json:"id"`
	Key           string `json:"key"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	Version       string `json:"version"`
	CategoryCount int    `json:"category_count"`
	StageCount    int    `json:"stage_count"`
}

// ListMethodologies — GET /methodologies. Active methodologies only.
func ListMethodologies(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	rows, err := pool.Query(r2.Context(), `
		select m.id, m.key, m.name, coalesce(m.description, ''), coalesce(m.version, ''),
		       (select count(*) from public.methodology_factor_categories c where c.methodology_id = m.id),
		       (select count(*) from public.methodology_stages s where s.methodology_id = m.id)
		from public.methodologies m
		where m.is_active = true
		order by m.name`)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	out := []MethodologySummary{}
	for rows.Next() {
		var m MethodologySummary
		if err := rows.Scan(&m.ID, &m.Key, &m.Name, &m.Description, &m.Version, &m.CategoryCount, &m.StageCount); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		out = append(out, m)
	}
	response.OK(w, out)
}
