// The Executive Dashboard (wireframe §10, EXE-001).
//
// §10.1: "Unlike the Workshop Dashboard, which is designed to support
// methodology execution, the Executive Dashboard is designed to support
// strategic decision-making. Executives are not interested in workshop
// mechanics." It answers five questions: what do I need to know, what is
// changing, what should concern me, what opportunities are emerging, what
// actions should we take.
//
// So this aggregates ACROSS workshops and shows only approved output —
// §10.6: "Executives should consume synthesized intelligence rather than raw
// workshop outputs."
//
// One honest decision worth keeping: §10.15 asks for trend direction
// ("Increasing"). Real trend data needs history across many workshops over
// time. Rather than draw an arrow from one data point, this reports the
// activity it can actually see and says plainly when there is not enough
// history to call a trend.
package handlers

import (
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/objects"
	"swot-tows/pkg/response"
)

type ExecItem struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Body         string  `json:"body"`
	WorkshopID   string  `json:"workshop_id"`
	WorkshopName string  `json:"workshop_name"`
	Extra        string  `json:"extra,omitempty"`
	Evidence     int     `json:"evidence_count"`
	Promoted     bool    `json:"promoted"`
	CreatedAt    string  `json:"created_at"`
}

type ExecPortfolio struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Status         string `json:"status"`
	StagesComplete int    `json:"stages_complete"`
	StagesTotal    int    `json:"stages_total"`
	Recommendations int   `json:"recommendations"`
}

type ExecAlert struct {
	Severity string `json:"severity"` // attention | watch
	Title    string `json:"title"`
	Detail   string `json:"detail"`
}

type ExecTrend struct {
	Period string `json:"period"`
	Count  int    `json:"count"`
}

type ExecutiveBrief struct {
	Workshops       int             `json:"workshops"`
	Themes          []ExecItem      `json:"themes"`
	Insights        []ExecItem      `json:"insights"`
	Recommendations []ExecItem      `json:"recommendations"`
	Risks           []ExecItem      `json:"risks"`
	Alerts          []ExecAlert     `json:"alerts"`
	Portfolio       []ExecPortfolio `json:"portfolio"`
	Trend           []ExecTrend     `json:"trend"`
	TrendNote       string          `json:"trend_note"`
	PublishedReports int            `json:"published_reports"`
	KnowledgeAssets  int            `json:"knowledge_assets"`
}

