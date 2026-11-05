// Package mailer sends the product's own transactional email over SMTP.
//
// WHY THE APP SENDS ITS OWN MAIL. Supabase's mailer can only send Supabase's
// templates, which know the address, the link and the token — and not who did
// the inviting or what they were invited to. The best subject GoTrue can
// produce for an invitation is therefore "Reset Your Password", which is the
// commonest phishing pattern in existence and was reported as exactly that by
// real test users. Those two facts cannot be added from outside, so the
// message had to become ours. See the migration 20261105100000 for the full
// argument.
//
// WHY STDLIB SMTP AND NOT A PROVIDER SDK. net/smtp is in the standard library
// and every provider speaks it, so this adds no dependency and no lock-in:
// Brevo, Postmark, SES and a self-hosted relay are all the same six
// environment variables. An HTTP API would have bought nothing a transactional
// send needs, and the same reasoning as the logo-in-a-column decision applies —
// check what a dependency actually buys before adding a subsystem.
//
// WHAT THIS PACKAGE DOES NOT DO. It does not decide whether to send, does not
// read the database and does not know about workshops. It takes an already
// rendered message and puts it on the wire, or says precisely why it could not.
package mailer

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

// ErrNotConfigured means no SMTP host or credentials are set, so nothing can
// be sent. Callers fall back to handing over a link rather than failing the
// whole invitation.
var ErrNotConfigured = errors.New("no SMTP server is configured on this server")

// ErrNoEncryption means the server would not negotiate TLS. We refuse to carry
// on rather than send credentials — and the invitee's one-time token — in
// plaintext across the internet.
var ErrNoEncryption = errors.New("the SMTP server does not offer STARTTLS, so credentials were not sent")

// Config is the whole of this package's configuration, read from the
// environment so a provider change is a redeploy and not a rebuild.
type Config struct {
	Host     string
	Port     int
	Username string
	Password string
	// From is the envelope and header sender. It must be an address the
	// provider has authorised, or the provider will reject the message — which
	// is one of the two commonest reasons a transactional email silently never
	// arrives.
	From     string
	FromName string
}

// Load reads the configuration. Port defaults to 587 (submission with
// STARTTLS), which is what every hosted relay issues.
func Load() Config {
	port, _ := strconv.Atoi(strings.TrimSpace(os.Getenv("SMTP_PORT")))
	if port == 0 {
		port = 587
	}
	c := Config{
		Host:     strings.TrimSpace(os.Getenv("SMTP_HOST")),
		Port:     port,
		Username: strings.TrimSpace(os.Getenv("SMTP_USERNAME")),
		Password: os.Getenv("SMTP_PASSWORD"),
		From:     strings.TrimSpace(os.Getenv("MAIL_FROM")),
		FromName: strings.TrimSpace(os.Getenv("MAIL_FROM_NAME")),
	}
	// A relay that needs no credentials is legitimate (a local MTA, an
	// IP-allowlisted gateway), so only the host and the From address are
	// required. Falling back to the username as the sender is NOT done: an
	// SMTP username is frequently not an address at all — Brevo's is a
	// numeric login — and a malformed From is rejected by the receiver, which
	// looks exactly like a deliverability problem.
	return c
}

// Configured reports whether a send can be attempted at all.
func (c Config) Configured() bool { return c.Host != "" && c.From != "" }

