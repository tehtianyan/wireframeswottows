// The delivery board — the kanban on the Reporting stage, and its export.
//
// WHAT THIS IS FOR. The workshop ends with agreed actions, ranked. The room
// then has to DO them, and until this existed the trail stopped at a report:
// every action sat at the same unchanging status whether it had been started,
// finished or forgotten. The board is three or more columns the facilitator
// drags a card across, and the export hands the whole lot to the tracker the
// work will actually be managed in.
//
// EVERYTHING ABOUT THE COLUMNS IS CONFIGURATION. "To Do", "In Progress" and
// "Done" are three names in the report stage's own jsonb, and this file
// contains no state key, no count of states and no assumption that there are
// three. A methodology with a four-column board, or none at all, is a config
// change. That is the same rule `pkg/weights` holds for scales — a literal
// bound there is a bug — and for the same reason: the first hardcoded value is
// the one that makes the next methodology a code change.
//
// THE BOARD DOES NOT REORDER, AND THAT IS A DECISION. Cards within a column
// are in the order the facilitator already set on the TOWS matrix (initiative
// order, then rank inside it). A second hand-set order here would be a second
// authority over the same question — and the matrix's order is the one taken
// in front of the room, with the ratings visible, which is precisely why it
// outranks the aggregate. Letting a later drag on a different screen silently
// override it would undo that argument. So a card carries its rank and its
// rating, and moving it changes only which column it is in.
package handlers

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/methodology"
	"swot-tows/pkg/objects"
	"swot-tows/pkg/response"
	"swot-tows/pkg/weights"
)

// Moving a card is a statement about delivery, not about content, so it sits
// with the roles that own the report: a facilitator runs the workshop and an
// analyst maintains its output. Everybody else reads the board.
var deliveryEditRoles = []string{"facilitator", "analyst"}

// DeliveryState is one column.
type DeliveryState struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	// Description is optional help text for the column.
	Description string `json:"description,omitempty"`
}

// DeliveryGroup is a heading the cards sit under — an initiative, for
// SWOT-TOWS. Sent separately from the items so a group with nothing in it
// still appears, which is how a facilitator notices an empty programme.
type DeliveryGroup struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	TypeKey  string `json:"type_key"`
	TypeName string `json:"type_name"`
	Position int    `json:"position"`
}

// DeliveryItem is one card.
type DeliveryItem struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	// State is RESOLVED: never empty, never a key the board has no column
	// for. A row whose stored value is null, or is left over from a state the
	// methodology no longer declares, comes back in the first column rather
	// than vanishing from a board that is meant to show all the work.
	State string `json:"state"`
	// ObjectState is the governance lifecycle — draft, submitted, approved.
	// Shown on the card, because a board that hides it would present work
	// nobody has agreed to as if it were agreed.
	ObjectState string  `json:"object_state"`
	GroupID     *string `json:"group_id"`
	GroupTitle  string  `json:"group_title"`
	TypeKey     string  `json:"type_key"`
	TypeName    string  `json:"type_name"`
	Rank        int     `json:"rank"`
	Priority    string  `json:"priority"`
}

// DeliveryBoard is the whole response: the columns, the headings, the cards,
// and whether the caller may move one.
type DeliveryBoard struct {
	Kind      string          `json:"kind"`
	Label     string          `json:"label"`
	ItemLabel string          `json:"item_label"`
	GroupKind string          `json:"group_kind"`
	States    []DeliveryState `json:"states"`
	Exports   []string        `json:"exports"`
	Groups    []DeliveryGroup `json:"groups"`
	Items     []DeliveryItem  `json:"items"`
	CanMove   bool            `json:"can_move"`
	// WeightKey is the rating the cards carry, so the client reads the figure
	// from /weights against the real scale instead of assuming one.
	WeightKey string `json:"weight_key,omitempty"`
}

// deliveryConfig is the stage's declaration, parsed once.
type deliveryConfig struct {
	Kind      string
	Label     string
	ItemLabel string
	GroupKind string
	States    []DeliveryState
	Exports   []string
	WeightKey string
}

