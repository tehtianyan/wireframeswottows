package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/audit"
	"swot-tows/pkg/httpctx"
	"swot-tows/pkg/mailer"
	"swot-tows/pkg/response"
)

// ---- Administration: the copy, the mail setup, and what actually happened ----

// ListEmailTemplates — GET /admin/email-templates
//
// The copy, the vocabulary each template may use, and the SMTP status in one
// response. The status belongs here because "why did they not get it?" is
// answered first by "is sending switched on at all?", and that was previously
// visible only in deploy logs.
func ListEmailTemplates(w http.ResponseWriter, r *http.Request) {
	pool, _, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}

	rows, err := pool.Query(r.Context(), `
		select t.key, t.subject, t.body, t.updated_at,
		       coalesce(nullif(btrim(p.display_name), ''), p.email, '')
		  from public.email_templates t
		  left join public.profiles p on p.id = t.updated_by
		 order by t.key`)
	if err != nil {
		failDB(w, err)
		return
	}
	defer rows.Close()

	type tplRow struct {
		emailTemplate
		UpdatedAt string `json:"updated_at"`
		UpdatedBy string `json:"updated_by"`
		// Placeholders the copy CURRENTLY uses, and every one it MAY use. The
		// second is what makes the editor usable without documentation.
		Uses    []string `json:"uses"`
		Allowed []string `json:"allowed"`
	}
	out := []tplRow{}
	for rows.Next() {
		var t tplRow
		var at time.Time
		if err := rows.Scan(&t.Key, &t.Subject, &t.Body, &at, &t.UpdatedBy); err != nil {
			failDB(w, err)
			return
		}
		t.UpdatedAt = at.Format(time.RFC3339)
		t.Uses = mailer.Placeholders(t.Subject + "\n" + t.Body)
		t.Allowed = mailer.Vocabulary[t.Key]
		if t.Allowed == nil {
			// A key the CHECK allows but Go has no vocabulary for would give
			// an editor with no guidance, so say so rather than show nothing.
			t.Allowed = []string{}
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		failDB(w, err)
		return
	}

	response.OK(w, map[string]interface{}{
		"templates": out,
		"mail":      mailConfig().Status(),
	})
}

type emailTemplateBody struct {
	// Pointers, so "leave the subject alone while rewriting the body" is
	// expressible. Same reasoning as brandingBody.
	Subject *string `json:"subject"`
	Body    *string `json:"body"`
}

// UpdateEmailTemplate — PUT /admin/email-templates/{key}
//
// Platform-admin only, like branding: the words that go out over the product's
// name to a client's staff are administration, not something a facilitator
// should be able to rewrite.
func UpdateEmailTemplate(w http.ResponseWriter, r *http.Request) {
	pool, actor, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	key := chi.URLParam(r, "key")
	if !mailer.KnownTemplate(key) {
		response.Fail(w, response.CodeNotFound, "There is no email template called "+key+".")
		return
	}

	var body emailTemplateBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}

	current, err := loadEmailTemplate(ctx, pool, key)
	if err != nil {
		failDB(w, err)
		return
	}
	subject := current.Subject
	if body.Subject != nil {
		subject = strings.TrimSpace(*body.Subject)
	}
	text := current.Body
	if body.Body != nil {
		text = *body.Body
	}

	if subject == "" || strings.TrimSpace(text) == "" {
		// A configured-to-nothing state that reads as a bug: the invitation
		// goes out with no subject and no words. Also enforced by a CHECK,
		// because a limit that lives only in a handler is one the next writer
		// does not know about.
		response.Fail(w, response.CodeValidationError,
			"The subject and the message both need some words in them.")
		return
	}

	// REFUSED AT SAVE TIME, not blanked at send time. A typo like
	// {{inviter}} would otherwise render as nothing at all, and the first
	// person to notice would be the invitee reading a sentence with a hole in
	// it. The one person who can fix it is the one making this request.
	if bad := mailer.UnknownPlaceholders(key, subject+"\n"+text); len(bad) > 0 {
		response.Fail(w, response.CodeValidationError,
			"This template has no "+strings.Join(wrapEach(bad, "{{", "}}"), ", ")+
				". The ones it can use are: "+
				strings.Join(wrapEach(mailer.Vocabulary[key], "{{", "}}"), ", ")+".")
		return
	}
	// The action link is what the whole message exists to deliver. Dropping it
	// produces a perfectly well-formed invitation that nobody can accept —
	// the same shape as every other "looked like it worked" defect here.
	if needsActionURL(key) && !strings.Contains(text, "{{action_url}}") {
		response.Fail(w, response.CodeValidationError,
			"The message must include {{action_url}} — without it the recipient has no way in.")
		return
	}

	if _, err := pool.Exec(ctx, `
		update public.email_templates
		   set subject = $2, body = $3, updated_at = now(), updated_by = $4
		 where key = $1`, key, subject, text, actor); err != nil {
		failDB(w, err)
		return
	}

	audit.Record(ctx, pool, actor, "email_template.updated", "email_template", key, "", "",
		map[string]interface{}{"subject": subject})

	response.OK(w, map[string]interface{}{
		"key": key, "subject": subject, "body": text,
		"uses": mailer.Placeholders(subject + "\n" + text),
	})
}

