// The Knowledge Workspace (App Spec §2.12, §6.15, §8.31, §11.26).
//
// Organizational memory: search across every workshop the caller can see,
// follow an object's evidence chain, and deliberately promote the small
// number of outputs worth keeping.
//
// Everything is addressed through the object registry, so a sixth object kind
// becomes searchable, traceable and promotable without touching this file.
//
// The security rule that matters here (§12.24): a caller may only ever see
// objects in workspaces they belong to. Every query below is scoped by
// workspace membership, not filtered afterwards.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/objects"
	"swot-tows/pkg/response"
)

// Curators promote workshop output into organizational knowledge.
//
// App Spec §3.23's permission table gives Curate to the Analyst and NOT to
// the Facilitator. That looks surprising, but it is deliberate and matches
// §3.9's dedicated "Knowledge Analyst" role: curation is a separate
// discipline from running a workshop, and the person who ran it is not
// automatically the person who decides it is worth remembering. Followed as
// written rather than quietly widened.
var curatorRoles = []string{"analyst"}

// searchable is the set of kinds knowledge search covers, with the columns
// that carry their text. Reports are included per §6.15's search categories
// even though they are not an object-registry kind.
type searchableKind struct {
	Kind       string
	Table      string
	TitleCol   string
	BodyCol    string
	HasState   bool
}

func searchableKinds() []searchableKind {
	out := []searchableKind{
		{"factor", "factors", "title", "description", true},
	}
	for _, k := range objects.All() {
		body := "description"
		if !k.HasDescription {
			body = "narrative"
		}
		out = append(out, searchableKind{k.Key, k.Table, "title", body, true})
	}
	out = append(out, searchableKind{"report", "reports", "title", "", true})
	return out
}

type KnowledgeHit struct {
	ObjectKind   string  `json:"object_kind"`
	ObjectID     string  `json:"object_id"`
	Title        string  `json:"title"`
	Snippet      string  `json:"snippet"`
	State        string  `json:"state"`
	WorkshopID   string  `json:"workshop_id"`
	WorkshopName string  `json:"workshop_name"`
	CreatedAt    string  `json:"created_at"`
	Promoted     bool    `json:"promoted"`
	KnowledgeID  *string `json:"knowledge_id"`
}

// SearchKnowledge — GET /knowledge/search?q=&object_type=&workshop_id=&date_from=&date_to=
func SearchKnowledge(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	q := strings.TrimSpace(r2.URL.Query().Get("q"))
	kindFilter := r2.URL.Query().Get("object_type")
	workshopFilter := r2.URL.Query().Get("workshop_id")
	dateFrom := r2.URL.Query().Get("date_from")
	dateTo := r2.URL.Query().Get("date_to")
	promotedOnly := r2.URL.Query().Get("promoted") == "true"

	hits := []KnowledgeHit{}
	for _, k := range searchableKinds() {
		if kindFilter != "" && kindFilter != k.Kind {
			continue
		}

		body := "''"
		if k.BodyCol != "" {
			body = fmt.Sprintf("coalesce(o.%s, '')", k.BodyCol)
		}

		// Scoped by workspace membership in the JOIN, so an object the caller
		// cannot see never enters the result set to begin with.
		query := fmt.Sprintf(`
			select o.id::text, coalesce(o.%s, ''), %s, o.state, o.workshop_id::text, w.name, o.created_at,
			       ka.id::text
			from public.%s o
			join public.workshops w on w.id = o.workshop_id
			join public.workspace_members wsm
			     on wsm.workspace_id = w.workspace_id and wsm.user_id = $1
			left join public.knowledge_assets ka
			     on ka.object_kind = $2 and ka.object_id = o.id
			where true`, k.TitleCol, body, k.Table)

		args := []interface{}{user.ID, k.Kind}

		if q != "" {
			args = append(args, q)
			query += fmt.Sprintf(`
				and to_tsvector('english', coalesce(o.%s,'') || ' ' || %s)
				    @@ plainto_tsquery('english', $%d)`, k.TitleCol, body, len(args))
		}
		if workshopFilter != "" {
			args = append(args, workshopFilter)
			query += fmt.Sprintf(` and o.workshop_id = $%d`, len(args))
		}
		if dateFrom != "" {
			args = append(args, dateFrom)
			query += fmt.Sprintf(` and o.created_at >= $%d::timestamptz`, len(args))
		}
		if dateTo != "" {
			args = append(args, dateTo)
			query += fmt.Sprintf(` and o.created_at <= $%d::timestamptz`, len(args))
		}
		if promotedOnly {
			query += ` and ka.id is not null`
		}
		query += ` order by o.created_at desc limit 25`

		rows, err := pool.Query(r2.Context(), query, args...)
		if err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		for rows.Next() {
			var h KnowledgeHit
			var createdAt time.Time
			if err := rows.Scan(&h.ObjectID, &h.Title, &h.Snippet, &h.State,
				&h.WorkshopID, &h.WorkshopName, &createdAt, &h.KnowledgeID); err != nil {
				rows.Close()
				response.Fail(w, response.CodeServerError, err.Error())
				return
			}
			h.ObjectKind = k.Kind
			h.CreatedAt = createdAt.Format(time.RFC3339)
			h.Promoted = h.KnowledgeID != nil
			if len(h.Snippet) > 220 {
				h.Snippet = h.Snippet[:220] + "…"
			}
			hits = append(hits, h)
		}
		rows.Close()
	}

	response.OK(w, hits)
}