// readDeliveryConfig parses a stage's `delivery` block.
//
// It returns nil for a stage that declares none, which is how six of the eight
// methodologies get no board: the absence of a key, not a flag set to false.
func readDeliveryConfig(stage *methodology.Stage) *deliveryConfig {
	if stage == nil {
		return nil
	}
	raw, ok := stage.Config["delivery"].(map[string]interface{})
	if !ok {
		return nil
	}
	cfg := &deliveryConfig{
		Kind:      stringFromConfig(raw, "kind"),
		Label:     stringFromConfig(raw, "label"),
		ItemLabel: stringFromConfig(raw, "item_label"),
		GroupKind: stringFromConfig(raw, "group_kind"),
		States:    []DeliveryState{},
		Exports:   []string{},
	}
	if list, ok := raw["states"].([]interface{}); ok {
		for _, item := range list {
			m, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			key := stringFromConfig(m, "key")
			if key == "" {
				continue
			}
			name := stringFromConfig(m, "name")
			if name == "" {
				name = key
			}
			cfg.States = append(cfg.States, DeliveryState{
				Key: key, Name: name, Description: stringFromConfig(m, "description"),
			})
		}
	}
	if list, ok := raw["exports"].([]interface{}); ok {
		for _, item := range list {
			if s, ok := item.(string); ok && s != "" {
				cfg.Exports = append(cfg.Exports, s)
			}
		}
	}
	if cfg.Label == "" {
		cfg.Label = "Delivery board"
	}
	if cfg.Kind == "" || len(cfg.States) == 0 {
		return nil
	}
	return cfg
}

func stringFromConfig(m map[string]interface{}, key string) string {
	s, _ := m[key].(string)
	return strings.TrimSpace(s)
}

// has reports whether the configured states include this key. A stored value
// the config no longer declares is NOT an error — a methodology may rename a
// column — so the reader falls back to the first state rather than refusing.
func (c *deliveryConfig) has(key string) bool {
	for _, s := range c.States {
		if s.Key == key {
			return true
		}
	}
	return false
}

func (c *deliveryConfig) stateName(key string) string {
	for _, s := range c.States {
		if s.Key == key {
			return s.Name
		}
	}
	return key
}

func (c *deliveryConfig) offersExport(format string) bool {
	for _, e := range c.Exports {
		if e == format {
			return true
		}
	}
	return false
}

// resolveDeliveryStage finds the stage that declares a board.
//
// The caller may name one with ?stage_key=, but does not have to: there is at
// most one report stage in practice, and the board is reachable from the
// export link as well as from the screen. Searching for the declaration means
// neither caller has to know which stage holds it.
func resolveDeliveryStage(m *methodology.Methodology, stageKey string) (*methodology.Stage, *deliveryConfig) {
	if stageKey != "" {
		s := m.StageByKey(stageKey)
		if cfg := readDeliveryConfig(s); cfg != nil {
			return s, cfg
		}
		return nil, nil
	}
	for i := range m.Stages {
		if cfg := readDeliveryConfig(&m.Stages[i]); cfg != nil {
			return &m.Stages[i], cfg
		}
	}
	return nil, nil
}

// GetDeliveryBoard — GET /workshops/{id}/delivery
func GetDeliveryBoard(w http.ResponseWriter, r *http.Request) {
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
	role, err := authz.RequireWorkshopRole(ctx, pool, user.ID, workshopID)
	if err != nil {
		writeAuthzErr(w, err)
		return
	}

	m, err := methodology.LoadForWorkshop(ctx, pool, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}
	_, cfg := resolveDeliveryStage(m, r2.URL.Query().Get("stage_key"))
	if cfg == nil {
		response.Fail(w, response.CodeValidationError,
			"This workshop's methodology does not track delivery — no stage declares a board.")
		return
	}
	kind, msg := deliverableKind(cfg)
	if msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}

	board, err := loadDeliveryBoard(ctx, pool, m, cfg, kind, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}
	board.CanMove = roleIn(role, deliveryEditRoles)
	response.OK(w, board)
}

