// Organization branding — white labelling.
//
// Two endpoints and one validator. The validator is the interesting part: a
// logo arrives as a base64 data URI in ordinary JSON, which means the request
// body is TEXT claiming to be an image. Everything downstream — the app
// header, the branding response, the report export's <img> — trusts that
// claim, so it is checked here once, properly, rather than at each consumer.
//
// WHY NO MULTIPART AND NO STORAGE BUCKET: see the migration
// 20261101100000_organization_branding.sql. In short, the report export
// already requires an inline data URI, so storing one avoids a conversion AND
// avoids introducing both a new Supabase subsystem and a second client write
// path around Go.
package handlers

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"net/http"
	"strings"

	// Registered for their side effects: image.Decode needs a decoder per
	// format or it reports "unknown format" for a perfectly good PNG.
	//
	// PNG and JPEG only, and that is a deliberate stop. WebP would need
	// golang.org/x/image — a new dependency, on this module's FIRST
	// third-party image code, to accept a format nobody has asked for. The
	// refusal below names WebP explicitly so the answer is a sentence rather
	// than a mystery.
	_ "image/jpeg"
	_ "image/png"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/response"
)

// maxLogoDataURI caps the stored string. Mirrored by a CHECK constraint on the
// column, because a limit enforced only in a handler is one the next writer
// does not know exists.
const maxLogoDataURI = 262144 // 256 KiB of base64 ≈ 190 KiB of image

// Branding is what every surface renders from. Null columns come back as
// empty strings and the CLIENT decides the fallback, because the fallbacks
// differ per surface: the header falls back to initials, the report cover
// falls back to no logo at all.
type Branding struct {
	OrganizationID string `json:"organization_id"`
	// The organization's own name, always present — so a caller can show
	// "Acme Group" even when nobody has set a display name.
	Name string `json:"name"`
	// The white-label product name, or "" to use the build-time default.
	DisplayName  string `json:"display_name"`
	LogoDataURI  string `json:"logo_data_uri"`
	LogoFilename string `json:"logo_filename"`
}

// GetBranding — GET /branding[?workshop_id=|?organization_id=]
//
// Resolution is deliberately explicit rather than clever. With a workshop or
// organization named, that one is used (after checking the caller can see it).
// With nothing named, the caller's brand is only unambiguous when they belong
// to exactly ONE organization; belonging to several has no single right
// answer, so it returns empty and the client keeps its build-time brand. A
// guess here would silently put one client's logo on another client's screen.
func GetBranding(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	user := httpctx.UserFromContext(r2.Context())
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	var row Branding
	var displayName, logo, filename *string

	// Every branch below is scoped by the caller's membership IN THE QUERY.
	// Go connects as postgres (rolbypassrls), so RLS protects nothing here —
	// the join through workspace_members IS the authorization.
	const cols = `o.id, o.name, o.display_name, o.logo_data_uri, o.logo_filename`
	var err error
	switch {
	case r2.URL.Query().Get("workshop_id") != "":
		err = pool.QueryRow(r2.Context(), `
			select `+cols+`
			  from public.workshops ws
			  join public.workspaces sp on sp.id = ws.workspace_id
			  join public.organizations o on o.id = sp.organization_id
			  join public.workspace_members wm
			    on wm.workspace_id = sp.id and wm.user_id = $2
			 where ws.id = $1`,
			r2.URL.Query().Get("workshop_id"), user.ID,
		).Scan(&row.OrganizationID, &row.Name, &displayName, &logo, &filename)

	case r2.URL.Query().Get("organization_id") != "":
		err = pool.QueryRow(r2.Context(), `
			select `+cols+`
			  from public.organizations o
			  join public.workspaces sp on sp.organization_id = o.id
			  join public.workspace_members wm
			    on wm.workspace_id = sp.id and wm.user_id = $2
			 where o.id = $1
			 limit 1`,
			r2.URL.Query().Get("organization_id"), user.ID,
		).Scan(&row.OrganizationID, &row.Name, &displayName, &logo, &filename)

	default:
		// Exactly one, or none. `limit 2` then counting is how "is it
		// unambiguous" gets answered without a second round trip.
		rows, qErr := pool.Query(r2.Context(), `
			select distinct `+cols+`
			  from public.organizations o
			  join public.workspaces sp on sp.organization_id = o.id
			  join public.workspace_members wm
			    on wm.workspace_id = sp.id and wm.user_id = $1
			 limit 2`, user.ID)
		if qErr != nil {
			failDB(w, qErr)
			return
		}
		defer rows.Close()
		found := 0
		for rows.Next() {
			found++
			if found > 1 {
				break
			}
			if sErr := rows.Scan(&row.OrganizationID, &row.Name,
				&displayName, &logo, &filename); sErr != nil {
				failDB(w, sErr)
				return
			}
		}
		if found != 1 {
			// None, or more than one. Both mean "no single brand applies".
			response.OK(w, Branding{})
			return
		}
	}

	if err == pgx.ErrNoRows {
		// Not found, or not visible to this caller. Deliberately the same
		// answer: branding is not a probe for which organizations exist.
		response.OK(w, Branding{})
		return
	}
	if err != nil {
		failDB(w, err)
		return
	}

	row.DisplayName = derefOr(displayName, "")
	row.LogoDataURI = derefOr(logo, "")
	row.LogoFilename = derefOr(filename, "")
	response.OK(w, row)
}

