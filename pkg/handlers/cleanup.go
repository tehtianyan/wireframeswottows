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

// Tidying the whole wall is the facilitator's job. A participant editing
// their own note goes through PATCH /factors/{id} as before.
var cleanupRoles = []string{"facilitator"}

// cleanupSubject is a kind of thing this feature can tidy.
//
// IT STARTED AS NOTES AND NOW ALSO TIDIES ACTIONS, and generalising it was the
// right call rather than copying it: the three properties that make an AI
// EDITING human content legitimate — nothing approved, nothing destroyed,
// nothing untraceable — are enforced by this file, and a second copy would be
// a second place for one of them to lapse quietly.
//
// A CLEANABLE KIND IS A PLATFORM ADDITION, not configuration. Each one needs a
// column on `board_cleanup_changes` with its own foreign key, so the cascade
// comes from the database, and each one's safety rule has to be ARGUED rather
// than derived — what makes a note unsafe to merge away is not what makes an
// action unsafe. Two entries, and there is no mechanism for a methodology to
// add a third.
//
// Note that `factor` is NOT a key in pkg/objects: factors predate the registry
// and keep their own handlers. So the subject table lives here, where both can
// be described, rather than as another registry field that one of the two
// members could never fill in.
type cleanupSubject struct {
	// Kind is the name a changeset prompt's `applies_to` uses.
	Kind  string
	Table string
	// ChangeCol is this subject's column on board_cleanup_changes. Exactly one
	// of them is non-null on any row, which a CHECK enforces.
	ChangeCol string
	// GroupCol is the column a `move` rewrites — the category a note is in,
	// the initiative an action sits under.
	GroupCol string
	// Noun and GroupNoun are the words a refusal uses. They are generic
	// platform words, not a methodology's labels: the facilitator's screen
	// renders the methodology's own label beside them.
	Noun      string
	GroupNoun string
}

var cleanupSubjects = map[string]*cleanupSubject{
	"factor": {
		Kind: "factor", Table: "factors", ChangeCol: "factor_id",
		GroupCol: "factor_category_id", Noun: "note", GroupNoun: "category",
	},
	"recommendation": {
		Kind: "recommendation", Table: "recommendations", ChangeCol: "recommendation_id",
		GroupCol: "initiative_id", Noun: "action", GroupNoun: "initiative",
	},
}

// subjectFor resolves what a changeset prompt edits.
//
// THE PROMPT DECLARES IT, and a prompt that declares nothing is refused rather
// than assumed to mean factors. "No subject means the original one" is how the
// second subject becomes silently wrong, and it is the same shape as
// `scope='object'` with an empty `applies_to` — a configuration that looks
// complete and does nothing.
func subjectFor(p *methodology.AIPrompt) (*cleanupSubject, string) {
	for _, key := range p.AppliesTo {
		if s, ok := cleanupSubjects[key]; ok {
			return s, ""
		}
	}
	if len(p.AppliesTo) == 0 {
		return nil, "This tidy-up is not configured to say what it edits, so it cannot be run."
	}
	return nil, fmt.Sprintf("This tidy-up is configured to edit %s, which cannot be tidied automatically.",
		strings.Join(p.AppliesTo, " or "))
}

// resolveChangesetPrompt finds the tidy-up available on a stage.
//
// NOTHING NAMES A FUNCTION KEY. The capture board's prompt is `board_cleanup`
// and the matrix's is `action_cleanup`, and this file knows neither: the
// tidy-up exists wherever the methodology has a `changeset` prompt whose stage
// type matches. That is the whole opt-in, and it is why a second subject
// needed a config row rather than a Go constant.
//
// It cannot be `resolvePrompt` with a key, because the prompts table is unique
// on (methodology_id, function_key) — one methodology cannot hold two rows
// under one key, which is exactly why the second tidy-up has its own.
func resolveChangesetPrompt(m *methodology.Methodology, stage *methodology.Stage) *methodology.AIPrompt {
	var global *methodology.AIPrompt
	for i := range m.AIPrompts {
		p := &m.AIPrompts[i]
		if p.OutputKind != "changeset" {
			continue
		}
		if p.StageType == "" {
			global = p
			continue
		}
		if stage != nil && p.StageType == stage.StageType {
			return p
		}
	}
	return global
}

