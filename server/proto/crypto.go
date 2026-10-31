// Package proto is the server's copy of docs/protocol.md: identifiers and
// signature checks. app/src/crypto is the client's copy; the two must agree
// byte for byte.
package proto

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
)

var (
	B64 = base64.RawURLEncoding
	b32 = base32.StdEncoding.WithPadding(base32.NoPadding)
)

// KeyID encodes an Ed25519 public key as the text that X-SP-Key carries. An
// account's signing key changes only when the account is reset, so it isn't
// the account's ID (users.id is); it's how a request names its signer.
func KeyID(pub ed25519.PublicKey) string {
	return strings.ToLower(b32.EncodeToString(pub))
}

// ParseKeyID returns the public key a key ID encodes.
func ParseKeyID(id string) (ed25519.PublicKey, error) {
	if len(id) != 52 || id != strings.ToLower(id) {
		return nil, errors.New("bad key id")
	}
	b, err := b32.DecodeString(strings.ToUpper(id))
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("bad key id")
	}
	return ed25519.PublicKey(b), nil
}

// Verify checks sig over domain‖msg by the key id.
func Verify(id string, domain string, msg []byte, sig []byte) bool {
	pub, err := ParseKeyID(id)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(pub, append([]byte(domain), msg...), sig)
}

// VerifyKey is Verify for a raw b64 public key (share-link keys).
func VerifyKey(pubB64 string, msg []byte, sig []byte) bool {
	pub, err := B64.DecodeString(pubB64)
	if err != nil || len(pub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pub), msg, sig)
}

// IsKey reports whether s is a b64 32-byte public key (Ed25519 or X25519).
func IsKey(s string) bool {
	b, err := B64.DecodeString(s)
	return err == nil && len(b) == 32
}

// RequestSigningString is what X-SP-Sig signs.
func RequestSigningString(method, pathQuery, ts, nonce string, body []byte) []byte {
	sum := sha256.Sum256(body)
	return []byte("SP1\n" + method + "\n" + pathQuery + "\n" + ts + "\n" + nonce + "\n" + hex.EncodeToString(sum[:]))
}

// DocSigningString is what a document save's sig signs (domain "sp-doc").
// It binds the ciphertext to the document, the version it becomes and the
// key epoch it was sealed under, so a save can't be replayed elsewhere.
func DocSigningString(doc string, version, epoch int64, head, body string) []byte {
	h := sha256.Sum256([]byte(head))
	b := sha256.Sum256([]byte(body))
	return []byte(doc + "|" + strconv.FormatInt(version, 10) + "|" + strconv.FormatInt(epoch, 10) + "|" + hex.EncodeToString(h[:]) + "|" + hex.EncodeToString(b[:]))
}

// JoinSigningString is what a share-link key signs to let user join doc
// (domain "sp-join").
func JoinSigningString(link, doc, user string) []byte {
	return []byte(link + "|" + doc + "|" + user)
}

// IsID reports whether s is a 16-byte b64 identifier.
func IsID(s string) bool {
	b, err := B64.DecodeString(s)
	return err == nil && len(b) == 16
}

// NewID returns a fresh random 16-byte b64 identifier.
func NewID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return B64.EncodeToString(b)
}

// NewSecret returns 32 random bytes in b64, for tickets.
func NewSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return B64.EncodeToString(b)
}
