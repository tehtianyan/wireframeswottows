package handlers

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"swot-tows/pkg/mailer"
	"swot-tows/pkg/supaadmin"
)

// The product's own transactional mail: loading the editable copy, filling in
// the facts, sending it, and recording what happened.
//
// WHY A DELIVERY LOG AT ALL. "A user with a yahoo.com address never received
// the invitation" was unanswerable. The audit row said `delivery: emailed`,
// which recorded what we INTENDED, not what the mail server said — so a
// rejection, a greylist deferral, an unconfigured sender and a successful send
// were indistinguishable from the administration page. Every send now writes a
// row with the server's own words, and /admin shows them. That does not make
// mail arrive, but it turns "it vanished" into a sentence somebody can act on,
// which is the part that was actually ours to fix.

// mailConfig is a function so a test can substitute one. Production reads the
// environment every time rather than caching, so changing the provider is a
// redeploy and not a rebuild.
var mailConfig = mailer.Load

// emailTemplate is one piece of editable copy.
type emailTemplate struct {
	Key     string `json:"key"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}

func loadEmailTemplate(ctx context.Context, pool *pgxpool.Pool, key string) (emailTemplate, error) {
	t := emailTemplate{Key: key}
	err := pool.QueryRow(ctx,
		`select subject, body from public.email_templates where key = $1`, key,
	).Scan(&t.Subject, &t.Body)
	return t, err
}

// deliveryOutcome is what happened to one message.
type deliveryOutcome struct {
	// Route is 'smtp' when we sent it ourselves, 'supabase' when GoTrue's
	// mailer did, 'link' when nothing could be mailed and a link was handed
	// over instead.
	Route string
	// Err is nil on success. Its text is the server's own words.
	Err error
	// Skipped means NOTHING WAS SENT and that is not a failure: a reset asked
	// for an address with no account, or a link handed over by choice.
	//
	// IT HAS TO BE EXPLICIT. Deriving the status from Err alone recorded these
	// as 'sent', so the delivery log asserted that a message went to an
	// address no message was ever addressed to — a log that lies about the one
	// thing it exists to answer is worse than no log, and this is the table
	// somebody will consult when told "I never received it". Caught by
	// tests/suites/invites.js.
	Skipped bool
}

// recordDelivery writes the attempt, success or failure.
//
// Best-effort by design, and it SAYS SO when it fails. The lesson from
// audit.Record silently discarding every write for three phases is that a
// best-effort helper which swallows its own errors leaves a table that looks
// empty for a reason nobody can find.
func recordDelivery(ctx context.Context, pool *pgxpool.Pool, toEmail, key, subject string,
	out deliveryOutcome, actorID, workshopID string) {
	status := "sent"
	var errText *string
	switch {
	case out.Err != nil:
		status = "failed"
		s := out.Err.Error()
		errText = &s
	case out.Skipped:
		status = "skipped"
	}
	var actor, workshop *string
	if actorID != "" {
		actor = &actorID
	}
	if workshopID != "" {
		workshop = &workshopID
	}
	if _, err := pool.Exec(ctx, `
		insert into public.email_deliveries
		  (to_email, template_key, subject, status, error, route, actor_id, workshop_id)
		values ($1, $2, $3, $4, $5, $6, $7, $8)`,
		toEmail, key, subject, status, errText, out.Route, actor, workshop); err != nil {
		fmt.Fprintf(os.Stderr, "recordDelivery(%s, %s): %v\n", toEmail, key, err)
	}
}

// sendTemplated renders a template and sends it, returning what happened.
//
// It does NOT decide whether sending was the right thing to do, and it does
// not fall back — the caller owns the ladder, because only the caller knows
// what to do instead.
func sendTemplated(ctx context.Context, pool *pgxpool.Pool, key, to, replyTo string,
	vars map[string]string, actorID, workshopID string) (string, deliveryOutcome) {
	cfg := mailConfig()
	tpl, err := loadEmailTemplate(ctx, pool, key)
	if err != nil {
		return "", deliveryOutcome{Route: "smtp", Err: fmt.Errorf("the %s email template could not be loaded: %w", key, err)}
	}

	subject := mailer.Render(tpl.Subject, vars)
	// A subject is one line. Render's tidy() guarantees a trailing newline,
	// which belongs in a body and would be an invalid header here.
	subject = strings.TrimSpace(strings.ReplaceAll(subject, "\n", " "))
	body := mailer.Render(tpl.Body, vars)

	out := deliveryOutcome{Route: "smtp", Err: cfg.Send(ctx, mailer.Message{
		To: to, Subject: subject, Text: body, ReplyTo: replyTo,
	})}
	recordDelivery(ctx, pool, to, key, subject, out, actorID, workshopID)
	return subject, out
}

// productNameFor resolves the brand the recipient will recognise.
//
// Per-organization, through the workshop, because white labelling is already
// per-organization and an invitation signed with the wrong product name is
// worse than one signed with a generic one. Falls back to the deployment's
// brand and finally to a plain phrase — never to an empty string, which would
// leave the message signed with nothing.
func productNameFor(ctx context.Context, pool *pgxpool.Pool, workshopID string) string {
	if workshopID != "" {
		var name *string
		_ = pool.QueryRow(ctx, `
			select coalesce(o.display_name, o.name)
			  from public.workshops ws
			  join public.workspaces sp on sp.id = ws.workspace_id
			  join public.organizations o on o.id = sp.organization_id
			 where ws.id = $1`, workshopID).Scan(&name)
		if name != nil && strings.TrimSpace(*name) != "" {
			return strings.TrimSpace(*name)
		}
	}
	for _, k := range []string{"BRAND_NAME", "VITE_BRAND_NAME"} {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return "the Strategy Workspace"
}

// mintAppLink produces the one-time credential as a link to OUR OWN page.
//
// Prefetch-proof, which is the whole point: see supaadmin.AppVerifyURL. The
// GoTrue action link is the fallback for a project that returns no hashed
// token, and it is the form that a mail scanner can destroy.
func mintAppLink(ctx context.Context, email string, firstTime bool) (string, error) {
	minted, err := supaadmin.GenerateLink(ctx, supaadmin.LinkRecovery, email, siteURL())
	if err != nil {
		return "", err
	}
	if app := supaadmin.AppVerifyURL(siteURL(), minted.HashedToken, firstTime); app != "" {
		return app, nil
	}
	return minted.ActionLink, nil
}

// objectiveLine is the optional sentence about what the workshop is for.
//
// Empty when there is no objective, and `Render`'s tidy() then closes the gap
// — which is why the template can put it on its own line without risking a
// message with a visible hole in it.
func objectiveLine(objective string) string {
	o := strings.TrimSpace(objective)
	if o == "" {
		return ""
	}
	return "What the workshop is for: " + o + "\n"
}

// inviteFacts is everything the invitation says beyond the link.
type inviteFacts struct {
	To            string
	RecipientName string
	InviterName   string
	InviterEmail  string
	WorkshopID    string
	WorkshopName  string
	Objective     string
	Role          string
	FirstTime     bool
}

func (f inviteFacts) vars(actionURL, productName string) map[string]string {
	return map[string]string{
		"recipient_name":  firstOrAddress(f.RecipientName, f.To),
		"recipient_email": f.To,
		"inviter_name":    f.InviterName,
		"inviter_email":   f.InviterEmail,
		"workshop_name":   f.WorkshopName,
		"role":            roleWords(f.Role),
		"objective_line":  objectiveLine(f.Objective),
		"action_url":      actionURL,
		"product_name":    productName,
		"site_url":        strings.TrimRight(siteURL(), "/"),
	}
}

// firstOrAddress is what to call somebody in a greeting.
//
// The first name when we have a real one, the address otherwise — and NOT the
// full address when a name exists, because "Hello sam@acme.com" is the
// register of bulk mail, which is precisely the impression an invitation must
// not give. The invite handler defaults an absent name to the email address,
// so this also has to notice when "the name" is really the address.
func firstOrAddress(name, email string) string {
	n := strings.TrimSpace(name)
	if n == "" || strings.EqualFold(n, email) {
		return email
	}
	return firstOf(n)
}

// inviteDelivery is how one invitation actually reached somebody, in enough
// detail for the inviter to know what to do next.
type inviteDelivery struct {
	Delivery string
	Route    string
	Link     string
	LinkType string
	Warning  string
	// Notice explains a delivery that WORKED but is not the one intended —
	// specifically, GoTrue's own "Reset Your Password" mail going out because
	// this server has no SMTP configured. Without it, the invitation looks
	// successful and the recipient still gets the message that reads as
	// phishing, with nobody told why.
	Notice   string
	FellBack string
	Err      error
}

// deliverInvite is the delivery ladder, and the order is the design.
//
//  1. Our own mail, when SMTP is configured: our copy, naming the inviter and
//     the workshop, with a prefetch-proof link to our own page.
//  2. GoTrue's mailer, when it is not: unchanged behaviour, so nothing
//     regresses before SMTP is set up — but SAID OUT LOUD, because that is the
//     path that sends "Reset Your Password" to somebody who was invited to a
//     workshop.
//  3. A link to pass on by hand, when no mail can be sent or the send failed.
//
// An invitation that reports success while leaving somebody no way in is the
// worst outcome this code has, so every rung falls to the next rather than
// failing, and every fall is reported.
func deliverInvite(ctx context.Context, pool *pgxpool.Pool, actorID string,
	f inviteFacts, preferLink bool) inviteDelivery {

	cfg := mailConfig()

	// Rung 1 — our own message.
	//
	// A WORKSHOP IS REQUIRED FOR IT, and that is the rule rather than an
	// oversight. The invitation's whole improvement is that it names the
	// workshop and the person who invited you; rendered with those blank it
	// would be a message with holes where its credibility is supposed to be.
	// An account created straight from /admin has no workshop yet, so it takes
	// the rungs below and the administrator is told which template went out.
	if !preferLink && cfg.Configured() && strings.TrimSpace(f.WorkshopName) != "" {
		actionURL, err := mintAppLink(ctx, f.To, f.FirstTime)
		if err == nil {
			product := productNameFor(ctx, pool, f.WorkshopID)
			_, out := sendTemplated(ctx, pool, mailer.TemplateParticipantInvite,
				f.To, f.InviterEmail, f.vars(actionURL, product), actorID, f.WorkshopID)
			if out.Err == nil {
				return inviteDelivery{Delivery: "emailed", Route: "smtp", LinkType: linkKind(f.FirstTime)}
			}
			// The send failed, so the credential minted above was never
			// delivered. REUSE it rather than minting another: a second
			// generate_link would invalidate the first for no reason and
			// consumes a rate-limited call. Nothing has seen this link yet.
			return inviteDelivery{
				Delivery: "link", Route: "link", Link: actionURL, LinkType: linkKind(f.FirstTime),
				FellBack: "The invitation could not be emailed (" + out.Err.Error() +
					"). Here is a link to pass on instead.",
			}
		}
		// Could not even mint a credential — fall through to the old path,
		// which will report its own failure properly.
	}

	// Rungs 2 and 3 — GoTrue's mailer, falling back to a link.
	inv, err := supaadmin.DeliverSignInLink(ctx, f.To, siteURL(), f.FirstTime, !preferLink)
	d := inviteDelivery{
		Delivery: string(inv.Delivery), Link: inv.Link, LinkType: string(inv.LinkType),
		Warning: inv.Warning, FellBack: inv.FellBack, Err: err,
	}
	switch {
	case err != nil:
		d.Route = "link"
	case inv.Delivery == supaadmin.DeliveredByEmail:
		d.Route = "supabase"
		d.Notice = "This was sent using Supabase's built-in template, which is titled " +
			"\"Reset Your Password\" and cannot name you or the workshop. Configure SMTP_HOST, " +
			"SMTP_USERNAME, SMTP_PASSWORD and MAIL_FROM on the server to send the proper " +
			"invitation instead."
	default:
		d.Route = "link"
	}
	// Logged on these rungs too, or the delivery log would show only the
	// messages we sent ourselves and look empty on exactly the deployment
	// where somebody is asking why mail is not arriving.
	if err == nil {
		// `link` means nothing was mailed — a link was handed to the inviter
		// to pass on — so it is recorded as skipped, not sent.
		recordDelivery(ctx, pool, f.To, mailer.TemplateParticipantInvite,
			"(Supabase built-in template)",
			deliveryOutcome{Route: d.Route, Skipped: d.Route == "link"},
			actorID, f.WorkshopID)
	}
	return d
}

func linkKind(firstTime bool) string {
	if firstTime {
		return string(supaadmin.LinkInvite)
	}
	return string(supaadmin.LinkRecovery)
}

// roleLabel is the short form, for a list. `strings.Title` is deprecated and
// mishandles Unicode word boundaries, and the role keys are a closed set
// anyway — so they are spelled out rather than transformed.
func roleLabel(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "facilitator":
		return "Facilitator"
	case "analyst":
		return "Analyst"
	case "executive_sponsor", "executive-sponsor":
		return "Executive sponsor"
	case "observer":
		return "Observer"
	case "participant":
		return "Participant"
	}
	return role
}

// roleWords turns an operational role key into something a recipient reads
// without having to know the product's vocabulary.
func roleWords(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "facilitator":
		return "Facilitator — you will run the session"
	case "analyst":
		return "Analyst — you will work on the analysis"
	case "executive_sponsor", "executive-sponsor":
		return "Executive sponsor — you will review the outcome"
	case "observer":
		return "Observer — you can follow along"
	case "participant":
		return "Participant — you will contribute to the session"
	}
	if role == "" {
		return "Participant"
	}
	return role
}