type CleanupChange struct {
	ID         string                 `json:"id"`
	ChangeType string                 `json:"change_type"`
	ObjectKind string                 `json:"object_kind"`
	ObjectID   string                 `json:"object_id"`
	Before     map[string]interface{} `json:"before"`
	After      map[string]interface{} `json:"after"`
	Reason     *string                `json:"reason"`
	UndoneAt   *string                `json:"undone_at"`
	// ObjectTitle is the item's current title, so the panel can name what it
	// is offering to undo without a second round trip.
	ObjectTitle string `json:"object_title"`
}

// CleanupSkip is a change the model proposed and the server refused. Kept and
// shown rather than silently dropped: "those two look like duplicates, but one
// is cited by a theme" is a thing the facilitator needs to know, and is their
// call to make by hand.
type CleanupSkip struct {
	ChangeType string `json:"change_type"`
	ObjectID   string `json:"object_id"`
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
		failDB(w, err)
		return
	}
	if limit := limitForRole(role); used >= limit {
		response.Fail(w, response.CodeRateLimited, fmt.Sprintf(
			"You have used all %d AI requests available this hour. You can continue working without AI.", limit))
		return
	}

	m, err := methodology.LoadForWorkshop(ctx, pool, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}
	stage := m.StageByKey(body.StageKey)
	prompt := resolveChangesetPrompt(m, stage)
	if prompt == nil {
		response.Fail(w, response.CodeValidationError,
			"This methodology does not offer a tidy-up on this stage.")
		return
	}
	subject, msg := subjectFor(prompt)
	if msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}

	// The board is the whole wall, not one category — a note in the wrong
	// quadrant is by definition not on the stage it belongs to, and a
	// duplicate action is most often the same work written down in two
	// quadrants. So this builds its own context rather than using
	// buildAIContext's per-stage slice.
	items, err := cleanupCandidates(ctx, pool, subject, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}
	if len(items) < 2 {
		response.Fail(w, response.CodeValidationError, fmt.Sprintf(
			"There are not enough %ss here to tidy up yet.", subject.Noun))
		return
	}

	groups, err := cleanupGroups(ctx, pool, subject, m, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}
	// The keys the model sees are the SUBJECT's words, not the methodology's:
	// each prompt template is written against its own subject and names them
	// itself, which is what keeps this handler from having to know whether a
	// group is a category or an initiative.
	promptCtx := map[string]interface{}{
		subject.Noun + "s":      items,
		subject.GroupNoun + "s": groups,
	}

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
		failDB(w, err)
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
		failDB(w, err)
		return
	}
	_, _ = pool.Exec(ctx, `
		update public.ai_sessions
		set status = 'completed', latency_ms = $2, input_tokens = $3, output_tokens = $4
		where id = $1`, sessionID, result.LatencyMS, result.InputTokens, result.OutputTokens)

	run, err := applyCleanup(ctx, pool, subject, workshopID, user.ID, body.StageKey, outputID,
		proposedChanges(result.Parsed), items, groups)
	if err != nil {
		failDB(w, err)
		return
	}

	audit.Record(ctx, pool, user.ID, "board.cleaned", "board_cleanup_run", run.ID, "", "applied",
		map[string]interface{}{
			"workshop_id": workshopID, "stage_key": body.StageKey,
			"ai_output_id": outputID, "object_kind": subject.Kind,
			"applied": len(run.Changes), "skipped": len(run.Skipped),
		})

	response.Created(w, run)
}

// cleanupItem is one note or action as offered to the model.
type cleanupItem struct {
	ID string `json:"id"`
	// GroupKey is the category a note is in, or the id of the initiative an
	// action sits under. It is what a `move` names.
	GroupKey string `json:"group_key"`
	Title    string `json:"title"`
	Desc     string `json:"description"`

	// referenced is NOT sent to the model — it is the server's own refusal
	// check, applied to whatever comes back. Telling the model "don't merge
	// this one" would be a request; refusing it here is a guarantee.
	referenced string
	state      string
}

