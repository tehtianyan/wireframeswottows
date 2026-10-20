package handlers

import (
	"os"
	"strings"
	"testing"
)

// siteURL decides where an invite or password-reset link sends somebody, and
// got that wrong in two ways at once — which is why the first invite to a real
// address could not be opened. Both are pinned here because the function is
// pure, so neither needs a database, a server or a paid model call to check.
//
// The test that existed before covered "the API returned a link". It did, and
// the link was useless. A link is only correct if it goes somewhere.

func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for _, k := range []string{"SITE_URL", "PUBLIC_SITE_URL", "VITE_SITE_URL"} {
		old, had := os.LookupEnv(k)
		t.Cleanup(func() {
			if had {
				_ = os.Setenv(k, old)
			} else {
				_ = os.Unsetenv(k)
			}
		})
		_ = os.Unsetenv(k)
	}
	for k, v := range kv {
		_ = os.Setenv(k, v)
	}
}

// BUG 1. It appended "/auth/callback" — a route this app has never had. Ten
// routes exist and none is that, so even a correctly configured deployment
// dropped the invitee on a 404.
func TestSiteURLDoesNotPointAtARouteThatDoesNotExist(t *testing.T) {
	withEnv(t, map[string]string{"SITE_URL": "https://wireframeswottows.vercel.app"})
	got := siteURL()
	if strings.Contains(got, "auth/callback") {
		t.Fatalf("link targets a non-existent route: %q", got)
	}
	if got != "https://wireframeswottows.vercel.app/" {
		t.Fatalf("expected the site root, got %q", got)
	}
}

// BUG 2. With nothing set it returned "", which makes Supabase fall back to the
// PROJECT's Site URL — a dashboard setting this code cannot see. Production's
// was still http://localhost:3000, so real invitees were sent to their own
// machine. The empty fallback is still deliberate, but a deployment that sets
// the variable must have it honoured.
func TestSiteURLPrefersTheExplicitSetting(t *testing.T) {
	withEnv(t, nil)
	if got := siteURL(); got != "" {
		t.Fatalf("unset should fall back to the project Site URL, got %q", got)
	}

	// SITE_URL wins: Vercel reserves the PUBLIC_ prefix and refuses it on
	// production, so that name cannot be the primary one.
	withEnv(t, map[string]string{
		"SITE_URL":        "https://real.example",
		"PUBLIC_SITE_URL": "https://stale.example",
		"VITE_SITE_URL":   "https://older.example",
	})
	if got := siteURL(); got != "https://real.example/" {
		t.Fatalf("SITE_URL must win, got %q", got)
	}

	// The prefixed names stay as fallbacks so a deployment that already set
	// either keeps working.
	withEnv(t, map[string]string{"PUBLIC_SITE_URL": "https://fallback.example"})
	if got := siteURL(); got != "https://fallback.example/" {
		t.Fatalf("PUBLIC_SITE_URL should still be honoured, got %q", got)
	}
}

// A trailing slash in configuration must not become a double slash in the link.
func TestSiteURLNormalisesTheTrailingSlash(t *testing.T) {
	for _, in := range []string{
		"https://wireframeswottows.vercel.app",
		"https://wireframeswottows.vercel.app/",
		"https://wireframeswottows.vercel.app///",
	} {
		withEnv(t, map[string]string{"SITE_URL": in})
		if got := siteURL(); got != "https://wireframeswottows.vercel.app/" {
			t.Fatalf("%q normalised to %q", in, got)
		}
	}
}
