// "Merge and Fix" — a tracked, undoable AI tidy-up of the capture board.
//
// This is the one place the assistant CHANGES human-authored content rather
// than proposing new content, so App Spec §12.19 needs reading carefully
// rather than waving through. Three properties make it legitimate, and every
// one of them is enforced here rather than merely intended:
//
//   - Nothing is approved by AI. Touched factors stay `submitted`; the Review
//     Board is still where a human decides.
//   - Nothing is destroyed. A merged duplicate is `archived`, never deleted.
//   - Nothing is untraceable. Every change stores its own before-state and is
//     individually undoable.
//
// And one refusal that is the whole safety argument: a factor cited by a
// theme, used in a relationship, or carrying weights is NEVER merged away.
// Merging it would break a traceability chain that the FKs exist to protect.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/ai"
	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/response"
)

// cleanupFunctionKey is the config row this feature runs from. A methodology
// without it has no button — that is the entire opt-in mechanism.
const cleanupFunctionKey = "board_cleanup"

// Tidying the whole wall is the facilitator's job. A participant editing
// their own note goes through PATCH /factors/{id} as before.
var cleanupRoles = []string{"facilitator"}

type CleanupChange struct {
	ID         string                 `json:"id"`
	ChangeType string                 `json:"change_type"`
	FactorID   string                 `json:"factor_id"`
	Before     map[string]interface{} `json:"before"`
	After      map[string]interface{} `json:"after"`
	Reason     *string                `json:"reason"`
	UndoneAt   *string                `json:"undone_at"`
	// FactorTitle is the note's title, so the panel can name what it is
	// offering to undo without a second round trip.
	FactorTitle string `json:"factor_title"`
}

// CleanupSkip is a change the model proposed and the server refused. Kept and
// shown rather than silently dropped: "those two look like duplicates, but one
// is cited by a theme" is a thing the facilitator needs to know, and is their
// call to make by hand.
type CleanupSkip struct {
	ChangeType string `json:"change_type"`
	FactorID   string `json:"factor_id"`
	Title      string `json:"title"`
	Reason     string `json:"reason"`
	Refused    string `json:"refused"`
}

type CleanupRun struct {
	ID        string          `json:"id"`
	StageKey  *string         `json:"stage_key"`
	CreatedAt string          `json:"created_at"`
	CreatedBy string          `json:"created_by"`
	UndoneAt  *string         `json:"undone_at"`
	Changes   []CleanupChange `json:"changes"`
	Skipped   []CleanupSkip   `json:"skipped"`
}

type runCleanupBody struct {
	StageKey string `json:"stage_key"`
}