// needsActionURL reports whether a template is useless without its link. The
// confirmation message deliberately carries none — it is a reassurance after
// the fact, and a one-time link in it would be a credential nobody needs.
func needsActionURL(key string) bool { return key != mailer.TemplateConfirmation }

func wrapEach(items []string, pre, post string) []string {
	out := make([]string, 0, len(items))
	for _, s := range items {
		out = append(out, pre+s+post)
	}
	return out
}

// PreviewEmailTemplate — POST /admin/email-templates/{key}/preview
//
// Renders the copy with representative values, THROUGH THE SAME RENDERER the
// send path uses. The branding panel already taught this: a preview that
// computes its own answer is confidently wrong, and the one thing a preview
// must never do is disagree with what goes out.
func PreviewEmailTemplate(w http.ResponseWriter, r *http.Request) {
	pool, _, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	key := chi.URLParam(r, "key")
	if !mailer.KnownTemplate(key) {
		response.Fail(w, response.CodeNotFound, "There is no email template called "+key+".")
		return
	}

	// The body may carry unsaved edits, so an administrator can see the effect
	// before committing it.
	var body emailTemplateBody
	_ = json.NewDecoder(r.Body).Decode(&body)

	current, err := loadEmailTemplate(r.Context(), pool, key)
	if err != nil {
		failDB(w, err)
		return
	}
	subject, text := current.Subject, current.Body
	if body.Subject != nil && strings.TrimSpace(*body.Subject) != "" {
		subject = *body.Subject
	}
	if body.Body != nil && strings.TrimSpace(*body.Body) != "" {
		text = *body.Body
	}

	vars := sampleVars(strings.TrimRight(siteURL(), "/"), productNameFor(r.Context(), pool, ""))
	rendered := mailer.Render(text, vars)
	response.OK(w, map[string]interface{}{
		"subject": strings.TrimSpace(strings.ReplaceAll(mailer.Render(subject, vars), "\n", " ")),
		"text":    rendered,
		"html":    mailer.TextToHTML(rendered),
	})
}

// sampleVars is one set of plausible values for every placeholder in the
// vocabulary, so a preview of any template is complete.
//
// Deliberately obvious as an example: "Dana Okonjo" and a workshop name no
// client has. A preview seeded with real-looking client data invites somebody
// to mistake it for a sent message.
func sampleVars(site, product string) map[string]string {
	return map[string]string{
		"recipient_name":  "Sam",
		"recipient_email": "sam.rivera@example.com",
		"inviter_name":    "Dana Okonjo",
		"inviter_email":   "dana.okonjo@example.com",
		"workshop_name":   "Example Growth Strategy Review",
		"role":            roleWords("participant"),
		"objective_line":  objectiveLine("Agree where to invest next year."),
		"action_url":      site + "/welcome?token_hash=EXAMPLE-ONE-TIME-TOKEN&type=recovery&flow=invite",
		"product_name":    product,
		"site_url":        site,
		"workshop_list":   "  - Example Growth Strategy Review (Participant)\n",
	}
}

