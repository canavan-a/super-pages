package api

import (
	"testing"
	"time"
)

func TestPublish(t *testing.T) {
	e := newEnv(t)
	owner := e.signup("owner@example.com", "Owner", "")
	editor := e.signup("editor@example.com", "Editor", "")
	viewer := e.signup("viewer@example.com", "Viewer", "")
	other := e.signup("other@example.com", "Other", "")
	doc := e.createDoc(owner)
	e.share(owner, doc, editor, "edit")
	e.share(owner, doc, viewer, "view")

	push := func(u *user, slug string, base int64, body string) (int, map[string]any) {
		st, out, _ := e.do("PUT", "/v1/docs/"+doc+"/publish", map[string]any{
			"slug": slug, "title": "Hello", "body": body, "base": base,
		}, u.priv, nil)
		return st, out
	}
	read := func(slug string) (int, map[string]any) {
		st, out, _ := e.do("GET", "/v1/pub/"+slug, nil, nil, nil)
		return st, out
	}

	if st, _ := read("smart-bunny"); st != 404 {
		t.Fatalf("unpublished slug: %d", st)
	}
	for _, bad := range []string{"Smart-Bunny", "a", "smart--bunny", "-smart", "smart bunny"} {
		if st, _ := push(owner, bad, 0, "x"); st != 400 {
			t.Fatalf("slug %q: %d", bad, st)
		}
	}
	// Only an owner publishes; editors can't start it, viewers can't touch it.
	if st, _ := push(editor, "smart-bunny", 0, "x"); st != 403 {
		t.Fatalf("editor publish: %d", st)
	}
	if st, _ := push(viewer, "smart-bunny", 0, "x"); st != 403 {
		t.Fatalf("viewer publish: %d", st)
	}
	if st, out := push(owner, "smart-bunny", 0, "v1"); st != 200 || out["slug"] != "smart-bunny" || out["version"].(float64) != 1 {
		t.Fatalf("publish: %d %v", st, out)
	}
	st, out := read("smart-bunny")
	if st != 200 || out["body"] != "v1" || out["title"] != "Hello" || out["public_edit"] != false {
		t.Fatalf("read: %d %v", st, out)
	}
	_, out, _ = e.do("GET", "/v1/docs/"+doc, nil, viewer.priv, nil)
	if p, _ := out["published"].(map[string]any); p["slug"] != "smart-bunny" {
		t.Fatalf("doc view published: %v", out["published"])
	}

	// A save answers with where it's published, so the writer's app sends it on.
	st, out, _ = e.do("PUT", "/v1/docs/"+doc, e.save(editor, doc, 1, 1, "h2", "b2", ""), editor.priv, nil)
	if p, _ := out["published"].(map[string]any); st != 200 || p["slug"] != "smart-bunny" {
		t.Fatalf("save: %d %v", st, out)
	}

	// A reader waiting on version 1 hears about version 2.
	done := make(chan map[string]any)
	go func() {
		_, out, _ := e.do("GET", "/v1/pub/smart-bunny?since=1&wait=1", nil, nil, nil)
		done <- out
	}()
	time.Sleep(50 * time.Millisecond)
	if st, _ := push(editor, "", 1, "v2"); st != 200 {
		t.Fatalf("editor push: %d", st)
	}
	select {
	case out := <-done:
		if out["body"] != "v2" {
			t.Fatalf("live read: %v", out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiting reader never woke")
	}
	// A write from an old base gets the current copy back to merge.
	st, out = push(owner, "", 1, "old")
	if st != 409 || out["body"] != "v2" || out["version"].(float64) != 2 {
		t.Fatalf("stale push: %d %v", st, out)
	}

	// Public edits are off: nobody without an account writes.
	if st, _, _ := e.do("PUT", "/v1/pub/smart-bunny", map[string]any{"body": "spam", "base": 2}, nil, nil); st != 403 {
		t.Fatalf("public edit while off: %d", st)
	}
	// Only owners move it or open it to public edits.
	if st, _, _ := e.do("PATCH", "/v1/docs/"+doc+"/publish", map[string]any{"public_edit": true}, editor.priv, nil); st != 403 {
		t.Fatalf("editor patch: %d", st)
	}
	other2 := e.createDoc(other)
	if st, _, _ := e.do("PUT", "/v1/docs/"+other2+"/publish", map[string]any{"slug": "smart-bunny", "body": "x"}, other.priv, nil); st != 409 {
		t.Fatalf("taken slug: %d", st)
	}
	if st, _, _ := e.do("PATCH", "/v1/docs/"+doc+"/publish", map[string]any{"slug": "quiet-otter", "public_edit": true}, owner.priv, nil); st != 200 {
		t.Fatalf("patch: %d", st)
	}
	if st, _ := read("smart-bunny"); st != 404 {
		t.Fatalf("old slug still there: %d", st)
	}
	if st, out := read("quiet-otter"); st != 200 || out["public_edit"] != true || out["body"] != "v2" {
		t.Fatalf("moved: %d %v", st, out)
	}
	// Now anyone with the link edits it, from the current version.
	if st, out, _ := e.do("PUT", "/v1/pub/quiet-otter", map[string]any{"title": "T", "body": "public", "base": 2}, nil, nil); st != 200 || out["version"].(float64) != 3 {
		t.Fatalf("public edit: %d %v", st, out)
	}
	if st, out, _ := e.do("PUT", "/v1/pub/quiet-otter", map[string]any{"body": "late", "base": 2}, nil, nil); st != 409 || out["body"] != "public" {
		t.Fatalf("stale public edit: %d %v", st, out)
	}
	if st, _ := push(editor, "", 3, "merged"); st != 200 {
		t.Fatalf("member push after public edit: %d", st)
	}

	// Images of the page are public through the slug, and only its own.
	st, out, _ = e.do("PUT", "/v1/docs/"+doc+"/blobs", nil, owner.priv, []byte("sealed"))
	if st != 201 {
		t.Fatalf("blob: %d", st)
	}
	blob := out["id"].(string)
	if st, _, _ := e.do("GET", "/v1/pub/quiet-otter/blobs/"+blob, nil, nil, nil); st != 200 {
		t.Fatalf("public blob: %d", st)
	}
	st, out, _ = e.do("PUT", "/v1/docs/"+other2+"/blobs", nil, other.priv, []byte("secret"))
	if st != 201 {
		t.Fatalf("other blob: %d", st)
	}
	if st, _, _ := e.do("GET", "/v1/pub/quiet-otter/blobs/"+out["id"].(string), nil, nil, nil); st != 404 {
		t.Fatalf("another page's blob: %d", st)
	}

	// Only owners unpublish; deleting the page unpublishes it too.
	if st, _, _ := e.do("DELETE", "/v1/docs/"+doc+"/publish", nil, editor.priv, nil); st != 403 {
		t.Fatalf("editor unpublish: %d", st)
	}
	if st, _, _ := e.do("DELETE", "/v1/docs/"+doc+"/publish", nil, owner.priv, nil); st != 204 {
		t.Fatalf("unpublish: %d", st)
	}
	if st, _ := read("quiet-otter"); st != 404 {
		t.Fatalf("still published: %d", st)
	}
	if st, _ := push(editor, "quiet-otter", 0, "v2"); st != 403 {
		t.Fatalf("editor republish: %d", st)
	}
	push(owner, "quiet-otter", 0, "v2")
	e.do("DELETE", "/v1/docs/"+doc, nil, owner.priv, nil)
	if st, _ := read("quiet-otter"); st != 404 {
		t.Fatalf("deleted page still published: %d", st)
	}
}