// cleanupGroup is one thing a `move` may move between.
type cleanupGroup struct {
	// Key is what the model names in a change.
	Key  string `json:"group_key"`
	Name string `json:"name"`
	// Guidance is what belongs in this group, where the config says.
	Guidance string `json:"guidance,omitempty"`
	// id is the value written to the subject's GroupCol. For a category the
	// key is human-readable and the id is a uuid; for an initiative they are
	// the same uuid, since an initiative has no key column and its title is
	// not unique.
	id string
}

// cleanupCandidates lists what may be tidied: everything still in play.
//
// Approved and rejected items are frozen everywhere else in the system and
// stay frozen here, so they are not even offered — which is also why planning
// can treat "not in this list" as sufficient grounds to refuse a change.
func cleanupCandidates(ctx context.Context, pool *pgxpool.Pool, subject *cleanupSubject,
	workshopID string) ([]cleanupItem, error) {

	// THE SAFETY RULE IS ARGUED PER SUBJECT, which is why these two queries
	// are written out rather than generated.
	//
	// For a NOTE, "referenced" means something else already rests on it: a
	// theme cites it, a relationship pairs it, or the room has voted on it.
	// Merging it away would break a traceability chain the foreign keys exist
	// to protect.
	//
	// For an ACTION, the equivalents are: the room has RATED it (that rating
	// is the prioritisation decision the matrix was built to take, and folding
	// the action away would discard it); a report section already LISTS it, so
	// somebody has composed it into a document; or it has delivery sub-tasks
	// hanging off it. An action's evidence — the insights it cites — is what
	// IT points at, not what points at it, so it is not a reason to refuse.
	var q string
	switch subject.Kind {
	case "factor":
		q = `
		select f.id::text, mfc.key, f.title, coalesce(f.description, ''), f.state,
		       exists(select 1 from public.synthesis_factors sf where sf.factor_id = f.id)      as cited,
		       exists(select 1 from public.factor_relationships fr
		              where fr.source_factor_id = f.id or fr.target_factor_id = f.id)           as paired,
		       exists(select 1 from public.weights wt where wt.object_id = f.id)                as weighted
		from public.factors f
		join public.methodology_factor_categories mfc on mfc.id = f.factor_category_id
		where f.workshop_id = $1 and f.state in ('draft', 'submitted')
		order by f.created_at
		limit 300`
	case "recommendation":
		q = `
		select r.id::text, coalesce(r.initiative_id::text, ''), r.title,
		       coalesce(r.description, ''), r.state,
		       exists(select 1 from public.report_section_items rsi
		              where rsi.object_kind = 'recommendation' and rsi.object_id = r.id) as cited,
		       exists(select 1 from public.actions a where a.recommendation_id = r.id)    as paired,
		       exists(select 1 from public.weights wt where wt.object_id = r.id)          as weighted
		from public.recommendations r
		where r.workshop_id = $1 and r.state in ('draft', 'submitted')
		order by r.created_at
		limit 300`
	default:
		return nil, fmt.Errorf("no cleanup candidate query for %q", subject.Kind)
	}

	rows, err := pool.Query(ctx, q, workshopID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []cleanupItem{}
	for rows.Next() {
		var n cleanupItem
		var cited, paired, weighted bool
		if err := rows.Scan(&n.ID, &n.GroupKey, &n.Title, &n.Desc, &n.state, &cited, &paired, &weighted); err != nil {
			return nil, err
		}
		// Phrased WITHOUT a subject, so it reads correctly whether it is the
		// item being merged ("it " + reason) or the survivor ("the note it
		// would merge into " + reason).
		switch {
		case cited && subject.Kind == "factor":
			n.referenced = "is already cited by a theme"
		case cited:
			n.referenced = "is already listed in a report"
		case paired && subject.Kind == "factor":
			n.referenced = "is already used in a relationship"
		case paired:
			n.referenced = "already has delivery tasks against it"
		case weighted && subject.Kind == "factor":
			n.referenced = "already carries votes or scores"
		case weighted:
			n.referenced = "has already been rated by the room"
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// cleanupGroups lists where a `move` may put something.
//
// For notes these come from methodology CONFIG — the factor categories. For
// actions they are rows the room created, so they are read from the database.
// That asymmetry is real and not an inconsistency: a category exists because
// the methodology says so, an initiative because somebody typed it.
func cleanupGroups(ctx context.Context, pool *pgxpool.Pool, subject *cleanupSubject,
	m *methodology.Methodology, workshopID string) ([]cleanupGroup, error) {

	out := []cleanupGroup{}
	switch subject.Kind {
	case "factor":
		for _, c := range m.FactorCategories {
			out = append(out, cleanupGroup{
				Key: c.Key, Name: c.Name, Guidance: c.GuidanceText, id: c.ID,
			})
		}
		return out, nil
	case "recommendation":
		rows, err := pool.Query(ctx, `
			select i.id::text, i.title, coalesce(mrt.name, '')
			from public.initiatives i
			left join public.methodology_relationship_types mrt on mrt.id = i.relationship_type_id
			where i.workshop_id = $1 and i.state <> 'archived'
			order by coalesce(i.board_position, 0), i.created_at`, workshopID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var g cleanupGroup
			var typeName string
			if err := rows.Scan(&g.id, &g.Name, &typeName); err != nil {
				return nil, err
			}
			g.Key = g.id
			// The quadrant is given as guidance rather than as a separate
			// field: it is the one thing that distinguishes two initiatives
			// with the same name, and the model has to be able to tell them
			// apart to move an action to the right one.
			g.Guidance = typeName
			out = append(out, g)
		}
		return out, rows.Err()
	}
	return nil, fmt.Errorf("no cleanup group query for %q", subject.Kind)
}

// groupByKey finds a move target. Keys come from the model, so this is the
// only thing that turns one into a column value — an unknown key resolves to
// nothing and the change is refused.
func groupByKey(groups []cleanupGroup, key string) *cleanupGroup {
	for i := range groups {
		if groups[i].Key == key {
			return &groups[i]
		}
	}
	return nil
}

// proposedChange is one edit as the model described it.
//
// IT ACCEPTS TWO NAMES FOR THREE OF ITS FIELDS, and that is deliberate rather
// than sloppy. The capture board's prompt is deployed, tuned and names its
// subject directly (`factor_id`, `into_factor_id`, `category_key`); the
// action prompt uses the generic names (`object_id`, `into_object_id`,
// `group_key`). Renaming the deployed one would have been tidier and carries a
// real risk: migrations run BEFORE the code deploy, so between the two there
// would be a window where the live Go reads a field the new prompt no longer
// sends, and every move would be silently refused. Two names cost a helper
// each; the window costs a feature nobody would notice was broken.
type proposedChange struct {
	Type string `json:"type"`
	// Subject id, under either name.
	FactorID string `json:"factor_id"`
	ObjectID string `json:"object_id"`
	Title    string `json:"title"`
	// Description is a POINTER because absent and empty must mean different
	// things: a model that restates only the title is not asking for the
	// description to be erased. Treating the zero value as "clear it" silently
	// deleted a note's body whenever the rewrite touched only its title.
	Description *string `json:"description"`
	CategoryKey string  `json:"category_key"`
	GroupKey    string  `json:"group_key"`
	IntoFactor  string  `json:"into_factor_id"`
	IntoObject  string  `json:"into_object_id"`
	Reason      string  `json:"reason"`
}

func (c proposedChange) subjectID() string {
	if c.FactorID != "" {
		return c.FactorID
	}
	return c.ObjectID
}

func (c proposedChange) group() string {
	if c.CategoryKey != "" {
		return c.CategoryKey
	}
	return c.GroupKey
}

func (c proposedChange) into() string {
	if c.IntoFactor != "" {
		return c.IntoFactor
	}
	return c.IntoObject
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
	ObjectID string
	Before   map[string]interface{}
	After    map[string]interface{}
	Reason   string
	Title    string

	// Resolved during planning so execution does no lookups: the new group
	// for a move, the survivor for a merge.
	GroupID   string
	GroupKey  string
	MergeInto string
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
func planCleanup(subject *cleanupSubject, groups []cleanupGroup, items []cleanupItem,
	proposed []proposedChange) ([]plannedChange, []CleanupSkip) {

	byID := map[string]*cleanupItem{}
	for i := range items {
		byID[items[i].ID] = &items[i]
	}

	plan := []plannedChange{}
	skipped := []CleanupSkip{}
	skip := func(c proposedChange, title, why string) {
		skipped = append(skipped, CleanupSkip{
			ChangeType: c.Type, ObjectID: c.subjectID(), Title: title,
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
		id := c.subjectID()
		note := byID[id]
		if note == nil {
			// Either invented, or from another workshop, or already frozen:
			// cleanupCandidates offers only draft and submitted items, so an
			// approved one is not in this map and cannot be touched.
			skip(c, "", fmt.Sprintf("that %s is not here", subject.Noun))
			continue
		}
		if touched[id] {
			skip(c, note.Title, fmt.Sprintf("another change was already applied to this %s", subject.Noun))
			continue
		}

		p := plannedChange{
			Type: c.Type, ObjectID: id,
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
			key := strings.TrimSpace(c.group())
			group := groupByKey(groups, key)
			if group == nil {
				skip(c, note.Title, fmt.Sprintf("that is not a %s here", subject.GroupNoun))
				continue
			}
			if key == note.GroupKey {
				skip(c, note.Title, fmt.Sprintf("the %s is already in that %s", subject.Noun, subject.GroupNoun))
				continue
			}
			p.GroupID, p.GroupKey = group.id, key
			// The before-state carries the NAME as well as the key, so the
			// panel can say "Sales campaigns → Branding" rather than printing
			// two uuids. Keys alone were legible for categories and would not
			// be for anything identified by its id.
			p.Before = map[string]interface{}{
				"group_key": note.GroupKey, "group_name": groupName(groups, note.GroupKey),
			}
			p.After = map[string]interface{}{"group_key": key, "group_name": group.Name}
			// `category_key` is still written for a factor, because rows from
			// before this change carry only that and the panel reads both.
			if subject.Kind == "factor" {
				p.Before["category_key"] = note.GroupKey
				p.After["category_key"] = key
			}

		case "merge":
			into := c.into()
			if into == id {
				skip(c, note.Title, fmt.Sprintf("a %s cannot be merged into itself", subject.Noun))
				continue
			}
			target := byID[into]
			if target == nil {
				skip(c, note.Title, fmt.Sprintf("the %s it would merge into is not here", subject.Noun))
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
				skip(c, note.Title, fmt.Sprintf("the %s it would merge into %s", subject.Noun, target.referenced))
				continue
			}
			if mergedAway[into] {
				skip(c, note.Title, fmt.Sprintf(
					"the %s it would merge into is itself being merged away", subject.Noun))
				continue
			}
			if mergeTarget[id] {
				skip(c, note.Title, fmt.Sprintf(
					"another %s is already being merged into this one", subject.Noun))
				continue
			}
			mergedAway[id] = true
			mergeTarget[into] = true
			p.MergeInto = into
			p.Before = map[string]interface{}{"state": note.state}
			p.After = map[string]interface{}{"state": "archived", "merged_into": into}

		default:
			skip(c, note.Title, "unrecognised change type")
			continue
		}

		touched[id] = true
		plan = append(plan, p)
	}
	return plan, skipped
}

// resolveUndoGroup turns a stored group key back into the value the column
// holds, and refuses when the group is gone.
//
// A CATEGORY CANNOT VANISH BUT AN INITIATIVE CAN, which is why this exists at
// all: a category comes from methodology config and is still there, while the
// initiative an action was moved out of may have been deleted since. Putting
// the action back under a heading that no longer exists would violate the
// foreign key and surface as a 500; saying so is the honest answer.
func resolveUndoGroup(ctx context.Context, pool *pgxpool.Pool, subject *cleanupSubject,
	m *methodology.Methodology, workshopID, key string) (string, string) {

	if key == "" {
		return "", fmt.Sprintf("This change did not record which %s it came from.", subject.GroupNoun)
	}
	if subject.Kind == "factor" {
		cat := m.CategoryByKey(key)
		if cat == nil {
			return "", "The category this note came from no longer exists in this methodology."
		}
		return cat.ID, ""
	}
	var id string
	err := pool.QueryRow(ctx,
		`select id::text from public.initiatives where id = $1 and workshop_id = $2`,
		key, workshopID).Scan(&id)
	if err != nil {
		return "", fmt.Sprintf("The %s this %s came from has since been deleted, so it cannot be moved back.",
			subject.GroupNoun, subject.Noun)
	}
	return id, ""
}

// groupName looks up a group's display name, falling back to the key so a
// group that has since been deleted still reads as something.
func groupName(groups []cleanupGroup, key string) string {
	if g := groupByKey(groups, key); g != nil {
		return g.Name
	}
	return key
}

// applyCleanup executes a plan in one transaction, writing each change's
// before-state alongside the mutation so nothing is applied without a way back.
func applyCleanup(ctx context.Context, pool *pgxpool.Pool, subject *cleanupSubject,
	workshopID, userID, stageKey, outputID string,
	proposed []proposedChange, items []cleanupItem, groups []cleanupGroup) (*CleanupRun, error) {

	plan, skipped := planCleanup(subject, groups, items, proposed)

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
			if _, err := tx.Exec(ctx, fmt.Sprintf(
				`update public.%s set title = $2, description = nullif($3, '') where id = $1`,
				subject.Table), p.ObjectID, title, desc); err != nil {
				return nil, err
			}
		case "move":
			if _, err := tx.Exec(ctx, fmt.Sprintf(
				`update public.%s set %s = $2 where id = $1`,
				subject.Table, subject.GroupCol), p.ObjectID, p.GroupID); err != nil {
				return nil, err
			}
			// A NOTE ALSO CHANGES STAGE, which an action does not. A factor's
			// activity records which stage captured it, so moving it across
			// the board has to re-point that too — exactly what UpdateFactor
			// does when a sticky is dragged. An action has no activity: it
			// belongs to the initiative, and the initiative to the quadrant.
			if subject.Kind == "factor" {
				if _, err := tx.Exec(ctx, `
					update public.factors
					set activity_id = (
					      select a.id from public.activities a
					      join public.methodology_stages ms on ms.id = a.stage_id
					      where a.workshop_id = $2 and (ms.config->>'factor_category_key') = $3
					      limit 1)
					where id = $1`, p.ObjectID, workshopID, p.GroupKey); err != nil {
					return nil, err
				}
			}
		case "merge":
			// Archived, never deleted — so undo is a state change rather than
			// a resurrection, and nobody's contribution is thrown away.
			if _, err := tx.Exec(ctx, fmt.Sprintf(
				`update public.%s set state = 'archived' where id = $1`, subject.Table),
				p.ObjectID); err != nil {
				return nil, err
			}
		}

		beforeJSON, _ := json.Marshal(p.Before)
		afterJSON, _ := json.Marshal(p.After)
		var changeID string
		if err := tx.QueryRow(ctx, fmt.Sprintf(`
			insert into public.board_cleanup_changes
			  (run_id, change_type, %s, before_state, after_state, reason)
			values ($1, $2, $3, $4, $5, nullif($6, ''))
			returning id::text`, subject.ChangeCol),
			runID, p.Type, p.ObjectID, string(beforeJSON), string(afterJSON), p.Reason,
		).Scan(&changeID); err != nil {
			return nil, err
		}

		ch := CleanupChange{
			ID: changeID, ChangeType: p.Type,
			ObjectKind: subject.Kind, ObjectID: p.ObjectID,
			Before: p.Before, After: p.After, ObjectTitle: p.Title,
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
		failDB(w, err)
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
	// ONE QUERY OVER BOTH SUBJECTS, with the kind derived from which column is
	// set rather than stored beside them. A stored kind would be a third thing
	// that has to agree with the two columns, and the CHECK already guarantees
	// exactly one of them is non-null — so there is nothing for it to add and
	// one more way for it to disagree.
	cRows, err := pool.Query(ctx, `
		select c.id::text,
		       c.run_id::text,
		       c.change_type,
		       case when c.factor_id is not null then 'factor' else 'recommendation' end,
		       coalesce(c.factor_id::text, c.recommendation_id::text),
		       c.before_state, c.after_state, c.reason, c.undone_at,
		       coalesce(f.title, r.title, '')
		from public.board_cleanup_changes c
		left join public.factors f on f.id = c.factor_id
		left join public.recommendations r on r.id = c.recommendation_id
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
		if err := cRows.Scan(&c.ID, &runID, &c.ChangeType, &c.ObjectKind, &c.ObjectID,
			&beforeRaw, &afterRaw, &c.Reason, &undoneAt, &c.ObjectTitle); err != nil {
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
		failDB(w, err)
		return
	}

	undone, msg, err := undoOne(ctx, pool, m, workshopID, user.ID, changeID)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "that change is not part of this workshop")
		return
	}
	if err != nil {
		failDB(w, err)
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
		failDB(w, err)
		return
	}
	if !exists {
		response.Fail(w, response.CodeNotFound, "that cleanup run is not part of this workshop")
		return
	}

	m, err := methodology.LoadForWorkshop(ctx, pool, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}

	rows, err := pool.Query(ctx, `
		select id::text from public.board_cleanup_changes
		where run_id = $1 and undone_at is null order by created_at desc`, runID)
	if err != nil {
		failDB(w, err)
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			failDB(w, err)
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
			failDB(w, err)
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
			failDB(w, err)
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

	var changeType, kindKey, objectID, objectState string
	var beforeRaw []byte
	var undoneAt *time.Time
	// The row says which subject it touched, so the undo does not need to be
	// told — a run can in principle mix them, and this way nothing has to
	// guarantee that it does not.
	err := pool.QueryRow(ctx, `
		select c.change_type,
		       case when c.factor_id is not null then 'factor' else 'recommendation' end,
		       coalesce(c.factor_id::text, c.recommendation_id::text),
		       c.before_state, c.undone_at,
		       coalesce(f.state, r.state)
		from public.board_cleanup_changes c
		join public.board_cleanup_runs rn on rn.id = c.run_id
		left join public.factors f on f.id = c.factor_id
		left join public.recommendations r on r.id = c.recommendation_id
		where c.id = $1 and rn.workshop_id = $2`, changeID, workshopID,
	).Scan(&changeType, &kindKey, &objectID, &beforeRaw, &undoneAt, &objectState)
	if err != nil {
		return false, "", err
	}
	if undoneAt != nil {
		return false, "", nil
	}
	subject := cleanupSubjects[kindKey]
	if subject == nil {
		return false, "That change was made to something this version cannot undo.", nil
	}

	// An approved item's text is text somebody approved. Undoing into it would
	// change what the approval refers to — the same refusal UpdateFactor
	// makes, for the same reason.
	if objectState == "approved" || objectState == "rejected" {
		return false, fmt.Sprintf(
			"That %s has since been reviewed, so this change can no longer be undone. Edit it through the Review Board instead.",
			subject.Noun), nil
	}

	var before map[string]interface{}
	_ = json.Unmarshal(beforeRaw, &before)

	switch changeType {
	case "reword":
		title, _ := before["title"].(string)
		desc, _ := before["description"].(string)
		if _, err := pool.Exec(ctx, fmt.Sprintf(
			`update public.%s set title = $2, description = nullif($3, '') where id = $1`,
			subject.Table), objectID, title, desc); err != nil {
			return false, "", err
		}
	case "move":
		// `group_key` is what this writes now; `category_key` is what rows
		// written before the second subject existed carry. Reading both is
		// what lets an old run still be undone.
		key, _ := before["group_key"].(string)
		if key == "" {
			key, _ = before["category_key"].(string)
		}
		groupID, msg := resolveUndoGroup(ctx, pool, subject, m, workshopID, key)
		if msg != "" {
			return false, msg, nil
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf(
			`update public.%s set %s = $2 where id = $1`, subject.Table, subject.GroupCol),
			objectID, groupID); err != nil {
			return false, "", err
		}
		if subject.Kind == "factor" {
			if _, err := pool.Exec(ctx, `
				update public.factors
				set activity_id = (
				      select a.id from public.activities a
				      join public.methodology_stages ms on ms.id = a.stage_id
				      where a.workshop_id = $2 and (ms.config->>'factor_category_key') = $3
				      limit 1)
				where id = $1`, objectID, workshopID, key); err != nil {
				return false, "", err
			}
		}
	case "merge":
		state, _ := before["state"].(string)
		if state == "" {
			state = "submitted"
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf(
			`update public.%s set state = $2 where id = $1`, subject.Table),
			objectID, state); err != nil {
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
