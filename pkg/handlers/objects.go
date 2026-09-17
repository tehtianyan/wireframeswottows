// Generic handlers for every reviewable object kind — syntheses (themes),
// factor relationships (the TOWS matrix), insights and recommendations.
//
// One implementation serves all four, driven by pkg/objects. Adding a fifth
// kind is a registry entry, and a methodology that wants a synthesize stage
// gets these endpoints without any code.
//
// SQL here is assembled from identifiers in the registry, never from request
// input. The only values that reach the database do so as bound parameters.
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

	"swot-tows/pkg/audit"
	"swot-tows/pkg/auth"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/objects"
	"swot-tows/pkg/response"
)

// Object is the wire shape shared by every kind. Kind-specific columns live
// under Fields so one struct serves all four.
type Object struct {
	ID              string                 `json:"id"`
	WorkshopID      string                 `json:"workshop_id"`
	Kind            string                 `json:"kind"`
	Title           *string                `json:"title"`
	Description     *string                `json:"description"`
	State           string                 `json:"state"`
	GeneratedBy     string                 `json:"generated_by"`
	ConfidenceScore *float64               `json:"confidence_score"`
	CreatedBy       *string                `json:"created_by"`
	ReviewedBy      *string                `json:"reviewed_by"`
	ReviewedAt      *string                `json:"reviewed_at"`
	ReviewNote      *string                `json:"review_note"`
	CreatedAt       string                 `json:"created_at"`
	Fields          map[string]interface{} `json:"fields"`
	// Evidence maps a cited kind to the ids this object cites.
	Evidence map[string][]string `json:"evidence"`
	// Set only for kinds with a Pairing (the relationship matrix).
	SourceID           *string `json:"source_id,omitempty"`
	TargetID           *string `json:"target_id,omitempty"`
	RelationshipTypeID *string `json:"relationship_type_id,omitempty"`
}

// pairingColumns returns the extra columns a paired kind selects, in order.
func pairingColumns(kind *objects.Kind) []string {
	if kind.Pairing == nil {
		return nil
	}
	return []string{kind.Pairing.SourceCol, kind.Pairing.TargetCol, kind.Pairing.TypeCol}
}

// ListObjectKinds — GET /object-kinds. The catalogue the UI builds its forms
// from, so no screen hardcodes what a recommendation's fields are.
func ListObjectKinds(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	_ = r2
	response.OK(w, objects.All())
}

// kindFromRoute resolves the {kind} URL segment to a registry entry.
func kindFromRoute(w http.ResponseWriter, r *http.Request) (*objects.Kind, bool) {
	k, err := objects.ByRoute(chi.URLParam(r, "kind"))
	if err != nil {
		response.Fail(w, response.CodeNotFound, err.Error())
		return nil, false
	}
	return k, true
}

// sharedColumns returns the columns present on every reviewable object table
// for this kind. `description` is not universal — factor_relationships uses
// `narrative` instead — so it is included only where the column exists.
func sharedColumns(kind *objects.Kind) []string {
	cols := []string{"id", "workshop_id", "title"}
	if kind.HasDescription {
		cols = append(cols, "description")
	}
	return append(cols, "state", "generated_by", "confidence_score",
		"created_by", "reviewed_by", "reviewed_at", "review_note", "created_at")
}

