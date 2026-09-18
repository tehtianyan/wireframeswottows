// Dashboard data.
//
// Two scopes, matching the two questions people actually ask:
//   GET /dashboard                  "what needs me today?", across workshops
//   GET /workshops/{id}/summary     "where is this workshop?", per wireframe §1
//
// Both are assembled from the object registry rather than a fixed list of
// tables, so a new object kind appears in the counts without touching this
// file.
package handlers

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/objects"
	"swot-tows/pkg/response"
)

type KindCount struct {
	Kind      string `json:"kind"`
	Label     string `json:"label"`
	Total     int    `json:"total"`
	Approved  int    `json:"approved"`
	Awaiting  int    `json:"awaiting_review"`
}

type ActivityEvent struct {
	Action     string  `json:"action"`
	ObjectType string  `json:"object_type"`
	ActorName  string  `json:"actor_name"`
	NewState   *string `json:"new_state"`
	CreatedAt  string  `json:"created_at"`
}

type DashboardWorkshop struct {
	ID              string      `json:"id"`
	Name            string      `json:"name"`
	Status          string      `json:"status"`
	MethodologyName string      `json:"methodology_name"`
	MyRole          string      `json:"my_role"`
	StagesTotal     int         `json:"stages_total"`
	StagesComplete  int         `json:"stages_complete"`
	Counts          []KindCount `json:"counts"`
	AwaitingReview  int         `json:"awaiting_review"`
	FirstStageKey   string      `json:"first_stage_key"`
}

type Dashboard struct {
	Workshops      []DashboardWorkshop `json:"workshops"`
	AwaitingMyReview int               `json:"awaiting_my_review"`
	RecentActivity []ActivityEvent     `json:"recent_activity"`
}

// countableKinds is the registry's kinds plus factors, which predate it.
func countableKinds() []struct{ Key, Table, Label string } {
	out := []struct{ Key, Table, Label string }{
		{"factor", "factors", "Factors"},
	}
	for _, k := range objects.All() {
		out = append(out, struct{ Key, Table, Label string }{k.Key, k.Table, k.Label + "s"})
	}
	return out
}

func countsFor(ctx context.Context, pool *pgxpool.Pool, workshopID string) ([]KindCount, int, error) {
	counts := []KindCount{}
	awaiting := 0
	for _, k := range countableKinds() {
		var total, approved, submitted int
		err := pool.QueryRow(ctx, fmt.Sprintf(`
			select count(*),
			       count(*) filter (where state = 'approved'),
			       count(*) filter (where state = 'submitted')
			from public.%s where workshop_id = $1`, k.Table), workshopID).
			Scan(&total, &approved, &submitted)
		if err != nil {
			return nil, 0, err
		}
		counts = append(counts, KindCount{
			Kind: k.Key, Label: k.Label, Total: total, Approved: approved, Awaiting: submitted,
		})
		awaiting += submitted
	}
	return counts, awaiting, nil
}

