// Package weights is the generalisation of voting.
//
// A weight is a constrained number attached to an object on a scale the
// methodology defines. Voting was the first instance of it and is now
// expressed through it: a vote is a weight with an unbounded scale and a
// budget spread across objects, while a maturity or likelihood rating is a
// weight with a bounded scale and one value per object.
//
// NOTHING HERE MAY ASSUME A RANGE. The seven seeded methodologies mostly use
// 1-5, but that is their convention, not the engine's — the bounds, the step
// and the labels are all configuration. A literal 5 in this package, or a
// five-element array, is a bug.
package weights

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Constraint types.
const (
	// ConstraintBudget gives the participant a pool to spread across objects.
	// Voting is the canonical case.
	ConstraintBudget = "budget"
	// ConstraintSingle is one value per object, with no pool.
	ConstraintSingle = "single"
)

// Definition is one weight a methodology declares.
type Definition struct {
	ID        string `json:"id"`
	Key       string `json:"key"`
	Name      string `json:"name"`
	AppliesTo string `json:"applies_to"`

	ScaleMin  float64  `json:"scale_min"`
	ScaleMax  *float64 `json:"scale_max"` // nil = unbounded, which is what a vote is
	ScaleStep float64  `json:"scale_step"`
	// ScaleLabels are optional ordinal names covering exactly the steps of the
	// scale — ISO 31000's Rare..Almost certain, CMMI's Initial..Optimized.
	ScaleLabels []string `json:"scale_labels,omitempty"`

	ConstraintType  string   `json:"constraint_type"`
	ConstraintTotal *float64 `json:"constraint_total,omitempty"`

	PerParticipant bool     `json:"per_participant"`
	Aggregate      string   `json:"aggregate"`
	AllowedRoles   []string `json:"allowed_roles"`

	GuidanceText string `json:"guidance_text,omitempty"`
	SortOrder    int    `json:"sort_order"`
}

// Steps reports how many discrete values the scale admits, or 0 when it is
// unbounded. The UI uses this to decide between a stepper and a scale picker.
func (d *Definition) Steps() int {
	if d.ScaleMax == nil {
		return 0
	}
	return int(math.Floor((*d.ScaleMax-d.ScaleMin)/d.ScaleStep)) + 1
}

// AllowsRole reports whether this workshop role may set the weight. Voting
// includes participants; a risk rating typically does not.
func (d *Definition) AllowsRole(role string) bool {
	for _, r := range d.AllowedRoles {
		if r == role {
			return true
		}
	}
	return false
}

// Label returns the ordinal name for a value when the definition carries one,
// so an API response can say "Almost certain" rather than only 5.
func (d *Definition) Label(value float64) string {
	if len(d.ScaleLabels) == 0 {
		return ""
	}
	i := int(math.Round((value - d.ScaleMin) / d.ScaleStep))
	if i < 0 || i >= len(d.ScaleLabels) {
		return ""
	}
	return d.ScaleLabels[i]
}

// formatNumber prints a scale bound the way a person wrote it in config: 5
// rather than 5.0, but 2.5 kept intact. Error messages quote the configured
// bounds, so they must not invent precision.
func formatNumber(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// ValidateValue checks one value against the scale alone. It returns a message
// written for the person who will read it, or "" when the value is good.
//
// The budget check is separate (see CheckBudget) because it needs the caller's
// other allocations, and a scale error should be reported without a database
// round trip.
func (d *Definition) ValidateValue(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "That is not a number."
	}
	if value < d.ScaleMin {
		return fmt.Sprintf("%s cannot be below %s.", d.Name, formatNumber(d.ScaleMin))
	}
	if d.ScaleMax != nil && value > *d.ScaleMax {
		return fmt.Sprintf("%s cannot be above %s.", d.Name, formatNumber(*d.ScaleMax))
	}
	// The value must land on a step. Compared against a relative epsilon so a
	// 0.1 step does not fail on binary floating point.
	steps := (value - d.ScaleMin) / d.ScaleStep
	if math.Abs(steps-math.Round(steps)) > 1e-9*math.Max(1, math.Abs(steps)) {
		return fmt.Sprintf("%s moves in steps of %s.", d.Name, formatNumber(d.ScaleStep))
	}
	return ""
}