// ListObjects — GET /workshops/{id}/{kind}?state=submitted
func ListObjects(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	kind, ok := kindFromRoute(w, r2)
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

	cols := append(sharedColumns(kind), kind.FieldNames()...)
	cols = append(cols, pairingColumns(kind)...)
	query := fmt.Sprintf(`select %s from public.%s where workshop_id = $1`,
		strings.Join(cols, ", "), kind.Table)
	args := []interface{}{workshopID}
	if state := r2.URL.Query().Get("state"); state != "" {
		args = append(args, state)
		query += ` and state = $2`
	}
	query += ` order by created_at desc`

	rows, err := pool.Query(r2.Context(), query, args...)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	out := []Object{}
	ids := []string{}
	for rows.Next() {
		obj, err := scanObject(rows, kind)
		if err != nil {
			rows.Close()
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		out = append(out, *obj)
		ids = append(ids, obj.ID)
	}
	rows.Close()

	if err := attachEvidence(r2.Context(), pool, kind, out, ids); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	response.OK(w, out)
}

func scanObject(rows pgx.Rows, kind *objects.Kind) (*Object, error) {
	var o Object
	var createdAt time.Time
	var reviewedAt *time.Time
	fieldVals := make([]interface{}, len(kind.Fields))

	dest := []interface{}{&o.ID, &o.WorkshopID, &o.Title}
	if kind.HasDescription {
		dest = append(dest, &o.Description)
	}
	dest = append(dest, &o.State, &o.GeneratedBy, &o.ConfidenceScore,
		&o.CreatedBy, &o.ReviewedBy, &reviewedAt, &o.ReviewNote, &createdAt)
	for i := range kind.Fields {
		dest = append(dest, &fieldVals[i])
	}
	if kind.Pairing != nil {
		dest = append(dest, &o.SourceID, &o.TargetID, &o.RelationshipTypeID)
	}
	if err := rows.Scan(dest...); err != nil {
		return nil, err
	}

	o.Kind = kind.Key
	o.CreatedAt = createdAt.Format(time.RFC3339)
	if reviewedAt != nil {
		s := reviewedAt.Format(time.RFC3339)
		o.ReviewedAt = &s
	}
	o.Fields = map[string]interface{}{}
	for i, f := range kind.Fields {
		o.Fields[f.Name] = fieldVals[i]
	}
	o.Evidence = map[string][]string{}
	for _, e := range kind.Evidence {
		o.Evidence[e.CitesKind] = []string{}
	}
	return &o, nil
}

// attachEvidence fills in each object's cited ids with one query per link
// table rather than one per object.
func attachEvidence(ctx context.Context, pool *pgxpool.Pool, kind *objects.Kind, out []Object, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	byID := map[string]*Object{}
	for i := range out {
		byID[out[i].ID] = &out[i]
	}
	for _, link := range kind.Evidence {
		q := fmt.Sprintf(`select %s, %s from public.%s where %s = any($1)`,
			link.SelfCol, link.OtherCol, link.Table, link.SelfCol)
		rows, err := pool.Query(ctx, q, ids)
		if err != nil {
			return err
		}
		for rows.Next() {
			var self, other string
			if err := rows.Scan(&self, &other); err != nil {
				rows.Close()
				return err
			}
			if o := byID[self]; o != nil {
				o.Evidence[link.CitesKind] = append(o.Evidence[link.CitesKind], other)
			}
		}
		rows.Close()
	}
	return nil
}

type writeObjectBody struct {
	Title       *string                `json:"title"`
	Description *string                `json:"description"`
	Fields      map[string]interface{} `json:"fields"`
	// Evidence replaces the object's citations wholesale when present.
	Evidence map[string][]string `json:"evidence"`
	// Paired kinds only.
	SourceID             *string `json:"source_id"`
	TargetID             *string `json:"target_id"`
	RelationshipTypeKey  *string `json:"relationship_type_key"`
}

// CreateObject — POST /workshops/{id}/{kind}
func CreateObject(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	kind, ok := kindFromRoute(w, r2)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID, contributorRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var body writeObjectBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	id, msg, err := insertObject(r2.Context(), pool, kind, workshopID, user.ID, &body, "human", nil)
	if msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(r2.Context(), pool, user.ID, kind.Key+".created", kind.Key, id, "", "submitted",
		map[string]interface{}{"workshop_id": workshopID})
	response.Created(w, map[string]string{"id": id})
}

// insertObject is the single path by which any analysis object is created.
//
// AI-accepted suggestions go through here too, with generatedBy "ai", so an
// AI suggestion cannot bypass the validation a human's input gets: the same
// pairing rules, the same evidence-belongs-to-this-workshop check, the same
// "submitted" starting state. App Spec §12.19 — AI output is never final and
// never self-approving.
//
// Returns (id, userFacingValidationMessage, internalError).
func insertObject(ctx context.Context, pool *pgxpool.Pool, kind *objects.Kind,
	workshopID, userID string, body *writeObjectBody, generatedBy string, sourceAIOutputID *string,
) (string, string, error) {

	title := trimPtr(body.Title)
	if kind.TitleRequired && (title == nil || *title == "") {
		return "", "Title is required.", nil
	}
	if title != nil && len([]rune(*title)) > 200 {
		return "", "Title must be 200 characters or fewer.", nil
	}

	fieldVals, msg := coerceFields(kind, body.Fields)
	if msg != "" {
		return "", msg, nil
	}
	if msg := validateEvidence(kind, body.Evidence); msg != "" {
		return "", msg, nil
	}

	cols := []string{"workshop_id", "title", "created_by", "state", "generated_by"}
	args := []interface{}{workshopID, title, userID, "submitted", generatedBy}
	if kind.HasDescription {
		cols = append(cols, "description")
		args = append(args, trimPtr(body.Description))
	}
	if sourceAIOutputID != nil {
		cols = append(cols, "source_ai_output_id")
		args = append(args, *sourceAIOutputID)
	}
	for _, f := range kind.Fields {
		if v, present := fieldVals[f.Name]; present {
			cols = append(cols, f.Name)
			args = append(args, v)
		}
	}

	if kind.Pairing != nil {
		srcID, tgtID, typeID, msg := resolvePairing(ctx, pool, kind, workshopID, body)
		if msg != "" {
			return "", msg, nil
		}
		cols = append(cols, kind.Pairing.SourceCol, kind.Pairing.TargetCol, kind.Pairing.TypeCol)
		args = append(args, srcID, tgtID, typeID)
	}

	placeholders := make([]string, len(args))
	for i := range args {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}

	var id string
	err := pool.QueryRow(ctx, fmt.Sprintf(
		`insert into public.%s (%s) values (%s) returning id`,
		kind.Table, strings.Join(cols, ", "), strings.Join(placeholders, ", ")),
		args...).Scan(&id)
	if err != nil {
		return "", "", err
	}

	if err := replaceEvidence(ctx, pool, kind, id, workshopID, body.Evidence); err != nil {
		return "", err.Error(), nil
	}
	return id, "", nil
}

// UpdateObject — PATCH /workshops/{id}/{kind}/{objectId}
func UpdateObject(w http.ResponseWriter, r *http.Request) {
	ctx, pool, kind, user, row, ok := loadObjectForWrite(w, r)
	if !ok {
		return
	}
	if row.state == "approved" || row.state == "rejected" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"This "+strings.ToLower(kind.Label)+" has already been reviewed and can no longer be edited.")
		return
	}

	var body writeObjectBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	sets := []string{}
	args := []interface{}{}
	add := func(col string, v interface{}) {
		args = append(args, v)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if body.Title != nil {
		t := trimPtr(body.Title)
		if kind.TitleRequired && (t == nil || *t == "") {
			response.Fail(w, response.CodeValidationError, "Title is required.")
			return
		}
		add("title", t)
	}
	if body.Description != nil && kind.HasDescription {
		add("description", trimPtr(body.Description))
	}
	fieldVals, msg := coerceFields(kind, body.Fields)
	if msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}
	for _, f := range kind.Fields {
		if v, present := fieldVals[f.Name]; present {
			add(f.Name, v)
		}
	}

	if len(sets) > 0 {
		args = append(args, row.id)
		if _, err := pool.Exec(ctx, fmt.Sprintf(`update public.%s set %s where id = $%d`,
			kind.Table, strings.Join(sets, ", "), len(args)), args...); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
	}

	if body.Evidence != nil {
		if msg := validateEvidence(kind, body.Evidence); msg != "" {
			response.Fail(w, response.CodeValidationError, msg)
			return
		}
		if err := replaceEvidence(ctx, pool, kind, row.id, row.workshopID, body.Evidence); err != nil {
			response.Fail(w, response.CodeValidationError, err.Error())
			return
		}
	}

	audit.Record(ctx, pool, user.ID, kind.Key+".updated", kind.Key, row.id, row.state, row.state,
		map[string]interface{}{"workshop_id": row.workshopID})
	response.OK(w, map[string]string{"id": row.id})
}