// GetDashboard — GET /dashboard
func GetDashboard(w http.ResponseWriter, r *http.Request) {
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
		select w.id, w.name, w.status, m.name, wm.role
		from public.workshops w
		join public.workshop_members wm on wm.workshop_id = w.id and wm.user_id = $1
		join public.methodologies m on m.id = w.methodology_id
		order by w.updated_at desc nulls last, w.created_at desc`, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	type row struct{ id, name, status, methodology, role string }
	found := []row{}
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.id, &x.name, &x.status, &x.methodology, &x.role); err != nil {
			rows.Close()
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		found = append(found, x)
	}
	rows.Close()

	out := Dashboard{Workshops: []DashboardWorkshop{}, RecentActivity: []ActivityEvent{}}
	for _, x := range found {
		counts, awaiting, err := countsFor(r2.Context(), pool, x.id)
		if err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}

		var stagesTotal, stagesComplete int
		pool.QueryRow(r2.Context(), `
			select count(*), count(*) filter (where status = 'completed')
			from public.activities where workshop_id = $1`, x.id).Scan(&stagesTotal, &stagesComplete)

		var firstStage string
		pool.QueryRow(r2.Context(), `
			select ms.key from public.methodology_stages ms
			join public.workshops w on w.methodology_id = ms.methodology_id
			where w.id = $1 order by ms.sequence_number limit 1`, x.id).Scan(&firstStage)

		d := DashboardWorkshop{
			ID: x.id, Name: x.name, Status: x.status, MethodologyName: x.methodology,
			MyRole: x.role, StagesTotal: stagesTotal, StagesComplete: stagesComplete,
			Counts: counts, FirstStageKey: firstStage,
		}
		// Only reviewers are actually being asked to do something.
		if x.role == "facilitator" || x.role == "analyst" {
			d.AwaitingReview = awaiting
			out.AwaitingMyReview += awaiting
		}
		out.Workshops = append(out.Workshops, d)
	}

	// The activity feed is the audit trail, scoped to workshops this user
	// belongs to. It is real history, not a sample.
	actRows, err := pool.Query(r2.Context(), `
		select a.action, a.object_type, coalesce(p.display_name, p.email, 'Someone'),
		       a.new_state, a.created_at
		from public.audit_events a
		left join public.profiles p on p.id = a.actor_id
		where a.metadata->>'workshop_id' in (
		  select workshop_id::text from public.workshop_members where user_id = $1
		)
		order by a.created_at desc limit 20`, user.ID)
	if err == nil {
		for actRows.Next() {
			var e ActivityEvent
			var createdAt time.Time
			if err := actRows.Scan(&e.Action, &e.ObjectType, &e.ActorName, &e.NewState, &createdAt); err != nil {
				break
			}
			e.CreatedAt = createdAt.Format(time.RFC3339)
			out.RecentActivity = append(out.RecentActivity, e)
		}
		actRows.Close()
	}

	response.OK(w, out)
}

type StageProgressItem struct {
	Key       string `json:"key"`
	Name      string `json:"name"`
	StageType string `json:"stage_type"`
	Sequence  int    `json:"sequence_number"`
	Status    string `json:"status"`
	ItemCount int    `json:"item_count"`
}

type HealthSignal struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	Value   int    `json:"value"`
	Target  int    `json:"target"`
	Message string `json:"message"`
}

type WorkshopSummary struct {
	Counts          []KindCount         `json:"counts"`
	ByCategory      []CategoryCount     `json:"factors_by_category"`
	Stages          []StageProgressItem `json:"stages"`
	AwaitingReview  int                 `json:"awaiting_review"`
	Participants    int                 `json:"participants"`
	HealthScore     int                 `json:"health_score"`
	HealthSignals   []HealthSignal      `json:"health_signals"`
	RecentActivity  []ActivityEvent     `json:"recent_activity"`
}

type CategoryCount struct {
	Key        string `json:"key"`
	Name       string `json:"name"`
	ColorToken string `json:"color_token"`
	Count      int    `json:"count"`
}

// GetWorkshopSummary — GET /workshops/{id}/summary
//
// The numbers behind the workshop dashboard (wireframe §1.13, §1.17, §1.19).
func GetWorkshopSummary(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID); err != nil {
		writeAuthzErr(w, err)
		return
	}

	m, err := methodology.LoadForWorkshop(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	counts, awaiting, err := countsFor(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	summary := WorkshopSummary{
		Counts: counts, AwaitingReview: awaiting,
		ByCategory: []CategoryCount{}, Stages: []StageProgressItem{},
		HealthSignals: []HealthSignal{}, RecentActivity: []ActivityEvent{},
	}

	// Factors per configured category — six buckets for PESTLE, four for SWOT.
	for _, c := range m.FactorCategories {
		var n int
		pool.QueryRow(r2.Context(), `
			select count(*) from public.factors f
			join public.methodology_factor_categories mfc on mfc.id = f.factor_category_id
			where f.workshop_id = $1 and mfc.key = $2`, workshopID, c.Key).Scan(&n)
		summary.ByCategory = append(summary.ByCategory, CategoryCount{
			Key: c.Key, Name: c.Name, ColorToken: c.ColorToken, Count: n,
		})
	}

	// Stage progress, with how much each stage has actually produced.
	for _, s := range m.Stages {
		item := StageProgressItem{
			Key: s.Key, Name: s.Name, StageType: s.StageType,
			Sequence: s.SequenceNumber, Status: "not_started",
		}
		pool.QueryRow(r2.Context(), `
			select a.status from public.activities a
			join public.methodology_stages ms on ms.id = a.stage_id
			where a.workshop_id = $1 and ms.key = $2 limit 1`, workshopID, s.Key).Scan(&item.Status)
		item.ItemCount = stageItemCount(r2.Context(), pool, workshopID, &s)
		summary.Stages = append(summary.Stages, item)
	}

	pool.QueryRow(r2.Context(),
		`select count(*) from public.workshop_members where workshop_id = $1`, workshopID).
		Scan(&summary.Participants)

	summary.HealthSignals, summary.HealthScore = workshopHealth(summary, m)

	actRows, err := pool.Query(r2.Context(), `
		select a.action, a.object_type, coalesce(p.display_name, p.email, 'Someone'),
		       a.new_state, a.created_at
		from public.audit_events a
		left join public.profiles p on p.id = a.actor_id
		where a.metadata->>'workshop_id' = $1
		order by a.created_at desc limit 15`, workshopID)
	if err == nil {
		for actRows.Next() {
			var e ActivityEvent
			var createdAt time.Time
			if err := actRows.Scan(&e.Action, &e.ObjectType, &e.ActorName, &e.NewState, &createdAt); err != nil {
				break
			}
			e.CreatedAt = createdAt.Format(time.RFC3339)
			summary.RecentActivity = append(summary.RecentActivity, e)
		}
		actRows.Close()
	}

	response.OK(w, summary)
}

// stageItemCount says how much a stage has produced, addressed through the
// registry so it works for any stage type.
func stageItemCount(ctx context.Context, pool *pgxpool.Pool, workshopID string, s *methodology.Stage) int {
	var n int
	if catKey, _ := s.Config["factor_category_key"].(string); catKey != "" {
		pool.QueryRow(ctx, `
			select count(*) from public.factors f
			join public.methodology_factor_categories mfc on mfc.id = f.factor_category_id
			where f.workshop_id = $1 and mfc.key = $2`, workshopID, catKey).Scan(&n)
		return n
	}
	if s.StageType == "report" {
		pool.QueryRow(ctx, `select count(*) from public.reports where workshop_id = $1`, workshopID).Scan(&n)
		return n
	}
	kind, err := objects.ByStageType(s.StageType)
	if err != nil {
		return 0
	}
	pool.QueryRow(ctx, fmt.Sprintf(`select count(*) from public.%s where workshop_id = $1`, kind.Table),
		workshopID).Scan(&n)
	return n
}

// workshopHealth reports signals and a score derived transparently from them.
//
// Deliberately NOT a single opaque number: the old mock dashboard showed "84"
// with nothing behind it. Each signal states what it measured and what it
// wanted, so a facilitator can act on it rather than admire it.
func workshopHealth(s WorkshopSummary, m *methodology.Methodology) ([]HealthSignal, int) {
	signals := []HealthSignal{}

	// 1. Is every configured category being used? An empty category usually
	//    means a blind spot, not an absence.
	emptyCats := 0
	for _, c := range s.ByCategory {
		if c.Count == 0 {
			emptyCats++
		}
	}
	covered := len(s.ByCategory) - emptyCats
	signals = append(signals, HealthSignal{
		Key: "coverage", Label: "Category coverage", Value: covered, Target: len(s.ByCategory),
		Message: coverageMessage(emptyCats),
	})

	// 2. How much of what was captured has been decided on?
	var totalFactors, approvedFactors int
	for _, c := range s.Counts {
		if c.Kind == "factor" {
			totalFactors, approvedFactors = c.Total, c.Approved
		}
	}
	reviewed := 0
	if totalFactors > 0 {
		reviewed = approvedFactors * 100 / totalFactors
	}
	signals = append(signals, HealthSignal{
		Key: "review", Label: "Factors approved", Value: reviewed, Target: 100,
		Message: fmt.Sprintf("%d of %d captured factors approved", approvedFactors, totalFactors),
	})

	// 3. How far through the methodology.
	done := 0
	for _, st := range s.Stages {
		if st.Status == "completed" {
			done++
		}
	}
	progress := 0
	if len(s.Stages) > 0 {
		progress = done * 100 / len(s.Stages)
	}
	signals = append(signals, HealthSignal{
		Key: "progress", Label: "Stages complete", Value: done, Target: len(s.Stages),
		Message: fmt.Sprintf("%d of %d %s stages complete", done, len(s.Stages), m.Name),
	})

	// 4. Is a review queue building up?
	signals = append(signals, HealthSignal{
		Key: "queue", Label: "Awaiting review", Value: s.AwaitingReview, Target: 0,
		Message: queueMessage(s.AwaitingReview),
	})

	// Score: the mean of coverage, approval and progress, with a penalty for a
	// review backlog. Simple and explainable on purpose.
	coveragePct := 0
	if len(s.ByCategory) > 0 {
		coveragePct = covered * 100 / len(s.ByCategory)
	}
	score := (coveragePct + reviewed + progress) / 3
	if s.AwaitingReview > 10 {
		score -= 10
	}
	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}
	return signals, score
}

func coverageMessage(empty int) string {
	switch empty {
	case 0:
		return "Every category has captured factors"
	case 1:
		return "1 category still has nothing captured"
	default:
		return fmt.Sprintf("%d categories still have nothing captured", empty)
	}
}

func queueMessage(n int) string {
	switch {
	case n == 0:
		return "Nothing is waiting for a decision"
	case n == 1:
		return "1 item is waiting for review"
	default:
		return fmt.Sprintf("%d items are waiting for review", n)
	}
}
