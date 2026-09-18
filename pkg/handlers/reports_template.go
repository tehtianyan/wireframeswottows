package handlers

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/auth"
	"swot-tows/pkg/authz"
	"swot-tows/pkg/db"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/response"
)

func poolFor(r *http.Request) (*pgxpool.Pool, error) {
	return db.Pool(r.Context())
}

// loadReportForWrite authorizes an edit and returns the report's current
// state, so callers can refuse edits to a published report consistently.
func loadReportForWrite(w http.ResponseWriter, r *http.Request) (
	context.Context, *pgxpool.Pool, *auth.User, string, string, string, bool,
) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return nil, nil, nil, "", "", "", false
	}
	ctx := r2.Context()
	user := httpctx.UserFromContext(ctx)
	workshopID := chi.URLParam(r2, "id")
	reportID := chi.URLParam(r2, "reportId")

	pool := mustPool(r2, w)
	if pool == nil {
		return nil, nil, nil, "", "", "", false
	}
	if _, err := authz.RequireWorkshopRole(ctx, pool, user.ID, workshopID, contributorRoles...); err != nil {
		writeAuthzErr(w, err)
		return nil, nil, nil, "", "", "", false
	}

	var state string
	err := pool.QueryRow(ctx,
		`select state from public.reports where id = $1 and workshop_id = $2`,
		reportID, workshopID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		response.Fail(w, response.CodeNotFound, "report not found in this workshop")
		return nil, nil, nil, "", "", "", false
	}
	if err != nil {
		response.Fail(w, response.CodeServerError, err.Error())
		return nil, nil, nil, "", "", "", false
	}
	return ctx, pool, user, workshopID, reportID, state, true
}

