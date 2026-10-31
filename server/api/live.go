package api

import (
	"context"
	"net/http"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// Live editing. Everyone with a page open (each tab, each device) checks in
// here with a random tab id: the server keeps who's there, each tab's latest
// "aware" blob (its cursor), and a short buffer of the changes tabs send, and
// hands them on. All of it is sealed under the page's key by the apps; the
// server only relays opaque strings, in memory. Changes are CRDT updates, so
// replaying or reordering them is harmless, and anything older than the
// buffer is in the saved page already (every tab saves what it typed).
const (
	// A visible tab checks in every few seconds; a hidden one (browsers slow
	// its timers to once a minute) is kept longer.
	liveTTL       = 20 * time.Second
	liveHiddenTTL = 100 * time.Second
	// How long a check-in with nothing new waits for something to happen.
	liveWait = 20 * time.Second
	// The change buffer: this long, or this many changes or bytes, per page.
	liveKeep      = 3 * time.Minute
	liveKeepCount = 2000
	liveKeepBytes = 8 << 20
	// One change, one cursor blob, and the changes in one check-in.
	liveMaxUpdate = 256 << 10
	liveMaxAware  = 2 << 10
	liveMaxBatch  = 64
	// Open copies one page tracks, and one person can hold in it.
	livePerDoc  = 64
	livePerUser = 16
)

var tabID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,32}$`)

type liveKey struct{ user, tab string }

type liveTab struct {
	since, seen time.Time
	hidden      bool
	aware       string
}

type liveMsg struct {
	Seq  int64     `json:"seq"`
	User string    `json:"user"`
	Tab  string    `json:"tab"`
	Data string    `json:"data"`
	at   time.Time `json:"-"`
}

type liveDoc struct {
	tabs  map[liveKey]*liveTab
	msgs  []liveMsg
	bytes int
	// seq of the newest change; first is the oldest seq still buffered.
	seq, first int64
	// Closed (and replaced) whenever anything changes, to wake waiters; gen
	// counts the changes, so a tab can tell it missed one between check-ins.
	changed chan struct{}
	gen     int64
}

type liveHub struct {
	mu        sync.Mutex
	docs      map[string]*liveDoc
	lastSweep time.Time
}

func newLiveHub() *liveHub { return &liveHub{docs: map[string]*liveDoc{}} }

func (d *liveDoc) wake() {
	close(d.changed)
	d.changed = make(chan struct{})
	d.gen++
}

// prune drops tabs not heard from and changes past keeping. True if any tab
// went (so waiters should hear about it).
func (d *liveDoc) prune(now time.Time) bool {
	gone := false
	for k, t := range d.tabs {
		ttl := liveTTL
		if t.hidden {
			ttl = liveHiddenTTL
		}
		if now.Sub(t.seen) > ttl {
			delete(d.tabs, k)
			gone = true
		}
	}
	drop := 0
	for drop < len(d.msgs) {
		m := d.msgs[drop]
		if now.Sub(m.at) <= liveKeep && len(d.msgs)-drop <= liveKeepCount && d.bytes <= liveKeepBytes {
			break
		}
		d.bytes -= len(m.Data)
		drop++
	}
	if drop > 0 {
		d.msgs = append([]liveMsg(nil), d.msgs[drop:]...)
	}
	if len(d.msgs) > 0 {
		d.first = d.msgs[0].Seq
	} else {
		d.first = d.seq + 1
	}
	return gone
}

func (h *liveHub) doc(id string, now time.Time) *liveDoc {
	if now.Sub(h.lastSweep) > time.Minute {
		for k, d := range h.docs {
			if d.prune(now) {
				d.wake()
			}
			if len(d.tabs) == 0 && len(d.msgs) == 0 {
				delete(h.docs, k)
			}
		}
		h.lastSweep = now
	}
	d := h.docs[id]
	if d == nil {
		d = &liveDoc{tabs: map[liveKey]*liveTab{}, changed: make(chan struct{}), first: 1}
		h.docs[id] = d
	}
	if d.prune(now) {
		d.wake()
	}
	return d
}

// drop forgets everyone on a page (deleted, or moved to a new key) or one
// person on it (removed).
func (h *liveHub) drop(doc, user string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	d := h.docs[doc]
	if d == nil {
		return
	}
	if user == "" {
		d.msgs, d.bytes, d.first = nil, 0, d.seq+1
	}
	for k := range d.tabs {
		if user == "" || k.user == user {
			delete(d.tabs, k)
		}
	}
	d.wake()
}

type liveReq struct {
	Tab     string   `json:"tab"`
	Hidden  bool     `json:"hidden"`
	Leaving bool     `json:"leaving"`
	Aware   string   `json:"aware"`
	Updates []string `json:"updates"`
	// Since is the newest seq the tab has, or -1 on its first check-in (it
	// has just loaded the saved page: send everything buffered). Wait asks
	// the server to hold the answer until something happens after gen.
	Since int64 `json:"since"`
	Gen   int64 `json:"gen"`
	Wait  bool  `json:"wait"`
}

type viewerView struct {
	User  string `json:"user"`
	Tab   string `json:"tab"`
	Aware string `json:"aware,omitempty"`
}

type liveResp struct {
	Seq     int64        `json:"seq"`
	Gen     int64        `json:"gen"`
	Reset   bool         `json:"reset,omitempty"`
	Msgs    []liveMsg    `json:"msgs"`
	Viewers []viewerView `json:"viewers"`
	Version int64        `json:"version"`
	Epoch   int64        `json:"epoch"`
}

// liveCheckIn: POST /v1/docs/:id/live. Members only (view members too: they
// see the others and the page change, but can't send changes).
func (a *API) liveCheckIn(c *gin.Context) {
	var req liveReq
	if !bindBody(c, &req) {
		return
	}
	if !tabID.MatchString(req.Tab) || len(req.Aware) > liveMaxAware || len(req.Updates) > liveMaxBatch {
		abort(c, http.StatusBadRequest, "bad check-in")
		return
	}
	for _, u := range req.Updates {
		if u == "" || len(u) > liveMaxUpdate {
			abort(c, http.StatusBadRequest, "bad change")
			return
		}
	}
	d, role, ok := a.access(c, c.Param("id"))
	if !ok {
		return
	}
	if len(req.Updates) > 0 && !need(c, role != "view", "you can only view this page") {
		return
	}
	user := me(c).ID
	k := liveKey{user, req.Tab}

	a.live.mu.Lock()
	now := a.now()
	ld := a.live.doc(d.ID, now)
	if req.Leaving {
		if _, ok := ld.tabs[k]; ok {
			delete(ld.tabs, k)
			ld.wake()
		}
		a.live.mu.Unlock()
		c.Status(http.StatusNoContent)
		return
	}
	t := ld.tabs[k]
	if t == nil {
		mine := 0
		for o := range ld.tabs {
			if o.user == user {
				mine++
			}
		}
		if len(ld.tabs) >= livePerDoc || mine >= livePerUser {
			a.live.mu.Unlock()
			abort(c, http.StatusTooManyRequests, "this page is open in too many places")
			return
		}
		t = &liveTab{since: now}
		ld.tabs[k] = t
		ld.wake()
	}
	t.seen, t.hidden = now, req.Hidden
	if req.Aware != t.aware {
		t.aware = req.Aware
		ld.wake()
	}
	for _, u := range req.Updates {
		ld.seq++
		ld.msgs = append(ld.msgs, liveMsg{Seq: ld.seq, User: user, Tab: req.Tab, Data: u, at: now})
		ld.bytes += len(u)
	}
	if len(req.Updates) > 0 {
		ld.prune(now)
		ld.wake()
	}
	// Nothing new since this tab last heard, and it asked to wait: wait.
	if req.Wait && len(req.Updates) == 0 && req.Since >= 0 && ld.gen == req.Gen {
		ch := ld.changed
		a.live.mu.Unlock()
		ctx, cancel := context.WithTimeout(c.Request.Context(), liveWait)
		select {
		case <-ch:
		case <-ctx.Done():
		}
		cancel()
		if c.Request.Context().Err() != nil {
			return
		}
		a.live.mu.Lock()
		ld = a.live.doc(d.ID, a.now())
		if t := ld.tabs[k]; t != nil {
			t.seen = a.now()
		}
	}
	resp := liveResp{Seq: ld.seq, Gen: ld.gen, Msgs: []liveMsg{}, Viewers: []viewerView{}}
	if req.Since >= 0 && (req.Since < ld.first-1 || req.Since > ld.seq) {
		// It missed changes that are gone from the buffer (or the server
		// restarted and forgot them): it should reload the saved page, then
		// carry on from here.
		resp.Reset = true
	} else {
		for _, m := range ld.msgs {
			if m.Seq > req.Since && m.Tab != req.Tab {
				resp.Msgs = append(resp.Msgs, m)
			}
		}
	}
	type sorted struct {
		v     viewerView
		since time.Time
	}
	var vs []sorted
	for k, t := range ld.tabs {
		vs = append(vs, sorted{viewerView{User: k.user, Tab: k.tab, Aware: t.aware}, t.since})
	}
	a.live.mu.Unlock()
	sort.Slice(vs, func(i, j int) bool {
		if !vs[i].since.Equal(vs[j].since) {
			return vs[i].since.Before(vs[j].since)
		}
		return vs[i].v.Tab < vs[j].v.Tab
	})
	for _, v := range vs {
		resp.Viewers = append(resp.Viewers, v.v)
	}
	// The saved version and key epoch now, so tabs notice saves and new keys.
	var cur struct{ Version, KeyEpoch int64 }
	if err := a.db.Table("documents").Select("version, key_epoch").Where("id = ?", d.ID).Take(&cur).Error; err != nil {
		dbError(c, err)
		return
	}
	resp.Version, resp.Epoch = cur.Version, cur.KeyEpoch
	c.JSON(http.StatusOK, resp)
}
