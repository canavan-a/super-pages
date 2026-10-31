package proto

import (
	"encoding/json"
	"os"
	"testing"
)

// testdata/ts-sigs.json is written by app/__tests__/crypto.test.ts
// (UPDATE_FIXTURE=1): signatures the app made, which the server must accept.
func TestTSSignatures(t *testing.T) {
	raw, err := os.ReadFile("testdata/ts-sigs.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		KeyID   string `json:"key_id"`
		Request struct{ Msg, Sig string }
		Doc     struct {
			ID      string
			Version int64
			Epoch   int64
			Head    string
			Body    string
			Msg     string
			Sig     string
		}
		Join struct {
			Link    string
			Doc     string
			User    string
			LinkPub string `json:"link_pub"`
			Proof   string
		}
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	dec := func(s string) []byte {
		b, err := B64.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	want := RequestSigningString("GET", "/v1/me", "1700000000000", "nonce", nil)
	if string(dec(f.Request.Msg)) != string(want) {
		t.Fatalf("request signing string differs:\n%q\n%q", dec(f.Request.Msg), want)
	}
	if !Verify(f.KeyID, "", want, dec(f.Request.Sig)) {
		t.Fatal("request signature rejected")
	}

	msg := DocSigningString(f.Doc.ID, f.Doc.Version, f.Doc.Epoch, f.Doc.Head, f.Doc.Body)
	if string(dec(f.Doc.Msg)) != string(msg) {
		t.Fatalf("doc signing string differs:\n%q\n%q", dec(f.Doc.Msg), msg)
	}
	if !Verify(f.KeyID, "sp-doc", msg, dec(f.Doc.Sig)) {
		t.Fatal("doc signature rejected")
	}

	join := append([]byte("sp-join"), JoinSigningString(f.Join.Link, f.Join.Doc, f.Join.User)...)
	if !VerifyKey(f.Join.LinkPub, join, dec(f.Join.Proof)) {
		t.Fatal("join proof rejected")
	}
}
