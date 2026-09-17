// The AI Strategy Assistant (App Spec §12-13).
//
// One endpoint serves every AI function of every methodology: the prompt, its
// output schema and which stages it applies to are all rows in
// methodology_ai_prompts. Adding an AI function to a new methodology is a
// config insert.
//
// Three rules from the spec are load-bearing here and should not be relaxed:
//   * AI never approves anything. Accepted suggestions become `submitted`
//     objects that still need a human review decision (§12.19).
//   * Nothing unparseable or unvalidated is stored as a business object
//     (§12.30).
//   * The user can always continue without AI; every failure returns the same
//     message and leaves the workshop untouched (§12.22).
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/ai"
	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/objects"
	"swot-tows/pkg/response"
)

// Rate limits per App Spec §12.21, by workshop role.
var aiHourlyLimit = map[string]int{
	"facilitator":      100,
	"analyst":          100,
	"participant":      20,
	"observer":         20,
	"executive_viewer": 20,
}

const defaultAIHourlyLimit = 20

// AIFunction is one available assistant action, as offered to the UI.
type AIFunction struct {
	FunctionKey string `json:"function_key"`
	Name        string `json:"name"`
	// StageType is empty for functions available anywhere in the workshop.
	StageType string `json:"stage_type"`
}

// AIStatus tells the client whether to offer AI at all, and what it may run.
type AIStatus struct {
	Configured bool         `json:"configured"`
	Limit      int          `json:"limit_per_hour"`
	Used       int          `json:"used_this_hour"`
	Functions  []AIFunction `json:"functions"`
}

// GetAIStatus — GET /workshops/{id}/ai?stage_key=...
//
// Prompt templates are deliberately NOT included: the client gets function
// keys and display names only.
func GetAIStatus(w http.ResponseWriter, r *http.Request) {
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
	role, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID)
	if err != nil {
		writeAuthzErr(w, err)
		return
	}

	m, err := methodology.LoadForWorkshop(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	stageKey := r2.URL.Query().Get("stage_key")
	var stageType string
	if stageKey != "" {
		if s := m.StageByKey(stageKey); s != nil {
			stageType = s.StageType
		}
	}

	fns := []AIFunction{}
	for _, p := range m.AIPrompts {
		// A prompt with no stage type is available anywhere; one with a stage
		// type only on stages of that type.
		if p.StageType != "" && p.StageType != stageType {
			continue
		}
		fns = append(fns, AIFunction{FunctionKey: p.FunctionKey, Name: p.Name, StageType: p.StageType})
	}

	used, _ := aiRequestsThisHour(r2.Context(), pool, user.ID)
	response.OK(w, AIStatus{
		Configured: ai.Configured(),
		Limit:      limitForRole(role),
		Used:       used,
		Functions:  fns,
	})
}

func limitForRole(role string) int {
	if n, ok := aiHourlyLimit[role]; ok {
		return n
	}
	return defaultAIHourlyLimit
}

func aiRequestsThisHour(ctx context.Context, pool *pgxpool.Pool, userID string) (int, error) {
	var n int
	err := pool.QueryRow(ctx,
		`select count(*)::int from public.ai_sessions
		 where user_id = $1 and created_at > now() - interval '1 hour'`, userID).Scan(&n)
	return n, err
}

type executeAIBody struct {
	StageKey    string `json:"stage_key"`
	FunctionKey string `json:"function_key"`
}

// AIOutput is a stored suggestion set awaiting human review.
type AIOutput struct {
	ID             string                 `json:"id"`
	SessionID      string                 `json:"session_id"`
	OutputType     string                 `json:"output_type"`
	Content        map[string]interface{} `json:"content"`
	ReviewStatus   string                 `json:"human_review_status"`
	PromptVersion  *string                `json:"prompt_version"`
	StageKey       *string                `json:"stage_key"`
	CreatedAt      string                 `json:"created_at"`
	ConvertedType  *string                `json:"converted_object_type"`
	ConvertedID    *string                `json:"converted_object_id"`
}