type TraceNode struct {
	ObjectKind string `json:"object_kind"`
	ObjectID   string `json:"object_id"`
	Title      string `json:"title"`
	State      string `json:"state"`
}

type TraceResult struct {
	Root TraceNode              `json:"root"`
	// Levels maps a cited kind to the objects at that level, walked through
	// the registry's own evidence links.
	Levels map[string][]TraceNode `json:"levels"`
}

// TraceKnowledge — GET /knowledge/trace?object_type=&object_id=
//
// App Spec §11.26 draws this as recommendation → insight → theme → artifact,
// but the shape comes from the registry's Evidence links, not from that list,
// so a methodology whose insights cite something else traces correctly too.
func TraceKnowledge(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	kindKey := r2.URL.Query().Get("object_type")
	objectID := r2.URL.Query().Get("object_id")
	if kindKey == "" || objectID == "" {
		response.Fail(w, response.CodeValidationError, "object_type and object_id are required")
		return
	}

	workshopID, title, state, errMsg := loadTraceRoot(r2.Context(), pool, kindKey, objectID)
	if errMsg != "" {
		response.Fail(w, response.CodeNotFound, errMsg)
		return
	}
	// Reuses the ordinary workshop membership check, so knowledge tracing
	// cannot be used to read across a boundary the rest of the app enforces.
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID); err != nil {
		writeAuthzErr(w, err)
		return
	}

	out := TraceResult{
		Root:   TraceNode{ObjectKind: kindKey, ObjectID: objectID, Title: title, State: state},
		Levels: map[string][]TraceNode{},
	}

	kind, err := objects.ByKey(kindKey)
	if err == nil {
		supports := map[string][]SectionItem{}
		if err := expandEvidence(r2.Context(), pool, workshopID, kind, objectID, supports, 0); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		for citeKind, items := range supports {
			nodes := []TraceNode{}
			for _, it := range items {
				nodes = append(nodes, TraceNode{
					ObjectKind: citeKind, ObjectID: it.ID, Title: it.Title, State: it.State,
				})
			}
			out.Levels[citeKind] = nodes
		}
	}

	response.OK(w, out)
}

func loadTraceRoot(ctx context.Context, pool *pgxpool.Pool, kindKey, objectID string) (
	workshopID, title, state, errMsg string,
) {
	table, _ := tableForKind(kindKey)
	if table == "" {
		if kindKey == "report" {
			table = "reports"
		} else {
			return "", "", "", "unknown object type"
		}
	}
	err := pool.QueryRow(ctx, fmt.Sprintf(
		`select workshop_id::text, coalesce(title, ''), state from public.%s where id = $1`, table),
		objectID).Scan(&workshopID, &title, &state)
	if err != nil {
		return "", "", "", "object not found"
	}
	return workshopID, title, state, ""
}

