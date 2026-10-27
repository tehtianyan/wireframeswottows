package supaadmin

import (
	"errors"
	"strings"
	"testing"
)

// RedirectWarning is the guard against the failure that took three attempts to
// find: Supabase SILENTLY replaces a `redirect_to` that is not in the project's
// Redirect URLs with the project's Site URL. No error, no field, nothing in the
// response. Production's Site URL was still http://localhost:3000, so every
// invite link pointed at the invitee's own machine while the API returned a
// perfectly well-formed link.
//
// It is pure, so these run without a network call — which matters, because the
// bug it guards was previously only observable by asking a real person to open
// a real link and watching it fail.

const sent = "https://wireframeswottows.vercel.app/"

func linkWith(redirect string) string {
	base := "https://ref.supabase.co/auth/v1/verify?token=abc&type=recovery"
	if redirect == "" {
		return base
	}
	return base + "&redirect_to=" + redirect
}

// The exact production failure: asked for the real site, got localhost back.
func TestRedirectWarningCatchesTheSilentSubstitution(t *testing.T) {
	warn := RedirectWarning(sent, linkWith("http://localhost:3000"))
	if warn == "" {
		t.Fatal("a substituted redirect produced no warning — this is the bug")
	}
	// The warning has to be actionable by the person reading it, so it must
	// name both the wrong destination and what to do about it.
	for _, want := range []string{"http://localhost:3000", "Redirect URLs", "invite again"} {
		if !strings.Contains(warn, want) {
			t.Fatalf("warning does not mention %q: %s", want, warn)
		}
	}
}

func TestRedirectWarningSilentWhenHonoured(t *testing.T) {
	if w := RedirectWarning(sent, linkWith(sent)); w != "" {
		t.Fatalf("honoured redirect should not warn: %s", w)
	}
}

// Supabase adds and drops the trailing slash inconsistently, and it means
// nothing here. Warning on it would train people to ignore the warning.
func TestRedirectWarningIgnoresTheTrailingSlash(t *testing.T) {
	for _, got := range []string{
		"https://wireframeswottows.vercel.app",
		"https://wireframeswottows.vercel.app/",
	} {
		if w := RedirectWarning(sent, linkWith(got)); w != "" {
			t.Fatalf("slash-only difference warned (%s): %s", got, w)
		}
	}
	// And the comparison is case-insensitive on the host, as URLs are.
	if w := RedirectWarning(sent, linkWith("https://WireframesWotTows.vercel.app")); w != "" {
		t.Fatalf("case-only difference warned: %s", w)
	}
}

// Asking for nothing means the project's Site URL IS the intended answer, so
// there is nothing to compare and nothing to complain about.
func TestRedirectWarningSaysNothingWhenNoneWasRequested(t *testing.T) {
	if w := RedirectWarning("", linkWith("http://localhost:3000")); w != "" {
		t.Fatalf("no request should mean no warning: %s", w)
	}
}

// A link with no redirect_to at all, or one that does not parse, must not make
// the invite fail — the membership is already real by then.
func TestRedirectWarningIsQuietOnUnusableInput(t *testing.T) {
	if w := RedirectWarning(sent, linkWith("")); w != "" {
		t.Fatalf("absent redirect_to should not warn: %s", w)
	}
	if w := RedirectWarning(sent, "::not a url::"); w != "" {
		t.Fatalf("unparseable link should not warn: %s", w)
	}
}

// A fallback message must not name a cause the server did not report. The
// first version blamed missing SMTP unconditionally, and the first real run
// was a rate limit — so it stated the wrong cause with full confidence.
func TestExplainMailFailureDoesNotGuessWrong(t *testing.T) {
	rateLimited := explainMailFailure(errors.New(
		"supabase admin: For security purposes, you can only request this after 59 seconds."))
	if strings.Contains(strings.ToLower(rateLimited), "smtp") {
		t.Errorf("a rate limit must not be reported as an SMTP problem: %s", rateLimited)
	}
	if !strings.Contains(strings.ToLower(rateLimited), "rate-limit") {
		t.Errorf("a rate limit should say so: %s", rateLimited)
	}
	if !strings.Contains(strings.ToLower(rateLimited), "nothing is misconfigured") {
		t.Errorf("and should say nothing needs changing: %s", rateLimited)
	}

	notConfigured := explainMailFailure(ErrNotConfigured)
	if !strings.Contains(notConfigured, "no Supabase admin credentials") {
		t.Errorf("missing credentials should be named exactly: %s", notConfigured)
	}

	// The generic case must still carry the server's own words, so a cause
	// nobody anticipated is at least visible.
	other := explainMailFailure(errors.New("supabase admin: Error sending recovery email"))
	if !strings.Contains(other, "Error sending recovery email") {
		t.Errorf("the server's own message must survive: %s", other)
	}

	// Every branch has to offer the link, since that is the whole point of
	// falling back rather than failing.
	for _, m := range []string{rateLimited, notConfigured, other} {
		if !strings.Contains(strings.ToLower(m), "link") {
			t.Errorf("a fallback must mention the link it is giving you: %s", m)
		}
	}
}