func derefOr(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return *p
}

// ListAdminOrganizations — GET /admin/organizations
//
// Every organization on the platform with its branding, so the admin panel can
// offer a picker. Platform-admin only, and NOT scoped to the caller's
// memberships: a platform administrator maintaining a client's branding should
// not have to be added to that client's workspace first, which was exactly
// the friction the /admin/workshops endpoint exists to remove.
func ListAdminOrganizations(w http.ResponseWriter, r *http.Request) {
	pool, _, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}

	rows, err := pool.Query(r.Context(), `
		select o.id, o.name, o.display_name, o.logo_data_uri, o.logo_filename,
		       (select count(*) from public.workspaces sp where sp.organization_id = o.id)
		  from public.organizations o
		 where o.status = 'active'
		 order by o.name`)
	if err != nil {
		failDB(w, err)
		return
	}
	defer rows.Close()

	type orgRow struct {
		Branding
		WorkspaceCount int `json:"workspace_count"`
	}
	out := []orgRow{}
	for rows.Next() {
		var o orgRow
		var displayName, logo, filename *string
		if err := rows.Scan(&o.OrganizationID, &o.Name, &displayName, &logo,
			&filename, &o.WorkspaceCount); err != nil {
			failDB(w, err)
			return
		}
		o.DisplayName = derefOr(displayName, "")
		o.LogoDataURI = derefOr(logo, "")
		o.LogoFilename = derefOr(filename, "")
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		failDB(w, err)
		return
	}
	response.OK(w, out)
}

type brandingBody struct {
	// Pointers so "not supplied" and "cleared" are different requests. A
	// plain string cannot express "leave the logo alone while renaming", and
	// an absent description erasing a factor's body is a bug this codebase
	// has already shipped once (see cleanup.go's proposedChange.Description).
	DisplayName  *string `json:"display_name"`
	LogoDataURI  *string `json:"logo_data_uri"`
	LogoFilename *string `json:"logo_filename"`
}

// UpdateBranding — PUT /admin/organizations/{orgId}/branding
//
// Platform administrators only. A facilitator must not be able to restyle the
// report that goes to the client's board.
func UpdateBranding(w http.ResponseWriter, r *http.Request) {
	pool, actorID, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	orgID := chi.URLParam(r, "orgId")

	var body brandingBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	// Build the update from the fields actually supplied.
	sets := []string{}
	args := []interface{}{orgID}
	add := func(col string, v interface{}) {
		args = append(args, v)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)))
	}

	if body.DisplayName != nil {
		name := strings.TrimSpace(*body.DisplayName)
		if name == "" {
			add("display_name", nil) // cleared → fall back to organizations.name
		} else if len(name) > 120 {
			response.Fail(w, response.CodeValidationError,
				"The display name is too long for the header — keep it under 120 characters.")
			return
		} else {
			add("display_name", name)
		}
	}

	if body.LogoDataURI != nil {
		raw := strings.TrimSpace(*body.LogoDataURI)
		if raw == "" {
			add("logo_data_uri", nil)
			add("logo_filename", nil)
		} else {
			if msg := validateLogoDataURI(raw); msg != "" {
				response.Fail(w, response.CodeValidationError, msg)
				return
			}
			add("logo_data_uri", raw)
			name := ""
			if body.LogoFilename != nil {
				name = strings.TrimSpace(*body.LogoFilename)
			}
			if len(name) > 200 {
				name = name[:200]
			}
			if name == "" {
				add("logo_filename", nil)
			} else {
				add("logo_filename", name)
			}
		}
	}

	if len(sets) == 0 {
		response.Fail(w, response.CodeValidationError,
			"Nothing to change — supply display_name, logo_data_uri, or both.")
		return
	}

	tag, err := pool.Exec(r.Context(),
		`update public.organizations set `+strings.Join(sets, ", ")+` where id = $1`, args...)
	if err != nil {
		failDB(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		response.Fail(w, response.CodeNotFound, "organization not found")
		return
	}

	// The logo itself is NOT written to the audit trail — a data URI would
	// bloat every row and the useful fact is that branding changed, by whom.
	meta := map[string]interface{}{}
	if body.DisplayName != nil {
		meta["display_name_set"] = strings.TrimSpace(*body.DisplayName) != ""
	}
	if body.LogoDataURI != nil {
		meta["logo_set"] = strings.TrimSpace(*body.LogoDataURI) != ""
		if body.LogoFilename != nil {
			meta["logo_filename"] = strings.TrimSpace(*body.LogoFilename)
		}
	}
	audit.Record(r.Context(), pool, actorID, "organization.branding_changed",
		"organization", orgID, "", "", meta)

	// Echo the stored state so the admin page renders from the server's
	// answer rather than from what it hoped it sent.
	var out Branding
	var displayName, logo, filename *string
	if err := pool.QueryRow(r.Context(), `
		select id, name, display_name, logo_data_uri, logo_filename
		  from public.organizations where id = $1`, orgID,
	).Scan(&out.OrganizationID, &out.Name, &displayName, &logo, &filename); err != nil {
		failDB(w, err)
		return
	}
	out.DisplayName = derefOr(displayName, "")
	out.LogoDataURI = derefOr(logo, "")
	out.LogoFilename = derefOr(filename, "")
	response.OK(w, out)
}

