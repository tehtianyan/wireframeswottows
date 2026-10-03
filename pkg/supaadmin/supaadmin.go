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
func SignInLinkFor(ctx context.Context, email, redirectTo string, firstTime bool) (string, LinkType, error) {
	link, err := GenerateLink(ctx, LinkRecovery, email, redirectTo)
	if err != nil {
		return "", "", err
	}
	if firstTime {
		return link, LinkInvite, nil
	}
	return link, LinkRecovery, nil
}

// GenerateLink mints a one-time link without sending any email.
//
// redirectTo is where the person lands after following it, and must be an
// allowed redirect URL in the project's auth settings or Supabase will refuse
// to honour it.
func GenerateLink(ctx context.Context, t LinkType, email, redirectTo string) (string, error) {
	body := map[string]interface{}{"type": string(t), "email": email}
	if redirectTo != "" {
		body["redirect_to"] = redirectTo
	}
	var out struct {
		ActionLink string `json:"action_link"`
	}
	if err := do(ctx, http.MethodPost, "/auth/v1/admin/generate_link", body, &out); err != nil {
		return "", err
	}
	if out.ActionLink == "" {
		return "", errors.New("supabase admin: no link was returned")
	}
	return out.ActionLink, nil
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