// SendTestEmail — POST /admin/email-templates/{key}/test
//
// TO THE CALLER'S OWN ADDRESS, and no other. An admin panel that mails
// arbitrary addresses on request is an open relay with a login page in front
// of it, and the reputation damage from that lands on the sending domain —
// which is the same reputation every real invitation depends on.
//
// Testing by mailing yourself is also the only honest test of deliverability:
// the question is not whether the server accepted the message but whether it
// arrived, and nothing in this process can observe an inbox.
func SendTestEmail(w http.ResponseWriter, r *http.Request) {
	pool, actor, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	key := chi.URLParam(r, "key")
	if !mailer.KnownTemplate(key) {
		response.Fail(w, response.CodeNotFound, "There is no email template called "+key+".")
		return
	}
	if !mailConfig().Configured() {
		response.Fail(w, response.CodeServerError,
			"No SMTP server is configured, so nothing can be sent. Set SMTP_HOST, SMTP_USERNAME, "+
				"SMTP_PASSWORD and MAIL_FROM on the server.")
		return
	}

	var to string
	if err := pool.QueryRow(ctx, `select email from public.profiles where id = $1`, actor).Scan(&to); err != nil {
		failDB(w, err)
		return
	}

	vars := sampleVars(strings.TrimRight(siteURL(), "/"), productNameFor(ctx, pool, ""))
	vars["recipient_email"] = to
	subject, out := sendTemplated(ctx, pool, key, to, "", vars, actor, "")
	if out.Err != nil {
		response.Fail(w, response.CodeServerError,
			"The test message was not accepted by the mail server: "+out.Err.Error())
		return
	}
	response.OK(w, map[string]interface{}{
		"sent_to": to, "subject": subject,
		"note": "The mail server accepted it. That is not the same as it arriving — " +
			"check the inbox, and the spam folder.",
	})
}

// ListEmailDeliveries — GET /admin/email-deliveries
//
// What was actually attempted, and what the mail server said. This is the
// answer to "they never received it", which was previously unanswerable: the
// audit row recorded our intention to email, not the outcome.
func ListEmailDeliveries(w http.ResponseWriter, r *http.Request) {
	pool, _, ok := requirePlatformAdmin(w, r)
	if !ok {
		return
	}
	rows, err := pool.Query(r.Context(), `
		select d.id, d.to_email, d.template_key, d.subject, d.status,
		       coalesce(d.error, ''), d.route, d.created_at,
		       coalesce(w.name, '')
		  from public.email_deliveries d
		  left join public.workshops w on w.id = d.workshop_id
		 order by d.created_at desc
		 limit 100`)
	if err != nil {
		failDB(w, err)
		return
	}
	defer rows.Close()

	type delivery struct {
		ID           string `json:"id"`
		ToEmail      string `json:"to_email"`
		TemplateKey  string `json:"template_key"`
		Subject      string `json:"subject"`
		Status       string `json:"status"`
		Error        string `json:"error"`
		Route        string `json:"route"`
		CreatedAt    string `json:"created_at"`
		WorkshopName string `json:"workshop_name"`
	}
	out := []delivery{}
	for rows.Next() {
		var d delivery
		var at time.Time
		if err := rows.Scan(&d.ID, &d.ToEmail, &d.TemplateKey, &d.Subject, &d.Status,
			&d.Error, &d.Route, &at, &d.WorkshopName); err != nil {
			failDB(w, err)
			return
		}
		d.CreatedAt = at.Format(time.RFC3339)
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		failDB(w, err)
		return
	}
	response.OK(w, out)
}

// ---- Forgotten passwords: the one public endpoint ----

type forgotBody struct {
	Email string `json:"email"`
}

// The same answer whatever happened, so the endpoint cannot be used to find
// out which addresses have accounts.
const forgotAnswer = "If that address has an account, a link to choose a new password is on its way. " +
	"It can only be used once. Check the spam folder if it does not arrive within a few minutes."

