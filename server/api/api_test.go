package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"main/config"
	"main/database"
	"main/proto"
	"main/regcode"
)

// fakeMail records what would have been emailed.
type fakeMail struct {
	mu      sync.Mutex
	codes   map[string]string
	notices []string
}

func (f *fakeMail) Ready() bool { return true }
func (f *fakeMail) SendCode(to, code string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.codes[to] = code
	return nil
}
func (f *fakeMail) SendShareNotice(to, _, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notices = append(f.notices, to)
	return nil
}
func (f *fakeMail) code(t *testing.T, to string) string {
	for i := 0; i < 100; i++ {
		f.mu.Lock()
		c, ok := f.codes[to]
		f.mu.Unlock()
		if ok {
			f.mu.Lock()
			delete(f.codes, to)
			f.mu.Unlock()
			return c
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no code sent to %s", to)
	return ""
}

type env struct {
	t    *testing.T
	api  *API
	srv  http.Handler
	mail *fakeMail
	cfg  config.Config
	// bodies collects every response body, for the email-leak check.
	bodies []string
	// ip is the client address; 0 gives each request its own, so only the
	// per-address limits come into play.
	ip int
	n  int
}

func newEnv(t *testing.T, mod ...func(*config.Config)) *env {
	t.Helper()
	dir := t.TempDir()
	cfg := config.Config{
		DataDir: dir, DBPath: filepath.Join(dir, "test.db"), BlobDir: dir, MaxBlobBytes: 1 << 20,
		RequireRegCode: true, ShareInvitesBypassCode: true,
	}
	for _, m := range mod {
		m(&cfg)
	}
	db, err := database.Connect(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	m := &fakeMail{codes: map[string]string{}}
	a := New(db, cfg, m)
	return &env{t: t, api: a, srv: a.Router(), mail: m, cfg: cfg}
}

type user struct {
	ID    string
	Email string
	priv  ed25519.PrivateKey
	key   string
	box   string
}

func genKeys() (ed25519.PrivateKey, string) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	return priv, proto.KeyID(pub)
}

func (e *env) do(method, path string, body any, signer ed25519.PrivateKey, raw []byte) (int, map[string]any, http.Header) {
	e.t.Helper()
	var data []byte
	switch {
	case raw != nil:
		data = raw
	case body != nil:
		data, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	e.n++
	ip := e.ip
	if ip == 0 {
		ip = e.n
	}
	req.RemoteAddr = "10.0." + strconv.Itoa(ip/250) + "." + strconv.Itoa(ip%250+1) + ":1234"
	if signer != nil {
		ts := strconv.FormatInt(e.api.now().UnixMilli(), 10)
		nonce := proto.NewID()
		msg := proto.RequestSigningString(method, path, ts, nonce, data)
		req.Header.Set("X-SP-Key", proto.KeyID(signer.Public().(ed25519.PublicKey)))
		req.Header.Set("X-SP-Ts", ts)
		req.Header.Set("X-SP-Nonce", nonce)
		req.Header.Set("X-SP-Sig", proto.B64.EncodeToString(ed25519.Sign(signer, msg)))
	}
	w := httptest.NewRecorder()
	e.srv.ServeHTTP(w, req)
	e.bodies = append(e.bodies, w.Body.String())
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out, w.Header()
}

func (e *env) code(label string, uses int64) string {
	code, _, err := regcode.Create(e.api.db, label, uses, 0, time.Now())
	if err != nil {
		e.t.Fatal(err)
	}
	return code
}

// verify runs the email-code steps and returns the verify response.
func (e *env) verify(email string) map[string]any {
	e.t.Helper()
	if st, _, _ := e.do("POST", "/v1/auth/email/start", map[string]string{"email": email}, nil, nil); st != 200 {
		e.t.Fatalf("start: %d", st)
	}
	st, out, _ := e.do("POST", "/v1/auth/email/verify", map[string]string{"email": email, "code": e.mail.code(e.t, email)}, nil, nil)
	if st != 200 {
		e.t.Fatalf("verify: %d %v", st, out)
	}
	return out
}

func (e *env) signup(email, name, code string) *user {
	e.t.Helper()
	v := e.verify(email)
	priv, key := genKeys()
	box := proto.B64.EncodeToString(make([]byte, 32))
	st, out, _ := e.do("POST", "/v1/accounts", map[string]string{
		"ticket": v["ticket"].(string), "reg_code": code, "box_pub": box, "bundle": "locked", "name": name,
	}, priv, nil)
	if st != 201 {
		e.t.Fatalf("signup %s: %d %v", email, st, out)
	}
	return &user{ID: out["id"].(string), Email: email, priv: priv, key: key, box: box}
}

func (e *env) createDoc(u *user) string {
	e.t.Helper()
	id := proto.NewID()
	st, out, _ := e.do("POST", "/v1/docs", e.save(u, id, 0, 1, "head", "body", "k-"+u.ID), u.priv, nil)
	if st != 201 {
		e.t.Fatalf("create doc: %d %v", st, out)
	}
	return id
}

func (e *env) save(u *user, doc string, base, epoch int64, head, body, key string) map[string]any {
	sig := ed25519.Sign(u.priv, append([]byte("sp-doc"), proto.DocSigningString(doc, base+1, epoch, head, body)...))
	m := map[string]any{"id": doc, "base_version": base, "epoch": epoch, "head_ct": head, "body_ct": body, "sig": proto.B64.EncodeToString(sig)}
	if key != "" {
		m["wrapped_key"] = key
	}
	return m
}

// share adds who to doc with role, the way the owner's app does.
func (e *env) share(owner *user, doc string, who *user, role string) {
	e.t.Helper()
	st, out, _ := e.do("POST", "/v1/docs/"+doc+"/share", map[string]string{"email": who.Email, "role": role}, owner.priv, nil)
	if st != 200 || out["user"] == nil {
		e.t.Fatalf("share: %d %v", st, out)
	}
	st, out, _ = e.do("POST", "/v1/docs/"+doc+"/members", map[string]any{"user_id": who.ID, "role": role, "epoch": 1, "wrapped_key": "k-" + who.ID}, owner.priv, nil)
	if st != 204 {
		e.t.Fatalf("add member: %d %v", st, out)
	}
}

func TestSignatureAndReplay(t *testing.T) {
	e := newEnv(t)
	u := e.signup("a@example.com", "A", e.code("t", 1))
	if st, _, _ := e.do("GET", "/v1/me", nil, nil, nil); st != 401 {
		t.Fatalf("unsigned: %d", st)
	}
	stranger, _ := genKeys()
	if st, _, _ := e.do("GET", "/v1/me", nil, stranger, nil); st != 401 {
		t.Fatalf("unknown key: %d", st)
	}
	// Same nonce twice.
	data := []byte{}
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	msg := proto.RequestSigningString("GET", "/v1/me", ts, "n1", data)
	for i, want := range []int{200, 401} {
		req := httptest.NewRequest("GET", "/v1/me", nil)
		req.Header.Set("X-SP-Key", u.key)
		req.Header.Set("X-SP-Ts", ts)
		req.Header.Set("X-SP-Nonce", "n1")
		req.Header.Set("X-SP-Sig", proto.B64.EncodeToString(ed25519.Sign(u.priv, msg)))
		w := httptest.NewRecorder()
		e.srv.ServeHTTP(w, req)
		if w.Code != want {
			t.Fatalf("attempt %d: %d", i, w.Code)
		}
	}
}

func TestRegistrationCodes(t *testing.T) {
	e := newEnv(t)
	try := func(email, code string) int {
		v := e.verify(email)
		if v["needs_code"] != true {
			t.Fatalf("expected needs_code for %s", email)
		}
		priv, _ := genKeys()
		st, _, _ := e.do("POST", "/v1/accounts", map[string]string{
			"ticket": v["ticket"].(string), "reg_code": code, "box_pub": proto.B64.EncodeToString(make([]byte, 32)), "bundle": "x",
		}, priv, nil)
		return st
	}
	if st := try("nocode@example.com", ""); st != 403 {
		t.Fatalf("no code: %d", st)
	}
	if st := try("wrong@example.com", "AAAA-BBBB-CCCC"); st != 403 {
		t.Fatalf("wrong code: %d", st)
	}
	one := e.code("one", 1)
	if st := try("first@example.com", strings.ToLower(one)); st != 201 {
		t.Fatalf("good code (any case): %d", st)
	}
	if st := try("second@example.com", one); st != 403 {
		t.Fatalf("used-up code: %d", st)
	}
	revoked := e.code("r", 5)
	e.api.db.Model(&database.RegistrationCode{}).Where("code_hash = ?", regcode.Hash(revoked)).Update("revoked", true)
	if st := try("third@example.com", revoked); st != 403 {
		t.Fatalf("revoked code: %d", st)
	}
	expired, _, _ := regcode.Create(e.api.db, "e", 5, time.Hour, time.Now().Add(-2*time.Hour))
	if st := try("fourth@example.com", expired); st != 403 {
		t.Fatalf("expired code: %d", st)
	}

	off := newEnv(t, func(c *config.Config) { c.RequireRegCode = false })
	off.signup("free@example.com", "F", "")
}

func TestShareInviteSkipsCode(t *testing.T) {
	e := newEnv(t)
	owner := e.signup("owner@example.com", "Owner", e.code("o", 1))
	doc := e.createDoc(owner)
	st, out, _ := e.do("POST", "/v1/docs/"+doc+"/share", map[string]string{"email": "Friend@Example.com", "role": "edit"}, owner.priv, nil)
	if st != 200 || out["pending"] == nil {
		t.Fatalf("pending share: %d %v", st, out)
	}
	if p := out["pending"].(map[string]any); p["email"] != "f***@example.com" {
		t.Fatalf("pending email not masked: %v", p["email"])
	}
	if len(e.mail.notices) != 1 {
		// sent in a goroutine
		time.Sleep(50 * time.Millisecond)
	}
	if v := e.verify("friend@example.com"); v["needs_code"] != false {
		t.Fatalf("invited email asked for a code: %v", v)
	}
	friend := e.signup("friend@example.com", "Friend", "")

	// The owner's app sees the share to finish, then finishes it.
	_, out, _ = e.do("GET", "/v1/shares/todo", nil, owner.priv, nil)
	todo := out["todo"].([]any)
	if len(todo) != 1 || todo[0].(map[string]any)["kind"] != "pending" {
		t.Fatalf("todo: %v", todo)
	}
	item := todo[0].(map[string]any)
	st, out, _ = e.do("POST", "/v1/docs/"+doc+"/members", map[string]any{
		"user_id": friend.ID, "epoch": 1, "wrapped_key": "k", "pending_id": item["pending_id"],
	}, owner.priv, nil)
	if st != 204 {
		t.Fatalf("finish share: %d %v", st, out)
	}
	_, out, _ = e.do("GET", "/v1/docs/"+doc, nil, friend.priv, nil)
	if out["role"] != "edit" || out["key"] != "k" {
		t.Fatalf("friend's view: %v", out)
	}
	for _, m := range out["members"].([]any) {
		mv := m.(map[string]any)
		if mv["id"] == "" || mv["sign_pub"] == "" || mv["box_pub"] == "" || mv["name"] == "" || mv["has_key"] != true {
			t.Fatalf("member fields missing: %v", mv)
		}
	}

	strict := newEnv(t, func(c *config.Config) { c.ShareInvitesBypassCode = false })
	o2 := strict.signup("o@example.com", "O", strict.code("o", 1))
	d2 := strict.createDoc(o2)
	strict.do("POST", "/v1/docs/"+d2+"/share", map[string]string{"email": "x@example.com", "role": "view"}, o2.priv, nil)
	if v := strict.verify("x@example.com"); v["needs_code"] != true {
		t.Fatalf("bypass off but no code needed")
	}
}

func TestEmailRateLimits(t *testing.T) {
	e := newEnv(t)
	e.ip = 1
	var last int
	var hdr http.Header
	for i := 0; i < 4; i++ {
		last, _, hdr = e.do("POST", "/v1/auth/email/start", map[string]string{"email": "spam@example.com"}, nil, nil)
	}
	if last != 429 || hdr.Get("Retry-After") == "" {
		t.Fatalf("per-email limit: %d %q", last, hdr.Get("Retry-After"))
	}
	for i := 0; i < 30; i++ {
		last, _, _ = e.do("POST", "/v1/auth/email/verify", map[string]string{"email": "spam@example.com", "code": "000000"}, nil, nil)
	}
	if last != 429 {
		t.Fatalf("verify limit: %d", last)
	}

	e = newEnv(t, func(c *config.Config) { c.RequireRegCode = false })
	owner := e.signup("owner@example.com", "O", "")
	doc := e.createDoc(owner)
	for i := 0; i < 31; i++ {
		last, _, _ = e.do("POST", "/v1/docs/"+doc+"/share", map[string]string{"email": "p" + strconv.Itoa(i) + "@example.com", "role": "view"}, owner.priv, nil)
	}
	if last != 429 {
		t.Fatalf("share lookup limit: %d", last)
	}
}

func TestWrongCodeAttempts(t *testing.T) {
	e := newEnv(t)
	e.do("POST", "/v1/auth/email/start", map[string]string{"email": "a@example.com"}, nil, nil)
	code := e.mail.code(t, "a@example.com")
	for i := 0; i < 5; i++ {
		e.do("POST", "/v1/auth/email/verify", map[string]string{"email": "a@example.com", "code": "999999x"}, nil, nil)
	}
	if st, _, _ := e.do("POST", "/v1/auth/email/verify", map[string]string{"email": "a@example.com", "code": code}, nil, nil); st != 401 {
		t.Fatalf("code survived 5 wrong tries: %d", st)
	}
}

func TestRoles(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.RequireRegCode = false })
	owner := e.signup("owner@example.com", "Owner", "")
	editor := e.signup("editor@example.com", "Editor", "")
	viewer := e.signup("viewer@example.com", "Viewer", "")
	outsider := e.signup("out@example.com", "Out", "")
	doc := e.createDoc(owner)
	e.share(owner, doc, editor, "edit")
	e.share(owner, doc, viewer, "view")

	if st, _, _ := e.do("GET", "/v1/docs/"+doc, nil, outsider.priv, nil); st != 404 {
		t.Fatalf("outsider read: %d", st)
	}
	if st, _, _ := e.do("PUT", "/v1/docs/"+doc, e.save(viewer, doc, 1, 1, "h", "b", ""), viewer.priv, nil); st != 403 {
		t.Fatalf("viewer write: %d", st)
	}
	if st, out, _ := e.do("PUT", "/v1/docs/"+doc, e.save(editor, doc, 1, 1, "h2", "b2", ""), editor.priv, nil); st != 200 {
		t.Fatalf("editor write: %d %v", st, out)
	}
	// Stale base version.
	if st, out, _ := e.do("PUT", "/v1/docs/"+doc, e.save(owner, doc, 1, 1, "h3", "b3", ""), owner.priv, nil); st != 409 || out["version"] != float64(2) {
		t.Fatalf("stale save: %d %v", st, out)
	}
	// Signature by someone else.
	bad := e.save(editor, doc, 2, 1, "h", "b", "")
	if st, _, _ := e.do("PUT", "/v1/docs/"+doc, bad, owner.priv, nil); st != 400 {
		t.Fatalf("forged signature: %d", st)
	}
	for _, path := range []string{"/v1/docs/" + doc + "/share", "/v1/docs/" + doc + "/links", "/v1/docs/" + doc + "/members"} {
		if st, _, _ := e.do("POST", path, map[string]string{"email": "z@example.com", "role": "view"}, editor.priv, nil); st != 403 {
			t.Fatalf("editor %s: %d", path, st)
		}
	}
	if st, _, _ := e.do("DELETE", "/v1/docs/"+doc, nil, editor.priv, nil); st != 403 {
		t.Fatalf("editor delete: %d", st)
	}
	if st, _, _ := e.do("PATCH", "/v1/docs/"+doc+"/members/"+viewer.ID, map[string]string{"role": "edit"}, editor.priv, nil); st != 403 {
		t.Fatalf("editor set role: %d", st)
	}
	// Last owner.
	if st, _, _ := e.do("PATCH", "/v1/docs/"+doc+"/members/"+owner.ID, map[string]string{"role": "edit"}, owner.priv, nil); st != 409 {
		t.Fatalf("demote last owner: %d", st)
	}
	if st, _, _ := e.do("POST", "/v1/docs/"+doc+"/leave", nil, owner.priv, nil); st != 409 {
		t.Fatalf("last owner leave: %d", st)
	}
	// Viewer leaves: an owner should make a fresh key.
	if st, _, _ := e.do("POST", "/v1/docs/"+doc+"/leave", nil, viewer.priv, nil); st != 204 {
		t.Fatalf("viewer leave: %d", st)
	}
	_, out, _ := e.do("GET", "/v1/shares/todo", nil, owner.priv, nil)
	if todo := out["todo"].([]any); len(todo) != 1 || todo[0].(map[string]any)["kind"] != "rekey" {
		t.Fatalf("rekey todo: %v", out)
	}
	if st, _, _ := e.do("DELETE", "/v1/docs/"+doc, nil, owner.priv, nil); st != 204 {
		t.Fatalf("owner delete: %d", st)
	}
}

func TestRekeyRemovesMember(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.RequireRegCode = false })
	owner := e.signup("owner@example.com", "Owner", "")
	gone := e.signup("gone@example.com", "Gone", "")
	stays := e.signup("stays@example.com", "Stays", "")
	doc := e.createDoc(owner)
	e.share(owner, doc, gone, "edit")
	e.share(owner, doc, stays, "view")
	linkPub := proto.B64.EncodeToString(make([]byte, 32))
	if st, _, _ := e.do("POST", "/v1/docs/"+doc+"/links", map[string]any{"role": "view", "link_pub": linkPub, "key_ct": "x", "epoch": 1}, owner.priv, nil); st != 201 {
		t.Fatalf("link: %d", st)
	}

	rekey := e.save(owner, doc, 1, 2, "h", "b", "")
	rekey["remove"] = []string{gone.ID}
	rekey["keys"] = map[string]string{owner.ID: "k2o"} // missing stays
	if st, _, _ := e.do("POST", "/v1/docs/"+doc+"/rekey", rekey, owner.priv, nil); st != 409 {
		t.Fatalf("rekey missing a member: %d", st)
	}
	rekey = e.save(owner, doc, 1, 2, "h", "b", "")
	rekey["remove"] = []string{gone.ID}
	rekey["keys"] = map[string]string{owner.ID: "k2o", stays.ID: "k2s"}
	if st, out, _ := e.do("POST", "/v1/docs/"+doc+"/rekey", rekey, owner.priv, nil); st != 200 {
		t.Fatalf("rekey: %d %v", st, out)
	}
	if st, _, _ := e.do("GET", "/v1/docs/"+doc, nil, gone.priv, nil); st != 404 {
		t.Fatalf("removed member still reads: %d", st)
	}
	_, out, _ := e.do("GET", "/v1/docs/"+doc, nil, stays.priv, nil)
	if out["key"] != "k2s" || out["epoch"] != float64(2) {
		t.Fatalf("stays: %v", out)
	}
	_, out, _ = e.do("GET", "/v1/docs/"+doc+"/links", nil, owner.priv, nil)
	if len(out["links"].([]any)) != 0 {
		t.Fatalf("links survived the rekey: %v", out)
	}
}

