package handlers

import (
	"bytes"
	"html/template"
	"strings"
	"testing"
)

// THE #ZgotmplZ TRAP.
//
// The report export uses html/template, which treats src= as a URL context
// and rewrites any scheme that is not http, https or mailto to the literal
// "#ZgotmplZ". A data URI passed as a plain string therefore does NOT render
// and reports NO error — the logo is simply absent from the exported file.
//
// That is why ExportReportHTML wraps it in template.URL. This test is here
// because the failure is invisible: everything returns 200, the file
// downloads, and the branding is just quietly gone. Nobody reviewing a diff
// would spot it, and nobody testing status codes would catch it.

// The data in the test is a fixture, not a real report: the template only
// needs the cover keys for what is being asserted here.
func renderCover(t *testing.T, data map[string]interface{}) string {
	t.Helper()
	tmpl, err := template.New("report").Parse(reportHTMLTemplate)
	if err != nil {
		t.Fatalf("the report template does not parse: %v", err)
	}
	if data["Report"] == nil {
		data["Report"] = map[string]interface{}{
			"Title": "Strategic Assessment", "Version": "v1", "State": "published",
			"Sections": []interface{}{},
		}
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		t.Fatalf("rendering: %v", err)
	}
	return buf.String()
}

const fixtureLogo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="

func TestReportCoverKeepsTheDataURIIntact(t *testing.T) {
	out := renderCover(t, map[string]interface{}{
		"Workshop":    "Acme Strategy Offsite",
		"GeneratedAt": "1 November 2026",
		"BrandLogo":   template.URL(fixtureLogo),
		"BrandName":   "Acme Group",
	})

	if strings.Contains(out, "ZgotmplZ") {
		t.Fatal("html/template neutered the logo URL — the export would silently carry no branding")
	}
	if !strings.Contains(out, fixtureLogo) {
		t.Fatalf("the data URI is not in the output at all:\n%s", firstLines(out, 40))
	}
	if !strings.Contains(out, `alt="Acme Group"`) {
		t.Error("the logo has no alt text naming the brand")
	}
}

// The inverse, so the test documents WHY template.URL is needed rather than
// just asserting the happy path. If a future change passes a plain string,
// this is the behaviour it will get.
func TestPlainStringLogoWouldBeNeutered(t *testing.T) {
	out := renderCover(t, map[string]interface{}{
		"Workshop":    "Acme Strategy Offsite",
		"GeneratedAt": "1 November 2026",
		"BrandLogo":   fixtureLogo, // a plain string, deliberately
		"BrandName":   "Acme Group",
	})
	if !strings.Contains(out, "ZgotmplZ") {
		t.Skip("html/template no longer filters data: URIs in src — template.URL may no longer be needed here")
	}
}

// An organization with no logo must export exactly as before: no empty <img>,
// no broken-image icon on a document going to a board.
func TestReportCoverOmitsTheImageWhenUnbranded(t *testing.T) {
	out := renderCover(t, map[string]interface{}{
		"Workshop":    "Acme Strategy Offsite",
		"GeneratedAt": "1 November 2026",
		"BrandLogo":   template.URL(""),
		"BrandName":   "",
	})
	if strings.Contains(out, `class="brand"`) {
		t.Error("an unbranded report still emitted a logo element")
	}
	if !strings.Contains(out, "Strategic Assessment") {
		t.Error("the cover did not render at all")
	}
}

// The export's stated promise is a self-contained archival file. A logo that
// arrived as an http URL would break it the day the host moves or a client
// VPN blocks it, and nothing in the document would say why.
func TestReportStaysSelfContained(t *testing.T) {
	out := renderCover(t, map[string]interface{}{
		"Workshop":    "Acme Strategy Offsite",
		"GeneratedAt": "1 November 2026",
		"BrandLogo":   template.URL(fixtureLogo),
		"BrandName":   "Acme Group",
	})
	for _, external := range []string{`src="http`, `href="http`, `@import`} {
		if strings.Contains(out, external) {
			t.Errorf("the export references something external (%s) — it is no longer standalone", external)
		}
	}
}

func firstLines(s string, n int) string {
	lines := strings.SplitN(s, "\n", n+1)
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "\n")
}
