// Where a workshop has got to — the facts behind the overview's readout, the
// break-time summary and the dashboard's cross-workshop view.
//
// ONE ANSWER, THREE READERS (DECIDED 2026-11-14). The overview panel, the
// Summarize Workshop prompt and the dashboard all want "what is done, what is
// waiting on somebody, and what to pick up next". Computing it three times is
// how the screen and the summary come to disagree in front of a room — the
// same reason `src/lib/stages.ts` states the stage-visibility rule once for
// the three surfaces that list stages.
//
// EVERYTHING HERE IS COUNTED, NOT INTERPRETED. "Emerging properties of the
// themes" and "strategic projects" are readings, and a reading belongs to the
// assistant, under review, where the product already puts them. What this file
// produces is arithmetic a facilitator can check against the board.
package handlers

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/methodology"
	"swot-tows/pkg/objects"
)

// StageStanding is one stage's progress, derived rather than stored.
type StageStanding struct {
	Key    string `json:"key"`
	Name   string `json:"name"`
	Type   string `json:"stage_type"`
	Number int    `json:"sequence_number"`
	// not_started | in_progress | completed
	Status string `json:"status"`
	Items  int    `json:"items"`
	// FacilitatorOnly stages are tools rather than steps in the room's path;
	// a summary that chases the room to finish one would be chasing them to
	// do something they were never shown.
	FacilitatorOnly bool `json:"facilitator_only"`
}

// ActionStanding is one tracked action and how far it has got.
type ActionStanding struct {
	Title string `json:"title"`
	// Delivery column, resolved — never empty, never a key with no column.
	State string `json:"state"`
	// Owner is empty when nobody has been named.
	Owner string `json:"owner"`
	// Planned is true once any of the delivery detail has been filled in.
	Planned bool `json:"planned"`
	// Approved distinguishes agreed work from a proposal nobody has decided.
	Approved bool `json:"approved"`
	Group    string `json:"group,omitempty"`
}

// WorkshopStanding is the whole readout.
type WorkshopStanding struct {
	Stages []StageStanding `json:"stages"`
	// AwaitingReview counts submitted items per kind label, so a summary can
	// say "nine notes and two themes are waiting on you" rather than a total
	// that hides which queue is blocked.
	AwaitingReview map[string]int `json:"awaiting_review"`
	Themes         int            `json:"themes"`
	// ThemesByCategory is how the themes are spread — the countable half of
	// "emerging properties", and the half that is a fact.
	ThemesByCategory map[string]int   `json:"themes_by_category"`
	Initiatives      int              `json:"initiatives"`
	Actions          []ActionStanding `json:"actions"`
	ActionsByState   map[string]int   `json:"actions_by_state"`
	ActionsUnowned   int              `json:"actions_unowned"`
	Participants     int              `json:"participants"`
	// Contributed is how many of them have actually put something in. A room
	// of twelve where three have contributed is the finding, not the twelve.
	Contributed int `json:"contributed"`
}

// stageIsFacilitatorOnly reads `visible_to_roles` the way the client does.
//
// A stage listing roles and NOT listing "participant" is a tool rather than a
// step in the room's path — so a summary must not chase the room to finish
// one. An empty or absent list means everybody, which is why the check is for
// a non-empty list that excludes participants rather than for the key's mere
// presence.
func stageIsFacilitatorOnly(st methodology.Stage) bool {
	raw, ok := st.Config["visible_to_roles"].([]interface{})
	if !ok || len(raw) == 0 {
		return false
	}
	for _, v := range raw {
		if s, _ := v.(string); s == "participant" {
			return false
		}
	}
	return true
}

