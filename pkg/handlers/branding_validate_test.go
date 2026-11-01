package handlers

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

// validateLogoDataURI is pure — no DB, no network — so the security rule it
// enforces is exercised here rather than only over HTTP. Same reasoning as
// cleanup_plan_test.go: a rule that needs a live database to check is a rule
// nobody runs before pushing.

func dataURI(mime string, raw []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 1, G: 2, B: 3, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encoding fixture: %v", err)
	}
	return buf.Bytes()
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("encoding fixture: %v", err)
	}
	return buf.Bytes()
}

func TestValidateLogoAcceptsRealImages(t *testing.T) {
	if msg := validateLogoDataURI(dataURI("image/png", pngBytes(t, 240, 80))); msg != "" {
		t.Errorf("a real PNG was refused: %s", msg)
	}
	if msg := validateLogoDataURI(dataURI("image/jpeg", jpegBytes(t, 240, 80))); msg != "" {
		t.Errorf("a real JPEG was refused: %s", msg)
	}
}

// THE SECURITY RULE. An SVG can carry <script>, and this string is rendered
// inline for every member of the organization and embedded in exported
// reports. "Upload your logo" must not be a stored-XSS vector.
func TestValidateLogoRefusesSVG(t *testing.T) {
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	for _, uri := range []string{
		dataURI("image/svg+xml", svg),
		dataURI("image/SVG+XML", svg), // case must not be a way past it
		"data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString(svg),
	} {
		msg := validateLogoDataURI(uri)
		if msg == "" {
			t.Fatalf("an SVG was ACCEPTED — this is the stored-XSS hole: %s", uri[:40])
		}
		// The refusal has to say why, or it reads as an arbitrary limitation
		// and somebody works around it by renaming the file.
		if !strings.Contains(strings.ToLower(msg), "script") {
			t.Errorf("the SVG refusal should explain the risk: %s", msg)
		}
	}
}

// The declared MIME is attacker-controlled text. Claiming PNG must not be
// enough; the BYTES decide.
func TestValidateLogoDoesNotTrustTheDeclaredType(t *testing.T) {
	notAnImage := dataURI("image/png", []byte("#!/bin/sh\nrm -rf /\n"))
	if msg := validateLogoDataURI(notAnImage); msg == "" {
		t.Fatal("a shell script labelled image/png was accepted")
	}

	// An SVG relabelled as PNG: caught by the decoder even though the
	// prefix check above does not fire.
	relabelled := dataURI("image/png", []byte(`<svg><script>alert(1)</script></svg>`))
	if msg := validateLogoDataURI(relabelled); msg == "" {
		t.Fatal("an SVG relabelled as image/png was accepted")
	}
}

func TestValidateLogoRefusesOversizeAndGarbage(t *testing.T) {
	big := "data:image/png;base64," + strings.Repeat("A", maxLogoDataURI)
	msg := validateLogoDataURI(big)
	if msg == "" {
		t.Fatal("an over-cap string was accepted")
	}
	if !strings.Contains(msg, "too large") {
		t.Errorf("the size refusal should say so plainly: %s", msg)
	}

	if validateLogoDataURI("data:image/png;base64,!!!not base64!!!") == "" {
		t.Error("undecodable base64 was accepted")
	}
	if validateLogoDataURI("https://example.com/logo.png") == "" {
		t.Error("a URL was accepted where a data URI is required")
	}
	if validateLogoDataURI(dataURI("image/png", nil)) == "" {
		t.Error("an empty payload was accepted")
	}
}

// An enormous image dropped in by mistake should be named as such, not stored
// and silently scaled by the browser into a 32px slot.
//
// The fixture is deliberately WIDE AND SHORT. The first version was 4200x3000,
// which encodes to 475KB — so the SIZE check fired and this test passed while
// never once reaching the dimension guard it was written for. A large flat
// image can compress to almost nothing, which is exactly the case where bytes
// do not catch it and pixels must.
func TestValidateLogoRefusesOversizeDimensions(t *testing.T) {
	uri := dataURI("image/png", pngBytes(t, 4200, 120))
	if len(uri) > maxLogoDataURI {
		t.Fatalf("fixture is %d bytes encoded — the size check will fire first and this test proves nothing", len(uri))
	}
	msg := validateLogoDataURI(uri)
	if msg == "" {
		t.Fatal("a 4200px-wide image was accepted as a logo")
	}
	if !strings.Contains(msg, "4200") {
		t.Errorf("the refusal should quote the actual size so it is obvious what happened: %s", msg)
	}
	if strings.Contains(msg, "too large") {
		t.Errorf("this should be the dimension refusal, not the byte-size one: %s", msg)
	}
}

// Every refusal is read by an administrator mid-task, so each one has to be a
// sentence that says what to do — not a code and not "invalid input".
func TestValidateLogoRefusalsAreActionable(t *testing.T) {
	for _, bad := range []string{
		dataURI("image/svg+xml", []byte("<svg/>")),
		dataURI("image/png", []byte("nonsense")),
		"data:image/png;base64," + strings.Repeat("A", maxLogoDataURI),
		dataURI("image/png", pngBytes(t, 4200, 10)),
		dataURI("image/webp", []byte("RIFF....WEBP")),
	} {
		msg := validateLogoDataURI(bad)
		if msg == "" {
			t.Fatalf("expected a refusal for %.30s", bad)
		}
		if !strings.HasSuffix(msg, ".") {
			t.Errorf("refusal is not a sentence: %q", msg)
		}
		if len(msg) < 25 {
			t.Errorf("refusal is too terse to act on: %q", msg)
		}
	}
}