// validateLogoDataURI returns "" when the string is a safe, decodable raster
// image, and otherwise a sentence an administrator can act on.
//
// THREE CHECKS, EACH FOR A STATED REASON:
//
//  1. SVG IS REFUSED. An SVG can carry <script>, and this file is served
//     inline to every member of the organization and embedded in exported
//     reports. "Upload your logo" must not be a stored-XSS vector.
//  2. THE DECLARED MIME IS NOT TRUSTED. A caller writes the prefix, so
//     "data:image/png" proves nothing. The bytes are decoded and the format
//     the DECODER reports is what counts.
//  3. IT MUST ACTUALLY DECODE. Without this the column holds arbitrary
//     base64 that the report template later emits into an <img>, producing a
//     broken archival document nobody can explain.
func validateLogoDataURI(s string) string {
	if len(s) > maxLogoDataURI {
		return fmt.Sprintf(
			"That image is too large (%d KB encoded, limit %d KB). A header logo needs far less — export it at about 80px tall.",
			len(s)/1024, maxLogoDataURI/1024)
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "data:image/svg") || strings.Contains(lower, "svg+xml") {
		return "SVG logos are not accepted: an SVG can contain scripts, and this file is shown to everyone in the organization and embedded in exported reports. Please supply a PNG (with transparency) or a JPEG."
	}

	if strings.HasPrefix(lower, "data:image/webp") {
		return "WebP logos are not accepted. Please supply a PNG (with transparency) or a JPEG."
	}

	const marker = ";base64,"
	i := strings.Index(s, marker)
	if !strings.HasPrefix(lower, "data:image/") || i < 0 {
		return "That does not look like an image. Choose a PNG or JPEG file."
	}
	payload := s[i+len(marker):]
	bin, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return "The image could not be read — it may have been corrupted on the way. Try choosing the file again."
	}
	if len(bin) == 0 {
		return "That file is empty."
	}

	cfg, format, err := image.DecodeConfig(bytes.NewReader(bin))
	if err != nil {
		return "That file is not a readable PNG or JPEG image, whatever its name says."
	}
	switch format {
	case "png", "jpeg":
	default:
		return fmt.Sprintf("%s images are not accepted. Please supply a PNG or JPEG.", strings.ToUpper(format))
	}
	return checkDimensions(cfg.Width, cfg.Height)
}

// A logo renders into a 32px-tall header slot and a print cover. Something
// 8000px wide is a photograph somebody dropped in by mistake; saying so is
// more useful than storing it and letting the browser scale it.
func checkDimensions(wPx, hPx int) string {
	if wPx <= 0 || hPx <= 0 {
		return "That image reports no size and cannot be displayed."
	}
	if wPx > 4000 || hPx > 4000 {
		return fmt.Sprintf(
			"That image is %dx%d pixels — far larger than a logo needs. Around 240x80 (or 480x160 for sharp retina rendering) is ideal.",
			wPx, hPx)
	}
	return ""
}