func TestShareLink(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.RequireRegCode = false })
	owner := e.signup("owner@example.com", "Owner", "")
	joiner := e.signup("joiner@example.com", "Joiner", "")
	doc := e.createDoc(owner)
	linkPub, linkPriv, _ := ed25519.GenerateKey(rand.Reader)
	st, out, _ := e.do("POST", "/v1/docs/"+doc+"/links", map[string]any{
		"role": "edit", "link_pub": proto.B64.EncodeToString(linkPub), "key_ct": "sealed", "epoch": 1, "max_uses": 1,
	}, owner.priv, nil)
	if st != 201 {
		t.Fatalf("create link: %d %v", st, out)
	}
	link := out["id"].(string)
	st, out, _ = e.do("GET", "/v1/links/"+link, nil, nil, nil)
	if st != 200 || out["key_ct"] != "sealed" || out["role"] != "edit" {
		t.Fatalf("preview: %d %v", st, out)
	}
	// A proof for someone else doesn't work.
	wrong := ed25519.Sign(linkPriv, append([]byte("sp-join"), proto.JoinSigningString(link, doc, owner.ID)...))
	if st, _, _ := e.do("POST", "/v1/links/"+link+"/join", map[string]string{"proof": proto.B64.EncodeToString(wrong), "wrapped_key": "k"}, joiner.priv, nil); st != 403 {
		t.Fatalf("bad proof: %d", st)
	}
	proof := ed25519.Sign(linkPriv, append([]byte("sp-join"), proto.JoinSigningString(link, doc, joiner.ID)...))
	if st, out, _ := e.do("POST", "/v1/links/"+link+"/join", map[string]string{"proof": proto.B64.EncodeToString(proof), "wrapped_key": "k"}, joiner.priv, nil); st != 200 {
		t.Fatalf("join: %d %v", st, out)
	}
	_, out, _ = e.do("GET", "/v1/docs/"+doc, nil, joiner.priv, nil)
	if out["role"] != "edit" {
		t.Fatalf("joined role: %v", out)
	}
	if st, _, _ := e.do("GET", "/v1/links/"+link, nil, nil, nil); st != 404 {
		t.Fatalf("used-up link still previews: %d", st)
	}
}

