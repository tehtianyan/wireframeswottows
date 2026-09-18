// Package router builds the full /api/v1 route table in one place, shared
// by the Vercel entrypoint (api/v1/[...path].go) and local dev.
package router

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"swot-tows/pkg/handlers"
)

func New() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", handlers.Health)

		// The catalogue the creation wizard picks from — active methodologies
		// only, so activating one is a config change, not a release.
		r.Get("/methodologies", handlers.ListMethodologies)
		r.Get("/workspaces", handlers.ListWorkspaces)
		// Field definitions per object kind, so the UI builds its forms from
		// the registry instead of hardcoding what a recommendation looks like.
		r.Get("/object-kinds", handlers.ListObjectKinds)

		// "What needs me today?" across every workshop the caller belongs to.
		r.Get("/dashboard", handlers.GetDashboard)

		r.Route("/workshops", func(r chi.Router) {
			r.Get("/", handlers.ListWorkshops)
			r.Post("/", handlers.CreateWorkshop)
			r.Get("/{id}", handlers.GetWorkshop)
			r.Post("/{id}/configure", handlers.TransitionWorkshop("configured"))
			r.Post("/{id}/start", handlers.TransitionWorkshop("active"))
			r.Post("/{id}/analysis", handlers.TransitionWorkshop("analysis"))
			r.Post("/{id}/reporting", handlers.TransitionWorkshop("reporting"))
			r.Post("/{id}/complete", handlers.CompleteWorkshop)
			r.Get("/{id}/activities", handlers.ListActivities)
			r.Get("/{id}/factors", handlers.ListFactors)
			r.Post("/{id}/factors", handlers.CreateFactor)
			r.Patch("/{id}/factors/{factorId}", handlers.UpdateFactor)
			r.Delete("/{id}/factors/{factorId}", handlers.DeleteFactor)
			r.Post("/{id}/factors/{factorId}/review", handlers.ReviewFactor)

			r.Get("/{id}/votes", handlers.GetVotes)
			r.Put("/{id}/factors/{factorId}/vote", handlers.SetVote)

			// AI Strategy Assistant. Registered before the {kind} wildcard so
			// "ai" is never mistaken for an object route.
			r.Get("/{id}/ai", handlers.GetAIStatus)
			r.Post("/{id}/ai/execute", handlers.ExecuteAI)
			r.Get("/{id}/ai/outputs", handlers.ListAIOutputs)
			r.Post("/{id}/ai/outputs/{outputId}/review", handlers.ReviewAIOutput)

			// Reporting. Registered before the {kind} wildcard, like the AI
			// routes, so "reports" is never taken for an object route.
			r.Get("/{id}/summary", handlers.GetWorkshopSummary)
			r.Get("/{id}/report-types", handlers.ListReportTypes)
			r.Get("/{id}/reports", handlers.ListReports)
			r.Post("/{id}/reports", handlers.CreateReport)
			r.Get("/{id}/reports/{reportId}", handlers.GetReport)
			r.Put("/{id}/reports/{reportId}/sections", handlers.UpdateReportSections)
			r.Patch("/{id}/reports/{reportId}/sections/{sectionId}", handlers.UpdateReportSection)
			r.Post("/{id}/reports/{reportId}/review", handlers.ReviewReport)
			r.Post("/{id}/reports/{reportId}/publish", handlers.PublishReport)
			r.Post("/{id}/reports/{reportId}/versions", handlers.CreateReportVersion)
			r.Get("/{id}/reports/{reportId}/export.html", handlers.ExportReportHTML)

			// Every other reviewable object kind — syntheses, relationships,
			// insights, recommendations — shares one generic handler set
			// dispatched on {kind}. See pkg/objects for the registry.
			r.Get("/{id}/{kind}", handlers.ListObjects)
			r.Post("/{id}/{kind}", handlers.CreateObject)
			r.Patch("/{id}/{kind}/{objectId}", handlers.UpdateObject)
			r.Delete("/{id}/{kind}/{objectId}", handlers.DeleteObject)
			r.Post("/{id}/{kind}/{objectId}/review", handlers.ReviewObject)
		})
	})

	return r
}
