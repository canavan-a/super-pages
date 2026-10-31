package api

import (
	"testing"
	"time"
)

func TestLive(t *testing.T) {
	e := newEnv(t)
	owner := e.signup("owner@example.com", "Owner", "")
	viewer := e.signup("viewer@example.com", "Viewer", "")
	stranger := e.signup("stranger@example.com", "Stranger", "")
	doc := e.createDoc(owner)
	e.share(owner, doc, viewer, "view")
	path := "/v1/docs/" + doc + "/live"
	checkIn := func(u *user, body map[string]any) (int, map[string]any) {
		t.Helper()
		st, out, _ := e.do("POST", path, body, u.priv, nil)
		return st, out
	}

	// Two tabs of the owner and one of the viewer open the page.
	st, out := checkIn(owner, map[string]any{"tab": "owner-tab-1", "since": -1, "aware": "cursor-1"})
	if st != 200 {
		t.Fatalf("check-in: %d %v", st, out)
	}
	checkIn(owner, map[string]any{"tab": "owner-tab-2", "since": -1})
	st, out = checkIn(viewer, map[string]any{"tab": "viewer-tab", "since": -1})
	if st != 200 || len(out["viewers"].([]any)) != 3 {
		t.Fatalf("viewers: %d %v", st, out)
	}
	first := out["viewers"].([]any)[0].(map[string]any)
	if first["tab"] != "owner-tab-1" || first["aware"] != "cursor-1" || first["user"] != owner.ID {
		t.Fatalf("first viewer: %v", first)
	}
	since, gen := int64(out["seq"].(float64)), int64(out["gen"].(float64))

	// The viewer waits; the owner's change wakes it up.
	done := make(chan map[string]any)
	go func() {
		_, out := checkIn(viewer, map[string]any{"tab": "viewer-tab", "since": since, "gen": gen, "wait": true})
		done <- out
	}()
	time.Sleep(50 * time.Millisecond)
	if st, out := checkIn(owner, map[string]any{"tab": "owner-tab-1", "since": since, "updates": []string{"change-a", "change-b"}}); st != 200 || len(out["msgs"].([]any)) != 0 {
		t.Fatalf("send: %d %v (a tab doesn't get its own changes back)", st, out)
	}
	select {
	case out := <-done:
		msgs := out["msgs"].([]any)
		if len(msgs) != 2 || msgs[0].(map[string]any)["data"] != "change-a" || msgs[1].(map[string]any)["tab"] != "owner-tab-1" {
			t.Fatalf("woken with %v", out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the waiting check-in wasn't woken")
	}

	// The owner's other tab gets them too, and a new tab gets the buffer.
	if _, out := checkIn(owner, map[string]any{"tab": "owner-tab-2", "since": since}); len(out["msgs"].([]any)) != 2 {
		t.Fatalf("other tab: %v", out)
	}
	if _, out := checkIn(owner, map[string]any{"tab": "owner-tab-3", "since": -1}); len(out["msgs"].([]any)) != 2 {
		t.Fatalf("new tab: %v", out)
	}

	// View members can't send changes; strangers can't check in at all.
	if st, _ := checkIn(viewer, map[string]any{"tab": "viewer-tab", "since": 0, "updates": []string{"x"}}); st != 403 {
		t.Fatalf("viewer sent a change: %d", st)
	}
	if st, _ := checkIn(stranger, map[string]any{"tab": "stranger-tab", "since": -1}); st != 404 {
		t.Fatalf("stranger: %d", st)
	}
	if st, _ := checkIn(owner, map[string]any{"tab": "x", "since": -1}); st != 400 {
		t.Fatalf("bad tab id: %d", st)
	}

	// Leaving takes a tab off the list at once, and wakes the others.
	go func() {
		_, out := checkIn(viewer, map[string]any{"tab": "viewer-tab", "since": since + 2, "gen": -1, "wait": false})
		gen := int64(out["gen"].(float64))
		_, out = checkIn(viewer, map[string]any{"tab": "viewer-tab", "since": since + 2, "gen": gen, "wait": true})
		done <- out
	}()
	time.Sleep(50 * time.Millisecond)
	checkIn(owner, map[string]any{"tab": "owner-tab-3", "leaving": true})
	select {
	case out := <-done:
		for _, v := range out["viewers"].([]any) {
			if v.(map[string]any)["tab"] == "owner-tab-3" {
				t.Fatalf("still listed after leaving: %v", out)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("leaving didn't wake the others")
	}

	// Going quiet takes a tab off after 30s.
	checkIn(owner, map[string]any{"tab": "owner-tab-2", "since": -1})
	e.api.SetClock(func() time.Time { return time.Now().Add(25 * time.Second) })
	checkIn(owner, map[string]any{"tab": "owner-tab-2", "since": -1})
	e.api.SetClock(func() time.Time { return time.Now().Add(40 * time.Second) })
	_, out = checkIn(viewer, map[string]any{"tab": "viewer-tab", "since": -1})
	var tabs []string
	for _, v := range out["viewers"].([]any) {
		tabs = append(tabs, v.(map[string]any)["tab"].(string))
	}
	if len(tabs) != 2 || tabs[0] != "owner-tab-2" || tabs[1] != "viewer-tab" {
		t.Fatalf("after 30s: %v", tabs)
	}

	// Long after, the changes are gone from the buffer: a tab that was
	// behind (or ahead, after a restart) is told to reload.
	e.api.SetClock(func() time.Time { return time.Now().Add(10 * time.Minute) })
	if _, out := checkIn(viewer, map[string]any{"tab": "viewer-tab", "since": since + 2}); out["reset"] != true {
		t.Fatalf("expected a reset: %v", out)
	}
}
