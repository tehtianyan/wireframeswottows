// Package supaadmin wraps the few Supabase Auth (GoTrue) admin calls the
// product needs: creating a login-capable account, minting a one-time invite
// or recovery link, and disabling an account.
//
// WHY THIS IS IN GO. These calls require the service-role key, which must
// never reach the browser. They used to live in a TanStack server function
// (src/lib/participants.functions.ts), which meant identity management ran
// outside the Go trust boundary and outside pkg/authz — so the authority check
// was a hand-rolled membership query and nothing wrote an audit row. Inviting
// somebody is a permission grant; it belongs where every other permission
// decision is made.
//
// LINKS, NOT EMAIL. Every flow here MINTS A LINK and returns it to the caller
// to pass on. Supabase's built-in mailer is heavily rate-limited and, on newer
// projects, only delivers to the project members' own addresses — so asking it
// to email a client's domain can fail silently, which is the worst outcome for
// an invitation. `generate_link` works regardless of SMTP, and an admin who can
// see the link always knows whether the invite exists.
package supaadmin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// ErrNotConfigured is returned when the service-role key or project URL is
// absent, so a deployment without them degrades to a clear message rather than
// a confusing 500.
var ErrNotConfigured = errors.New("Supabase admin API is not configured on this server")

// ErrEmailExists means the address already has an account. It is a normal
// outcome, not a failure: inviting someone to a second workshop should reuse
// the person they already are.
var ErrEmailExists = errors.New("an account already exists for that email")

func baseURL() string { return strings.TrimRight(strings.TrimSpace(os.Getenv("SUPABASE_URL")), "/") }
func serviceKey() string {
	return strings.TrimSpace(os.Getenv("SUPABASE_SERVICE_ROLE_KEY"))
}

// Configured reports whether the admin API can be called at all.
func Configured() bool { return baseURL() != "" && serviceKey() != "" }

var client = &http.Client{Timeout: 20 * time.Second}