// Status is what the administration page shows about mail, so somebody
// diagnosing "they never got it" can see whether sending is even switched on
// without reading deploy logs. It deliberately carries no password.
type Status struct {
	Configured bool   `json:"configured"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	From       string `json:"from"`
	FromName   string `json:"from_name"`
	// Encryption says what will be negotiated, because "my mail is not
	// arriving" and "my mail is going out in clear text" are both answered by
	// knowing this and neither is visible anywhere else.
	Encryption string `json:"encryption"`
}

func (c Config) Status() Status {
	return Status{
		Configured: c.Configured(),
		Host:       c.Host,
		Port:       c.Port,
		From:       c.From,
		FromName:   c.FromName,
		Encryption: c.encryptionName(),
	}
}

func (c Config) encryptionName() string {
	if c.Port == 465 {
		return "implicit TLS"
	}
	return "STARTTLS"
}

// Message is one email, already rendered.
type Message struct {
	To      string
	Subject string
	// Text is the whole message as plain text. The HTML part is DERIVED from
	// it rather than authored separately, so the two cannot drift apart and an
	// administrator editing the copy cannot produce broken markup.
	Text string
	// ReplyTo is the person the recipient should answer — the inviter, for an
	// invitation. This does real work for both trust and deliverability: a
	// recipient can see a human behind the message, and a reply to a real
	// mailbox is one of the strongest positive engagement signals a receiver
	// has.
	ReplyTo string
}

// Send puts one message on the wire, or returns why it could not.
//
// It returns the SERVER'S OWN WORDS on failure. Everything above this layer
// quotes them rather than paraphrasing: the first version of the old
// explainMailFailure guessed at a cause, named the wrong one with complete
// confidence, and would have sent somebody to reconfigure working mail.
func (c Config) Send(ctx context.Context, m Message) error {
	if !c.Configured() {
		return ErrNotConfigured
	}
	if _, err := mail.ParseAddress(m.To); err != nil {
		return fmt.Errorf("%q is not a valid email address", m.To)
	}

	raw, err := c.Build(m, time.Now())
	if err != nil {
		return err
	}

	addr := net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	dialer := &net.Dialer{Timeout: 20 * time.Second}

	var conn net.Conn
	if c.Port == 465 {
		// Implicit TLS: the connection is encrypted before a single SMTP verb
		// is spoken, so there is no plaintext phase to strip.
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: c.Host})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return err
	}
	defer conn.Close()

	client, err := smtp.NewClient(conn, c.Host)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	if err := client.Hello(heloName(c.From)); err != nil {
		return err
	}

	if c.Port != 465 {
		// STARTTLS OR NOTHING, when there are credentials to protect.
		//
		// This was previously left as an open question — whether GoTrue
		// refuses a server that declines STARTTLS or carries on in plaintext
		// was never established. Here it is not a question: an on-path
		// attacker who can strip the STARTTLS offer would otherwise be handed
		// the SMTP password and the invitee's one-time sign-in token, and a
		// quiet downgrade is the kind of failure nobody ever notices. A relay
		// needing no credentials is allowed to be plaintext, because then
		// there is nothing to hand over and a local MTA on loopback is a real
		// deployment.
		ok, _ := client.Extension("STARTTLS")
		if ok {
			if err := client.StartTLS(&tls.Config{ServerName: c.Host}); err != nil {
				return err
			}
		} else if c.Password != "" {
			return ErrNoEncryption
		}
	}

	if c.Username != "" || c.Password != "" {
		if err := client.Auth(smtp.PlainAuth("", c.Username, c.Password, c.Host)); err != nil {
			return err
		}
	}

	if err := client.Mail(c.From); err != nil {
		return err
	}
	if err := client.Rcpt(m.To); err != nil {
		return err
	}
	wc, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := wc.Write(raw); err != nil {
		_ = wc.Close()
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return client.Quit()
}

// Build assembles the RFC 5322 message. Pure apart from the clock and the
// message id, both of which are parameters or random — so the headers and the
// MIME structure are tested without a mail server. See mailer_test.go.
//
// Both parts are base64-encoded on purpose. The copy is administrator-edited
// and may hold any UTF-8, and SMTP lines are capped at 998 octets; base64
// makes both non-issues, where quoted-printable would mean hand-rolling
// soft-wrap rules that only break on somebody's long sentence in production.
func (c Config) Build(m Message, now time.Time) ([]byte, error) {
	from := (&mail.Address{Name: c.FromName, Address: c.From}).String()

	boundary, err := randomBoundary()
	if err != nil {
		return nil, err
	}

	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + m.To + "\r\n")
	if rt := strings.TrimSpace(m.ReplyTo); rt != "" {
		if _, err := mail.ParseAddress(rt); err == nil {
			b.WriteString("Reply-To: " + rt + "\r\n")
		}
	}
	// RFC 2047 for anything non-ASCII; QEncoding passes plain ASCII through
	// unchanged, so an English subject stays human-readable in raw form.
	b.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", m.Subject) + "\r\n")
	b.WriteString("Date: " + now.Format(time.RFC1123Z) + "\r\n")
	// A Message-ID whose domain matches the sender. Receivers treat a missing
	// or malformed one as a spam signal, and Go's SMTP client does not add it.
	b.WriteString("Message-ID: " + messageID(c.From, boundary) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n")
	b.WriteString("\r\n")

	// Plain text FIRST. multipart/alternative is ordered least- to
	// most-preferred, and a text part that genuinely says everything is both
	// what a text-only reader needs and a strong positive signal to spam
	// filters, which distrust HTML-only mail.
	b.WriteString("--" + boundary + "\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
	b.WriteString(wrap76(base64.StdEncoding.EncodeToString([]byte(normalizeNewlines(m.Text)))))

	b.WriteString("\r\n--" + boundary + "\r\n")
	b.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
	b.WriteString(wrap76(base64.StdEncoding.EncodeToString([]byte(TextToHTML(m.Text)))))

	b.WriteString("\r\n--" + boundary + "--\r\n")
	return []byte(b.String()), nil
}

func normalizeNewlines(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\n", "\r\n")
}

// wrap76 breaks base64 into RFC-compliant lines. A single 4KB line is legal
// base64 and an illegal SMTP line, and some relays silently mangle it.
func wrap76(s string) string {
	var b strings.Builder
	for len(s) > 76 {
		b.WriteString(s[:76])
		b.WriteString("\r\n")
		s = s[76:]
	}
	b.WriteString(s)
	return b.String()
}

func randomBoundary() (string, error) {
	var buf [18]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "swot-" + base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

func messageID(from, nonce string) string {
	domain := "localhost"
	if i := strings.LastIndex(from, "@"); i >= 0 && i < len(from)-1 {
		domain = from[i+1:]
	}
	return "<" + nonce + "@" + domain + ">"
}

// heloName is the name we announce ourselves as. The sender's domain is a
// better answer than Go's default "localhost", which some relays reject
// outright.
func heloName(from string) string {
	if i := strings.LastIndex(from, "@"); i >= 0 && i < len(from)-1 {
		return from[i+1:]
	}
	return "localhost"
}