// reportHTMLTemplate is a self-contained export: styles inlined, no external
// requests, prints sensibly straight from a browser. Deliberately plain —
// this is an archival artifact, not the application UI.
const reportHTMLTemplate = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Report.Title}} — {{.Report.Version}}</title>
<style>
  @page { size: A4; margin: 18mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.55 Georgia, "Times New Roman", serif; color: #1a1a1a;
         background: #fff; margin: 0 auto; max-width: 860px; padding: 32px 24px; }
  header.cover { border-bottom: 2px solid #1a1a1a; padding-bottom: 18px; margin-bottom: 28px; }
  header.cover h1 { font-size: 26pt; margin: 0 0 6px; line-height: 1.2; }
  .meta { font: 9pt/1.5 ui-monospace, "SF Mono", Menlo, monospace; color: #555;
          text-transform: uppercase; letter-spacing: .05em; }
  nav.toc { margin: 0 0 32px; padding: 14px 18px; background: #f5f5f4; border-radius: 4px; }
  nav.toc p { margin: 0 0 8px; font: 9pt ui-monospace, monospace; text-transform: uppercase;
              letter-spacing: .06em; color: #555; }
  nav.toc ol { margin: 0; padding-left: 20px; }
  nav.toc a { color: #1a1a1a; }
  section.rs { margin: 0 0 30px; break-inside: avoid; }
  section.rs > h2 { font-size: 15pt; margin: 0 0 10px; padding-bottom: 5px;
                    border-bottom: 1px solid #ddd; }
  .ai { display: inline-block; font: 8pt ui-monospace, monospace; text-transform: uppercase;
        letter-spacing: .06em; color: #6d28d9; border: 1px solid #c4b5fd;
        border-radius: 3px; padding: 1px 5px; margin-left: 8px; vertical-align: middle; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .group { border: 1px solid #ddd; border-radius: 4px; padding: 12px 14px; break-inside: avoid; }
  .group h3 { margin: 0 0 8px; font-size: 11pt; text-transform: uppercase;
              letter-spacing: .05em; color: #333; }
  .group .pair { font: 8pt ui-monospace, monospace; color: #777; display: block;
                 margin-top: -4px; margin-bottom: 8px; }
  ul.items { margin: 0; padding-left: 18px; }
  ul.items li { margin-bottom: 5px; }
  ul.items .sub { display: block; color: #555; font-size: 10pt; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th, td { border: 1px solid #ddd; padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #f5f5f4; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em; }
  .chain { border-left: 3px solid #ddd; padding-left: 12px; margin-bottom: 14px; break-inside: avoid; }
  .chain h4 { margin: 0 0 4px; font-size: 11pt; }
  .chain .lvl { font-size: 9.5pt; color: #555; margin: 2px 0; }
  .chain .lvl b { font: 8pt ui-monospace, monospace; text-transform: uppercase;
                  letter-spacing: .05em; color: #777; }
  .empty { color: #777; font-style: italic; font-size: 10pt; }
  footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid #ddd;
           font: 8.5pt ui-monospace, monospace; color: #666; }
  @media print { body { padding: 0; max-width: none; } nav.toc { background: none; border: 1px solid #ddd; } }
</style>
</head>
<body>

<header class="cover">
  <h1>{{.Report.Title}}</h1>
  <p class="meta">{{.Workshop}} &middot; {{.Report.Version}} &middot; {{.Report.State}}</p>
</header>

<nav class="toc">
  <p>Contents</p>
  <ol>
  {{range .Report.Sections}}{{if .Included}}
    <li><a href="#s-{{.SectionKey}}">{{.Name}}</a></li>
  {{end}}{{end}}
  </ol>
</nav>

{{range .Report.Sections}}{{if .Included}}
<section class="rs" id="s-{{.SectionKey}}">
  <h2>{{.Name}}{{if ne .GeneratedBy "human"}}<span class="ai">{{.GeneratedBy}} drafted</span>{{end}}</h2>

  {{if eq .SectionType "narrative"}}
    {{if .Body}}<p>{{.Body}}</p>{{else}}<p class="empty">Not yet written.</p>{{end}}

  {{else if eq .SectionType "table"}}
    {{if .Items}}
    <table>
      <thead><tr><th>Recommendation</th><th>Priority</th><th>Expected benefit</th><th>Risk</th></tr></thead>
      <tbody>
      {{range .Items}}<tr>
        <td><strong>{{.Title}}</strong>{{if .Body}}<br>{{.Body}}{{end}}</td>
        <td>{{with index .Fields "priority"}}{{.}}{{end}}</td>
        <td>{{with index .Fields "benefits"}}{{.}}{{end}}</td>
        <td>{{with index .Fields "risks"}}{{.}}{{end}}</td>
      </tr>{{end}}
      </tbody>
    </table>
    {{else}}<p class="empty">Nothing approved to show.</p>{{end}}

  {{else if eq .SectionType "evidence_chain"}}
    {{if .Chains}}
      {{range .Chains}}
      <div class="chain">
        <h4>{{.Root.Title}}</h4>
        {{range $kind, $items := .Supports}}
          <p class="lvl"><b>{{$kind}}</b>
          {{range $i, $it := $items}}{{if $i}}; {{end}}{{$it.Title}}{{end}}</p>
        {{end}}
      </div>
      {{end}}
    {{else}}<p class="empty">No evidence chain available.</p>{{end}}

  {{else if .Groups}}
    <div class="grid">
    {{range .Groups}}
      <div class="group">
        <h3>{{.Name}}</h3>
        {{if .SourceName}}<span class="pair">{{.SourceName}} &times; {{.TargetName}}</span>{{end}}
        {{if .Items}}
        <ul class="items">
          {{range .Items}}<li>{{.Title}}{{if .Body}}<span class="sub">{{.Body}}</span>{{end}}</li>{{end}}
        </ul>
        {{else}}<p class="empty">None.</p>{{end}}
      </div>
    {{end}}
    </div>

  {{else}}
    {{if .Items}}
    <ul class="items">
      {{range .Items}}<li><strong>{{.Title}}</strong>{{if .Body}}<span class="sub">{{.Body}}</span>{{end}}</li>{{end}}
    </ul>
    {{else}}<p class="empty">Nothing approved to show.</p>{{end}}
  {{end}}
</section>
{{end}}{{end}}

<footer>
  Generated {{.GeneratedAt}} &middot; {{.Report.Version}} &middot;
  {{if .Report.FromSnapshot}}Published content, frozen at publication{{else}}Draft — reflects current workshop data{{end}}
</footer>

</body>
</html>
`