func TestResetAccount(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.RequireRegCode = false })
	owner := e.signup("owner@example.com", "Owner", "")
	friend := e.signup("friend@example.com", "Friend", "")
	shared := e.createDoc(owner)
	solo := e.createDoc(friend)
	e.share(owner, shared, friend, "view")

	v := e.verify("friend@example.com")
	acct := v["account"].(map[string]any)
	if acct["bundle"] != "locked" {
		t.Fatalf("verify didn't return the bundle: %v", v)
	}
	priv, _ := genKeys()
	st, out, _ := e.do("POST", "/v1/accounts/reset", map[string]string{
		"ticket": v["ticket"].(string), "box_pub": proto.B64.EncodeToString(make([]byte, 32)), "bundle": "new",
	}, priv, nil)
	if st != 200 || out["id"] != friend.ID || out["key_gen"] != float64(2) {
		t.Fatalf("reset: %d %v", st, out)
	}
	if st, _, _ := e.do("GET", "/v1/me", nil, friend.priv, nil); st != 401 {
		t.Fatalf("old key still works: %d", st)
	}
	if st, _, _ := e.do("GET", "/v1/docs/"+solo, nil, priv, nil); st != 404 {
		t.Fatalf("doc only they could read survived: %d", st)
	}
	_, out, _ = e.do("GET", "/v1/shares/todo", nil, owner.priv, nil)
	todo := out["todo"].([]any)
	if len(todo) != 1 || todo[0].(map[string]any)["kind"] != "key" {
		t.Fatalf("re-share todo: %v", todo)
	}
	if st, _, _ := e.do("PUT", "/v1/docs/"+shared+"/keys/"+friend.ID, map[string]any{"epoch": 1, "wrapped_key": "fresh"}, owner.priv, nil); st != 204 {
		t.Fatalf("re-share: %d", st)
	}
	_, out, _ = e.do("GET", "/v1/docs/"+shared, nil, priv, nil)
	if out["key"] != "fresh" {
		t.Fatalf("after re-share: %v", out)
	}
}

