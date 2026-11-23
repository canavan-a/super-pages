package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"main/database"
)

// Publishing puts a page on the web at /p/<slug> for anyone to read, live.
// It's the one place a page leaves end-to-end encryption: the apps send the
// server the page in the clear (see docs/protocol.md).
//
// The public copy is written by members' apps after each save, and, when the
// owner allows public edits, by anyone with the link. Every write names the
// version it started from (base); a stale one gets 409 with the current
// copy, and the writer merges it in (bodies carry Yjs states, which always
// merge) and tries again. Members' apps with the page open merge public
// edits back into the encrypted page and save it.

// Slugs are lowercase words joined by single dashes ("smart-bunny").
var slugRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

const (
	minSlug    = 3
	maxSlug    = 48
	maxPubBody = 4 << 20
	maxPubHead = 512
	pubWait    = 20 * time.Second
)

func validSlug(s string) bool { return len(s) >= minSlug && len(s) <= maxSlug && slugRe.MatchString(s) }

// pubWatch wakes readers waiting on a published page when it changes.
type pubWatch struct {
	mu   sync.Mutex
	subs map[string]chan struct{}
}

func newPubWatch() *pubWatch { return &pubWatch{subs: map[string]chan struct{}{}} }

func (w *pubWatch) wait(slug string) <-chan struct{} {
	w.mu.Lock()
	defer w.mu.Unlock()
	ch, ok := w.subs[slug]
	if !ok {
		ch = make(chan struct{})
		w.subs[slug] = ch
	}
	return ch
}

func (w *pubWatch) wake(slug string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if ch, ok := w.subs[slug]; ok {
		close(ch)
		delete(w.subs, slug)
	}
}

type pubInfo struct {
	Slug       string `json:"slug"`
	PublicEdit bool   `json:"public_edit"`
}

// publishedInfo maps document IDs to how they're published.
func (a *API) publishedInfo(ids []string) (map[string]*pubInfo, error) {
	out := map[string]*pubInfo{}
	if len(ids) == 0 {
		return out, nil
	}
	var rows []database.PublishedPage
	if err := a.db.Select("slug", "doc_id", "public_edit").Where("doc_id IN ?", ids).Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.DocID] = &pubInfo{Slug: r.Slug, PublicEdit: r.PublicEdit}
	}
	return out, nil
}

var (
	errSlugTaken   = errors.New("slug taken")
	errNotOwner    = errors.New("not owner")
	errPubConflict = errors.New("public copy changed")
)

// pubConflict answers a stale write with the current copy to merge.
func pubConflict(c *gin.Context, p *database.PublishedPage) {
	c.AbortWithStatusJSON(http.StatusConflict, gin.H{
		"error": "edited elsewhere", "slug": p.Slug, "version": p.Version, "title": p.Title, "body": p.Body,
	})
}

func pubView(p *database.PublishedPage) gin.H {
	return gin.H{
		"slug": p.Slug, "public_edit": p.PublicEdit, "title": p.Title, "body": p.Body,
		"version": p.Version, "updated_at": p.UpdatedAt,
	}
}

// writePublished stores a new version of a published page if base is the
// current one. cur is filled with the row as it was.
func (a *API) writePublished(where *gorm.DB, base int64, title, body, by string, cur *database.PublishedPage) error {
	return a.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where(where).Take(cur).Error; err != nil {
			return err
		}
		if cur.Version != base {
			return errPubConflict
		}
		res := tx.Model(&database.PublishedPage{}).Where("slug = ? AND version = ?", cur.Slug, base).Updates(map[string]any{
			"title": title, "body": body, "version": base + 1, "updated_by": by, "updated_at": a.now().UnixMilli(),
		})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return errPubConflict
		}
		return nil
	})
}