// RelatedKnowledge — GET /knowledge/related?object_type=&object_id=
//
// "Related" means sharing evidence: two insights that cite the same theme are
// related, which is a structural claim rather than a guess at similarity.
func RelatedKnowledge(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	kindKey := r2.URL.Query().Get("object_type")
	objectID := r2.URL.Query().Get("object_id")
	if kindKey == "" || objectID == "" {
		response.Fail(w, response.CodeValidationError, "object_type and object_id are required")
		return
	}

	kind, err := objects.ByKey(kindKey)
	if err != nil {
		response.OK(w, []TraceNode{})
		return
	}
	workshopID, _, _, errMsg := loadTraceRoot(r2.Context(), pool, kindKey, objectID)
	if errMsg != "" {
		response.Fail(w, response.CodeNotFound, errMsg)
		return
	}
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID); err != nil {
		writeAuthzErr(w, err)
		return
	}

	seen := map[string]bool{objectID: true}
	out := []TraceNode{}

	// Siblings: other objects of the same kind citing any of the same things.
	for _, link := range kind.Evidence {
		rows, err := pool.Query(r2.Context(), fmt.Sprintf(`
			select distinct other.%s::text, coalesce(o.title,''), o.state
			from public.%s mine
			join public.%s other on other.%s = mine.%s and other.%s <> mine.%s
			join public.%s o on o.id = other.%s
			where mine.%s = $1
			limit 20`,
			link.SelfCol, link.Table, link.Table, link.OtherCol, link.OtherCol,
			link.SelfCol, link.SelfCol, kind.Table, link.SelfCol, link.SelfCol), objectID)
		if err != nil {
			continue
		}
		for rows.Next() {
			var n TraceNode
			if err := rows.Scan(&n.ObjectID, &n.Title, &n.State); err != nil {
				break
			}
			if seen[n.ObjectID] {
				continue
			}
			seen[n.ObjectID] = true
			n.ObjectKind = kindKey
			out = append(out, n)
		}
		rows.Close()
	}

	response.OK(w, out)
}

// ---- promotion ----

type KnowledgeAsset struct {
	ID           string   `json:"id"`
	WorkspaceID  string   `json:"workspace_id"`
	ObjectKind   string   `json:"object_kind"`
	ObjectID     string   `json:"object_id"`
	Title        string   `json:"title"`
	Summary      *string  `json:"summary"`
	State        string   `json:"state"`
	Tags         []string `json:"tags"`
	WorkshopName *string  `json:"workshop_name"`
	PromotedAt   string   `json:"promoted_at"`
	PublishedAt  *string  `json:"published_at"`
}

