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

		// THE ONLY PUBLIC MUTATING ENDPOINT, and it has to be: somebody who
		// has forgotten their password cannot authenticate to ask for a reset.
		// Before it existed there was no way back in at all — the sign-in page
		// simply asked again for the thing they did not know, and the only
		// remedy was to find an administrator.
		// Its three safeguards (one unvarying answer so it cannot enumerate
		// accounts, a refusal for disabled accounts, and a per-address rate
		// limit checked before any send) are in handlers.ForgotPassword.
		r.Post("/auth/forgot-password", handlers.ForgotPassword)

		// The catalogue the creation wizard picks from — active methodologies
		// only, so activating one is a config change, not a release.
		r.Get("/methodologies", handlers.ListMethodologies)
		r.Get("/workspaces", handlers.ListWorkspaces)
		// Field definitions per object kind, so the UI builds its forms from
		// the registry instead of hardcoding what a recommendation looks like.
		r.Get("/object-kinds", handlers.ListObjectKinds)

		// "What needs me today?" across every workshop the caller belongs to.
		r.Get("/dashboard", handlers.GetDashboard)

		// White-label branding for the caller's organization. Readable by any
		// authenticated caller because the app chrome needs it on every page;
		// the WRITE is platform-admin only, below.
		r.Get("/branding", handlers.GetBranding)

		// Executive Dashboard — cross-workshop, read-only, approved output only.
		r.Get("/executive", handlers.GetExecutiveBrief)

		// Knowledge Workspace — organizational memory across workshops.
		r.Get("/knowledge/search", handlers.SearchKnowledge)
		r.Get("/knowledge/related", handlers.RelatedKnowledge)
		r.Get("/knowledge/trace", handlers.TraceKnowledge)
		r.Get("/knowledge/assets", handlers.ListKnowledgeAssets)
		r.Post("/knowledge/assets", handlers.PromoteKnowledge)
		r.Post("/knowledge/assets/{assetId}/publish", handlers.PublishKnowledge)
		r.Delete("/knowledge/assets/{assetId}", handlers.RemoveKnowledge)

		// Notifications — one recipient each; authorization is the recipient_id.
		r.Get("/notifications", handlers.ListNotifications)
		r.Post("/notifications/read-all", handlers.MarkAllNotificationsRead)
		r.Post("/notifications/{notificationId}/read", handlers.MarkNotificationRead)
		r.Delete("/notifications/{notificationId}", handlers.DeleteNotification)

		// Administration — platform-wide, gated on profiles.global_role.
		r.Get("/admin/users", handlers.ListAdminUsers)
		r.Put("/admin/users/{userId}/role", handlers.UpdateUserRole)
		r.Post("/admin/users/{userId}/status", handlers.SetUserStatus)
		// Platform IAM: create a login-capable account for a real address, and
		// mint a reset link. Both return a one-time link rather than emailing,
		// because Supabase's built-in mailer may silently drop mail to a
		// client's domain — see pkg/supaadmin.
		r.Post("/admin/users", handlers.CreateAdminUser)
		r.Post("/admin/users/{userId}/reset-password", handlers.ResetUserPassword)
		// Every workshop on the platform, so an admin can archive one or fix a
		// roster without first joining it.
		r.Get("/admin/workshops", handlers.ListAdminWorkshops)
		r.Get("/admin/workshops/{id}/participants", handlers.ListAdminWorkshopParticipants)
		// White labelling. The write is here rather than under /branding
		// because it is administration: a facilitator must not be able to
		// restyle the report that goes to the client's board.
		r.Get("/admin/organizations", handlers.ListAdminOrganizations)
		r.Put("/admin/organizations/{orgId}/branding", handlers.UpdateBranding)

		// The invitation copy, editable here rather than in the Supabase
		// dashboard — which is the only place it could live while GoTrue was
		// writing the words, and which is why the copy could never name the
		// inviter or the workshop. The delivery log is beside it because
		// "they never received it" is answered by the mail server's own words,
		// not by our record of having tried.
		r.Get("/admin/email-templates", handlers.ListEmailTemplates)
		r.Put("/admin/email-templates/{key}", handlers.UpdateEmailTemplate)
		r.Post("/admin/email-templates/{key}/preview", handlers.PreviewEmailTemplate)
		r.Post("/admin/email-templates/{key}/test", handlers.SendTestEmail)
		r.Get("/admin/email-deliveries", handlers.ListEmailDeliveries)

		// The confirmation somebody gets after choosing their password. Its
		// only possible recipient is the caller's own verified address, which
		// is what keeps an authenticated endpoint from being a way to mail
		// strangers.
		r.Post("/me/password-set", handlers.ConfirmPasswordSet)

		r.Get("/audit-events", handlers.ListAuditEvents)

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

			// Closing a stage. "stages" is another literal at the same depth as
			// the {kind} wildcard below, so it is registered up here with
			// "activities", "weights" and "ai"; router_test.go holds that.
			//
			// A stage's PROGRESS is derived from its content and needs no
			// endpoint — only the facilitator's decision that a stage is
			// finished is stored, because no count can mean "the room is done
			// talking about strengths". See pkg/handlers/stage_status.go.
			r.Put("/{id}/stages/{stageKey}/complete", handlers.SetStageComplete)
			r.Get("/{id}/factors", handlers.ListFactors)
			r.Post("/{id}/factors", handlers.CreateFactor)
			r.Patch("/{id}/factors/{factorId}", handlers.UpdateFactor)
			r.Delete("/{id}/factors/{factorId}", handlers.DeleteFactor)
			r.Post("/{id}/factors/{factorId}/review", handlers.ReviewFactor)

			// The capture board's hand-set order. "order" is a literal sitting
			// where "{factorId}" also sits, so chi must resolve the literal
			// first — it does, and router_test.go holds it to that. The verb
			// differs from every /factors/{factorId} route anyway, but the
			// guard is cheap and the next route added here may not differ.
			r.Put("/{id}/factors/order", handlers.SetFactorOrder)

			// Weights — the generic mechanism. "/{id}/weights" is a literal
			// sitting beside the {kind} wildcard below, so it is registered
			// first, like "ai" and "reports". router_test.go guards this.
			r.Get("/{id}/weights", handlers.GetWeights)

			// Voting is one instance of a weight. These two endpoints are
			// adapters kept for the prioritization UI and the UAT cases that
			// exercise it; see pkg/handlers/votes.go.
			r.Get("/{id}/votes", handlers.GetVotes)
			r.Put("/{id}/factors/{factorId}/vote", handlers.SetVote)
			r.Put("/{id}/factors/{factorId}/weights/{weightKey}", handlers.SetFactorWeight)

			// AI Strategy Assistant. Registered before the {kind} wildcard so
			// "ai" is never mistaken for an object route.
			r.Get("/{id}/ai", handlers.GetAIStatus)
			r.Post("/{id}/ai/execute", handlers.ExecuteAI)
			r.Get("/{id}/ai/outputs", handlers.ListAIOutputs)
			r.Post("/{id}/ai/outputs/{outputId}/review", handlers.ReviewAIOutput)

			// Participants. Membership writes are GO-ONLY: the RLS write
			// policies were removed in 20261003110000 after a participant was
			// shown to be able to promote themselves to facilitator through
			// PostgREST. Literals, so registered before the {kind} wildcard.
			r.Get("/{id}/participants", handlers.ListParticipants)
			r.Post("/{id}/participants", handlers.InviteParticipant)
			r.Patch("/{id}/participants/{userId}", handlers.SetParticipantRole)
			r.Delete("/{id}/participants/{userId}", handlers.RevokeParticipant)

			// Archiving — the lifecycle's last state, previously unreachable.
			r.Post("/{id}/archive", handlers.ArchiveWorkshop)
			r.Post("/{id}/unarchive", handlers.UnarchiveWorkshop)

			// "Merge and Fix" — the tracked, undoable board tidy-up. Another
			// literal beside the {kind} wildcard; router_test.go guards it.
			r.Post("/{id}/cleanup", handlers.RunCleanup)
			r.Get("/{id}/cleanup/runs", handlers.ListCleanupRuns)
			r.Post("/{id}/cleanup/runs/{runId}/undo", handlers.UndoCleanupRun)
			r.Post("/{id}/cleanup/changes/{changeId}/undo", handlers.UndoCleanupChange)

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
			r.Put("/{id}/{kind}/{objectId}/weights/{weightKey}", handlers.SetWeight)
		})
	})

	return r
}
