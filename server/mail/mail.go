// Package mail sends sign-in codes and share notices over SMTP (Gmail by
// default) with an app password, the same way super-matrix does.
package mail

import (
	"errors"
	"fmt"
	"html"
	"log"

	"gopkg.in/gomail.v2"

	"main/config"
	"main/otp"
)

// ErrOff is returned when SMTP isn't configured.
var ErrOff = errors.New("email isn't set up on this server")

// Mailer is what the API sends email through (a fake in tests).
type Mailer interface {
	Ready() bool
	SendCode(to, code string) error
	SendShareNotice(to, fromName, origin string) error
}

type Sender struct {
	host        string
	port        int
	email       string
	appPassword string
	// logCodes prints codes to the server log instead of failing when SMTP
	// isn't configured, so local dev works without a mail account.
	logCodes bool
}

func New(cfg config.Config) *Sender {
	return &Sender{
		host: cfg.SMTPHost, port: cfg.SMTPPort, email: cfg.SMTPEmail, appPassword: cfg.SMTPAppPassword,
		logCodes: cfg.LogCodes,
	}
}

func (s *Sender) configured() bool { return s.email != "" && s.appPassword != "" }

// Ready reports whether codes can be delivered (or, in dev, logged).
func (s *Sender) Ready() bool { return s.configured() || s.logCodes }

// SendCode emails a sign-in code.
func (s *Sender) SendCode(to, code string) error {
	if !s.configured() {
		if s.logCodes {
			log.Printf("sign-in code for %s: %s (SMTP not configured)", to, code)
			return nil
		}
		return ErrOff
	}
	return s.send(to, fmt.Sprintf("%s is your Super Pages code", code), fmt.Sprintf(`
        <p>Your code to sign in to <b>Super Pages</b> is:</p>
        <h2 style="letter-spacing: 4px;">%s</h2>
        <p>It's valid for 10 minutes. If you didn't ask for it, you can ignore this email.</p>
    `, code))
}

// SendShareNotice tells someone without an account that a page was shared
// with them. It carries no document content, only who and where to go.
func (s *Sender) SendShareNotice(to, fromName, origin string) error {
	if !s.configured() {
		if s.logCodes {
			log.Printf("share notice for %s from %q (SMTP not configured)", otp.Mask(to), fromName)
			return nil
		}
		return ErrOff
	}
	if fromName == "" {
		fromName = "Someone"
	}
	link := origin
	if link == "" {
		link = "https://pages.superbadger.io"
	}
	return s.send(to, fmt.Sprintf("%s shared a page with you on Super Pages", fromName), fmt.Sprintf(`
        <p><b>%s</b> shared a page with you on Super Pages.</p>
        <p><a href="%s">Sign in with this email address</a> to open it. No invite code needed.</p>
        <p>Pages are end-to-end encrypted; this email doesn't contain any of it.</p>
    `, html.EscapeString(fromName), html.EscapeString(link)))
}

func (s *Sender) send(to, subject, body string) error {
	m := gomail.NewMessage()
	m.SetHeader("From", m.FormatAddress(s.email, "Super Pages"))
	m.SetHeader("To", to)
	m.SetHeader("Subject", subject)
	m.SetBody("text/html", body)
	d := gomail.NewDialer(s.host, s.port, s.email, s.appPassword)
	if err := d.DialAndSend(m); err != nil {
		return fmt.Errorf("smtp send: %w", err)
	}
	return nil
}
