// Package regcode makes and checks the pre-release registration codes that
// gate new accounts. A code is 12 Crockford base32 characters shown as
// XXXX-XXXX-XXXX; only its SHA-256 is stored.
package regcode

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"

	"main/database"
	"main/proto"
)

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// ErrInvalid covers wrong, revoked, expired and used-up codes alike, so a
// guesser learns nothing from which.
var ErrInvalid = errors.New("that registration code isn't valid")

// Generate returns a fresh code in display form.
func Generate() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	var sb strings.Builder
	for i, v := range b {
		if i > 0 && i%4 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(alphabet[int(v)%len(alphabet)])
	}
	return sb.String()
}

// Normalize strips separators and spaces, uppercases, and maps the
// characters Crockford base32 treats as look-alikes (I, L → 1; O → 0).
func Normalize(code string) string {
	var sb strings.Builder
	for _, r := range strings.ToUpper(code) {
		switch {
		case r == '-' || r == ' ':
		case r == 'I' || r == 'L':
			sb.WriteByte('1')
		case r == 'O':
			sb.WriteByte('0')
		default:
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// Hash is what's stored for code.
func Hash(code string) string {
	h := sha256.Sum256([]byte("sp-regcode|" + Normalize(code)))
	return hex.EncodeToString(h[:])
}

// Create stores a new code and returns it; the code itself is never stored.
func Create(db *gorm.DB, label string, maxUses int64, ttl time.Duration, now time.Time) (string, database.RegistrationCode, error) {
	code := Generate()
	rc := database.RegistrationCode{
		ID: proto.NewID(), CodeHash: Hash(code), Label: label, MaxUses: maxUses, CreatedAt: now.Unix(),
	}
	if ttl > 0 {
		exp := now.Add(ttl).Unix()
		rc.ExpiresAt = &exp
	}
	return code, rc, db.Create(&rc).Error
}

// Redeem uses one use of code for user inside tx.
func Redeem(tx *gorm.DB, code, user string, now time.Time) error {
	var rc database.RegistrationCode
	err := tx.Where("code_hash = ?", Hash(code)).Take(&rc).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrInvalid
	}
	if err != nil {
		return err
	}
	if rc.Revoked || rc.Uses >= rc.MaxUses || (rc.ExpiresAt != nil && now.Unix() >= *rc.ExpiresAt) {
		return ErrInvalid
	}
	res := tx.Model(&database.RegistrationCode{}).Where("id = ? AND uses < max_uses", rc.ID).
		Update("uses", gorm.Expr("uses + 1"))
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected != 1 {
		return ErrInvalid
	}
	return tx.Create(&database.CodeRedemption{CodeID: rc.ID, UserID: user, At: now.Unix()}).Error
}