// publishDoc sends a page's content to its public copy. If it isn't
// published yet, an owner publishes it at slug (with public_edit); after
// that any writer's app may send content, from base.
func (a *API) publishDoc(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, database.CanWrite(role), "you can only view this document") {
		return
	}
	var req struct {
		Slug       string `json:"slug"`
		PublicEdit bool   `json:"public_edit"`
		Title      string `json:"title"`
		Body       string `json:"body"`
		Base       int64  `json:"base"`
	}
	if !bindBody(c, &req) {
		return
	}
	if req.Body == "" || len(req.Body) > maxPubBody || len(req.Title) > maxPubHead {
		abort(c, http.StatusBadRequest, "bad page")
		return
	}
	u, now := me(c), a.now().UnixMilli()
	var cur database.PublishedPage
	err := a.writePublished(a.db.Where("doc_id = ?", d.ID), req.Base, req.Title, req.Body, u.ID, &cur)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		// Not published yet: this is publishing it.
		if role != database.RoleOwner {
			abort(c, http.StatusForbidden, "only owners can publish a page")
			return
		}
		if !validSlug(req.Slug) {
			abort(c, http.StatusBadRequest, "use 3 to 48 lowercase letters, numbers and single dashes")
			return
		}
		cur = database.PublishedPage{
			Slug: req.Slug, DocID: d.ID, PublicEdit: req.PublicEdit, Title: req.Title, Body: req.Body,
			Version: 1, UpdatedBy: u.ID, CreatedAt: now, UpdatedAt: now,
		}
		err = a.db.Transaction(func(tx *gorm.DB) error {
			var n int64
			if err := tx.Model(&database.PublishedPage{}).Where("slug = ? OR doc_id = ?", req.Slug, d.ID).Count(&n).Error; err != nil {
				return err
			}
			if n > 0 {
				return errSlugTaken
			}
			return tx.Create(&cur).Error
		})
		if errors.Is(err, errSlugTaken) {
			abort(c, http.StatusConflict, "that address is taken")
			return
		}
		if err != nil {
			dbError(c, err)
			return
		}
		a.pub.wake(cur.Slug)
		c.JSON(http.StatusOK, gin.H{"slug": cur.Slug, "public_edit": cur.PublicEdit, "version": cur.Version})
		return
	}
	if errors.Is(err, errPubConflict) {
		pubConflict(c, &cur)
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	a.pub.wake(cur.Slug)
	c.JSON(http.StatusOK, gin.H{"slug": cur.Slug, "public_edit": cur.PublicEdit, "version": req.Base + 1})
}

// patchPublished moves a published page to another slug or turns public
// edits on or off. Owners only.
func (a *API) patchPublished(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can change how a page is published") {
		return
	}
	var req struct {
		Slug       *string `json:"slug"`
		PublicEdit *bool   `json:"public_edit"`
	}
	if !bindBody(c, &req) {
		return
	}
	if req.Slug != nil && !validSlug(*req.Slug) {
		abort(c, http.StatusBadRequest, "use 3 to 48 lowercase letters, numbers and single dashes")
		return
	}
	var cur database.PublishedPage
	err := a.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("doc_id = ?", d.ID).Take(&cur).Error; err != nil {
			return err
		}
		patch := map[string]any{}
		if req.Slug != nil && *req.Slug != cur.Slug {
			var n int64
			if err := tx.Model(&database.PublishedPage{}).Where("slug = ?", *req.Slug).Count(&n).Error; err != nil {
				return err
			}
			if n > 0 {
				return errSlugTaken
			}
			patch["slug"] = *req.Slug
		}
		if req.PublicEdit != nil {
			patch["public_edit"] = *req.PublicEdit
		}
		if len(patch) == 0 {
			return nil
		}
		return tx.Model(&database.PublishedPage{}).Where("doc_id = ?", d.ID).Updates(patch).Error
	})
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		abort(c, http.StatusNotFound, "this page isn't published")
		return
	case errors.Is(err, errSlugTaken):
		abort(c, http.StatusConflict, "that address is taken")
		return
	case err != nil:
		dbError(c, err)
		return
	}
	a.pub.wake(cur.Slug)
	slug, publicEdit := cur.Slug, cur.PublicEdit
	if req.Slug != nil {
		slug = *req.Slug
	}
	if req.PublicEdit != nil {
		publicEdit = *req.PublicEdit
	}
	a.pub.wake(slug)
	c.JSON(http.StatusOK, gin.H{"slug": slug, "public_edit": publicEdit, "version": cur.Version})
}