// DeleteObject — DELETE /workshops/{id}/{kind}/{objectId}
func DeleteObject(w http.ResponseWriter, r *http.Request) {
	ctx, pool, kind, user, row, ok := loadObjectForWrite(w, r)
	if !ok {
		return
	}
	if row.state == "approved" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"Approved items cannot be deleted — reject it instead so the decision stays on the record.")
		return
	}
	if _, err := pool.Exec(ctx, fmt.Sprintf(`delete from public.%s where id = $1`, kind.Table), row.id); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	audit.Record(ctx, pool, user.ID, kind.Key+".deleted", kind.Key, row.id, row.state, "deleted",
		map[string]interface{}{"workshop_id": row.workshopID})
	response.OK(w, map[string]string{"id": row.id})
}

// ReviewObject — POST /workshops/{id}/{kind}/{objectId}/review
//
// The same decision point as ReviewFactor, for every other kind. Reviewers
// only, rejection needs a reason, and the decision is always attributed.
func ReviewObject(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	kind, ok := kindFromRoute(w, r2)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	workshopID := chi.URLParam(r2, "id")
	objectID := chi.URLParam(r2, "objectId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID, reviewerRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var body reviewFactorBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	var newState string
	switch body.Action {
	case "approve":
		newState = "approved"
	case "reject":
		newState = "rejected"
	default:
		response.Fail(w, response.CodeValidationError, `action must be "approve" or "reject"`)
		return
	}

	var currentState string
	err := pool.QueryRow(r2.Context(), fmt.Sprintf(
		`select state from public.%s where id = $1 and workshop_id = $2`, kind.Table),
		objectID, workshopID).Scan(&currentState)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "not found in this workshop")
		return
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	if currentState == "draft" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"This item is still a draft and has not been submitted for review.")
		return
	}

	note := trimPtr(body.Note)
	if newState == "rejected" && note == nil {
		response.Fail(w, response.CodeValidationError, "A reason is required when rejecting.")
		return
	}

	if _, err := pool.Exec(r2.Context(), fmt.Sprintf(
		`update public.%s set state = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 where id = $1`,
		kind.Table), objectID, newState, user.ID, note); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(r2.Context(), pool, user.ID, kind.Key+"."+body.Action+"d", kind.Key, objectID,
		currentState, newState, map[string]interface{}{"workshop_id": workshopID})
	response.OK(w, map[string]string{"id": objectID, "state": newState})
}

