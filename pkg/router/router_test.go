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

		{"GET", "/api/v1/dashboard", "/api/v1/dashboard"},

		{"GET", "/api/v1/executive", "/api/v1/executive"},

		// Knowledge, notifications and administration.
		{"GET", "/api/v1/knowledge/search", "/api/v1/knowledge/search"},
		{"GET", "/api/v1/knowledge/trace", "/api/v1/knowledge/trace"},
		{"GET", "/api/v1/knowledge/assets", "/api/v1/knowledge/assets"},
		{"POST", "/api/v1/knowledge/assets", "/api/v1/knowledge/assets"},
		{"POST", "/api/v1/knowledge/assets/a1/publish", "/api/v1/knowledge/assets/{assetId}/publish"},
		{"GET", "/api/v1/notifications", "/api/v1/notifications"},
		{"POST", "/api/v1/notifications/read-all", "/api/v1/notifications/read-all"},
		{"POST", "/api/v1/notifications/n1/read", "/api/v1/notifications/{notificationId}/read"},
		{"GET", "/api/v1/admin/users", "/api/v1/admin/users"},
		{"PUT", "/api/v1/admin/users/u1/role", "/api/v1/admin/users/{userId}/role"},
		{"GET", "/api/v1/audit-events", "/api/v1/audit-events"},
		{"GET", "/api/v1/workshops/abc/summary", "/api/v1/workshops/{id}/summary"},

		// Reporting must not be swallowed by the {kind} wildcard either.
		{"GET", "/api/v1/workshops/abc/report-types", "/api/v1/workshops/{id}/report-types"},
		{"GET", "/api/v1/workshops/abc/reports", "/api/v1/workshops/{id}/reports"},
		{"POST", "/api/v1/workshops/abc/reports", "/api/v1/workshops/{id}/reports"},
		{"GET", "/api/v1/workshops/abc/reports/r1", "/api/v1/workshops/{id}/reports/{reportId}"},
		{"PUT", "/api/v1/workshops/abc/reports/r1/sections", "/api/v1/workshops/{id}/reports/{reportId}/sections"},
		{"PATCH", "/api/v1/workshops/abc/reports/r1/sections/s1", "/api/v1/workshops/{id}/reports/{reportId}/sections/{sectionId}"},
		{"POST", "/api/v1/workshops/abc/reports/r1/publish", "/api/v1/workshops/{id}/reports/{reportId}/publish"},
		{"POST", "/api/v1/workshops/abc/reports/r1/versions", "/api/v1/workshops/{id}/reports/{reportId}/versions"},
		{"GET", "/api/v1/workshops/abc/reports/r1/export.html", "/api/v1/workshops/{id}/reports/{reportId}/export.html"},

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