// deliverableKind resolves the configured kind and checks the platform can
// actually track it.
//
// A stage declaring a board over a kind with no delivery column is a config
// mistake, and it is reported as one rather than drawing an empty board — the
// same reason `scope='object'` with an empty `applies_to` is refused.
func deliverableKind(cfg *deliveryConfig) (*objects.Kind, string) {
	kind, err := objects.ByKey(cfg.Kind)
	if err != nil {
		return nil, fmt.Sprintf("This stage's delivery board names %q, which is not a kind of object this platform has.", cfg.Kind)
	}
	if kind.DeliveryCol == "" {
		return nil, fmt.Sprintf("A %s cannot be tracked on a delivery board — it is a finding, not a piece of work.",
			strings.ToLower(kind.Label))
	}
	return kind, ""
}

func roleIn(role string, allowed []string) bool {
	for _, a := range allowed {
		if a == role {
			return true
		}
	}
	return false
}

// loadDeliveryBoard reads the headings and the cards.
//
// The item query is built from the REGISTRY's identifiers — the kind's table,
// its delivery column, its parent column — never from request input, which is
// the invariant the generic SQL builder in objects.go relies on too.
func loadDeliveryBoard(ctx context.Context, pool *pgxpool.Pool, m *methodology.Methodology,
	cfg *deliveryConfig, kind *objects.Kind, workshopID string) (*DeliveryBoard, error) {

	board := &DeliveryBoard{
		Kind: cfg.Kind, Label: cfg.Label, ItemLabel: cfg.ItemLabel,
		GroupKind: cfg.GroupKind, States: cfg.States, Exports: cfg.Exports,
		Groups: []DeliveryGroup{}, Items: []DeliveryItem{},
	}
	if board.ItemLabel == "" {
		board.ItemLabel = kind.Label
	}

	// The rating shown on a card is whatever weight the methodology defines
	// for this kind. Reading the first one rather than naming a key keeps the
	// board out of the business of knowing what a methodology calls its scale.
	if defs := weights.ForKind(m.Weights, cfg.Kind); len(defs) > 0 {
		board.WeightKey = defs[0].Key
	}

	// Headings, if the board has them.
	groupKind, _ := objects.ByKey(cfg.GroupKind)
	if groupKind != nil && kind.Parent != nil && kind.Parent.Kind == cfg.GroupKind {
		rows, err := pool.Query(ctx, fmt.Sprintf(`
			select g.id::text, g.title, coalesce(mrt.key, ''), coalesce(mrt.name, ''),
			       coalesce(g.board_position, 0)
			from public.%s g
			left join public.methodology_relationship_types mrt on mrt.id = g.%s
			where g.workshop_id = $1 and g.state <> 'archived'
			order by coalesce(g.board_position, 0), g.created_at`,
			groupKind.Table, groupKind.TypeCol), workshopID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var g DeliveryGroup
			if err := rows.Scan(&g.ID, &g.Title, &g.TypeKey, &g.TypeName, &g.Position); err != nil {
				rows.Close()
				return nil, err
			}
			board.Groups = append(board.Groups, g)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	// A kind with no parent has no headings, no quadrant and no parent order
	// to rank by, so those columns become literals rather than referring to a
	// join that is not there. Only `recommendation` is deliverable today and
	// it HAS a parent, which is exactly why this has to be written down: the
	// untaken branch is the one that breaks the day a second kind arrives.
	parentCol, parentTitle, typeKey, typeName := "null::uuid", "''", "''", "''"
	parentOrder, parentJoin := "0", ""
	if kind.Parent != nil {
		parentCol = "o." + kind.Parent.Column
		parentTitle, typeKey, typeName = "coalesce(p.title, '')", "coalesce(mrt.key, '')", "coalesce(mrt.name, '')"
		// THE PARENT'S CREATED_AT IS A TIEBREAK, NOT DECORATION.
		//
		// `board_position` is only written when a facilitator DRAGS something,
		// so until then every initiative sits at NULL — and ordering by that
		// alone put every initiative's first action in one block, their second
		// actions in the next, and so on. The board drew five actions from two
		// initiatives interleaved, which reads as the ranking being arbitrary.
		//
		// Same shape as the RFC3339 tie that inverted two initiatives on the
		// matrix: a sort key that is equal for every row is not a sort key,
		// and the stable order underneath it shows through. Found by LOOKING
		// at a screenshot, again.
		parentOrder = "coalesce(p.board_position, 0), p.created_at, p.id"
		parentJoin = fmt.Sprintf(
			`left join public.%s p on p.id = o.%s
			 left join public.methodology_relationship_types mrt on mrt.id = p.relationship_type_id`,
			kind.Parent.Table, kind.Parent.Column)
	}
	// `priority` is a recommendation's own field, declared in the registry
	// rather than assumed: a deliverable kind without one exports the default.
	priorityCol := "''"
	if kind.Field("priority") != nil {
		priorityCol = "coalesce(o.priority, '')"
	}
	orderCol := "0"
	if kind.Ordered {
		orderCol = "coalesce(o.board_position, 0)"
	}

	// REJECTED AND ARCHIVED WORK IS OFF THE BOARD; everything else is on it.
	//
	// Only showing `approved` was the other candidate and would have drawn an
	// empty board for every real workshop — production's actions are all
	// `submitted`, because the lifecycle advances by a decision nobody has
	// taken yet. So the board shows the work and labels its governance state,
	// which is the honest version: a card you can see is a card you can ask
	// about.
	q := fmt.Sprintf(`
		select o.id::text, o.title, coalesce(o.description, ''),
		       coalesce(o.%s, ''), o.state,
		       %s, %s, %s, %s, %s, %s
		from public.%s o
		%s
		where o.workshop_id = $1 and o.state not in ('rejected', 'archived')
		order by %s, %s, o.created_at, o.id`,
		kind.DeliveryCol, parentCol, parentTitle, typeKey, typeName, orderCol, priorityCol,
		kind.Table, parentJoin, parentOrder, orderCol)

	rows, err := pool.Query(ctx, q, workshopID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var it DeliveryItem
		var stored string
		var positionInGroup int
		if err := rows.Scan(&it.ID, &it.Title, &it.Description, &stored, &it.ObjectState,
			&it.GroupID, &it.GroupTitle, &it.TypeKey, &it.TypeName,
			&positionInGroup, &it.Priority); err != nil {
			return nil, err
		}
		it.State = cfg.States[0].Key
		if stored != "" && cfg.has(stored) {
			it.State = stored
		}
		// RANK IS THE POSITION ACROSS THE WHOLE BOARD, not within a heading.
		// `board_position` restarts at zero in every initiative — it is the
		// matrix's within-a-cell order — so sending it as the rank would put
		// four different actions at "1" and make the number meaningless on a
		// board that groups by column instead of by heading. The query's ORDER
		// BY is the board's order, so the row's index IS its rank.
		it.Rank = len(board.Items)
		board.Items = append(board.Items, it)
	}
	return board, rows.Err()
}

type setDeliveryBody struct {
	State string `json:"state"`
}

// SetDeliveryState — PUT /workshops/{id}/delivery/{objectId}
//
// The kind is NOT in the URL. It comes from the stage's own declaration, which
// means there is one route whatever a methodology tracks, and no chance of the
// chi wildcard collision that forced factors onto their own weights route.
func SetDeliveryState(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	ctx := r2.Context()
	user := httpctx.UserFromContext(ctx)
	workshopID := chi.URLParam(r2, "id")
	objectID := chi.URLParam(r2, "objectId")
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}
	if _, err := authz.RequireWorkshopRole(ctx, pool, user.ID, workshopID, deliveryEditRoles...); err != nil {
		writeAuthzErr(w, err)
		return
	}

	var body setDeliveryBody
	if err := json.NewDecoder(r2.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	m, err := methodology.LoadForWorkshop(ctx, pool, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}
	_, cfg := resolveDeliveryStage(m, r2.URL.Query().Get("stage_key"))
	if cfg == nil {
		response.Fail(w, response.CodeValidationError,
			"This workshop's methodology does not track delivery — no stage declares a board.")
		return
	}
	kind, msg := deliverableKind(cfg)
	if msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}

	state := strings.TrimSpace(body.State)
	if !cfg.has(state) {
		// Names the real columns, so a typo is diagnosable from the message
		// rather than from the config.
		names := make([]string, 0, len(cfg.States))
		for _, s := range cfg.States {
			names = append(names, s.Name)
		}
		response.Fail(w, response.CodeValidationError, fmt.Sprintf(
			"This board has no %q column. It has: %s.", state, strings.Join(names, ", ")))
		return
	}

	var before string
	err = pool.QueryRow(ctx, fmt.Sprintf(
		`select coalesce(%s, '') from public.%s where id = $1 and workshop_id = $2`,
		kind.DeliveryCol, kind.Table), objectID, workshopID).Scan(&before)
	if err != nil {
		// Scoped by workshop, so an id from another workshop is a 404 and
		// never becomes something this caller can write to.
		response.Fail(w, response.CodeNotFound, fmt.Sprintf(
			"That %s is not part of this workshop.", strings.ToLower(kind.Label)))
		return
	}
	if before == "" {
		before = cfg.States[0].Key
	}

	if _, err := pool.Exec(ctx, fmt.Sprintf(
		`update public.%s set %s = $2 where id = $1 and workshop_id = $3`,
		kind.Table, kind.DeliveryCol), objectID, state, workshopID); err != nil {
		failDB(w, err)
		return
	}

	audit.Record(ctx, pool, user.ID, "delivery.moved", cfg.Kind, objectID, before, state,
		map[string]interface{}{"workshop_id": workshopID})

	response.OK(w, map[string]interface{}{
		"id": objectID, "state": state, "state_name": cfg.stateName(state),
	})
}

// ---- Export to Jira ----

// jiraPriority maps this platform's priority vocabulary onto Jira's default
// scheme. Both are fixed lists owned by their own system, so the mapping is a
// platform constant and not configuration: the left side is
// `objects.Kind.Fields`' enum and the right side is Jira's.
//
// An unmapped or absent value exports as "Medium" rather than blank — Jira
// rejects an unknown priority and skips the row, and a silently missing issue
// is worse than a correctly-imported one with a default priority.
var jiraPriority = map[string]string{
	"critical": "Highest",
	"high":     "High",
	"medium":   "Medium",
	"low":      "Low",
}

var labelUnsafe = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

// jiraLabel makes a Jira-legal label. Jira labels may not contain spaces, and
// one that does is rejected along with its whole row.
func jiraLabel(s string) string {
	return strings.Trim(labelUnsafe.ReplaceAllString(s, "-"), "-")
}

// ExportDeliveryJira — GET /workshops/{id}/delivery/export/jira.csv
//
// Jira's own External System Import reads CSV, so the export is a file the
// person uploads rather than an integration: no API token to store, no OAuth
// app to register, and it works for Jira Cloud, Data Center and a Jira the
// server cannot reach. The shape is Jira's documented one — an Epic row per
// heading and a Story row per action, linked by Epic Name.
//
// TRACEABILITY TRAVELS WITH IT. Each issue's description carries where the
// action came from (the quadrant that produced it) and what the room thought
// of it, as two numbers. An action arriving in Jira stripped of its provenance
// is an action nobody can argue about six months later, which is the whole
// thing this product exists to prevent.
func ExportDeliveryJira(w http.ResponseWriter, r *http.Request) {
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

	m, err := methodology.LoadForWorkshop(ctx, pool, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}
	_, cfg := resolveDeliveryStage(m, r2.URL.Query().Get("stage_key"))
	if cfg == nil || !cfg.offersExport("jira") {
		response.Fail(w, response.CodeValidationError,
			"This workshop's methodology does not offer a Jira export.")
		return
	}
	kind, msg := deliverableKind(cfg)
	if msg != "" {
		response.Fail(w, response.CodeValidationError, msg)
		return
	}

	board, err := loadDeliveryBoard(ctx, pool, m, cfg, kind, workshopID)
	if err != nil {
		failDB(w, err)
		return
	}

	var ratings []weights.Aggregate
	var participation map[string]weights.Participation
	if board.WeightKey != "" {
		if d := m.WeightByKey(board.WeightKey); d != nil {
			ratings, _ = weights.LoadAggregates(ctx, pool, workshopID, []weights.Definition{*d})
			participation, _ = weights.LoadParticipation(ctx, pool, workshopID, []weights.Definition{*d})
		}
	}
	byObject := map[string]weights.Aggregate{}
	for _, a := range ratings {
		byObject[a.ObjectID] = a
	}
	contributors := 0
	if p, ok := participation[board.WeightKey]; ok {
		contributors = p.Contributors
	}

	var wkName string
	_ = pool.QueryRow(ctx, `select name from public.workshops where id = $1`, workshopID).Scan(&wkName)

	csvBody, err := renderJiraCSV(board, byObject, contributors, wkName, m.Name)
	if err != nil {
		response.Fail(w, response.CodeServerError, "The export could not be written.")
		return
	}

	audit.Record(ctx, pool, user.ID, "delivery.exported", "workshop", workshopID, "", "jira",
		map[string]interface{}{"workshop_id": workshopID, "items": len(board.Items)})

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(
		`attachment; filename="%s-jira.csv"`, slugForFile(wkName)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(csvBody))
}

var fileUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

func slugForFile(s string) string {
	slug := strings.Trim(fileUnsafe.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if slug == "" {
		return "workshop"
	}
	if len(slug) > 60 {
		slug = slug[:60]
	}
	return slug
}

// renderJiraCSV is PURE, so the whole file format — the header row, the epic
// linking, the collision handling, the provenance text — is exercised by a Go
// test with no database and no Jira. The alternative is checking the format by
// uploading it, which means it is checked once.
func renderJiraCSV(board *DeliveryBoard, ratings map[string]weights.Aggregate,
	contributors int, workshopName, methodologyName string) (string, error) {

	var sb strings.Builder
	cw := csv.NewWriter(&sb)

	// TWO `Labels` COLUMNS, which is Jira's documented way of giving one issue
	// several labels in CSV: repeated headers become repeated values.
	header := []string{
		"Issue Type", "Summary", "Description", "Status", "Priority",
		"Epic Name", "Epic Link", "Labels", "Labels",
	}
	if err := cw.Write(header); err != nil {
		return "", err
	}

	epicName := uniqueEpicNames(board.Groups)

	methodologyLabel := jiraLabel(methodologyName)

	for _, g := range board.Groups {
		row := []string{
			"Epic", epicName[g.ID],
			fmt.Sprintf("%s from the %s workshop \"%s\".",
				board.GroupKindLabel(), methodologyName, workshopName),
			board.States[0].Name, "Medium",
			epicName[g.ID], "",
			jiraLabel(g.TypeKey), methodologyLabel,
		}
		if err := cw.Write(row); err != nil {
			return "", err
		}
	}

	// Cards in board order, which loadDeliveryBoard already established —
	// re-sorting here would be a second opinion about the same question.
	for _, it := range board.Items {
		link := ""
		if it.GroupID != nil {
			link = epicName[*it.GroupID]
		}
		priority, ok := jiraPriority[strings.ToLower(it.Priority)]
		if !ok {
			priority = "Medium"
		}
		row := []string{
			"Story", it.Title,
			jiraDescription(it, ratings[it.ID], contributors, board, workshopName),
			board.stateName(it.State), priority,
			"", link,
			jiraLabel(it.TypeKey), methodologyLabel,
		}
		if err := cw.Write(row); err != nil {
			return "", err
		}
	}

	cw.Flush()
	if err := cw.Error(); err != nil {
		return "", err
	}
	return sb.String(), nil
}

// uniqueEpicNames maps each heading to a name no other heading shares.
//
// EPIC NAMES MUST BE UNIQUE OR JIRA LINKS THE WRONG STORIES. Jira's CSV
// importer matches Epic Link to Epic Name by TEXT, so two epics called
// "Invest in partners" silently collect each other's stories — the file
// imports cleanly and the result is wrong.
//
// THE FIRST VERSION APPENDED THE QUADRANT AND ASSUMED THAT WAS ENOUGH, on the
// reasoning that "one initiative per quadrant" means a collision is always
// cross-quadrant. That is a CONVENTION, not a constraint: nothing stops two
// initiatives with the same title in the SAME quadrant, and a browser probe
// printed a real file with four epics all called "Invest in partners [SO]".
// The suffix had made the names longer without making them distinct, and the
// Go test passed because its fixture collided across quadrants — the shape the
// code was written for.
//
// So the quadrant is tried first, because it is the meaningful distinction and
// the one a reader recognises, and a counter is added only where that still
// leaves two the same. Uniqueness is then a property of the OUTPUT rather than
// an assumption about the input.
func uniqueEpicNames(groups []DeliveryGroup) map[string]string {
	out := map[string]string{}
	collides := map[string]int{}
	for _, g := range groups {
		collides[strings.ToLower(g.Title)]++
	}

	used := map[string]bool{}
	for _, g := range groups {
		name := g.Title
		if collides[strings.ToLower(g.Title)] > 1 && g.TypeKey != "" {
			name = fmt.Sprintf("%s [%s]", g.Title, strings.ToUpper(g.TypeKey))
		}
		candidate := name
		for n := 2; used[strings.ToLower(candidate)]; n++ {
			candidate = fmt.Sprintf("%s (%d)", name, n)
		}
		used[strings.ToLower(candidate)] = true
		out[g.ID] = candidate
	}
	return out
}

// GroupKindLabel names the heading kind in the epic's description.
func (b *DeliveryBoard) GroupKindLabel() string {
	if k, err := objects.ByKey(b.GroupKind); err == nil {
		return k.Label
	}
	return "Programme"
}

func (b *DeliveryBoard) stateName(key string) string {
	for _, s := range b.States {
		if s.Key == key {
			return s.Name
		}
	}
	if len(b.States) > 0 {
		return b.States[0].Name
	}
	return key
}

// jiraDescription writes the issue body: what to do, then where it came from.
//
// TWO NUMBERS, NEVER ONE — the rating AND how many people are behind it. A
// bare "4.5" in a Jira ticket reads as the room's agreement when one
// enthusiast produced it, and this is the furthest from the workshop that
// figure ever travels, so it is where the misreading does most damage.
func jiraDescription(it DeliveryItem, rating weights.Aggregate, contributors int,
	board *DeliveryBoard, workshopName string) string {

	parts := []string{}
	if it.Description != "" {
		parts = append(parts, it.Description)
	}

	provenance := []string{fmt.Sprintf("Agreed in the %q workshop", workshopName)}
	if it.TypeName != "" {
		provenance = append(provenance, fmt.Sprintf("from the %s pairing", it.TypeName))
	}
	if it.GroupTitle != "" {
		provenance = append(provenance, fmt.Sprintf("under %q", it.GroupTitle))
	}
	parts = append(parts, strings.Join(provenance, " ")+".")

	if rating.Voters > 0 {
		line := fmt.Sprintf("Workshop priority: %s", trimFloat(rating.Value))
		if rating.Label != "" {
			line += fmt.Sprintf(" (%s)", rating.Label)
		}
		if contributors > 0 {
			line += fmt.Sprintf(" — rated by %d of %d who took part", rating.Voters, contributors)
		} else {
			line += fmt.Sprintf(" — rated by %d", rating.Voters)
		}
		parts = append(parts, line)
	} else {
		parts = append(parts, "Workshop priority: not yet rated.")
	}

	if it.ObjectState != "" && it.ObjectState != "approved" {
		parts = append(parts, fmt.Sprintf(
			"Status in the workshop: %s — not yet approved.", it.ObjectState))
	}
	parts = append(parts, fmt.Sprintf("Rank on the %s: %d.", strings.ToLower(board.Label), it.Rank+1))

	return strings.Join(parts, "\n\n")
}

// trimFloat prints 4 as "4" and 4.5 as "4.5", so a whole-number mean does not
// arrive in a ticket as "4.000000".
func trimFloat(f float64) string {
	s := fmt.Sprintf("%.2f", f)
	s = strings.TrimRight(s, "0")
	return strings.TrimRight(s, ".")
}