// GetExecutiveBrief — GET /executive
func GetExecutiveBrief(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	out := ExecutiveBrief{
		Themes: []ExecItem{}, Insights: []ExecItem{}, Recommendations: []ExecItem{},
		Risks: []ExecItem{}, Alerts: []ExecAlert{}, Portfolio: []ExecPortfolio{}, Trend: []ExecTrend{},
	}

	// Themes ranked by how much evidence supports them — the closest honest
	// analogue of §10.10's "frequency", using data that actually exists.
	syn, err := objects.ByKey("synthesis")
	if err == nil {
		out.Themes, err = execItems(r2, pool, user.ID, syn.Table, "synthesis",
			`(select count(*) from public.synthesis_factors sf where sf.synthesis_id = o.id)`, "", 6)
		if err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
	}

	out.Insights, err = execItems(r2, pool, user.ID, "insights", "insight",
		`(select count(*) from public.insight_syntheses isy where isy.insight_id = o.id)`,
		"coalesce(o.strategic_significance, '')", 6)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	// §10.12: priority-ranked. The ordering is explicit rather than
	// alphabetical, because "critical" must not sort after "high".
	out.Recommendations, err = execItems(r2, pool, user.ID, "recommendations", "recommendation",
		`(select count(*) from public.recommendation_insights ri where ri.recommendation_id = o.id)`,
		`coalesce(o.priority, '')`, 8)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	// §10.14 Risk panel. Derived from what recommendations actually record as
	// risks, rather than inventing a risk taxonomy the methodology does not
	// have. A methodology whose recommendations have no risks field simply
	// produces nothing here.
	riskRows, err := pool.Query(r2.Context(), `
		select o.id::text, coalesce(o.title,''), coalesce(o.risks,''), o.workshop_id::text, w.name, o.created_at
		from public.recommendations o
		join public.workshops w on w.id = o.workshop_id
		join public.workshop_members wm on wm.workshop_id = w.id and wm.user_id = $1
		join public.workspace_members wsm on wsm.workspace_id = w.workspace_id and wsm.user_id = $1
		where o.state = 'approved' and coalesce(o.risks, '') <> ''
		order by o.created_at desc limit 6`, user.ID)
	if err == nil {
		for riskRows.Next() {
			var it ExecItem
			var createdAt time.Time
			if err := riskRows.Scan(&it.ID, &it.Title, &it.Body, &it.WorkshopID, &it.WorkshopName, &createdAt); err != nil {
				break
			}
			it.CreatedAt = createdAt.Format(time.RFC3339)
			out.Risks = append(out.Risks, it)
		}
		riskRows.Close()
	}

	// Portfolio (§10.17).
	portRows, err := pool.Query(r2.Context(), `
		select w.id::text, w.name, w.status,
		       (select count(*) from public.activities a where a.workshop_id = w.id),
		       (select count(*) from public.activities a where a.workshop_id = w.id and a.status = 'completed'),
		       (select count(*) from public.recommendations rc where rc.workshop_id = w.id and rc.state = 'approved')
		from public.workshops w
		join public.workshop_members wm on wm.workshop_id = w.id and wm.user_id = $1
		join public.workspace_members wsm on wsm.workspace_id = w.workspace_id and wsm.user_id = $1
		order by w.created_at desc`, user.ID)
	if err == nil {
		for portRows.Next() {
			var p ExecPortfolio
			if err := portRows.Scan(&p.ID, &p.Name, &p.Status, &p.StagesTotal,
				&p.StagesComplete, &p.Recommendations); err != nil {
				break
			}
			out.Portfolio = append(out.Portfolio, p)
		}
		portRows.Close()
	}
	out.Workshops = len(out.Portfolio)

	// §10.15 Trend. Approved insights per month, which is real history rather
	// than a direction arrow drawn from one workshop.
	trendRows, err := pool.Query(r2.Context(), `
		select to_char(date_trunc('month', o.created_at), 'Mon YYYY'), count(*)::int
		from public.insights o
		join public.workshops w on w.id = o.workshop_id
		join public.workshop_members wm on wm.workshop_id = w.id and wm.user_id = $1
		join public.workspace_members wsm on wsm.workspace_id = w.workspace_id and wsm.user_id = $1
		where o.state = 'approved'
		group by date_trunc('month', o.created_at)
		order by date_trunc('month', o.created_at) limit 12`, user.ID)
	if err == nil {
		for trendRows.Next() {
			var t ExecTrend
			if err := trendRows.Scan(&t.Period, &t.Count); err != nil {
				break
			}
			out.Trend = append(out.Trend, t)
		}
		trendRows.Close()
	}
	switch {
	case out.Workshops < 2:
		out.TrendNote = "Trends need several workshops over time. There is not enough history yet to call a direction."
	case len(out.Trend) < 2:
		out.TrendNote = "Not enough months of approved insight to show a direction yet."
	default:
		out.TrendNote = ""
	}

	// Alerts: operational, methodology-neutral, and only things a leader can
	// actually act on.
	out.Alerts = executiveAlerts(r2, pool, user.ID)

	pool.QueryRow(r2.Context(), `
		select count(*) from public.reports rp
		join public.workshops w on w.id = rp.workshop_id
		join public.workshop_members wm on wm.workshop_id = w.id and wm.user_id = $1
		where rp.state = 'published'`, user.ID).Scan(&out.PublishedReports)

	pool.QueryRow(r2.Context(), `
		select count(*) from public.knowledge_assets ka
		join public.workspace_members wsm
		     on wsm.workspace_id = ka.workspace_id and wsm.user_id = $1
		where ka.state = 'published'`, user.ID).Scan(&out.KnowledgeAssets)

	response.OK(w, out)
}

