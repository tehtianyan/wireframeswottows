package mailer

import (
	"html"
	"regexp"
	"sort"
	"strings"
)

// Template keys. Go names these so a typo is a compile error rather than a
// row nobody sends; the same three strings are a CHECK constraint on
// public.email_templates.
const (
	TemplateParticipantInvite = "participant_invite"
	TemplatePasswordReset     = "password_reset"
	TemplateConfirmation      = "password_set_confirmation"
)

// Vocabulary is which placeholders each template may use.
//
// IT IS DECLARED, NOT INFERRED, and the administration page refuses a save
// that uses anything else. The alternative — accept any placeholder and
// substitute what we happen to have — means a typo like {{inviter}} renders as
// nothing at all, and the first person to notice is the invitee reading a
// sentence with a hole in it. A refusal at save time is seen by the one person
// who can fix it.
//
// The product name and the site URL are available everywhere because every
// message is signed and every message may need to point at the app.
var Vocabulary = map[string][]string{
	TemplateParticipantInvite: {
		"recipient_name", "recipient_email",
		"inviter_name", "inviter_email",
		"workshop_name", "role", "objective_line",
		"action_url", "product_name", "site_url",
	},
	TemplatePasswordReset: {
		"recipient_name", "recipient_email",
		"action_url", "product_name", "site_url",
	},
	TemplateConfirmation: {
		"recipient_name", "recipient_email",
		"workshop_list", "product_name", "site_url",
	},
}

// KnownTemplate reports whether a key is one this product sends.
func KnownTemplate(key string) bool {
	_, ok := Vocabulary[key]
	return ok
}

var placeholderRE = regexp.MustCompile(`\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}`)

// Placeholders lists the distinct placeholders a piece of copy uses, in
// alphabetical order. Used to validate an edit and to show an administrator
// what the copy currently depends on.
func Placeholders(s string) []string {
	seen := map[string]bool{}
	for _, m := range placeholderRE.FindAllStringSubmatch(s, -1) {
		seen[m[1]] = true
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// UnknownPlaceholders lists the placeholders in `s` that are not in the
// template's vocabulary. Empty means the copy is safe to save.
func UnknownPlaceholders(templateKey, s string) []string {
	allowed := map[string]bool{}
	for _, k := range Vocabulary[templateKey] {
		allowed[k] = true
	}
	var bad []string
	for _, k := range Placeholders(s) {
		if !allowed[k] {
			bad = append(bad, k)
		}
	}
	return bad
}

// Render substitutes the values and tidies up after itself.
//
// An absent or empty value removes the placeholder rather than printing it.
// A placeholder is a hole for a fact; if the fact is missing, a recipient
// should see a slightly shorter sentence, never `{{inviter_name}}`. The
// administration page is where a missing fact gets noticed, not the inbox.
//
// Pure, and tested in render_test.go.
func Render(tmpl string, vars map[string]string) string {
	out := placeholderRE.ReplaceAllStringFunc(tmpl, func(m string) string {
		sub := placeholderRE.FindStringSubmatch(m)
		return vars[sub[1]]
	})
	return tidy(out)
}

var blankRuns = regexp.MustCompile(`\n{3,}`)

// tidy collapses the gap an empty placeholder leaves behind.
//
// `{{objective_line}}` sits on its own line because a workshop usually has an
// objective worth stating. When it does not, naive substitution leaves three
// consecutive newlines, and a message with a visible hole in it reads as
// broken software — which is the opposite of what an invitation needs to
// convey. Trailing whitespace goes too: it is invisible in the editor and
// shows up as ragged quoting when somebody replies.
func tidy(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], " \t")
	}
	s = strings.Join(lines, "\n")
	s = blankRuns.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s) + "\n"
}

// A URL run, stopped before trailing punctuation that is nearly always
// sentence punctuation rather than part of the address.
var urlRE = regexp.MustCompile(`https?://[^\s<]+[^\s<.,;:!?)\]]`)

// TextToHTML derives the HTML part from the plain-text part.
//
// DERIVED, NEVER AUTHORED SEPARATELY. Two bodies an administrator can edit
// independently are two bodies that disagree, and the one nobody checks is the
// one most recipients see. One source also means the person editing the copy
// does not have to write HTML in a textarea, which is how broken markup gets
// mailed to a client.
//
// Escaping happens BEFORE linkifying, so no part of the copy can inject
// markup. `&` inside a link becomes `&amp;`, which is correct inside an href
// and resolves back to `&` — the one-time token therefore survives the trip.
func TextToHTML(text string) string {
	escaped := html.EscapeString(strings.ReplaceAll(tidy(text), "\r\n", "\n"))

	linked := urlRE.ReplaceAllStringFunc(escaped, func(u string) string {
		return `<a href="` + u + `" style="color:#1d4ed8">` + u + `</a>`
	})

	var body strings.Builder
	for _, para := range strings.Split(linked, "\n\n") {
		if strings.TrimSpace(para) == "" {
			continue
		}
		// An indented block in the source is a detail list — the workshop,
		// the role, who invited you — so it keeps its alignment instead of
		// being reflowed into a paragraph where those pairs run together.
		if strings.HasPrefix(para, "  ") || strings.HasPrefix(para, "\t") {
			body.WriteString(`<pre style="margin:0 0 16px;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap">` +
				para + "</pre>\n")
			continue
		}
		body.WriteString(`<p style="margin:0 0 16px">` +
			strings.ReplaceAll(para, "\n", "<br>\n") + "</p>\n")
	}

	// A deliberately plain document. No images, no tracking pixel, no
	// external stylesheet: every one of those is a spam signal on a
	// one-to-one transactional message, and a remote image in an invitation
	// is the exact shape of the phishing mail this is replacing. Inline
	// styles only, because email clients discard <style> blocks.
	return `<!doctype html>
<html><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width"></head>` +
		`<body style="margin:0;padding:24px;background:#f6f7f9">` +
		`<div style="max-width:560px;margin:0 auto;padding:28px;background:#ffffff;` +
		`border:1px solid #e3e6ea;border-radius:6px;` +
		`font:15px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1d21">` +
		"\n" + body.String() +
		`</div></body></html>`
}
