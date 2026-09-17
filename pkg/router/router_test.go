package router

import (
	"testing"

	"github.com/go-chi/chi/v5"
)

// Phase 2 introduced a wildcard route, /workshops/{id}/{kind}, that sits at
// the same depth as literal routes like /workshops/{id}/factors and
// /workshops/{id}/votes. If chi ever resolved the wildcard first, those
// endpoints would silently start 404ing as "unknown object kind" — a failure
// that would look like a data bug rather than a routing bug.
//
// This asserts which pattern actually wins for each path.
func TestRoutePrecedence(t *testing.T) {
	r := New()

	cases := []struct {
		method string
		path   string
		want   string
	}{
		// Literals must beat the {kind} wildcard.
		{"GET", "/api/v1/workshops/abc/factors", "/api/v1/workshops/{id}/factors"},
		{"POST", "/api/v1/workshops/abc/factors", "/api/v1/workshops/{id}/factors"},
		{"GET", "/api/v1/workshops/abc/votes", "/api/v1/workshops/{id}/votes"},
		{"GET", "/api/v1/workshops/abc/activities", "/api/v1/workshops/{id}/activities"},
		{"POST", "/api/v1/workshops/abc/configure", "/api/v1/workshops/{id}/configure"},
		{"POST", "/api/v1/workshops/abc/complete", "/api/v1/workshops/{id}/complete"},
		{"PATCH", "/api/v1/workshops/abc/factors/f1", "/api/v1/workshops/{id}/factors/{factorId}"},
		{"POST", "/api/v1/workshops/abc/factors/f1/review", "/api/v1/workshops/{id}/factors/{factorId}/review"},
		{"PUT", "/api/v1/workshops/abc/factors/f1/vote", "/api/v1/workshops/{id}/factors/{factorId}/vote"},

		// "ai" must not be swallowed by the {kind} wildcard.
		{"GET", "/api/v1/workshops/abc/ai", "/api/v1/workshops/{id}/ai"},
		{"POST", "/api/v1/workshops/abc/ai/execute", "/api/v1/workshops/{id}/ai/execute"},
		{"GET", "/api/v1/workshops/abc/ai/outputs", "/api/v1/workshops/{id}/ai/outputs"},
		{"POST", "/api/v1/workshops/abc/ai/outputs/o1/review", "/api/v1/workshops/{id}/ai/outputs/{outputId}/review"},

		// The generic object routes.
		{"GET", "/api/v1/workshops/abc/syntheses", "/api/v1/workshops/{id}/{kind}"},
		{"POST", "/api/v1/workshops/abc/insights", "/api/v1/workshops/{id}/{kind}"},
		{"GET", "/api/v1/workshops/abc/relationships", "/api/v1/workshops/{id}/{kind}"},
		{"PATCH", "/api/v1/workshops/abc/recommendations/o1", "/api/v1/workshops/{id}/{kind}/{objectId}"},
		{"POST", "/api/v1/workshops/abc/insights/o1/review", "/api/v1/workshops/{id}/{kind}/{objectId}/review"},

		// Top-level catalogues.
		{"GET", "/api/v1/methodologies", "/api/v1/methodologies"},
		{"GET", "/api/v1/object-kinds", "/api/v1/object-kinds"},
		{"GET", "/api/v1/workspaces", "/api/v1/workspaces"},
		{"GET", "/api/v1/health", "/api/v1/health"},
	}

	for _, c := range cases {
		rctx := chi.NewRouteContext()
		if !r.(*chi.Mux).Match(rctx, c.method, c.path) {
			t.Errorf("%s %s did not match any route", c.method, c.path)
			continue
		}
		if got := rctx.RoutePattern(); got != c.want {
			t.Errorf("%s %s matched %q, want %q", c.method, c.path, got, c.want)
		}
	}
}