// ForgotPassword — POST /auth/forgot-password. PUBLIC, by necessity.
//
// WHY IT EXISTS. There was no way back in. Somebody who forgot their password
// had to find an administrator, who had to mint a link and pass it on by hand,
// and until then the sign-in page simply asked again for the thing they did
// not know. That is not a gap in a nice-to-have; it is the single commonest
// reason a real person cannot use an application.
//
// THREE PROPERTIES, each deliberate:
//
//  1. THE ANSWER NEVER VARIES. Same message for an address with an account, an
//     address without one, and a disabled account. A public endpoint that
//     distinguishes them is an account-enumeration oracle — feed it a list and
//     it tells you who your client's staff are.
//  2. A DISABLED ACCOUNT IS REFUSED, silently. A reset would hand back access
//     that was deliberately withdrawn, which is the same hole as the "disable
//     user" that disabled nothing.
//  3. IT IS RATE-LIMITED PER ADDRESS. Without that, anybody could mail
//     somebody else a reset link every second — annoying for them, and
//     reputational poison for the sending domain, which every real invitation
//     then depends on. The limit is checked BEFORE any send, the way the AI
//     rate limits are checked before any provider call.
func ForgotPassword(w http.ResponseWriter, r *http.Request) {
	pool := mustPool(r, w)
	if pool == nil {
		return
	}
	ctx := r.Context()

	var body forgotBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Fail(w, response.CodeValidationError, "invalid request body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if _, err := mail.ParseAddress(email); err != nil {
		// The one case that does NOT get the uniform answer, because it tells
		// an attacker nothing and telling the person their address is
		// malformed is genuinely useful.
		response.Fail(w, response.CodeValidationError, "That is not a valid email address.")
		return
	}

	// Rate limit first, and answer identically when it trips: a different
	// response here would leak that the address has an account worth limiting.
	var recent int
	if err := pool.QueryRow(ctx, `
		select count(*) from public.email_deliveries
		 where lower(to_email) = $1
		   and template_key = $2
		   and created_at > now() - interval '15 minutes'`,
		email, mailer.TemplatePasswordReset).Scan(&recent); err != nil {
		failDB(w, err)
		return
	}
	if recent >= 3 {
		response.OK(w, map[string]interface{}{"message": forgotAnswer})
		return
	}

	var userID, status, name string
	err := pool.QueryRow(ctx, `
		select id::text, coalesce(status, 'active'),
		       coalesce(nullif(btrim(display_name), ''), '')
		  from public.profiles where lower(email) = $1`, email,
	).Scan(&userID, &status, &name)

	switch {
	case err == pgx.ErrNoRows, err == nil && status != "active":
		// Recorded as skipped WITH the uniform answer going back, so an
		// administrator looking at the log can see that somebody tried and
		// why nothing was sent — the silence is explained on our side without
		// being explained to the caller.
		recordDelivery(ctx, pool, email, mailer.TemplatePasswordReset,
			"(no message sent)", deliveryOutcome{Route: "link", Skipped: true}, "", "")
		response.OK(w, map[string]interface{}{"message": forgotAnswer})
		return
	case err != nil:
		failDB(w, err)
		return
	}

	if !mailConfig().Configured() {
		// NOTHING TO HAND BACK on a public endpoint: returning the link here
		// would mail-less "reset" anybody's password by asking for it. So the
		// answer stays uniform and the failure is recorded for the
		// administrator, who is the only person who can fix it.
		recordDelivery(ctx, pool, email, mailer.TemplatePasswordReset, "(not sent)",
			deliveryOutcome{Route: "link", Err: errNoMailForReset}, "", "")
		response.OK(w, map[string]interface{}{"message": forgotAnswer})
		return
	}

	link, err := mintAppLink(ctx, email, false)
	if err != nil {
		recordDelivery(ctx, pool, email, mailer.TemplatePasswordReset, "(not sent)",
			deliveryOutcome{Route: "link", Err: err}, "", "")
		response.OK(w, map[string]interface{}{"message": forgotAnswer})
		return
	}

	_, out := sendTemplated(ctx, pool, mailer.TemplatePasswordReset, email, "",
		map[string]string{
			"recipient_name":  firstOrAddress(name, email),
			"recipient_email": email,
			"action_url":      link,
			"product_name":    productNameFor(ctx, pool, ""),
			"site_url":        strings.TrimRight(siteURL(), "/"),
		}, "", "")

	// The actor is the account itself, not an administrator — this was
	// self-service. Recorded because a reset request is a security-relevant
	// event even when it succeeds, and the link is NOT recorded, for the same
	// reason it never reaches audit_events: until used it is a bearer
	// credential.
	audit.Record(ctx, pool, userID, "user.password_reset_requested", "profile", userID, "", "",
		map[string]interface{}{"email": email, "emailed": out.Err == nil})

	response.OK(w, map[string]interface{}{"message": forgotAnswer})
}

var errNoMailForReset = mailer.ErrNotConfigured

// ---- The confirmation, after somebody sets their password ----