func do(ctx context.Context, method, path string, body interface{}, out interface{}) error {
	if !Configured() {
		return ErrNotConfigured
	}
	var buf []byte
	if body != nil {
		var err error
		buf, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, baseURL()+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	key := serviceKey()
	req.Header.Set("apikey", key)
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")

	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		var e struct {
			Msg       string `json:"msg"`
			Message   string `json:"message"`
			ErrorCode string `json:"error_code"`
		}
		_ = json.NewDecoder(res.Body).Decode(&e)
		msg := e.Msg
		if msg == "" {
			msg = e.Message
		}
		// GoTrue signals a duplicate in more than one way depending on
		// version, so this matches on the code AND the message rather than
		// trusting either alone.
		if res.StatusCode == http.StatusUnprocessableEntity || res.StatusCode == http.StatusConflict ||
			e.ErrorCode == "email_exists" || strings.Contains(strings.ToLower(msg), "already been registered") ||
			strings.Contains(strings.ToLower(msg), "already exists") {
			return ErrEmailExists
		}
		if msg == "" {
			msg = res.Status
		}
		return fmt.Errorf("supabase admin: %s", msg)
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// CreateUser makes a login-capable account with NO password.
//
// No password is deliberate. The previous implementation set every invited
// account to one shared hard-coded demo password, which meant an invited person
// could not be told how to sign in without being told everybody else's
// password too. They set their own when they open the invite link.
func CreateUser(ctx context.Context, email, firstName, lastName, displayName string) (*User, error) {
	var out User
	err := do(ctx, http.MethodPost, "/auth/v1/admin/users", map[string]interface{}{
		"email": email,
		// The address is taken as confirmed because an admin vouched for it by
		// inviting them; the invite link is what proves they control it.
		"email_confirm": true,
		"user_metadata": map[string]string{
			"first_name": firstName, "last_name": lastName, "display_name": displayName,
		},
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// FindUserByEmail returns the existing account for an address, or nil.
func FindUserByEmail(ctx context.Context, email string) (*User, error) {
	var out struct {
		Users []User `json:"users"`
	}
	// GoTrue's filter is a substring match, so the result is checked exactly —
	// otherwise "a@b.com" could return "aa@b.com" and an invite would attach to
	// the wrong person.
	if err := do(ctx, http.MethodGet,
		"/auth/v1/admin/users?per_page=50&filter="+urlQueryEscape(email), nil, &out); err != nil {
		return nil, err
	}
	for i := range out.Users {
		if strings.EqualFold(out.Users[i].Email, email) {
			return &out.Users[i], nil
		}
	}
	return nil, nil
}

// LinkType is the kind of one-time link to mint.
type LinkType string

const (
	// LinkInvite asks GoTrue to CREATE the account and mint a link in one step.
	//
	// It fails with email_exists for an account that already exists — including
	// one this package created moments earlier — so it is NOT what to use after
	// CreateUser. See SignInLinkFor.
	LinkInvite LinkType = "invite"
	// LinkRecovery mints a set-a-password link for an account that exists.
	LinkRecovery LinkType = "recovery"
)

// SignInLinkFor mints a link that lets somebody set a password and get in,
// whether or not they have been here before.
//
// It always uses `recovery`, which is the only type that works for an account
// that already exists — and after CreateUser, the account always does. Asking
// for `invite` immediately after creating the account fails with
// "email_exists", which is exactly the trap this function exists to stop
// anyone falling into again: the membership would be granted and the person
// would be left with no way to sign in.
//
// `firstTime` does not change the mechanism, only what the caller tells the
// person: somebody new is setting their first password, somebody returning is
// replacing one. The returned LinkType reflects that meaning.
// The third return value is a WARNING for the person doing the inviting, empty
// when all is well. See RedirectWarning: Supabase silently rewrites a
// redirect_to it does not recognise, and somebody has to be told.
// It PREFERS the app-hosted form (see AppVerifyURL) and falls back to
// GoTrue's own link when no hashed token came back. The fallback also
// restores the redirect warning: an app-hosted link never passes through
// GoTrue's redirect, so the project's Redirect URLs allow-list — the setting
// that silently broke every invite for three attempts — stops mattering at
// all, and there is nothing left to warn about.
func SignInLinkFor(ctx context.Context, email, redirectTo string, firstTime bool) (string, LinkType, string, error) {
	kind := LinkRecovery
	if firstTime {
		kind = LinkInvite
	}
	minted, err := GenerateLink(ctx, LinkRecovery, email, redirectTo)
	if err != nil {
		return "", "", "", err
	}
	if app := AppVerifyURL(redirectTo, minted.HashedToken, firstTime); app != "" {
		return app, kind, "", nil
	}
	return minted.ActionLink, kind, RedirectWarning(redirectTo, minted.ActionLink), nil
}

// Delivery says how an invitation actually reached the person.
type Delivery string

const (
	DeliveredByEmail Delivery = "emailed"
	DeliveredAsLink  Delivery = "link"
)

// Invitation is the outcome of getting a credential to one person.
type Invitation struct {
	Delivery Delivery
	// Link is set ONLY for DeliveredAsLink. It is deliberately empty when the
	// link was mailed: showing a second link would invalidate the mailed one.
	Link     string
	LinkType LinkType
	// Warning is the redirect-destination warning, available only on the link
	// path — see the note in DeliverSignInLink.
	Warning string
	// FellBack says why the email path was not used, when it was asked for.
	// Empty when nothing went wrong.
	FellBack string
}

// DeliverSignInLink mails a one-time sign-in link, or returns one to pass on
// by hand, and NEVER does both for the same invitation.
//
// Falling back is the important part. An invitation that silently fails is the
// worst outcome this code has: the inviter believes somebody was invited and
// that person never hears anything. So if the mail cannot be sent — no custom
// SMTP configured, provider rejected it, rate limit hit — this does not fail
// the invitation. It mints a link instead and reports WHY the email was not
// used, so whoever is inviting can pass the link on and knows to go and fix
// the mail setup.
//
// One honest limitation of the email path: `RedirectWarning` cannot be
// computed, because no link comes back to inspect. It is tempting to mint one
// first just to read the destination Supabase honoured, but `generate_link`
// stamps `recovery_sent_at`, which can rate-limit the recovery mail that
// follows — trading a warning for the delivery itself. So the destination is
// verified on the link path only, and the email path is verified the way it
// has to be: by sending the first one to yourself.
func DeliverSignInLink(ctx context.Context, email, redirectTo string, firstTime, byEmail bool) (Invitation, error) {
	kind := LinkRecovery
	if firstTime {
		kind = LinkInvite
	}

	fellBack := ""
	if byEmail {
		err := SendRecoveryEmail(ctx, email, redirectTo)
		if err == nil {
			return Invitation{Delivery: DeliveredByEmail, LinkType: kind}, nil
		}
		fellBack = explainMailFailure(err)
	}

	link, linkType, warn, err := SignInLinkFor(ctx, email, redirectTo, firstTime)
	if err != nil {
		return Invitation{FellBack: fellBack}, err
	}
	return Invitation{
		Delivery: DeliveredAsLink,
		Link:     link,
		LinkType: linkType,
		Warning:  warn,
		FellBack: fellBack,
	}, nil
}

// explainMailFailure turns a send failure into something the inviter can act
// on, WITHOUT guessing when the server already said what was wrong.
//
// The first version of this blamed missing SMTP in every case ("most often
// because the project has no custom SMTP configured"). The very first run hit
// a rate limit instead, so the message confidently named the wrong cause and
// would have sent somebody to reconfigure a working mail setup. A guess that
// reads like a diagnosis is worse than no diagnosis.
//
// Pure, so the wording is tested without a network call.
func explainMailFailure(err error) string {
	if errors.Is(err, ErrNotConfigured) {
		return "No email could be sent: this server has no Supabase admin credentials. Here is a link to pass on instead."
	}
	msg := err.Error()
	low := strings.ToLower(msg)

	// GoTrue rate-limits messages per address, and separately caps auth mail
	// per hour. Both are temporary and neither means anything is misconfigured.
	if strings.Contains(low, "for security purposes") || strings.Contains(low, "rate limit") ||
		strings.Contains(low, "too many requests") || strings.Contains(low, "only request this after") {
		return "Not emailed — Supabase is rate-limiting messages to this address (" + msg +
			"). Nothing is misconfigured; wait and invite again, or just pass this link on."
	}

	// Anything else: report what the server said, and name the likeliest
	// cause as a possibility rather than a conclusion.
	return "The invitation could not be emailed (" + msg +
		"). If that mentions sending or SMTP, the project may still be on Supabase's built-in sender, " +
		"which only delivers to pre-authorised addresses — configure custom SMTP under " +
		"Authentication → Emails. Here is a link to pass on meanwhile."
}

// RedirectWarning reports when Supabase did not honour the redirect we asked
// for, in words the person doing the inviting can act on.
//
// WHY THIS EXISTS. A `redirect_to` that is not in the project's Redirect URLs
// list is **silently discarded** and replaced with the project's Site URL. No
// error, no field, nothing in the response to say it happened. Production's
// Site URL was still `http://localhost:3000`, so every invite link pointed at
// the invitee's own machine — and because the API returned a perfectly
// well-formed link, nothing anywhere noticed. It surfaced only when a real
// person could not open one, and even then it looked like a code bug: the
// server was sending the right value and being overruled.
//
// The server can see what it asked for and what came back, so it can say so.
// A misconfigured project now announces itself to whoever is inviting, instead
// of to the one person who cannot get in.
//
// Pure, so it is tested without a network call: see supaadmin_test.go.
func RedirectWarning(requested, actionLink string) string {
	if requested == "" {
		// Nothing was asked for, so the project's Site URL is the intended
		// answer and there is nothing to compare against.
		return ""
	}
	u, err := url.Parse(actionLink)
	if err != nil {
		return ""
	}
	got := u.Query().Get("redirect_to")
	if got == "" || sameTarget(requested, got) {
		return ""
	}
	return fmt.Sprintf(
		"This link will send them to %s, not %s. Supabase replaced the destination because "+
			"%s is not in the project's Redirect URLs — add it (with a /** suffix) under "+
			"Authentication → URL Configuration, then invite again.",
		got, strings.TrimRight(requested, "/"), strings.TrimRight(requested, "/"))
}

// sameTarget compares two redirect URLs ignoring a trailing slash, which
// Supabase adds and drops inconsistently and which means nothing here.
func sameTarget(a, b string) bool {
	return strings.EqualFold(strings.TrimRight(a, "/"), strings.TrimRight(b, "/"))
}

// SendRecoveryEmail asks Supabase to MAIL a one-time sign-in link, instead of
// returning one for somebody to pass on by hand.
//
// Recovery for everyone, new account or not, for the same reason
// SignInLinkFor uses it: GoTrue's `invite` refuses an address that already has
// an account, including one created moments earlier by this very handler.
//
// **THIS AND GenerateLink ARE MUTUALLY EXCLUSIVE FOR ONE INVITATION.** GoTrue
// stores ONE token per user per type and clears the previous one when it
// writes a new one, so minting a link to display after mailing one would
// silently kill the link that is already in the person's inbox. Whichever runs
// last is the only one that works. Callers must do one or the other — never
// both — which is why there is no "mail it and also show it" helper here.
//
// It needs working SMTP on the project. Supabase's built-in sender delivers
// only to pre-authorised addresses at a couple of messages an hour, so without
// custom SMTP configured this fails for a real invitee — and failing is the
// point: the caller falls back to a link rather than reporting a delivery that
// never happened.
func SendRecoveryEmail(ctx context.Context, email, redirectTo string) error {
	path := "/auth/v1/recover"
	if redirectTo != "" {
		path += "?redirect_to=" + urlQueryEscape(redirectTo)
	}
	return do(ctx, http.MethodPost, path, map[string]interface{}{"email": email}, nil)
}

// Minted is what generate_link gives us. Two usable forms of the same
// one-time credential, and the choice between them decides whether a corporate
// mail scanner can destroy the invitation before its recipient reads it.
type Minted struct {
	// ActionLink is GoTrue's own URL: a GET to /auth/v1/verify that consumes
	// the token and redirects with a session in the fragment.
	//
	// ANY GET CONSUMES IT. Outlook Safe Links, Gmail's prefetcher, antivirus
	// gateways and an email provider's own click tracking all follow links in
	// mail, and each one burns a token that works exactly once. The invitee
	// then clicks a dead link and lands on the sign-in page being asked for
	// the password the link existed to let them choose. That is the reported
	// defect, and it is unfixable while the credential is spent by a GET.
	ActionLink string
	// HashedToken is the same credential in a form that is spent by a POST
	// instead. Put in a link to our OWN page, a scanner fetching that page
	// consumes nothing: the exchange happens only when the app calls
	// verifyOtp. See AppVerifyURL.
	HashedToken string
}

// GenerateLink mints a one-time credential without sending any email.
//
// redirectTo is where the person lands after following ActionLink, and must be
// an allowed redirect URL in the project's auth settings or Supabase will
// refuse to honour it — silently. See RedirectWarning.
func GenerateLink(ctx context.Context, t LinkType, email, redirectTo string) (Minted, error) {
	body := map[string]interface{}{"type": string(t), "email": email}
	if redirectTo != "" {
		body["redirect_to"] = redirectTo
	}
	var out struct {
		ActionLink  string `json:"action_link"`
		HashedToken string `json:"hashed_token"`
	}
	if err := do(ctx, http.MethodPost, "/auth/v1/admin/generate_link", body, &out); err != nil {
		return Minted{}, err
	}
	if out.ActionLink == "" {
		return Minted{}, errors.New("supabase admin: no link was returned")
	}
	return Minted{ActionLink: out.ActionLink, HashedToken: out.HashedToken}, nil
}

// AppVerifyURL builds a link to the app's own landing page carrying the token
// hash, rather than a link to GoTrue's verify endpoint.
//
// WHY THIS IS THE DEFAULT NOW. The credential is identical; what changes is
// what spends it. GoTrue's link is spent by a GET, so every scanner, prefetcher
// and click-tracker in the path between the sender and the reader destroys the
// invitation — and the invitee's experience of that is "the link took me to a
// login page and asked for a password I have never set". With this form the
// scanner gets a page of HTML and the token is still unused; it is spent by the
// POST that verifyOtp makes, which only happens when a real browser runs the
// app.
//
// `type=recovery` is what the exchange needs, because recovery is the only
// type that works for an account that already exists (see SignInLinkFor).
// `flow` is for the WORDING on the screen — a first-time invitee is choosing a
// password, somebody who asked for a reset is replacing one — and carries no
// authority: the server decides what it minted, and a visitor editing `flow`
// changes nothing but the heading.
//
// Pure, so the URL shape is tested without a network call.
func AppVerifyURL(siteURL, hashedToken string, firstTime bool) string {
	if siteURL == "" || hashedToken == "" {
		return ""
	}
	flow := "reset"
	if firstTime {
		flow = "invite"
	}
	return strings.TrimRight(siteURL, "/") + "/welcome?token_hash=" +
		urlQueryEscape(hashedToken) + "&type=recovery&flow=" + flow
}

// SetUserBanned disables or re-enables sign-in for an account.
//
// "none" lifts a ban; a duration like "876000h" is GoTrue's way of expressing
// an indefinite one, since it has no permanent-ban flag.
func SetUserBanned(ctx context.Context, userID string, banned bool) error {
	dur := "none"
	if banned {
		dur = "876000h" // ~100 years
	}
	return do(ctx, http.MethodPut, "/auth/v1/admin/users/"+userID,
		map[string]interface{}{"ban_duration": dur}, nil)
}

func urlQueryEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.', r == '~', r == '@':
			b.WriteRune(r)
		default:
			b.WriteString(fmt.Sprintf("%%%02X", r))
		}
	}
	return b.String()
}