// CheckBudget enforces a 'budget' constraint: everything this user has already
// spent on OTHER objects, plus what they are spending now, must fit the total.
// It is a no-op for 'single' weights.
func (d *Definition) CheckBudget(ctx context.Context, pool *pgxpool.Pool,
	workshopID, objectID, userID string, value float64) (string, error) {

	if d.ConstraintType != ConstraintBudget {
		return "", nil
	}
	if d.ConstraintTotal == nil {
		return fmt.Sprintf("%s has no budget configured for this methodology.", d.Name), nil
	}

	var usedElsewhere float64
	err := pool.QueryRow(ctx, `
		select coalesce(sum(value), 0) from public.weights
		where workshop_id = $1 and weight_key = $2 and user_id = $3 and object_id <> $4`,
		workshopID, d.Key, userID, objectID).Scan(&usedElsewhere)
	if err != nil {
		return "", err
	}
	if usedElsewhere+value > *d.ConstraintTotal {
		return fmt.Sprintf("That would exceed your %s budget for this workshop.",
			strings.ToLower(d.Name)), nil
	}
	return "", nil
}

// Load reads every weight a methodology defines.
//
// The slice is initialised rather than left nil: a nil slice marshals to JSON
// `null`, and the client reads these as arrays. The same trap already crashed
// the relationship matrix once.
func Load(ctx context.Context, pool *pgxpool.Pool, methodologyID string) ([]Definition, error) {
	out := []Definition{}
	rows, err := pool.Query(ctx, `
		select id::text, key, name, applies_to,
		       scale_min, scale_max, scale_step, scale_labels,
		       constraint_type, constraint_total,
		       per_participant, aggregate, allowed_roles,
		       coalesce(guidance_text, ''), sort_order
		from public.methodology_weights
		where methodology_id = $1
		order by sort_order, key`, methodologyID)
	if err != nil {
		return nil, fmt.Errorf("loading weight definitions: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var d Definition
		var labelsRaw []byte
		if err := rows.Scan(&d.ID, &d.Key, &d.Name, &d.AppliesTo,
			&d.ScaleMin, &d.ScaleMax, &d.ScaleStep, &labelsRaw,
			&d.ConstraintType, &d.ConstraintTotal,
			&d.PerParticipant, &d.Aggregate, &d.AllowedRoles,
			&d.GuidanceText, &d.SortOrder); err != nil {
			return nil, err
		}
		if len(labelsRaw) > 0 {
			_ = json.Unmarshal(labelsRaw, &d.ScaleLabels)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ByKey finds a definition in a loaded set.
func ByKey(defs []Definition, key string) *Definition {
	for i := range defs {
		if defs[i].Key == key {
			return &defs[i]
		}
	}
	return nil
}

// ForKind returns the definitions that apply to one object kind, in config
// order, so a stage can render exactly the weights its objects carry.
func ForKind(defs []Definition, kind string) []Definition {
	out := []Definition{}
	for i := range defs {
		if defs[i].AppliesTo == kind {
			out = append(out, defs[i])
		}
	}
	return out
}

// Value is one stored weight.
type Value struct {
	WeightKey  string  `json:"weight_key"`
	ObjectKind string  `json:"object_kind"`
	ObjectID   string  `json:"object_id"`
	UserID     string  `json:"user_id,omitempty"`
	Value      float64 `json:"value"`
	Label      string  `json:"label,omitempty"`
}

// Aggregate is a weight's rolled-up figure for one object, which is what a
// ranking, a report column and the executive view all read.
type Aggregate struct {
	WeightKey  string  `json:"weight_key"`
	ObjectID   string  `json:"object_id"`
	ObjectKind string  `json:"object_kind"`
	Value      float64 `json:"value"`
	Label      string  `json:"label,omitempty"`
	Voters     int     `json:"voters"`
}

// sqlAggregate maps a definition's aggregate to SQL. The set is closed by a
// CHECK constraint on the table, and anything unrecognised falls back to sum
// rather than interpolating caller input into the query.
func sqlAggregate(name string) string {
	switch name {
	case "mean":
		return "avg(value)"
	case "min":
		return "min(value)"
	case "max":
		return "max(value)"
	case "latest":
		return "(array_agg(value order by updated_at desc))[1]"
	default:
		return "sum(value)"
	}
}

// LoadValues returns one user's own values for a workshop. For weights that
// are not per-participant the value belongs to the object, so those rows carry
// no user and are returned to everyone.
func LoadValues(ctx context.Context, pool *pgxpool.Pool, workshopID, userID string) ([]Value, error) {
	out := []Value{}
	rows, err := pool.Query(ctx, `
		select weight_key, object_kind, object_id, coalesce(user_id::text, ''), value
		from public.weights
		where workshop_id = $1 and (user_id = $2 or user_id is null)`,
		workshopID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v Value
		if err := rows.Scan(&v.WeightKey, &v.ObjectKind, &v.ObjectID, &v.UserID, &v.Value); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// LoadAggregates rolls every weight up per object, using each definition's own
// aggregate function. One query per definition rather than one per object.
func LoadAggregates(ctx context.Context, pool *pgxpool.Pool, workshopID string,
	defs []Definition) ([]Aggregate, error) {

	out := []Aggregate{}
	for i := range defs {
		d := &defs[i]
		rows, err := pool.Query(ctx, fmt.Sprintf(`
			select object_id::text, object_kind, %s, count(*)
			from public.weights
			where workshop_id = $1 and weight_key = $2
			group by object_id, object_kind`, sqlAggregate(d.Aggregate)),
			workshopID, d.Key)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			a := Aggregate{WeightKey: d.Key}
			if err := rows.Scan(&a.ObjectID, &a.ObjectKind, &a.Value, &a.Voters); err != nil {
				rows.Close()
				return nil, err
			}
			a.Label = d.Label(a.Value)
			out = append(out, a)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Set writes one value, replacing whatever that user had on that object.
func Set(ctx context.Context, pool *pgxpool.Pool, workshopID string, d *Definition,
	objectKind, objectID, userID string, value float64) error {

	owner := &userID
	if !d.PerParticipant {
		owner = nil // the value belongs to the object, not to a person
	}

	if owner == nil {
		_, err := pool.Exec(ctx, `
			insert into public.weights (workshop_id, weight_key, object_kind, object_id, user_id, value)
			values ($1, $2, $3, $4, null, $5)
			on conflict (workshop_id, weight_key, object_id) where user_id is null
			do update set value = excluded.value, updated_at = now()`,
			workshopID, d.Key, objectKind, objectID, value)
		return err
	}

	_, err := pool.Exec(ctx, `
		insert into public.weights (workshop_id, weight_key, object_kind, object_id, user_id, value)
		values ($1, $2, $3, $4, $5, $6)
		on conflict (workshop_id, weight_key, object_id, user_id) where user_id is not null
		do update set value = excluded.value, updated_at = now()`,
		workshopID, d.Key, objectKind, objectID, *owner, value)
	return err
}

// Clear removes a value. Clearing is explicit rather than "write zero",
// because zero is a legitimate value on any scale whose minimum is zero.
func Clear(ctx context.Context, pool *pgxpool.Pool, workshopID string, d *Definition,
	objectID, userID string) error {

	if !d.PerParticipant {
		_, err := pool.Exec(ctx, `
			delete from public.weights
			where workshop_id = $1 and weight_key = $2 and object_id = $3 and user_id is null`,
			workshopID, d.Key, objectID)
		return err
	}
	_, err := pool.Exec(ctx, `
		delete from public.weights
		where workshop_id = $1 and weight_key = $2 and object_id = $3 and user_id = $4`,
		workshopID, d.Key, objectID, userID)
	return err
}

// DeleteForObject removes every weight on an object, called when the object
// itself is deleted. object_id carries no foreign key — the reference is
// polymorphic across five tables — so the cleanup is explicit here.
func DeleteForObject(ctx context.Context, pool *pgxpool.Pool, workshopID, objectID string) error {
	_, err := pool.Exec(ctx,
		`delete from public.weights where workshop_id = $1 and object_id = $2`,
		workshopID, objectID)
	return err
}