// execItems pulls approved objects of one kind across every workshop the
// caller can see, ranked by how much evidence supports them.
func execItems(r *http.Request, pool *pgxpool.Pool, userID, table, kind, evidenceExpr, extraExpr string,
	limit int) ([]ExecItem, error) {

	extra := "''"
	if extraExpr != "" {
		extra = extraExpr
	}
	// Recommendations rank by declared priority first; everything else by how
	// much evidence stands behind it.
	order := fmt.Sprintf("%s desc, o.created_at desc", evidenceExpr)
	if kind == "recommendation" {
		order = `case o.priority when 'critical' then 0 when 'high' then 1
		          when 'medium' then 2 else 3 end, o.created_at desc`
	}

	rows, err := pool.Query(r.Context(), fmt.Sprintf(`
		select o.id::text, coalesce(o.title,''), coalesce(o.description,''),
		       o.workshop_id::text, w.name, %s, %s, (ka.id is not null), o.created_at
		from public.%s o
		join public.workshops w on w.id = o.workshop_id
		join public.workshop_members wm on wm.workshop_id = w.id and wm.user_id = $1
		join public.workspace_members wsm on wsm.workspace_id = w.workspace_id and wsm.user_id = $1
		left join public.knowledge_assets ka on ka.object_kind = $2 and ka.object_id = o.id
		where o.state = 'approved'
		order by %s
		limit %d`, extra, evidenceExpr, table, order, limit), userID, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ExecItem{}
	for rows.Next() {
		var it ExecItem
		var createdAt time.Time
		if err := rows.Scan(&it.ID, &it.Title, &it.Body, &it.WorkshopID, &it.WorkshopName,
			&it.Extra, &it.Evidence, &it.Promoted, &createdAt); err != nil {
			return nil, err
		}
		it.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, it)
	}
	return out, nil
}

// executiveAlerts answers §10.1's "what should concern me?" with operational
// facts rather than a risk score. Each one names something a leader can do.
func executiveAlerts(r *http.Request, pool *pgxpool.Pool, userID string) []ExecAlert {
	alerts := []ExecAlert{}

	var stalled int
	pool.QueryRow(r.Context(), `
		select count(*) from public.workshops w
		join public.workshop_members wm on wm.workshop_id = w.id and wm.user_id = $1
		join public.workspace_members wsm on wsm.workspace_id = w.workspace_id and wsm.user_id = $1
		where w.status in ('active','analysis','reporting')
		  and w.updated_at < now() - interval '14 days'`, userID).Scan(&stalled)
	if stalled > 0 {
		alerts = append(alerts, ExecAlert{
			Severity: "attention",
			Title:    fmt.Sprintf("%d workshop%s has seen no activity for two weeks", stalled, plural(stalled)),
			Detail:   "Work in progress that has stopped moving rarely restarts on its own.",
		})
	}

	var backlog int
	pool.QueryRow(r.Context(), `
		select coalesce(sum(n), 0) from (
		  select count(*) n from public.insights o
		  join public.workshops w on w.id = o.workshop_id
		  join public.workshop_members wm on wm.workshop_id = w.id and wm.user_id = $1
		  where o.state = 'submitted'
		  union all
		  select count(*) from public.recommendations o
		  join public.workshops w on w.id = o.workshop_id
		  join public.workshop_members wm on wm.workshop_id = w.id and wm.user_id = $1
		  where o.state = 'submitted'
		) x`, userID).Scan(&backlog)
	if backlog > 5 {
		alerts = append(alerts, ExecAlert{
			Severity: "watch",
			Title:    fmt.Sprintf("%d conclusions are waiting for review", backlog),
			Detail:   "Nothing reaches a report until it has been reviewed.",
		})
	}

	// A published report citing something later rejected is exactly the sort
	// of thing a leader should know before quoting it.
	var stale int
	pool.QueryRow(r.Context(),
		`select count(distinct report_id) from public.report_stale_citations`).Scan(&stale)
	if stale > 0 {
		alerts = append(alerts, ExecAlert{
			Severity: "attention",
			Title:    fmt.Sprintf("%d published report%s cites evidence that was later rejected", stale, plural(stale)),
			Detail:   "The report itself is unchanged; consider publishing a new version.",
		})
	}

	return alerts
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