func (a *API) unpublishDoc(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can unpublish a page") {
		return
	}
	info, err := a.publishedInfo([]string{d.ID})
	if err != nil {
		dbError(c, err)
		return
	}
	if err := a.db.Where("doc_id = ?", d.ID).Delete(&database.PublishedPage{}).Error; err != nil {
		dbError(c, err)
		return
	}
	if p := info[d.ID]; p != nil {
		a.pub.wake(p.Slug)
	}
	c.Status(http.StatusNoContent)
}

// getPublished is the public read of /p/<slug>. With since=<version> and
// wait=1 it holds the answer until there's a newer version (or the page is
// unpublished, or its settings change), up to pubWait, so the page stays
// live.
func (a *API) getPublished(c *gin.Context) {
	slug := c.Param("slug")
	if !validSlug(slug) {
		abort(c, http.StatusNotFound, "this page isn't published")
		return
	}
	since, _ := strconv.ParseInt(c.Query("since"), 10, 64)
	edit := c.Query("edit")
	deadline := time.NewTimer(pubWait)
	defer deadline.Stop()
	c.Header("Cache-Control", "no-store")
	for {
		// Subscribe before reading, so a change between the two isn't missed.
		woke := a.pub.wait(slug)
		var p database.PublishedPage
		err := a.db.Where("slug = ?", slug).Take(&p).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			abort(c, http.StatusNotFound, "this page isn't published")
			return
		}
		if err != nil {
			dbError(c, err)
			return
		}
		changed := p.Version != since || (edit != "" && (edit == "1") != p.PublicEdit)
		if c.Query("wait") == "" || changed {
			c.JSON(http.StatusOK, pubView(&p))
			return
		}
		select {
		case <-woke:
		case <-deadline.C:
			c.JSON(http.StatusOK, gin.H{"slug": p.Slug, "public_edit": p.PublicEdit, "version": p.Version, "unchanged": true})
			return
		case <-c.Request.Context().Done():
			return
		}
	}
}

// putPublished is an edit by someone with the link, on a page whose owner
// allows public edits. No account: the slug is the only capability.
func (a *API) putPublished(c *gin.Context) {
	slug := c.Param("slug")
	var req struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		Base  int64  `json:"base"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, maxPubBody+maxPubHead+1024))
	if err := dec.Decode(&req); err != nil || req.Body == "" || len(req.Title) > maxPubHead {
		abort(c, http.StatusBadRequest, "bad page")
		return
	}
	var cur database.PublishedPage
	err := a.writePublished(a.db.Where("slug = ? AND public_edit = 1", slug), req.Base, req.Title, req.Body, "", &cur)
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		abort(c, http.StatusForbidden, "this page can't be edited here")
	case errors.Is(err, errPubConflict):
		pubConflict(c, &cur)
	case err != nil:
		dbError(c, err)
	default:
		a.pub.wake(slug)
		c.JSON(http.StatusOK, gin.H{"slug": slug, "version": req.Base + 1})
	}
}

// getPublishedBlob serves an image of a published page. It's still the
// sealed blob; its key is in the published body.
func (a *API) getPublishedBlob(c *gin.Context) {
	var p database.PublishedPage
	if err := a.db.Select("doc_id").Where("slug = ?", c.Param("slug")).Take(&p).Error; err != nil {
		abort(c, http.StatusNotFound, "no such image")
		return
	}
	var b database.Blob
	if err := a.db.Where("id = ? AND doc_id = ?", c.Param("bid"), p.DocID).Take(&b).Error; err != nil {
		abort(c, http.StatusNotFound, "no such image")
		return
	}
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	c.File(blobPath(a.cfg.BlobDir, b.ID))
}

// publicPage is /p/<slug> in a browser: the web app, which reads the page
// from /v1/pub. A server without the web app can't show it.
func (a *API) publicPage(c *gin.Context) {
	c.Header("Referrer-Policy", "no-referrer")
	if a.cfg.StaticDir == "" {
		c.String(http.StatusNotFound, "This server doesn't serve the web app, so it can't show published pages.")
		return
	}
	c.Header("Cache-Control", "no-cache")
	c.File(filepath.Join(a.cfg.StaticDir, "index.html"))
}