func TestBlobsAndAvatar(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.RequireRegCode = false })
	owner := e.signup("owner@example.com", "Owner", "")
	viewer := e.signup("viewer@example.com", "Viewer", "")
	doc := e.createDoc(owner)
	e.share(owner, doc, viewer, "view")
	st, out, _ := e.do("PUT", "/v1/docs/"+doc+"/blobs", nil, owner.priv, []byte("ciphertext"))
	if st != 201 {
		t.Fatalf("put blob: %d %v", st, out)
	}
	if st, _, _ := e.do("PUT", "/v1/docs/"+doc+"/blobs", nil, viewer.priv, []byte("x")); st != 403 {
		t.Fatalf("viewer upload: %d", st)
	}
	if st, _, _ := e.do("GET", "/v1/docs/"+doc+"/blobs/"+out["id"].(string), nil, viewer.priv, nil); st != 200 {
		t.Fatalf("viewer reads image: %d", st)
	}
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	st, out, _ = e.do("PUT", "/v1/me/avatar", nil, owner.priv, png)
	if st != 200 || out["avatar"] == nil {
		t.Fatalf("avatar: %d %v", st, out)
	}
	if st, _, _ := e.do("PUT", "/v1/me/avatar", nil, owner.priv, []byte("<svg></svg>")); st != 415 {
		t.Fatalf("non-image avatar: %d", st)
	}
	if st, _, _ := e.do("GET", "/v1/users/"+owner.ID+"/avatar", nil, nil, nil); st != 200 {
		t.Fatalf("get avatar: %d", st)
	}
}

