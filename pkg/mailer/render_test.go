package mailer

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestRenderSubstitutesAndRemovesUnknowns(t *testing.T) {
	got := Render("Hi {{recipient_name}}, {{inviter_name}} invited you.{{nonsense}}",
		map[string]string{"recipient_name": "Sam", "inviter_name": "Dana"})
	want := "Hi Sam, Dana invited you.\n"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

// An unreplaced placeholder in somebody's inbox is the failure this guards
// against: the recipient sees a sentence with machinery in it and the message
// loses exactly the credibility it was rewritten to gain.
func TestRenderNeverLeavesPlaceholderSyntax(t *testing.T) {
	got := Render("A {{present}} and a {{missing}}.", map[string]string{"present": "x"})
	if strings.Contains(got, "{{") || strings.Contains(got, "}}") {
		t.Fatalf("placeholder syntax survived: %q", got)
	}
}

// The reason `tidy` exists. A workshop with no objective leaves
// {{objective_line}} empty on its own line; without collapsing, the message
// has a visible hole in it.
func TestRenderCollapsesTheGapAnEmptyPlaceholderLeaves(t *testing.T) {
	tmpl := "One.\n\n{{objective_line}}\nTwo.\n"
	withValue := Render(tmpl, map[string]string{"objective_line": "The objective is growth.\n"})
	if !strings.Contains(withValue, "The objective is growth.") {
		t.Fatalf("value not rendered: %q", withValue)
	}
	empty := Render(tmpl, map[string]string{})
	if strings.Contains(empty, "\n\n\n") {
		t.Fatalf("blank run survived: %q", empty)
	}
	if !strings.Contains(empty, "One.\n\nTwo.") {
		t.Fatalf("unexpected shape: %q", empty)
	}
}

func TestPlaceholdersAndVocabulary(t *testing.T) {
	got := Placeholders("{{b}} {{a}} {{b}}")
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("got %v", got)
	}
	if bad := UnknownPlaceholders(TemplateParticipantInvite,
		"{{inviter_name}} {{workshop_name}}"); len(bad) != 0 {
		t.Fatalf("legitimate placeholders rejected: %v", bad)
	}
	bad := UnknownPlaceholders(TemplateParticipantInvite, "{{inviter}} {{workshop_name}}")
	if len(bad) != 1 || bad[0] != "inviter" {
		t.Fatalf("got %v, want [inviter]", bad)
	}
	// The confirmation message has no inviter, so naming one there is a
	// mistake worth refusing rather than silently blanking.
	if bad := UnknownPlaceholders(TemplateConfirmation, "{{inviter_name}}"); len(bad) != 1 {
		t.Fatalf("vocabulary is not per-template: %v", bad)
	}
}

// The copy is administrator-edited and goes out to clients. If it could inject
// markup, "edit the invitation wording" would be a way to put arbitrary HTML
// in front of every invitee — the same argument that refuses SVG on logo
// upload.
func TestTextToHTMLEscapesBeforeLinkifying(t *testing.T) {
	out := TextToHTML(`<script>alert(1)</script> and <b>bold</b>`)
	if strings.Contains(out, "<script>") || strings.Contains(out, "<b>bold</b>") {
		t.Fatalf("markup survived escaping: %q", out)
	}
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Fatalf("expected escaped text: %q", out)
	}
}

// The token travels in a query string, so `&` is the character that decides
// whether the link works. Escaped to `&amp;` inside an href is correct HTML
// and resolves back to `&`; left raw it is invalid, and rewritten any other
// way the token is corrupt and the invitee gets "link expired".
func TestTextToHTMLKeepsTheTokenIntact(t *testing.T) {
	url := "https://example.com/welcome?token_hash=abc123&type=invite"
	out := TextToHTML("Open this:\n\n" + url + "\n")
	if !strings.Contains(out, `href="https://example.com/welcome?token_hash=abc123&amp;type=invite"`) {
		t.Fatalf("link not rendered as expected: %q", out)
	}
	if strings.Contains(out, "token_hash=abc123&type") {
		t.Fatalf("raw & left in markup: %q", out)
	}
}

// A remote image in an invitation is the shape of the phishing mail this
// replaces, and an image-only HTML part is a spam signal besides.
func TestTextToHTMLHasNoRemoteContent(t *testing.T) {
	out := TextToHTML("Hello.\n")
	for _, bad := range []string{"<img", "<style", "<link", "background-image"} {
		if strings.Contains(out, bad) {
			t.Fatalf("%s present in HTML part: %q", bad, out)
		}
	}
}