// ListKnowledgeAssets — GET /knowledge/assets?state=
func ListKnowledgeAssets(w http.ResponseWriter, r *http.Request) {
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
		select ka.id, ka.workspace_id, ka.object_kind, ka.object_id, ka.title, ka.summary,
		       ka.state, ka.tags, w.name, ka.promoted_at, ka.published_at
		from public.knowledge_assets ka
		join public.workspace_members wsm
		     on wsm.workspace_id = ka.workspace_id and wsm.user_id = $1
		left join public.workshops w on w.id = ka.source_workshop_id
		where true`
	args := []interface{}{user.ID}
	if st := r2.URL.Query().Get("state"); st != "" {
		args = append(args, st)
		query += fmt.Sprintf(` and ka.state = $%d`, len(args))
	}
	query += ` order by ka.promoted_at desc limit 100`

	rows, err := pool.Query(r2.Context(), query, args...)
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	defer rows.Close()

	out := []KnowledgeAsset{}
	for rows.Next() {
		var a KnowledgeAsset
		var promotedAt time.Time
		var publishedAt *time.Time
		if err := rows.Scan(&a.ID, &a.WorkspaceID, &a.ObjectKind, &a.ObjectID, &a.Title,
			&a.Summary, &a.State, &a.Tags, &a.WorkshopName, &promotedAt, &publishedAt); err != nil {
			response.Fail(w, response.CodeServerError, err.Error())
			return
		}
		a.PromotedAt = promotedAt.Format(time.RFC3339)
		if publishedAt != nil {
			p := publishedAt.Format(time.RFC3339)
			a.PublishedAt = &p
		}
		out = append(out, a)
	}
	response.OK(w, out)
}

type promoteBody struct {
	ObjectKind string   `json:"object_kind"`
	ObjectID   string   `json:"object_id"`
	Summary    *string  `json:"summary"`
	Tags       []string `json:"tags"`
}

// PromoteKnowledge — POST /knowledge/assets
//
// §8.31: only reviewed output is worth remembering, so an object must be
// approved (or a report published) before it can become a candidate.
func PromoteKnowledge(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	var body promoteBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	workshopID, title, state, errMsg := loadTraceRoot(r2.Context(), pool, body.ObjectKind, body.ObjectID)
	if errMsg != "" {
		response.Fail(w, response.CodeNotFound, errMsg)
		return
	}

	// Curation is its own right (§3.23), checked against the source workshop.
	if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, workshopID, curatorRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	if state != "approved" && state != "published" {
		response.Fail(w, response.CodeInvalidStateTransition,
			"Only approved output can become organizational knowledge.")
		return
	}

	var workspaceID string
	if err := pool.QueryRow(r2.Context(),
		`select workspace_id from public.workshops where id = $1`, workshopID).Scan(&workspaceID); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	tags := body.Tags
	if tags == nil {
		tags = []string{}
	}

	var id string
	err := pool.QueryRow(r2.Context(), `
		insert into public.knowledge_assets
		  (workspace_id, source_workshop_id, object_kind, object_id, title, summary, state, promoted_by, tags)
		values ($1, $2, $3, $4, $5, $6, 'candidate', $7, $8)
		on conflict (object_kind, object_id) do nothing
		returning id`,
		workspaceID, workshopID, body.ObjectKind, body.ObjectID, title, trimPtr(body.Summary), user.ID, tags,
	).Scan(&id)
	if err == pgx.ErrNoRows {
		response.Fail(w, response.CodeValidationError, "This is already in the knowledge library.")
		return
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(r2.Context(), pool, user.ID, "knowledge.promoted", "knowledge_asset", id, "", "candidate",
		map[string]interface{}{"workshop_id": workshopID, "object_kind": body.ObjectKind})
	response.Created(w, map[string]string{"id": id, "state": "candidate"})
}

// PublishKnowledge — POST /knowledge/assets/{assetId}/publish
func PublishKnowledge(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	assetID := chi.URLParam(r2, "assetId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	var workspaceID, state string
	var sourceWorkshop *string
	if err := pool.QueryRow(r2.Context(),
		`select workspace_id::text, state, source_workshop_id::text
		 from public.knowledge_assets where id = $1`, assetID,
	).Scan(&workspaceID, &state, &sourceWorkshop); err != nil {
		response.Fail(w, response.CodeNotFound, "knowledge asset not found")
		return
	}
	if sourceWorkshop != nil {
		if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, *sourceWorkshop, curatorRoles...); err != nil {
			writeAuthzErr(w, err)
			return
		}
	}
	if state == "published" {
		response.Fail(w, response.CodeInvalidStateTransition, "This is already published.")
		return
	}

	if _, err := pool.Exec(r2.Context(), `
		update public.knowledge_assets
		set state = 'published', published_by = $2, published_at = now()
		where id = $1`, assetID, user.ID); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}

	audit.Record(r2.Context(), pool, user.ID, "knowledge.published", "knowledge_asset", assetID,
		state, "published", map[string]interface{}{"workspace_id": workspaceID})
	response.OK(w, map[string]string{"id": assetID, "state": "published"})
}

// RemoveKnowledge — DELETE /knowledge/assets/{assetId}
func RemoveKnowledge(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	assetID := chi.URLParam(r2, "assetId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	var sourceWorkshop *string
	if err := pool.QueryRow(r2.Context(),
		`select source_workshop_id::text from public.knowledge_assets where id = $1`, assetID,
	).Scan(&sourceWorkshop); err != nil {
		response.Fail(w, response.CodeNotFound, "knowledge asset not found")
		return
	}
	if sourceWorkshop != nil {
		if _, err := authz.RequireWorkshopRole(r2.Context(), pool, user.ID, *sourceWorkshop, curatorRoles...); err != nil {
			writeAuthzErr(w, err)
			return
		}
	}

	if _, err := pool.Exec(r2.Context(), `delete from public.knowledge_assets where id = $1`, assetID); err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return
	}
	audit.Record(r2.Context(), pool, user.ID, "knowledge.removed", "knowledge_asset", assetID, "", "deleted", nil)
	response.OK(w, map[string]string{"id": assetID})
}