// ---- helpers ----

// contributorRoles may create and edit analysis objects. Unlike factor
// capture, synthesis and interpretation are analytical work: participants
// contribute factors, but shaping them into themes and insights is the
// facilitator's and analyst's job (App Spec §3.17).
var contributorRoles = []string{"facilitator", "analyst"}

type objectRow struct {
	id         string
	workshopID string
	state      string
	createdBy  *string
}

func loadObjectForWrite(w http.ResponseWriter, r *http.Request) (
	context.Context, *pgxpool.Pool, *objects.Kind, *auth.User, objectRow, bool,
) {
	var empty objectRow
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return nil, nil, nil, nil, empty, false
	}
	kind, ok := kindFromRoute(w, r2)
	if !ok {
		return nil, nil, nil, nil, empty, false
	}
	ctx := r2.Context()
	user := httpctx.UserFromContext(ctx)
	workshopID := chi.URLParam(r2, "id")
	objectID := chi.URLParam(r2, "objectId")

	pool := mustPool(r2, w)
	if pool == nil {
		return nil, nil, nil, nil, empty, false
	}
	if _, err := authz.RequireWorkshopRole(ctx, pool, user.ID, workshopID, contributorRoles...); err != nil {
		writeAuthzErr(w, err)
		return nil, nil, nil, nil, empty, false
	}

	var row objectRow
	err := pool.QueryRow(ctx, fmt.Sprintf(
		`select id, workshop_id, state, created_by from public.%s where id = $1 and workshop_id = $2`,
		kind.Table), objectID, workshopID,
	).Scan(&row.id, &row.workshopID, &row.state, &row.createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "not found in this workshop")
		return nil, nil, nil, nil, empty, false
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return nil, nil, nil, nil, empty, false
	}
	return ctx, pool, kind, user, row, true
}

