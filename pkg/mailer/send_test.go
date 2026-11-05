package mailer

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Send over a real socket, against a fake SMTP server.
//
// WHY THIS IS WORTH A TEST. Everything else in this package is pure and
// already covered, but Send is the only thing that decides whether mail leaves
// the building — and its one security property cannot be checked by reading
// the code: that we REFUSE to hand over the SMTP password, and with it the
// invitee's one-time token, to a server that will not encrypt the connection.
// That question was previously left open ("it was NOT verified whether GoTrue
// refuses a server that declines STARTTLS or continues in plaintext"), and an
// unverified "probably fine" about credentials in clear text is exactly the
// shape of the findings this project keeps notes about.

// fakeSMTP speaks just enough SMTP to accept or refuse one message. It
// advertises STARTTLS only when asked to, which is the whole point: the
// downgrade case has to be reproducible.
type fakeSMTP struct {
	ln       net.Listener
	offerTLS bool
	mu       sync.Mutex
	received []string
	sawAuth  bool
	port     int
}

func newFakeSMTP(t *testing.T, offerTLS bool) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(portStr)
	s := &fakeSMTP{ln: ln, offerTLS: offerTLS, port: port}
	go s.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *fakeSMTP) serve() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *fakeSMTP) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	w := bufio.NewWriter(conn)
	rd := bufio.NewReader(conn)

	say := func(line string) {
		_, _ = w.WriteString(line + "\r\n")
		_ = w.Flush()
	}

	say("220 fake.example.com ESMTP")
	inData := false
	var body strings.Builder

	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")

		if inData {
			if line == "." {
				inData = false
				s.mu.Lock()
				s.received = append(s.received, body.String())
				s.mu.Unlock()
				body.Reset()
				say("250 2.0.0 Ok: queued")
				continue
			}
			body.WriteString(line + "\n")
			continue
		}

		verb := strings.ToUpper(strings.SplitN(line, " ", 2)[0])
		switch verb {
		case "EHLO":
			if s.offerTLS {
				say("250-fake.example.com")
				say("250-STARTTLS")
				say("250 AUTH PLAIN LOGIN")
			} else {
				say("250-fake.example.com")
				say("250 AUTH PLAIN LOGIN")
			}
		case "HELO":
			say("250 fake.example.com")
		case "AUTH":
			s.mu.Lock()
			s.sawAuth = true
			s.mu.Unlock()
			say("235 2.7.0 Authentication successful")
		case "MAIL", "RCPT":
			say("250 2.1.0 Ok")
		case "DATA":
			inData = true
			say("354 End data with <CR><LF>.<CR><LF>")
		case "QUIT":
			say("221 2.0.0 Bye")
			return
		default:
			say("250 2.0.0 Ok")
		}
	}
}

func (s *fakeSMTP) messages() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.received...)
}

func (s *fakeSMTP) authenticated() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sawAuth
}

// THE SECURITY PROPERTY. A server that will not negotiate TLS does not get the
// password — and therefore does not get the message, which carries a one-time
// sign-in credential for somebody's account. An on-path attacker who can strip
// the STARTTLS offer would otherwise be handed both, and a quiet downgrade is
// the kind of failure nobody ever notices.
func TestSendRefusesToAuthenticateWithoutEncryption(t *testing.T) {
	s := newFakeSMTP(t, false)
	c := Config{
		Host: "127.0.0.1", Port: s.port,
		Username: "user", Password: "secret",
		From: "no-reply@example.com", FromName: "COS",
	}

	err := c.Send(context.Background(), Message{
		To: "sam@example.org", Subject: "Invitation", Text: "Hello.\n",
	})
	if !errors.Is(err, ErrNoEncryption) {
		t.Fatalf("expected ErrNoEncryption, got %v", err)
	}
	if s.authenticated() {
		t.Fatal("credentials were sent over an unencrypted connection")
	}
	if len(s.messages()) != 0 {
		t.Fatal("the message was delivered despite the refusal")
	}
}

// A relay that needs no credentials is a real deployment — a local MTA, an
// IP-allowlisted gateway — and there is nothing to hand over, so plaintext is
// allowed there. Refusing it would break a legitimate setup for no gain.
func TestSendAllowsPlaintextWhenThereIsNoCredentialToProtect(t *testing.T) {
	s := newFakeSMTP(t, false)
	c := Config{Host: "127.0.0.1", Port: s.port, From: "no-reply@example.com", FromName: "COS"}

	if err := c.Send(context.Background(), Message{
		To:      "sam@example.org",
		Subject: "Dana has invited you to the Growth workshop",
		Text:    "Hello Sam,\n\nOpen https://example.com/welcome?token_hash=abc&type=recovery\n",
		ReplyTo: "dana@example.com",
	}); err != nil {
		t.Fatalf("send failed: %v", err)
	}

	msgs := s.messages()
	if len(msgs) != 1 {
		t.Fatalf("expected one message, got %d", len(msgs))
	}
	raw := msgs[0]

	// The headers that decide whether a receiver trusts the message at all.
	for _, want := range []string{
		"From: \"COS\" <no-reply@example.com>",
		"To: sam@example.org",
		"Reply-To: dana@example.com",
		"Message-ID: <",
		"multipart/alternative",
	} {
		if !strings.Contains(raw, want) {
			t.Errorf("missing %q in delivered message", want)
		}
	}
	if s.authenticated() {
		t.Error("authenticated when no credentials were configured")
	}
}

func TestSendRefusesAnUnconfiguredServerAndABadAddress(t *testing.T) {
	if err := (Config{}).Send(context.Background(), Message{To: "a@b.com"}); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("expected ErrNotConfigured, got %v", err)
	}
	s := newFakeSMTP(t, false)
	c := Config{Host: "127.0.0.1", Port: s.port, From: "no-reply@example.com"}
	// Refused before any connection, so a typo in an invite cannot leave a
	// half-open session or a confusing provider error.
	if err := c.Send(context.Background(), Message{To: "not an address"}); err == nil {
		t.Error("a malformed recipient was accepted")
	}
}