// ExecuteAI — POST /workshops/{id}/ai/execute
func ExecuteAI(w http.ResponseWriter, r *http.Request) {
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
	role, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID)
	if err != nil {
		writeAuthzErr(w, err)
		return
	}

	if !ai.Configured() {
		response.Fail(w, response.CodeAIGenerationFailed,
			"The AI assistant is not configured on this server.")
		return
	}

	var body executeAIBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	// §12.21 rate limiting, counted before any provider call is made.
	used, err := aiRequestsThisHour(r2.Context(), pool, user.ID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if limit := limitForRole(role); used >= limit {
		response.Fail(w, response.CodeRateLimited, fmt.Sprintf(
			"You have used all %d AI requests available this hour. You can continue working without AI.", limit))
		return
	}

	m, err := methodology.LoadForWorkshop(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	stage := m.StageByKey(body.StageKey)

	prompt := resolvePrompt(m, body.FunctionKey, stage)
	if prompt == nil {
		response.Fail(w, response.CodeValidationError,
			"That assistant function is not available for this stage.")
		return
	}

	// Build the context from the stage's OWN declared inputs — the same
	// citation graph Phase 2 uses. Nothing here knows what SWOT is.
	promptCtx, err := buildAIContext(r2.Context(), pool, m, stage, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	var wkName, wkObjective string
	_ = pool.QueryRow(r2.Context(),
		`select name, coalesce(objective, '') from public.workshops where id = $1`, workshopID,
	).Scan(&wkName, &wkObjective)

	vars := map[string]string{
		"workshop_name":      wkName,
		"workshop_objective": wkObjective,
		"methodology_name":   m.Name,
	}
	if stage != nil {
		vars["stage_name"] = stage.Name
		if catKey, _ := stage.Config["factor_category_key"].(string); catKey != "" {
			if c := m.CategoryByKey(catKey); c != nil {
				vars["factor_category_name"] = c.Name
				vars["factor_category_guidance"] = c.GuidanceText
			}
		}
	}

	// Record the session before calling out, so a provider failure still
	// leaves an audit trail and still counts against the rate limit.
	var sessionID string
	err = pool.QueryRow(r2.Context(), `
		insert into public.ai_sessions (user_id, workshop_id, prompt_type, input_summary, status, stage_key, model)
		values ($1, $2, $3, $4, 'pending', $5, $6) returning id`,
		user.ID, workshopID, prompt.FunctionKey,
		fmt.Sprintf("%s for %s", prompt.Name, wkName), nullableString(body.StageKey), ai.Model,
	).Scan(&sessionID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	userPrompt := buildUserPrompt(prompt, vars, promptCtx)
	result, aiErr := ai.Complete(r2.Context(), ai.SystemPrompt(m.Name), userPrompt, true)
	if aiErr != nil {
		_, _ = pool.Exec(r2.Context(),
			`update public.ai_sessions set status = 'failed', error_message = $2 where id = $1`,
			sessionID, aiErr.Error())
		audit.Record(r2.Context(), pool, user.ID, "ai.failed", "ai_session", sessionID, "pending", "failed",
			map[string]interface{}{"workshop_id": workshopID, "function_key": prompt.FunctionKey})
		// §12.22: one fixed user-facing message, whatever went wrong.
		response.Fail(w, response.CodeAIGenerationFailed, ai.UserFacingFailure)
		return
	}

	// §12.30: validate before storing. An output referencing objects outside
	// this workshop, or with an out-of-range confidence, is not saved.
	if msg := validateAIOutput(r2.Context(), pool, workshopID, result.Parsed); msg != "" {
		_, _ = pool.Exec(r2.Context(),
			`update public.ai_sessions set status = 'failed', error_message = $2 where id = $1`,
			sessionID, "validation: "+msg)
		response.Fail(w, response.CodeAIGenerationFailed, ai.UserFacingFailure)
		return
	}

	contentJSON, _ := json.Marshal(result.Parsed)
	var outputID string
	err = pool.QueryRow(r2.Context(), `
		insert into public.ai_outputs (ai_session_id, output_type, content, human_review_status, prompt_version)
		values ($1, $2, $3, 'pending', $4) returning id`,
		sessionID, prompt.FunctionKey, string(contentJSON), prompt.PromptVersion,
	).Scan(&outputID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	_, _ = pool.Exec(r2.Context(), `
		update public.ai_sessions
		set status = 'completed', latency_ms = $2, input_tokens = $3, output_tokens = $4
		where id = $1`, sessionID, result.LatencyMS, result.InputTokens, result.OutputTokens)

	audit.Record(r2.Context(), pool, user.ID, "ai.executed", "ai_output", outputID, "", "pending",
		map[string]interface{}{
			"workshop_id": workshopID, "function_key": prompt.FunctionKey,
			"stage_key": body.StageKey, "latency_ms": result.LatencyMS,
		})

	response.Created(w, map[string]interface{}{
		"session_id":          sessionID,
		"output_id":           outputID,
		"output_type":         prompt.FunctionKey,
		"content":             result.Parsed,
		"human_review_status": "pending",
	})
}

// resolvePrompt picks the prompt for a function: a stage-type match wins for
// a stage, otherwise a global (no stage type) prompt.
func resolvePrompt(m *methodology.Methodology, functionKey string, stage *methodology.Stage) *methodology.AIPrompt {
	var global *methodology.AIPrompt
	for i := range m.AIPrompts {
		p := &m.AIPrompts[i]
		if p.FunctionKey != functionKey {
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

// ListAIOutputs — GET /workshops/{id}/ai/outputs?status=pending
func ListAIOutputs(w http.ResponseWriter, r *http.Request) {
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

	query := `
		select o.id, o.ai_session_id, o.output_type, o.content, o.human_review_status,
		       o.prompt_version, s.stage_key, o.created_at, o.converted_object_type, o.converted_object_id
		from public.ai_outputs o
		join public.ai_sessions s on s.id = o.ai_session_id
		where s.workshop_id = $1`
	args := []interface{}{workshopID}
	if st := r2.URL.Query().Get("status"); st != "" {
		args = append(args, st)
		query += ` and o.human_review_status = $2`
	}
	if sk := r2.URL.Query().Get("stage_key"); sk != "" {
		args = append(args, sk)
		query += fmt.Sprintf(` and s.stage_key = $%d`, len(args))
	}
	query += ` order by o.created_at desc limit 50`

	rows, err := pool.Query(r2.Context(), query, args...)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	out := []AIOutput{}
	for rows.Next() {
		var o AIOutput
		var content []byte
		var createdAt time.Time
		if err := rows.Scan(&o.ID, &o.SessionID, &o.OutputType, &content, &o.ReviewStatus,
			&o.PromptVersion, &o.StageKey, &createdAt, &o.ConvertedType, &o.ConvertedID); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		_ = json.Unmarshal(content, &o.Content)
		o.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, o)
	}
	response.OK(w, out)
}

type reviewAIBody struct {
	Action string `json:"action"` // "accept" | "reject"
	// Index of the suggestion within the output's list.
	Index int `json:"index"`
	// Optional human edits. Their presence records the decision as "edited"
	// rather than "accepted" (App Spec §12.19 distinguishes the two).
	Overrides *writeObjectBody `json:"overrides"`
	StageKey  string           `json:"stage_key"`
}

// ReviewAIOutput — POST /workshops/{id}/ai/outputs/{outputId}/review
//
// Accepting converts one suggestion into a real object through the ordinary
// creation path, so every validation a human's input gets applies. The object
// lands in `submitted`, never `approved`: a human still has to review it.
func ReviewAIOutput(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	outputID := chi.URLParam(r2, "outputId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	// Accepting an AI suggestion creates analysis content, so it needs the
	// same authority as creating it by hand.
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID, contributorRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var body reviewAIBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	var contentRaw []byte
	var outputType, status string
	var stageKey *string
	err := pool.QueryRow(r2.Context(), `
		select o.content, o.output_type, o.human_review_status, s.stage_key
		from public.ai_outputs o
		join public.ai_sessions s on s.id = o.ai_session_id
		where o.id = $1 and s.workshop_id = $2`, outputID, workshopID,
	).Scan(&contentRaw, &outputType, &status, &stageKey)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "AI output not found in this workshop")
		return
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if status != "pending" {
		response.Fail(w, response.CodeInvalidStateTransition, "This suggestion has already been reviewed.")
		return
	}

	if body.Action == "reject" {
		if _, err := pool.Exec(r2.Context(), `
			update public.ai_outputs set human_review_status = 'rejected', reviewed_by = $2, reviewed_at = now()
			where id = $1`, outputID, user.ID); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		audit.Record(r2.Context(), pool, user.ID, "ai.rejected", "ai_output", outputID, "pending", "rejected",
			map[string]interface{}{"workshop_id": workshopID})
		response.OK(w, map[string]string{"id": outputID, "human_review_status": "rejected"})
		return
	}
	if body.Action != "accept" {
		response.Fail(w, response.CodeValidationError, `action must be "accept" or "reject"`)
		return
	}

	// Which stage the suggestion belongs to decides which object kind it
	// becomes — from the registry, not from the function's name.
	effectiveStageKey := body.StageKey
	if effectiveStageKey == "" && stageKey != nil {
		effectiveStageKey = *stageKey
	}
	m, err := methodology.LoadForWorkshop(r2.Context(), pool, workshopID)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	stage := m.StageByKey(effectiveStageKey)
	if stage == nil {
		response.Fail(w, response.CodeValidationError,
			"This suggestion is not tied to a stage that produces objects.")
		return
	}

	var content map[string]interface{}
	if err := json.Unmarshal(contentRaw, &content); err != nil {
		response.Fail(w, response.CodeServerError, "stored AI output is unreadable")
		return
	}
	items := firstArray(content)
	if body.Index < 0 || body.Index >= len(items) {
		response.Fail(w, response.CodeValidationError, "That suggestion no longer exists in this output.")
		return
	}
	item, _ := items[body.Index].(map[string]interface{})
	if item == nil {
		response.Fail(w, response.CodeValidationError, "That suggestion is not in a usable shape.")
		return
	}

	// A capture stage's suggestions become factors, which have their own
	// table and handler rather than living in the object registry.
	if stage.StageType == "capture" {
		id, msg := acceptAsFactor(r2.Context(), pool, m, stage, workshopID, user.ID, item, body.Overrides, outputID)
		if msg != "" {
			response.Fail(w, response.CodeValidationError, msg)
			return
		}
		finishAIAccept(r2.Context(), w, pool, user.ID, workshopID, outputID, "factor", id, body.Overrides != nil)
		return
	}

	kind, err := objects.ByStageType(stage.StageType)
	if err != nil {
		response.Fail(w, response.CodeValidationError,
			"Suggestions for this stage cannot be converted into objects yet.")
		return
	}

	input := suggestionToObjectInput(kind, item)
	if body.Overrides != nil {
		applyOverrides(input, body.Overrides)
	}

	id, msg, err := insertObject(r2.Context(), pool, kind, workshopID, user.ID, input, "ai", &outputID)
	if msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	finishAIAccept(r2.Context(), w, pool, user.ID, workshopID, outputID, kind.Key, id, body.Overrides != nil)
}

func finishAIAccept(ctx context.Context, w http.ResponseWriter, pool *pgxpool.Pool,
	userID, workshopID, outputID, objectType, objectID string, edited bool) {

	status := "accepted"
	if edited {
		status = "edited"
	}
	if _, err := pool.Exec(ctx, `
		update public.ai_outputs
		set human_review_status = $2, reviewed_by = $3, reviewed_at = now(),
		    converted_object_type = $4, converted_object_id = $5
		where id = $1`, outputID, status, userID, objectType, objectID); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	audit.Record(ctx, pool, userID, "ai."+status, "ai_output", outputID, "pending", status,
		map[string]interface{}{
			"workshop_id": workshopID, "converted_object_type": objectType, "converted_object_id": objectID,
		})
	response.Created(w, map[string]interface{}{
		"id":                    outputID,
		"human_review_status":   status,
		"converted_object_type": objectType,
		"converted_object_id":   objectID,
		// Stated explicitly so no client mistakes acceptance for approval.
		"object_state": "submitted",
	})
}