// RunCleanup — POST /workshops/{id}/cleanup
func RunCleanup(w http.ResponseWriter, r *http.Request) {
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
	role, err := authz.RequireWorkshopRole(ctx, pool, user.ID, workshopID, cleanupRoles...)
	if err != nil {
		writeAuthzErr(w, err)
		return
	}

	if !ai.Configured() {
		response.Fail(w, response.CodeAIGenerationFailed,
			"The AI assistant is not configured on this server.")
		return
	}

	var body runCleanupBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	// §12.21, counted before any provider call is made — same as ExecuteAI.
	used, err := aiRequestsThisHour(ctx, pool, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if limit := limitForRole(role); used >= limit {
		response.Fail(w, response.CodeRateLimited, fmt.Sprintf(
			"You have used all %d AI requests available this hour. You can continue working without AI.", limit))
		return
	}

	m, err := methodology.LoadForWorkshop(ctx, pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	stage := m.StageByKey(body.StageKey)
	prompt := resolvePrompt(m, cleanupFunctionKey, stage)
	if prompt == nil {
		response.Fail(w, response.CodeValidationError,
			"This methodology does not offer a board tidy-up on this stage.")
		return
	}

	// The board is the whole wall, not one category — a note in the wrong
	// quadrant is by definition not on the stage it belongs to. So this builds
	// its own context rather than using buildAIContext's per-stage slice.
	notes, err := cleanupCandidates(ctx, pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if len(notes) < 2 {
		response.Fail(w, response.CodeValidationError,
			"There is not enough on the board to tidy up yet.")
		return
	}

	cats := []map[string]interface{}{}
	for _, c := range m.FactorCategories {
		cats = append(cats, map[string]interface{}{
			"key": c.Key, "name": c.Name, "guidance": c.GuidanceText,
		})
	}
	promptCtx := map[string]interface{}{"notes": notes, "categories": cats}

	var wkName, wkObjective string
	_ = pool.QueryRow(ctx,
		`select name, coalesce(objective, '') from public.workshops where id = $1`, workshopID,
	).Scan(&wkName, &wkObjective)

	vars := map[string]string{
		"workshop_name":      wkName,
		"workshop_objective": wkObjective,
		"methodology_name":   m.Name,
	}
	if stage != nil {
		vars["stage_name"] = stage.Name
	}

	// Recorded before calling out, so a provider failure still leaves an audit
	// trail and still counts against the rate limit.
	var sessionID string
	err = pool.QueryRow(ctx, `
		insert into public.ai_sessions (user_id, workshop_id, prompt_type, input_summary, status, stage_key, model)
		values ($1, $2, $3, $4, 'pending', $5, $6) returning id`,
		user.ID, workshopID, prompt.FunctionKey,
		fmt.Sprintf("%s for %s", prompt.Name, wkName), nullableString(body.StageKey), ai.Model(),
	).Scan(&sessionID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	result, aiErr := ai.Complete(ctx, ai.SystemPrompt(m.Name),
		buildUserPrompt(prompt, vars, promptCtx), true)
	if aiErr != nil {
		_, _ = pool.Exec(ctx,
			`update public.ai_sessions set status = 'failed', error_message = $2 where id = $1`,
			sessionID, aiErr.Error())
		audit.Record(ctx, pool, user.ID, "ai.failed", "ai_session", sessionID, "pending", "failed",
			map[string]interface{}{"workshop_id": workshopID, "function_key": prompt.FunctionKey})
		// §12.22: one fixed user-facing message, whatever went wrong.
		response.Fail(w, response.CodeAIGenerationFailed, ai.UserFacingFailure)
		return
	}

	// The output is stored as `accepted` because it WAS applied, and the
	// facilitator's click is the human act that applied it. Recording it as
	// pending would describe a review that is not going to happen; the review
	// that matters is the Review Board's, on the notes themselves.
	contentJSON, _ := json.Marshal(result.Parsed)
	var outputID string
	err = pool.QueryRow(ctx, `
		insert into public.ai_outputs (ai_session_id, output_type, content, human_review_status,
		                               prompt_version, reviewed_by, reviewed_at)
		values ($1, $2, $3, 'accepted', $4, $5, now()) returning id`,
		sessionID, prompt.FunctionKey, string(contentJSON), prompt.PromptVersion, user.ID,
	).Scan(&outputID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	_, _ = pool.Exec(ctx, `
		update public.ai_sessions
		set status = 'completed', latency_ms = $2, input_tokens = $3, output_tokens = $4
		where id = $1`, sessionID, result.LatencyMS, result.InputTokens, result.OutputTokens)

	run, err := applyCleanup(ctx, pool, m, workshopID, user.ID, body.StageKey, outputID,
		proposedChanges(result.Parsed), notes)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(ctx, pool, user.ID, "board.cleaned", "board_cleanup_run", run.ID, "", "applied",
		map[string]interface{}{
			"workshop_id": workshopID, "stage_key": body.StageKey,
			"ai_output_id": outputID,
			"applied":      len(run.Changes), "skipped": len(run.Skipped),
		})

	response.Created(w, run)
}

// cleanupNote is one note as offered to the model.
type cleanupNote struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Title    string `json:"title"`
	Desc     string `json:"description"`

	// referenced is NOT sent to the model — it is the server's own refusal
	// check, applied to whatever comes back. Telling the model "don't merge
	// this one" would be a request; refusing it here is a guarantee.
	referenced string
	state      string
}

// cleanupCandidates lists what may be tidied: everything still in play.
// Approved and rejected notes are frozen everywhere else in the system and
// stay frozen here, so they are not even offered — which is also why planning
// can treat "not in this list" as sufficient grounds to refuse a change.
func cleanupCandidates(ctx context.Context, pool *pgxpool.Pool, workshopID string) ([]cleanupNote, error) {
	rows, err := pool.Query(ctx, `
		select f.id::text, mfc.key, f.title, coalesce(f.description, ''), f.state,
		       exists(select 1 from public.synthesis_factors sf where sf.factor_id = f.id)      as cited,
		       exists(select 1 from public.factor_relationships fr
		              where fr.source_factor_id = f.id or fr.target_factor_id = f.id)           as paired,
		       exists(select 1 from public.weights wt where wt.object_id = f.id)                as weighted
		from public.factors f
		join public.methodology_factor_categories mfc on mfc.id = f.factor_category_id
		where f.workshop_id = $1 and f.state in ('draft', 'submitted')
		order by f.created_at
		limit 300`, workshopID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []cleanupNote{}
	for rows.Next() {
		var n cleanupNote
		var cited, paired, weighted bool
		if err := rows.Scan(&n.ID, &n.Category, &n.Title, &n.Desc, &n.state, &cited, &paired, &weighted); err != nil {
			return nil, err
		}
		// Phrased WITHOUT a subject, so it reads correctly whether it is the
		// note being merged ("it " + reason) or the survivor ("the note it
		// would merge into " + reason).
		switch {
		case cited:
			n.referenced = "is already cited by a theme"
		case paired:
			n.referenced = "is already used in a relationship"
		case weighted:
			n.referenced = "already carries votes or scores"
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// proposedChange is one edit as the model described it.
type proposedChange struct {
	Type     string `json:"type"`
	FactorID string `json:"factor_id"`
	Title    string `json:"title"`
	// Description is a POINTER because absent and empty must mean different
	// things: a model that restates only the title is not asking for the
	// description to be erased. Treating the zero value as "clear it" silently
	// deleted a note's body whenever the rewrite touched only its title.
	Description *string `json:"description"`
	CategoryKey string  `json:"category_key"`
	IntoFactor  string  `json:"into_factor_id"`
	Reason      string  `json:"reason"`
}

// proposedChanges pulls the changeset out of the parsed output. It reads the
// declared key rather than "the first array in the map", because Go randomises
// map iteration order — the bug suggestionsArray was written to fix.
func proposedChanges(content map[string]interface{}) []proposedChange {
	raw, _ := content["changes"].([]interface{})
	out := []proposedChange{}
	for _, item := range raw {
		b, err := json.Marshal(item)
		if err != nil {
			continue
		}
		var c proposedChange
		if err := json.Unmarshal(b, &c); err != nil {
			continue
		}
		out = append(out, c)
	}
	return out
}

// plannedChange is one validated edit, ready to execute.
type plannedChange struct {
	Type     string
	FactorID string
	Before   map[string]interface{}
	After    map[string]interface{}
	Reason   string
	Title    string

	// Resolved during planning so execution does no lookups: the new category
	// for a move, the survivor for a merge.
	CategoryID  string
	CategoryKey string
	MergeInto   string
}

// planCleanup decides which proposed changes are allowed, and what each one
// would write.
//
// It is deliberately PURE — no database, no network — because the merge safety
// rule is the whole argument for this feature being acceptable, and a rule
// that can only be exercised by paying for a live model call is a rule nobody
// checks. See cleanup_plan_test.go.
//
// It DROPS what fails and keeps the rest, the same way sanitizeAIOutput does
// and for the same reason: one mangled id must not bin nine good fixes.
func planCleanup(m *methodology.Methodology, notes []cleanupNote,
	proposed []proposedChange) ([]plannedChange, []CleanupSkip) {

	byID := map[string]*cleanupNote{}
	for i := range notes {
		byID[notes[i].ID] = &notes[i]
	}

	plan := []plannedChange{}
	skipped := []CleanupSkip{}
	skip := func(c proposedChange, title, why string) {
		skipped = append(skipped, CleanupSkip{
			ChangeType: c.Type, FactorID: c.FactorID, Title: title,
			Reason: strings.TrimSpace(c.Reason), Refused: why,
		})
	}

	// One change per note, so two edits cannot contradict each other and an
	// undo always restores the state the note was actually in.
	touched := map[string]bool{}
	// Merges need two further relations, and they are NOT the same as
	// "touched": rewording the survivor and folding a duplicate into it are
	// independent edits with independent before-states, and the first live run
	// refused exactly that pair. What must be refused is a CHAIN — a note both
	// absorbing one duplicate and being merged away itself — because then the
	// survivor a merge names is not on the board any more.
	mergedAway := map[string]bool{}
	mergeTarget := map[string]bool{}

	for _, c := range proposed {
		note := byID[c.FactorID]
		if note == nil {
			// Either invented, or from another workshop, or already frozen:
			// cleanupCandidates offers only draft and submitted notes, so an
			// approved one is not in this map and cannot be touched.
			skip(c, "", "that note is not on this board")
			continue
		}
		if touched[c.FactorID] {
			skip(c, note.Title, "another change was already applied to this note")
			continue
		}

		p := plannedChange{
			Type: c.Type, FactorID: c.FactorID,
			Reason: strings.TrimSpace(c.Reason), Title: note.Title,
		}

		switch c.Type {
		case "reword":
			title := strings.TrimSpace(c.Title)
			if title == "" {
				title = note.Title
			}
			if msg := validateFactorTitle(title); msg != "" {
				skip(c, note.Title, strings.ToLower(strings.TrimSuffix(msg, ".")))
				continue
			}
			desc := note.Desc
			if c.Description != nil {
				desc = strings.TrimSpace(*c.Description)
			}
			if title == note.Title && desc == note.Desc {
				skip(c, note.Title, "the rewrite was identical to the original")
				continue
			}
			p.Before = map[string]interface{}{"title": note.Title, "description": note.Desc}
			p.After = map[string]interface{}{"title": title, "description": desc}

		case "move":
			key := strings.TrimSpace(c.CategoryKey)
			cat := m.CategoryByKey(key)
			if cat == nil {
				skip(c, note.Title, "that is not a category in this methodology")
				continue
			}
			if key == note.Category {
				skip(c, note.Title, "the note is already in that category")
				continue
			}
			p.CategoryID, p.CategoryKey = cat.ID, key
			p.Before = map[string]interface{}{"category_key": note.Category}
			p.After = map[string]interface{}{"category_key": key}

		case "merge":
			if c.IntoFactor == c.FactorID {
				skip(c, note.Title, "a note cannot be merged into itself")
				continue
			}
			target := byID[c.IntoFactor]
			if target == nil {
				skip(c, note.Title, "the note it would merge into is not on this board")
				continue
			}
			// THE SAFETY CHECK. A note cited by a theme, used in a
			// relationship or carrying votes is evidence that something else
			// already rests on — merging it away would break a traceability
			// chain the FKs exist to protect. Neither side may be referenced:
			// the survivor absorbs the duplicate's meaning, and whoever cited
			// the duplicate cited THAT note, not this one.
			if note.referenced != "" {
				skip(c, note.Title, "it "+note.referenced)
				continue
			}
			if target.referenced != "" {
				skip(c, note.Title, "the note it would merge into "+target.referenced)
				continue
			}
			if mergedAway[c.IntoFactor] {
				skip(c, note.Title, "the note it would merge into is itself being merged away")
				continue
			}
			if mergeTarget[c.FactorID] {
				skip(c, note.Title, "another note is already being merged into this one")
				continue
			}
			mergedAway[c.FactorID] = true
			mergeTarget[c.IntoFactor] = true
			p.MergeInto = c.IntoFactor
			p.Before = map[string]interface{}{"state": note.state}
			p.After = map[string]interface{}{"state": "archived", "merged_into": c.IntoFactor}

		default:
			skip(c, note.Title, "unrecognised change type")
			continue
		}

		touched[c.FactorID] = true
		plan = append(plan, p)
	}
	return plan, skipped
}

// applyCleanup executes a plan in one transaction, writing each change's
// before-state alongside the mutation so nothing is applied without a way back.
func applyCleanup(ctx context.Context, pool *pgxpool.Pool, m *methodology.Methodology,
	workshopID, userID, stageKey, outputID string,
	proposed []proposedChange, notes []cleanupNote) (*CleanupRun, error) {

	plan, skipped := planCleanup(m, notes, proposed)

	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	skippedJSON, _ := json.Marshal(skipped)
	var runID string
	var createdAt time.Time
	if err := tx.QueryRow(ctx, `
		insert into public.board_cleanup_runs (workshop_id, stage_key, ai_output_id, created_by, skipped)
		values ($1, $2, $3, $4, $5) returning id::text, created_at`,
		workshopID, nullableString(stageKey), nullableString(outputID), userID, string(skippedJSON),
	).Scan(&runID, &createdAt); err != nil {
		return nil, err
	}

	changes := []CleanupChange{}
	for _, p := range plan {
		switch p.Type {
		case "reword":
			title, _ := p.After["title"].(string)
			desc, _ := p.After["description"].(string)
			if _, err := tx.Exec(ctx,
				`update public.factors set title = $2, description = nullif($3, '') where id = $1`,
				p.FactorID, title, desc); err != nil {
				return nil, err
			}
		case "move":
			// The activity is re-pointed too, so the note belongs to the stage
			// that captures its new category — exactly what UpdateFactor does
			// when a sticky is dragged across the board.
			if _, err := tx.Exec(ctx, `
				update public.factors
				set factor_category_id = $2,
				    activity_id = (
				      select a.id from public.activities a
				      join public.methodology_stages ms on ms.id = a.stage_id
				      where a.workshop_id = $3 and (ms.config->>'factor_category_key') = $4
				      limit 1)
				where id = $1`, p.FactorID, p.CategoryID, workshopID, p.CategoryKey); err != nil {
				return nil, err
			}
		case "merge":
			// Archived, never deleted — so undo is a state change rather than
			// a resurrection, and nobody's contribution is thrown away.
			if _, err := tx.Exec(ctx,
				`update public.factors set state = 'archived' where id = $1`, p.FactorID); err != nil {
				return nil, err
			}
		}

		beforeJSON, _ := json.Marshal(p.Before)
		afterJSON, _ := json.Marshal(p.After)
		var changeID string
		if err := tx.QueryRow(ctx, `
			insert into public.board_cleanup_changes
			  (run_id, change_type, factor_id, before_state, after_state, reason)
			values ($1, $2, $3, $4, $5, nullif($6, ''))
			returning id::text`,
			runID, p.Type, p.FactorID, string(beforeJSON), string(afterJSON), p.Reason,
		).Scan(&changeID); err != nil {
			return nil, err
		}

		ch := CleanupChange{
			ID: changeID, ChangeType: p.Type, FactorID: p.FactorID,
			Before: p.Before, After: p.After, FactorTitle: p.Title,
		}
		if p.Reason != "" {
			reason := p.Reason
			ch.Reason = &reason
		}
		changes = append(changes, ch)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	run := &CleanupRun{
		ID: runID, CreatedAt: createdAt.Format(time.RFC3339), CreatedBy: userID,
		Changes: changes, Skipped: skipped,
	}
	if stageKey != "" {
		run.StageKey = &stageKey
	}
	return run, nil
}

// ListCleanupRuns — GET /workshops/{id}/cleanup/runs
//
// Every member can read the trail. Who changed a note and why is not a
// facilitator secret — it is the transparency the feature is built around.
func ListCleanupRuns(w http.ResponseWriter, r *http.Request) {
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

	runs, err := loadCleanupRuns(ctx, pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	response.OK(w, runs)
}

// loadCleanupRuns reads a workshop's runs, newest first, each with its changes.
func loadCleanupRuns(ctx context.Context, pool *pgxpool.Pool, workshopID string) ([]CleanupRun, error) {
	rows, err := pool.Query(ctx, `
		select r.id::text, r.stage_key, r.created_at, r.created_by::text, r.undone_at, r.skipped
		from public.board_cleanup_runs r
		where r.workshop_id = $1
		order by r.created_at desc limit 20`, workshopID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	runs := []CleanupRun{}
	index := map[string]int{}
	for rows.Next() {
		var run CleanupRun
		var createdAt time.Time
		var undoneAt *time.Time
		var skippedRaw []byte
		if err := rows.Scan(&run.ID, &run.StageKey, &createdAt, &run.CreatedBy, &undoneAt, &skippedRaw); err != nil {
			return nil, err
		}
		run.CreatedAt = createdAt.Format(time.RFC3339)
		if undoneAt != nil {
			s := undoneAt.Format(time.RFC3339)
			run.UndoneAt = &s
		}
		run.Skipped = []CleanupSkip{}
		_ = json.Unmarshal(skippedRaw, &run.Skipped)
		run.Changes = []CleanupChange{}
		index[run.ID] = len(runs)
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(runs) == 0 {
		return runs, nil
	}

	ids := make([]string, 0, len(runs))
	for _, r := range runs {
		ids = append(ids, r.ID)
	}
	cRows, err := pool.Query(ctx, `
		select c.id::text, c.run_id::text, c.change_type, c.factor_id::text,
		       c.before_state, c.after_state, c.reason, c.undone_at, coalesce(f.title, '')
		from public.board_cleanup_changes c
		left join public.factors f on f.id = c.factor_id
		where c.run_id = any($1::uuid[])
		order by c.created_at`, ids)
	if err != nil {
		return nil, err
	}
	defer cRows.Close()
	for cRows.Next() {
		var c CleanupChange
		var runID string
		var beforeRaw, afterRaw []byte
		var undoneAt *time.Time
		if err := cRows.Scan(&c.ID, &runID, &c.ChangeType, &c.FactorID,
			&beforeRaw, &afterRaw, &c.Reason, &undoneAt, &c.FactorTitle); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(beforeRaw, &c.Before)
		_ = json.Unmarshal(afterRaw, &c.After)
		if undoneAt != nil {
			s := undoneAt.Format(time.RFC3339)
			c.UndoneAt = &s
		}
		if i, ok := index[runID]; ok {
			runs[i].Changes = append(runs[i].Changes, c)
		}
	}
	return runs, cRows.Err()
}

// UndoCleanupChange — POST /workshops/{id}/cleanup/changes/{changeId}/undo
func UndoCleanupChange(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	ctx := r2.Context()
	user := httpctx.UserFromContext(ctx)
	workshopID := chi.URLParam(r2, "id")
	changeID := chi.URLParam(r2, "changeId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(ctx, pool, user.ID, workshopID, cleanupRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	m, err := methodology.LoadForWorkshop(ctx, pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	undone, msg, err := undoOne(ctx, pool, m, workshopID, user.ID, changeID)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "that change is not part of this workshop")
		return
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if msg != "" {
		response.Fail(w, response.CodeInvalidStateTransition, msg)
		return
	}

	audit.Record(ctx, pool, user.ID, "board.cleanup_undone", "board_cleanup_change", changeID, "applied", "undone",
		map[string]interface{}{"workshop_id": workshopID, "undone": undone})
	response.OK(w, map[string]interface{}{"id": changeID, "undone": undone})
}

// UndoCleanupRun — POST /workshops/{id}/cleanup/runs/{runId}/undo
//
// Walks the run's changes newest first, so a note with two edits unwinds in
// the order it was built up. Anything that cannot be undone is reported by
// count rather than failing the whole request: putting nine notes back is
// better than putting none back because the tenth was approved in between.
func UndoCleanupRun(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	ctx := r2.Context()
	user := httpctx.UserFromContext(ctx)
	workshopID := chi.URLParam(r2, "id")
	runID := chi.URLParam(r2, "runId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(ctx, pool, user.ID, workshopID, cleanupRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var exists bool
	if err := pool.QueryRow(ctx,
		`select exists(select 1 from public.board_cleanup_runs where id = $1 and workshop_id = $2)`,
		runID, workshopID).Scan(&exists); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if !exists {
		response.Fail(w, response.CodeNotFound, "that cleanup run is not part of this workshop")
		return
	}

	m, err := methodology.LoadForWorkshop(ctx, pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	rows, err := pool.Query(ctx, `
		select id::text from public.board_cleanup_changes
		where run_id = $1 and undone_at is null order by created_at desc`, runID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		ids = append(ids, id)
	}
	rows.Close()

	undone := 0
	refused := []string{}
	for _, id := range ids {
		ok, msg, err := undoOne(ctx, pool, m, workshopID, user.ID, id)
		if err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		if ok {
			undone++
		} else if msg != "" {
			refused = append(refused, msg)
		}
	}

	// The run is marked undone only when nothing of it is left standing —
	// otherwise the history would claim a reversal that did not happen.
	if len(refused) == 0 {
		if _, err := pool.Exec(ctx, `
			update public.board_cleanup_runs set undone_at = now(), undone_by = $2
			where id = $1 and undone_at is null`, runID, user.ID); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
	}

	audit.Record(ctx, pool, user.ID, "board.cleanup_undone", "board_cleanup_run", runID, "applied", "undone",
		map[string]interface{}{"workshop_id": workshopID, "undone": undone, "refused": len(refused)})

	response.OK(w, map[string]interface{}{"id": runID, "undone": undone, "refused": refused})
}

// undoOne reverses a single change. It returns (false, "") for a change that
// was already undone: two facilitators clicking at once must not produce a
// 500, and an undo that has already happened is the outcome the caller wanted.
func undoOne(ctx context.Context, pool *pgxpool.Pool, m *methodology.Methodology,
	workshopID, userID, changeID string) (bool, string, error) {

	var changeType, factorID, factorState string
	var beforeRaw []byte
	var undoneAt *time.Time
	err := pool.QueryRow(ctx, `
		select c.change_type, c.factor_id::text, c.before_state, c.undone_at, f.state
		from public.board_cleanup_changes c
		join public.board_cleanup_runs r on r.id = c.run_id
		join public.factors f on f.id = c.factor_id
		where c.id = $1 and r.workshop_id = $2`, changeID, workshopID,
	).Scan(&changeType, &factorID, &beforeRaw, &undoneAt, &factorState)
	if err != nil {
		return false, "", err
	}
	if undoneAt != nil {
		return false, "", nil
	}

	// An approved note's text is text somebody approved. Undoing into it would
	// change what the approval refers to — the same refusal UpdateFactor
	// makes, for the same reason.
	if factorState == "approved" || factorState == "rejected" {
		return false, "That note has since been reviewed, so this change can no longer be undone. Edit it through the Review Board instead.", nil
	}

	var before map[string]interface{}
	_ = json.Unmarshal(beforeRaw, &before)

	switch changeType {
	case "reword":
		title, _ := before["title"].(string)
		desc, _ := before["description"].(string)
		if _, err := pool.Exec(ctx,
			`update public.factors set title = $2, description = nullif($3, '') where id = $1`,
			factorID, title, desc); err != nil {
			return false, "", err
		}
	case "move":
		key, _ := before["category_key"].(string)
		cat := m.CategoryByKey(key)
		if cat == nil {
			return false, "The category this note came from no longer exists in this methodology.", nil
		}
		if _, err := pool.Exec(ctx, `
			update public.factors
			set factor_category_id = $2,
			    activity_id = (
			      select a.id from public.activities a
			      join public.methodology_stages ms on ms.id = a.stage_id
			      where a.workshop_id = $3 and (ms.config->>'factor_category_key') = $4
			      limit 1)
			where id = $1`, factorID, cat.ID, workshopID, key); err != nil {
			return false, "", err
		}
	case "merge":
		state, _ := before["state"].(string)
		if state == "" {
			state = "submitted"
		}
		if _, err := pool.Exec(ctx,
			`update public.factors set state = $2 where id = $1`, factorID, state); err != nil {
			return false, "", err
		}
	default:
		return false, "That change cannot be undone automatically.", nil
	}

	if _, err := pool.Exec(ctx, `
		update public.board_cleanup_changes set undone_at = now(), undone_by = $2
		where id = $1 and undone_at is null`, changeID, userID); err != nil {
		return false, "", err
	}
	return true, "", nil
}