// loadWorkshopStanding gathers it in a handful of aggregate queries.
func loadWorkshopStanding(ctx context.Context, pool *pgxpool.Pool,
	m *methodology.Methodology, workshopID string) (*WorkshopStanding, error) {

	out := &WorkshopStanding{
		Stages:           []StageStanding{},
		AwaitingReview:   map[string]int{},
		ThemesByCategory: map[string]int{},
		Actions:          []ActionStanding{},
		ActionsByState:   map[string]int{},
	}

	// ---- stages, derived the same way the overview derives them ----
	counts, err := loadStageCounts(ctx, pool, workshopID)
	if err != nil {
		return nil, err
	}
	stored := map[string]string{}
	rows, err := pool.Query(ctx,
		`select ms.key, coalesce(a.status, '')
		 from public.activities a
		 join public.methodology_stages ms on ms.id = a.stage_id
		 where a.workshop_id = $1`, workshopID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k, s string
		if err := rows.Scan(&k, &s); err != nil {
			rows.Close()
			return nil, err
		}
		stored[k] = s
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, st := range m.Stages {
		content := counts.contentFor(st)
		out.Stages = append(out.Stages, StageStanding{
			Key: st.Key, Name: st.Name, Type: st.StageType,
			Number: st.SequenceNumber,
			Status: stageStatus(stored[st.Key], content),
			Items:  content,
			// A stage nobody but the facilitator is shown is a tool, not a
			// step the room is behind on. Read from config, never assumed —
			// the same key src/lib/stages.ts reads, so the screen and the
			// summary cannot disagree about which stages are steps.
			FacilitatorOnly: stageIsFacilitatorOnly(st),
		})
	}

	// ---- what is waiting on a decision ----
	var submittedFactors int
	if err := pool.QueryRow(ctx,
		`select count(*) from public.factors where workshop_id = $1 and state = 'submitted'`,
		workshopID).Scan(&submittedFactors); err != nil {
		return nil, err
	}
	if submittedFactors > 0 {
		out.AwaitingReview["note"] = submittedFactors
	}
	for _, key := range []string{"synthesis", "factor_relationship", "insight", "initiative", "recommendation"} {
		k, err := objects.ByKey(key)
		if err != nil {
			continue
		}
		var n int
		if err := pool.QueryRow(ctx, fmt.Sprintf(
			`select count(*) from public.%s where workshop_id = $1 and state = 'submitted'`,
			k.Table), workshopID).Scan(&n); err != nil {
			return nil, err
		}
		if n > 0 {
			out.AwaitingReview[k.Label] = n
		}
	}

	// ---- themes, and how they are spread across the categories ----
	//
	// A theme's category is DERIVED from the notes it cites — `syntheses` has
	// no category column, on purpose — so this is the same join the matrix
	// uses to decide which axis a theme sits on. A theme spanning categories
	// is counted once, under no category, rather than twice.
	trows, err := pool.Query(ctx, `
		select coalesce(cat.key, ''), count(*)
		from (
		  select s.id,
		         case when count(distinct mfc.key) = 1
		              then min(mfc.key) else null end as key
		  from public.syntheses s
		  left join public.synthesis_factors sf on sf.synthesis_id = s.id
		  left join public.factors f on f.id = sf.factor_id
		  left join public.methodology_factor_categories mfc on mfc.id = f.factor_category_id
		  where s.workshop_id = $1 and s.state <> 'archived'
		  group by s.id
		) cat
		group by cat.key`, workshopID)
	if err != nil {
		return nil, err
	}
	for trows.Next() {
		var key string
		var n int
		if err := trows.Scan(&key, &n); err != nil {
			trows.Close()
			return nil, err
		}
		out.Themes += n
		if key != "" {
			name := key
			if c := m.CategoryByKey(key); c != nil {
				name = c.Name
			}
			out.ThemesByCategory[name] = n
		}
	}
	trows.Close()
	if err := trows.Err(); err != nil {
		return nil, err
	}

	// ---- the work, and how far it has got ----
	if err := pool.QueryRow(ctx,
		`select count(*) from public.initiatives where workshop_id = $1 and state <> 'archived'`,
		workshopID).Scan(&out.Initiatives); err != nil {
		return nil, err
	}

	// The delivery columns come from the report stage's config; without one,
	// an action has no board and no state to report.
	var states []DeliveryState
	for i := range m.Stages {
		if cfg := readDeliveryConfig(&m.Stages[i]); cfg != nil {
			states = cfg.States
			break
		}
	}

	arows, err := pool.Query(ctx, `
		select r.title, coalesce(r.delivery_state, ''), r.state,
		       coalesce(nullif(trim(p.display_name), ''),
		                nullif(trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''),
		                p.email, r.owner_name, '') as owner,
		       (r.owner_user_id is not null or r.owner_name is not null
		        or r.start_date is not null or r.end_date is not null
		        or r.effort_person_days is not null or r.value_amount is not null) as planned,
		       coalesce(i.title, '')
		from public.recommendations r
		left join public.profiles p on p.id = r.owner_user_id
		left join public.initiatives i on i.id = r.initiative_id
		where r.workshop_id = $1 and r.state not in ('rejected', 'archived')
		order by i.created_at nulls first, r.created_at`, workshopID)
	if err != nil {
		return nil, err
	}
	for arows.Next() {
		var a ActionStanding
		var stored, objState string
		if err := arows.Scan(&a.Title, &stored, &objState, &a.Owner, &a.Planned, &a.Group); err != nil {
			arows.Close()
			return nil, err
		}
		a.Approved = objState == "approved"
		// RESOLVED, exactly as the board resolves it: a null or stale value
		// is the first column, not a blank that reads as "nowhere".
		if len(states) > 0 {
			a.State = states[0].Name
			for _, s := range states {
				if s.Key == stored {
					a.State = s.Name
					break
				}
			}
		}
		if a.Owner == "" {
			out.ActionsUnowned++
		}
		out.ActionsByState[a.State]++
		out.Actions = append(out.Actions, a)
	}
	arows.Close()
	if err := arows.Err(); err != nil {
		return nil, err
	}

	// ---- who is in the room, and who has actually said something ----
	if err := pool.QueryRow(ctx,
		`select count(*) from public.workshop_members where workshop_id = $1`,
		workshopID).Scan(&out.Participants); err != nil {
		return nil, err
	}
	if err := pool.QueryRow(ctx, `
		select count(distinct created_by) from public.factors
		where workshop_id = $1 and created_by is not null`,
		workshopID).Scan(&out.Contributed); err != nil {
		return nil, err
	}

	return out, nil
}

// fetchWorkshopStanding is the AI-context shape of the same thing.
func fetchWorkshopStanding(ctx context.Context, pool *pgxpool.Pool,
	m *methodology.Methodology, workshopID string) (map[string]interface{}, error) {

	st, err := loadWorkshopStanding(ctx, pool, m, workshopID)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"stage_progress":     st.Stages,
		"awaiting_review":    st.AwaitingReview,
		"themes_by_category": st.ThemesByCategory,
		"actions":            st.Actions,
		"actions_by_state":   st.ActionsByState,
		"actions_unowned":    st.ActionsUnowned,
		"participants":       st.Participants,
		"contributors":       st.Contributed,
	}, nil
}