// TestNoEmailLeaks runs the whole flow and checks that no response but the
// caller's own /me carries another user's address.
func TestNoEmailLeaks(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.RequireRegCode = false })
	owner := e.signup("owner-secret@example.com", "Owner", "")
	other := e.signup("other-secret@example.com", "Other", "")
	doc := e.createDoc(owner)
	e.share(owner, doc, other, "edit")
	e.do("POST", "/v1/docs/"+doc+"/share", map[string]string{"email": "pending-secret@example.com", "role": "view"}, owner.priv, nil)
	e.bodies = nil
	for _, u := range []*user{owner, other} {
		e.do("GET", "/v1/docs", nil, u.priv, nil)
		e.do("GET", "/v1/docs/"+doc, nil, u.priv, nil)
		e.do("GET", "/v1/shares/todo", nil, u.priv, nil)
	}
	e.do("POST", "/v1/docs/"+doc+"/share", map[string]string{"email": "other-secret@example.com", "role": "view"}, owner.priv, nil)
	for _, b := range e.bodies {
		for _, secret := range []string{"owner-secret@", "other-secret@", "pending-secret@"} {
			if strings.Contains(b, secret) {
				t.Fatalf("response leaks %s: %s", secret, b)
			}
		}
	}
	_, out, _ := e.do("GET", "/v1/me", nil, owner.priv, nil)
	if out["email"] != "owner-secret@example.com" {
		t.Fatalf("/me: %v", out)
	}
}