// resolvePairing validates a paired kind's endpoints and relationship type.
//
// The category rule is the interesting part and it is entirely config-driven:
// methodology_relationship_types says an "so" relationship runs from a
// strength to an opportunity, so pairing a weakness into an SO cell is
// refused without this file knowing what SO, strength or opportunity mean. A
// methodology with different pairings gets its own rules for free.
func resolvePairing(ctx context.Context, pool *pgxpool.Pool, kind *objects.Kind,
	workshopID string, body *writeObjectBody) (src, tgt, typeID string, msg string) {

	if body.SourceID == nil || body.TargetID == nil || body.RelationshipTypeKey == nil {
		return "", "", "", "source_id, target_id and relationship_type_key are all required."
	}
	if *body.SourceID == *body.TargetID {
		return "", "", "", "A relationship must join two different factors."
	}

	var srcCat, tgtCat string
	for _, p := range []struct {
		id  string
		cat *string
	}{{*body.SourceID, &srcCat}, {*body.TargetID, &tgtCat}} {
		err := pool.QueryRow(ctx, fmt.Sprintf(
			`select factor_category_id::text from public.%s where id = $1 and workshop_id = $2`,
			kind.Pairing.PairsTable), p.id, workshopID).Scan(p.cat)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", "", "Both factors must belong to this workshop."
		}
		if err != nil {
			return "", "", "", err.Error()
		}
	}

	var wantSrc, wantTgt, typeName string
	err := pool.QueryRow(ctx, `
		select mrt.id::text, coalesce(mrt.source_category_id::text,''), coalesce(mrt.target_category_id::text,''), mrt.name
		from public.methodology_relationship_types mrt
		join public.workshops w on w.methodology_id = mrt.methodology_id
		where w.id = $1 and mrt.key = $2`, workshopID, *body.RelationshipTypeKey,
	).Scan(&typeID, &wantSrc, &wantTgt, &typeName)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", "Unknown relationship type for this workshop's methodology."
	}
	if err != nil {
		return "", "", "", err.Error()
	}

	if wantSrc != "" && srcCat != wantSrc {
		return "", "", "", fmt.Sprintf("The source factor's category is not valid for %s.", typeName)
	}
	if wantTgt != "" && tgtCat != wantTgt {
		return "", "", "", fmt.Sprintf("The target factor's category is not valid for %s.", typeName)
	}
	return *body.SourceID, *body.TargetID, typeID, ""
}

func trimPtr(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

// coerceFields validates the kind-specific fields and returns only those the
// caller actually supplied, so PATCH can distinguish "unset" from "cleared".
func coerceFields(kind *objects.Kind, in map[string]interface{}) (map[string]interface{}, string) {
	out := map[string]interface{}{}
	if in == nil {
		return out, ""
	}
	for name, raw := range in {
		f := kind.Field(name)
		if f == nil {
			return nil, fmt.Sprintf("unknown field %q for %s", name, kind.Label)
		}
		if raw == nil {
			out[name] = nil
			continue
		}
		switch f.Type {
		case "int":
			n, ok := raw.(float64)
			if !ok {
				return nil, fmt.Sprintf("%s must be a number", f.Label)
			}
			out[name] = int(n)
		case "enum":
			s, ok := raw.(string)
			if !ok {
				return nil, fmt.Sprintf("%s must be text", f.Label)
			}
			valid := false
			for _, o := range f.Options {
				if o == s {
					valid = true
					break
				}
			}
			if !valid {
				return nil, fmt.Sprintf("%s must be one of: %s", f.Label, strings.Join(f.Options, ", "))
			}
			out[name] = s
		default:
			s, ok := raw.(string)
			if !ok {
				return nil, fmt.Sprintf("%s must be text", f.Label)
			}
			t := strings.TrimSpace(s)
			if t == "" {
				out[name] = nil
			} else {
				out[name] = t
			}
		}
	}
	return out, ""
}

func validateEvidence(kind *objects.Kind, evidence map[string][]string) string {
	for citesKind := range evidence {
		if kind.EvidenceFor(citesKind) == nil {
			return fmt.Sprintf("a %s cannot cite %s", strings.ToLower(kind.Label), citesKind)
		}
	}
	return ""
}

// replaceEvidence rewrites this object's citations. Cited ids are checked to
// belong to the same workshop — traceability that pointed at another
// workshop's evidence would be worse than none.
func replaceEvidence(ctx context.Context, pool *pgxpool.Pool, kind *objects.Kind,
	objectID, workshopID string, evidence map[string][]string) error {
	if evidence == nil {
		return nil
	}
	for citesKind, ids := range evidence {
		link := kind.EvidenceFor(citesKind)
		if link == nil {
			return fmt.Errorf("a %s cannot cite %s", strings.ToLower(kind.Label), citesKind)
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf(`delete from public.%s where %s = $1`,
			link.Table, link.SelfCol), objectID); err != nil {
			return err
		}
		for _, id := range ids {
			var belongs bool
			if err := pool.QueryRow(ctx, fmt.Sprintf(
				`select exists(select 1 from public.%s where id = $1 and workshop_id = $2)`,
				link.OtherTable), id, workshopID).Scan(&belongs); err != nil {
				return err
			}
			if !belongs {
				return fmt.Errorf("cited %s does not belong to this workshop", citesKind)
			}
			if _, err := pool.Exec(ctx, fmt.Sprintf(
				`insert into public.%s (%s, %s) values ($1, $2) on conflict do nothing`,
				link.Table, link.SelfCol, link.OtherCol), objectID, id); err != nil {
				return err
			}
		}
	}
	return nil
}