func TestBuildHeadersAndStructure(t *testing.T) {
	c := Config{Host: "smtp.example.com", Port: 587, From: "no-reply@example.com", FromName: "COS"}
	raw, err := c.Build(Message{
		To:      "sam@example.org",
		Subject: "Dana has invited you",
		Text:    "Hello Sam,\n\nOpen https://example.com/welcome?a=1&b=2\n",
		ReplyTo: "dana@example.com",
	}, time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)

	for _, want := range []string{
		`From: "COS" <no-reply@example.com>`,
		"To: sam@example.org",
		"Reply-To: dana@example.com",
		"Subject: Dana has invited you",
		"MIME-Version: 1.0",
		"multipart/alternative",
		"text/plain; charset=utf-8",
		"text/html; charset=utf-8",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing header or part: %s", want)
		}
	}
	// Receivers treat a missing Message-ID as a spam signal, and net/smtp
	// does not add one. Its domain must match the sender or it is worse than
	// none at all.
	if !strings.Contains(s, "@example.com>") || !strings.Contains(s, "Message-ID: <") {
		t.Errorf("Message-ID missing or wrong domain: %s", s)
	}
	// Plain text before HTML: multipart/alternative is least- to
	// most-preferred, so the order is not cosmetic.
	if strings.Index(s, "text/plain") > strings.Index(s, "text/html") {
		t.Error("html part precedes the text part")
	}
}

// A single 4KB base64 line is legal base64 and an illegal SMTP line (998
// octets), and some relays mangle it rather than refusing it — which presents
// as a corrupt link, not as a send failure.
func TestBuildWrapsLongLines(t *testing.T) {
	c := Config{Host: "h", Port: 587, From: "a@b.com"}
	raw, err := c.Build(Message{To: "x@y.com", Subject: "s",
		Text: strings.Repeat("long sentence that keeps going ", 200)}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(raw), "\r\n") {
		if len(line) > 998 {
			t.Fatalf("line of %d octets", len(line))
		}
	}
}

// Non-ASCII copy must survive. base64 for the bodies and RFC 2047 for the
// subject is what makes that true without hand-rolled soft-wrap rules.
func TestBuildCarriesNonASCII(t *testing.T) {
	c := Config{Host: "h", Port: 587, From: "a@b.com", FromName: "Café"}
	raw, err := c.Build(Message{To: "x@y.com", Subject: "Prüfung — café",
		Text: "Grüße, Café — naïve\n"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	if !strings.Contains(s, "=?utf-8?q?") && !strings.Contains(s, "=?utf-8?Q?") {
		t.Fatalf("subject not RFC 2047 encoded: %s", s)
	}
	// Decode the text part back and confirm the characters round-tripped.
	parts := strings.Split(s, "Content-Transfer-Encoding: base64\r\n\r\n")
	if len(parts) < 2 {
		t.Fatal("no encoded part found")
	}
	enc := strings.SplitN(parts[1], "\r\n--", 2)[0]
	dec, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(enc, "\r\n", ""))
	if err != nil {
		t.Fatalf("text part is not valid base64: %v", err)
	}
	if !strings.Contains(string(dec), "Grüße, Café — naïve") {
		t.Fatalf("round trip lost characters: %q", dec)
	}
}

func TestConfiguredNeedsHostAndFrom(t *testing.T) {
	// The From address is required and is NOT defaulted from the username:
	// Brevo's username is a numeric login, and a malformed From is rejected by
	// the receiver, which looks like a deliverability problem rather than a
	// configuration one.
	cases := []struct {
		c    Config
		want bool
	}{
		{Config{}, false},
		{Config{Host: "h"}, false},
		{Config{From: "a@b.com"}, false},
		{Config{Host: "h", From: "a@b.com"}, true},
	}
	for _, tc := range cases {
		if got := tc.c.Configured(); got != tc.want {
			t.Errorf("%+v: got %v want %v", tc.c, got, tc.want)
		}
	}
}

func TestStatusCarriesNoPassword(t *testing.T) {
	c := Config{Host: "h", Port: 465, Username: "u", Password: "super-secret", From: "a@b.com"}
	st := c.Status()
	if st.Encryption != "implicit TLS" {
		t.Errorf("port 465 should be implicit TLS, got %q", st.Encryption)
	}
	if strings.Contains(st.Host+st.From+st.FromName+st.Encryption, "super-secret") {
		t.Error("password leaked into status")
	}
	if c2 := (Config{Host: "h", Port: 587, From: "a@b.com"}); c2.Status().Encryption != "STARTTLS" {
		t.Error("port 587 should report STARTTLS")
	}
}
