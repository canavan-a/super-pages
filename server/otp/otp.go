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
)

// admitted, on a code and the ticket it turns into, says the sign-in may
// make a new account: it gave the pre-release code, or none is needed.
type code struct {
	hash     [32]byte
	expires  time.Time
	tries    int
	admitted bool
}

type ticket struct {
	email    string
	expires  time.Time
	admitted bool
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
func (s *Store) NewCode(email string, admitted bool, now time.Time) (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	c := fmt.Sprintf("%06d", n.Int64())
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep(now)
	s.codes[email] = &code{hash: hashCode(email, c), expires: now.Add(CodeTTL), admitted: admitted}
	return c, nil
}

// Check uses up a code if it matches, and says whether it was admitted. A
// code dies after CodeAttempts wrong guesses or CodeTTL.
func (s *Store) Check(email, c string, now time.Time) (ok, admitted bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.codes[email]
	if cur == nil {
		return false, false
	}
	if now.After(cur.expires) {
		delete(s.codes, email)
		return false, false
	}
	h := hashCode(email, c)
	if subtle.ConstantTimeCompare(h[:], cur.hash[:]) == 1 {
		delete(s.codes, email)
		return true, cur.admitted
	}
	cur.tries++
	if cur.tries >= CodeAttempts {
		delete(s.codes, email)
	}
	return false, false
}

// NewTicket issues a ticket proving email was verified just now.
func (s *Store) NewTicket(email string, admitted bool, now time.Time) string {
	t := proto.NewSecret()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep(now)
	s.tickets[sha256.Sum256([]byte(t))] = &ticket{email: email, expires: now.Add(TicketTTL), admitted: admitted}
	return t
}

// Ticket returns the email a live ticket was issued for ("" if none) and
// whether it may make a new account.
func (s *Store) Ticket(t string, now time.Time) (email string, admitted bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.tickets[sha256.Sum256([]byte(t))]
	if cur == nil || now.After(cur.expires) {
		return "", false
	}
	return cur.email, cur.admitted
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