// ConfirmPasswordSet — POST /me/password-set
//
// Item 5: the reassurance. Setting a password on a one-time link is the moment
// somebody becomes a participant, and nothing confirmed it — they were left
// wondering whether it had worked, with no record of the address they used and
// no ordinary sign-in URL to keep. The one-time link is deliberately not one.
//
// AUTHENTICATED, so this is not a way to mail anybody: the only address it can
// write to is the caller's own, taken from their verified token rather than
// from the request.
//
// It is also IDEMPOTENT ENOUGH. The client calls it right after a successful
// password change, and a retry, a double-click or a second password change the
// same day must not produce a second identical message. A send inside the last
// day is treated as already done.
func ConfirmPasswordSet(w http.ResponseWriter, r *http.Request) {
	r2, ok := httpctx.RequireAuth(w, r)
	if !ok {
		return
	}
	ctx := r2.Context()
	user := httpctx.UserFromContext(ctx)
	pool := mustPool(r2, w)
	if pool == nil {
		return
	}

	var email, name string
	if err := pool.QueryRow(ctx, `
		select email, coalesce(nullif(btrim(display_name), ''), '')
		  from public.profiles where id = $1`, user.ID).Scan(&email, &name); err != nil {
		failDB(w, err)
		return
	}

	if !mailConfig().Configured() {
		// Not an error the person should see: their password IS set and they
		// ARE signed in. A failure here must not make a successful onboarding
		// look broken.
		response.OK(w, map[string]interface{}{"sent": false, "reason": "no SMTP configured"})
		return
	}

	var already int
	if err := pool.QueryRow(ctx, `
		select count(*) from public.email_deliveries
		 where lower(to_email) = lower($1) and template_key = $2
		   and status = 'sent' and created_at > now() - interval '1 day'`,
		email, mailer.TemplateConfirmation).Scan(&already); err != nil {
		failDB(w, err)
		return
	}
	if already > 0 {
		response.OK(w, map[string]interface{}{"sent": false, "reason": "already sent today"})
		return
	}

	// The workshops they are actually on, named. "You are now a participant"
	// with nothing after it is the kind of reassurance that reassures nobody;
	// seeing the workshop they were invited to is what closes the loop with
	// the invitation they accepted.
	list, firstWorkshop := workshopListFor(ctx, pool, user.ID)

	_, out := sendTemplated(ctx, pool, mailer.TemplateConfirmation, email, "",
		map[string]string{
			"recipient_name":  firstOrAddress(name, email),
			"recipient_email": email,
			"workshop_list":   list,
			"product_name":    productNameFor(ctx, pool, firstWorkshop),
			"site_url":        strings.TrimRight(siteURL(), "/"),
		}, user.ID, firstWorkshop)

	if out.Err != nil {
		// Reported as data rather than as a failed request, for the same
		// reason: the onboarding succeeded.
		response.OK(w, map[string]interface{}{"sent": false, "reason": out.Err.Error()})
		return
	}
	response.OK(w, map[string]interface{}{"sent": true, "to": email})
}

// workshopListFor renders the caller's live workshops as an indented block,
// which TextToHTML keeps aligned rather than reflowing into a paragraph.
//
// Scoped by BOTH memberships in the query, like every other cross-workshop
// read here: Go connects as postgres and bypasses RLS, so the join IS the
// authorization. Archived and completed ones are left out — this message is
// about what they can do now.
func workshopListFor(ctx context.Context, pool *pgxpool.Pool, userID string) (string, string) {
	rows, err := pool.Query(ctx, `
		select w.id::text, w.name, wm.role
		  from public.workshop_members wm
		  join public.workshops w on w.id = wm.workshop_id
		  join public.workspaces sp on sp.id = w.workspace_id
		  join public.workspace_members wsm
		    on wsm.workspace_id = sp.id and wsm.user_id = wm.user_id
		 where wm.user_id = $1
		   and w.status not in ('completed', 'archived')
		 order by w.created_at desc
		 limit 10`, userID)
	if err != nil {
		return "", ""
	}
	defer rows.Close()

	var b strings.Builder
	first := ""
	for rows.Next() {
		var id, name, role string
		if err := rows.Scan(&id, &name, &role); err != nil {
			break
		}
		if first == "" {
			first = id
		}
		b.WriteString("  - " + name + " (" + roleLabel(role) + ")\n")
	}
	if b.Len() == 0 {
		// Somebody can legitimately have no workshop yet — an account created
		// from /admin before being invited to one. The template's list
		// placeholder goes empty and Render's tidy() closes the gap, so the
		// message reads as a plain welcome rather than as a broken list.
		return "", ""
	}
	return b.String(), first
}
