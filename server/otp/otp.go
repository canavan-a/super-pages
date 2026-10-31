// Package otp holds email sign-in codes and the tickets a verified code
// turns into. Both live only in memory, as hashes: a restart just means
// asking for a new code. Ported from super-matrix's edge/otp.go.
package otp

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"math/big"
	netmail "net/mail"
	"strings"
	"sync"
	"time"

	"main/proto"
)

const (
	CodeTTL      = 10 * time.Minute
	CodeAttempts = 5
	// TicketTTL is how long a verified email has to finish signing up (set
	// a passphrase, write down the recovery phrase) or reset.
	TicketTTL = 30 * time.Minute
	// TicketAttempts caps wrong registration codes per ticket.
	TicketAttempts = 5
)

type code struct {
	hash    [32]byte
	expires time.Time
	tries   int
}

type ticket struct {
	email   string
	expires time.Time
	tries   int
}

type Store struct {
	mu      sync.Mutex
	codes   map[string]*code     // email
	tickets map[[32]byte]*ticket // sha256(ticket)
}

func NewStore() *Store {
	return &Store{codes: map[string]*code{}, tickets: map[[32]byte]*ticket{}}
}

func hashCode(email, c string) [32]byte { return sha256.Sum256([]byte(email + "\x00" + c)) }

// NewCode makes a 6-digit code for email, replacing any earlier one.
func (s *Store) NewCode(email string, now time.Time) (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	c := fmt.Sprintf("%06d", n.Int64())
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep(now)
	s.codes[email] = &code{hash: hashCode(email, c), expires: now.Add(CodeTTL)}
	return c, nil
}

// Check uses up a code if it matches. A code dies after CodeAttempts wrong
// guesses or CodeTTL.
func (s *Store) Check(email, c string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.codes[email]
	if cur == nil {
		return false
	}
	if now.After(cur.expires) {
		delete(s.codes, email)
		return false
	}
	h := hashCode(email, c)
	if subtle.ConstantTimeCompare(h[:], cur.hash[:]) == 1 {
		delete(s.codes, email)
		return true
	}
	cur.tries++
	if cur.tries >= CodeAttempts {
		delete(s.codes, email)
	}
	return false
}

// NewTicket issues a ticket proving email was verified just now.
func (s *Store) NewTicket(email string, now time.Time) string {
	t := proto.NewSecret()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep(now)
	s.tickets[sha256.Sum256([]byte(t))] = &ticket{email: email, expires: now.Add(TicketTTL)}
	return t
}

// TicketEmail returns the email a live ticket was issued for, or "".
func (s *Store) TicketEmail(t string, now time.Time) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.tickets[sha256.Sum256([]byte(t))]
	if cur == nil || now.After(cur.expires) || cur.tries >= TicketAttempts {
		return ""
	}
	return cur.email
}

// FailTicket counts a wrong registration code against a ticket.
func (s *Store) FailTicket(t string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur := s.tickets[sha256.Sum256([]byte(t))]; cur != nil {
		cur.tries++
	}
}

// UseTicket spends a ticket.
func (s *Store) UseTicket(t string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.tickets, sha256.Sum256([]byte(t)))
}

// sweep drops expired entries once the maps get big. Caller holds mu.
func (s *Store) sweep(now time.Time) {
	if len(s.codes) > 10000 {
		for k, c := range s.codes {
			if now.After(c.expires) {
				delete(s.codes, k)
			}
		}
	}
	if len(s.tickets) > 10000 {
		for k, t := range s.tickets {
			if now.After(t.expires) {
				delete(s.tickets, k)
			}
		}
	}
}

// NormalizeEmail lowercases and checks an address; "" if it isn't one.
func NormalizeEmail(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) > 254 || strings.ContainsAny(s, "|\n\r") {
		return ""
	}
	a, err := netmail.ParseAddress(s)
	if err != nil || a.Address != s || !strings.Contains(s, "@") {
		return ""
	}
	return s
}

// Mask hides most of an address for logs and for showing a pending share to
// a document's other owners: "alice@example.com" → "a***@example.com".
func Mask(email string) string {
	at := strings.LastIndexByte(email, '@')
	if at < 1 {
		return "***"
	}
	return email[:1] + "***" + email[at:]
}
