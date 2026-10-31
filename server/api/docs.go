package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"main/database"
	"main/otp"
	"main/proto"
)

const maxHeadLen = 4 << 10

// memberView is how a document's members are shown to each other: no email
// addresses, ever.
type memberView struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Avatar  *string `json:"avatar"`
	Role    string  `json:"role"`
	SignPub string  `json:"sign_pub"`
	BoxPub  string  `json:"box_pub"`
	// HasKey is false while the member waits for an owner's app to seal
	// the current key for them (a new share, or after an account reset).
	HasKey bool `json:"has_key"`
}

type docView struct {
	ID         string        `json:"id"`
	Version    int64         `json:"version"`
	Epoch      int64         `json:"epoch"`
	HeadCt     string        `json:"head_ct"`
	BodyCt     string        `json:"body_ct,omitempty"`
	Sig        string        `json:"sig,omitempty"`
	UpdatedBy  string        `json:"updated_by"`
	UpdatedAt  int64         `json:"updated_at"`
	CreatedAt  int64         `json:"created_at"`
	Role       string        `json:"role"`
	Key        *string       `json:"key"`
	NeedsRekey bool          `json:"needs_rekey"`
	Members    []memberView  `json:"members"`
	Pending    []pendingView `json:"pending,omitempty"`
}

type pendingView struct {
	ID string `json:"id"`
	// Email is masked ("a***@example.com"): the owner who typed it knows
	// it, but other owners see only enough to recognise it.
	Email string `json:"email"`
	Role  string `json:"role"`
}

// access loads doc and the caller's role in it, answering 404 (not 403, so
// IDs can't be probed) if the caller isn't a member.
func (a *API) access(c *gin.Context, doc string) (*database.Document, string, bool) {
	var m database.DocMember
	err := a.db.Where("doc_id = ? AND user_id = ?", doc, me(c).ID).Take(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		abort(c, http.StatusNotFound, "no such document")
		return nil, "", false
	}
	if err != nil {
		dbError(c, err)
		return nil, "", false
	}
	var d database.Document
	if err := a.db.Where("id = ?", doc).Take(&d).Error; err != nil {
		dbError(c, err)
		return nil, "", false
	}
	return &d, m.Role, true
}

// need checks the caller's role allows something, answering 403 if not.
func need(c *gin.Context, ok bool, what string) bool {
	if !ok {
		abort(c, http.StatusForbidden, what)
	}
	return ok
}

// members loads the member lists of docs, keyed by document, with whether
// each member holds the document's current key.
func (a *API) members(docs []database.Document) (map[string][]memberView, error) {
	out := map[string][]memberView{}
	if len(docs) == 0 {
		return out, nil
	}
	ids := make([]string, len(docs))
	for i, d := range docs {
		ids[i] = d.ID
	}
	// Flat fields: gorm doesn't fill ones promoted from an unexported
	// embedded struct.
	var rows []struct {
		DocID    string
		ID       string
		Name     string
		Avatar   *string
		Role     string
		SignPub  string
		BoxPub   string
		KeyEpoch *int64
	}
	err := a.db.Raw(`SELECT m.doc_id, u.id, u.name, u.avatar_blob AS avatar, m.role, u.sign_pub, u.box_pub,
			k.epoch AS key_epoch
		FROM doc_members m JOIN users u ON u.id = m.user_id
		LEFT JOIN doc_keys k ON k.doc_id = m.doc_id AND k.user_id = m.user_id
		WHERE m.doc_id IN ? ORDER BY m.added_at, u.id`, ids).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	epoch := map[string]int64{}
	for _, d := range docs {
		epoch[d.ID] = d.KeyEpoch
	}
	for _, r := range rows {
		out[r.DocID] = append(out[r.DocID], memberView{
			ID: r.ID, Name: r.Name, Avatar: r.Avatar, Role: r.Role, SignPub: r.SignPub, BoxPub: r.BoxPub,
			HasKey: r.KeyEpoch != nil && *r.KeyEpoch == epoch[r.DocID],
		})
	}
	return out, nil
}

// keysFor returns the caller's current-epoch wrapped keys for docs.
func (a *API) keysFor(user string, docs []database.Document) (map[string]string, error) {
	var keys []database.DocKey
	if err := a.db.Where("user_id = ?", user).Find(&keys).Error; err != nil {
		return nil, err
	}
	epoch := map[string]int64{}
	for _, d := range docs {
		epoch[d.ID] = d.KeyEpoch
	}
	out := map[string]string{}
	for _, k := range keys {
		if e, ok := epoch[k.DocID]; ok && e == k.Epoch {
			out[k.DocID] = k.WrappedKey
		}
	}
	return out, nil
}

func view(d *database.Document, role string, key string, members []memberView) docView {
	v := docView{
		ID: d.ID, Version: d.Version, Epoch: d.KeyEpoch, HeadCt: d.HeadCt, UpdatedBy: d.UpdatedBy,
		UpdatedAt: d.UpdatedAt, CreatedAt: d.CreatedAt, Role: role, NeedsRekey: d.NeedsRekey, Members: members,
	}
	if key != "" {
		v.Key = &key
	}
	if v.Members == nil {
		v.Members = []memberView{}
	}
	return v
}

// listDocs returns every document the caller is in, newest first, without
// bodies: the grid only needs titles and snippets (head_ct).
func (a *API) listDocs(c *gin.Context) {
	u := me(c)
	var roles []database.DocMember
	if err := a.db.Where("user_id = ?", u.ID).Find(&roles).Error; err != nil {
		dbError(c, err)
		return
	}
	role := map[string]string{}
	ids := make([]string, 0, len(roles))
	for _, m := range roles {
		role[m.DocID] = m.Role
		ids = append(ids, m.DocID)
	}
	var docs []database.Document
	if len(ids) > 0 {
		if err := a.db.Omit("body_ct").Where("id IN ?", ids).Order("updated_at DESC, id").Find(&docs).Error; err != nil {
			dbError(c, err)
			return
		}
	}
	members, err := a.members(docs)
	if err != nil {
		dbError(c, err)
		return
	}
	keys, err := a.keysFor(u.ID, docs)
	if err != nil {
		dbError(c, err)
		return
	}
	out := make([]docView, len(docs))
	for i := range docs {
		out[i] = view(&docs[i], role[docs[i].ID], keys[docs[i].ID], members[docs[i].ID])
	}
	c.JSON(http.StatusOK, gin.H{"docs": out})
}

func (a *API) getDoc(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok {
		return
	}
	members, err := a.members([]database.Document{*d})
	if err != nil {
		dbError(c, err)
		return
	}
	keys, err := a.keysFor(me(c).ID, []database.Document{*d})
	if err != nil {
		dbError(c, err)
		return
	}
	v := view(d, role, keys[d.ID], members[d.ID])
	v.BodyCt, v.Sig = d.BodyCt, d.Sig
	if role == database.RoleOwner {
		var pending []database.PendingShare
		if err := a.db.Where("doc_id = ?", d.ID).Order("created_at").Find(&pending).Error; err != nil {
			dbError(c, err)
			return
		}
		for _, p := range pending {
			v.Pending = append(v.Pending, pendingView{ID: p.ID, Email: otp.Mask(p.Email), Role: p.Role})
		}
	}
	c.JSON(http.StatusOK, v)
}

type saveReq struct {
	ID          string `json:"id"`
	BaseVersion int64  `json:"base_version"`
	Epoch       int64  `json:"epoch"`
	HeadCt      string `json:"head_ct"`
	BodyCt      string `json:"body_ct"`
	Sig         string `json:"sig"`
	// WrappedKey is the creator's sealed copy of the first key (create only).
	WrappedKey string `json:"wrapped_key"`
}

// checkSave validates a save's ciphertext and its signature by the caller
// for the version it would become.
func checkSave(c *gin.Context, doc string, version int64, r *saveReq) bool {
	if r.HeadCt == "" || len(r.HeadCt) > maxHeadLen || r.BodyCt == "" {
		abort(c, http.StatusBadRequest, "bad document")
		return false
	}
	sig, err := proto.B64.DecodeString(r.Sig)
	if err != nil || !proto.Verify(me(c).SignPub, "sp-doc", proto.DocSigningString(doc, version, r.Epoch, r.HeadCt, r.BodyCt), sig) {
		abort(c, http.StatusBadRequest, "bad document signature")
		return false
	}
	return true
}

func (a *API) createDoc(c *gin.Context) {
	var req saveReq
	if !bindBody(c, &req) {
		return
	}
	if !proto.IsID(req.ID) || req.Epoch != 1 || req.WrappedKey == "" {
		abort(c, http.StatusBadRequest, "bad document")
		return
	}
	if !checkSave(c, req.ID, 1, &req) {
		return
	}
	u, now := me(c), a.now().UnixMilli()
	d := database.Document{
		ID: req.ID, CreatedBy: u.ID, Version: 1, KeyEpoch: 1, HeadCt: req.HeadCt, BodyCt: req.BodyCt,
		Sig: req.Sig, UpdatedBy: u.ID, UpdatedAt: now, CreatedAt: now,
	}
	err := a.db.Transaction(func(tx *gorm.DB) error {
		var n int64
		if err := tx.Model(&database.Document{}).Where("id = ?", d.ID).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return errExists
		}
		if err := tx.Create(&d).Error; err != nil {
			return err
		}
		if err := tx.Create(&database.DocMember{DocID: d.ID, UserID: u.ID, Role: database.RoleOwner, AddedBy: u.ID, AddedAt: now}).Error; err != nil {
			return err
		}
		return tx.Create(&database.DocKey{DocID: d.ID, UserID: u.ID, Epoch: 1, WrappedKey: req.WrappedKey}).Error
	})
	if errors.Is(err, errExists) {
		abort(c, http.StatusConflict, "document id taken")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": d.ID, "version": d.Version, "updated_at": d.UpdatedAt})
}

// saveDoc replaces a document's content. base_version must be the version
// the writer started from, so two people saving at once can't silently
// overwrite each other: the second gets 409 and the current version.
func (a *API) saveDoc(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, database.CanWrite(role), "you can only view this document") {
		return
	}
	var req saveReq
	if !bindBody(c, &req) {
		return
	}
	if req.Epoch != d.KeyEpoch {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "the document's key changed; reload it", "version": d.Version, "epoch": d.KeyEpoch})
		return
	}
	if !checkSave(c, d.ID, req.BaseVersion+1, &req) {
		return
	}
	now := a.now().UnixMilli()
	res := a.db.Model(&database.Document{}).Where("id = ? AND version = ? AND key_epoch = ?", d.ID, req.BaseVersion, req.Epoch).
		Updates(map[string]any{
			"version": req.BaseVersion + 1, "head_ct": req.HeadCt, "body_ct": req.BodyCt, "sig": req.Sig,
			"updated_by": me(c).ID, "updated_at": now,
		})
	if res.Error != nil {
		dbError(c, res.Error)
		return
	}
	if res.RowsAffected != 1 {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "edited elsewhere", "version": d.Version, "epoch": d.KeyEpoch})
		return
	}
	c.JSON(http.StatusOK, gin.H{"version": req.BaseVersion + 1, "updated_at": now})
}

func (a *API) deleteDoc(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can delete a document") {
		return
	}
	var blobs []string
	err := a.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&database.Blob{}).Where("doc_id = ?", d.ID).Pluck("id", &blobs).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", d.ID).Delete(&database.Document{}).Error
	})
	if err != nil {
		dbError(c, err)
		return
	}
	a.removeBlobFiles(blobs)
	a.live.drop(d.ID, "")
	c.Status(http.StatusNoContent)
}

// leaveDoc removes the caller from a document. The last owner can't leave
// while others remain (promote someone or delete it instead). Whoever leaves
// still knows the current key, so the document is marked for an owner's app
// to make a fresh one.
func (a *API) leaveDoc(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok {
		return
	}
	u := me(c)
	var blobs []string
	err := a.db.Transaction(func(tx *gorm.DB) error {
		var others, owners int64
		if err := tx.Model(&database.DocMember{}).Where("doc_id = ? AND user_id <> ?", d.ID, u.ID).Count(&others).Error; err != nil {
			return err
		}
		if others == 0 {
			if err := tx.Model(&database.Blob{}).Where("doc_id = ?", d.ID).Pluck("id", &blobs).Error; err != nil {
				return err
			}
			return tx.Where("id = ?", d.ID).Delete(&database.Document{}).Error
		}
		if role == database.RoleOwner {
			if err := tx.Model(&database.DocMember{}).Where("doc_id = ? AND role = ? AND user_id <> ?", d.ID, database.RoleOwner, u.ID).Count(&owners).Error; err != nil {
				return err
			}
			if owners == 0 {
				return errLastOwner
			}
		}
		if err := tx.Where("doc_id = ? AND user_id = ?", d.ID, u.ID).Delete(&database.DocMember{}).Error; err != nil {
			return err
		}
		if err := tx.Where("doc_id = ? AND user_id = ?", d.ID, u.ID).Delete(&database.DocKey{}).Error; err != nil {
			return err
		}
		return tx.Model(d).Update("needs_rekey", true).Error
	})
	if errors.Is(err, errLastOwner) {
		abort(c, http.StatusConflict, "you're the last owner; make someone else an owner first, or delete the document")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	a.removeBlobFiles(blobs)
	a.live.drop(d.ID, u.ID)
	c.Status(http.StatusNoContent)
}

var errLastOwner = errors.New("last owner")

// rekeyDoc moves a document to a fresh key: the owner's app re-encrypts the
// content under it and seals it to every member who stays. This is also how
// members are removed (remove lists them), so a removed member never sees
// a key made after they left. Every share link dies with the old key.
func (a *API) rekeyDoc(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can remove people") {
		return
	}
	var req struct {
		saveReq
		Keys   map[string]string `json:"keys"`
		Remove []string          `json:"remove"`
	}
	if !bindBody(c, &req) {
		return
	}
	if req.Epoch != d.KeyEpoch+1 {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "the document's key changed; reload it", "version": d.Version, "epoch": d.KeyEpoch})
		return
	}
	if !checkSave(c, d.ID, req.BaseVersion+1, &req.saveReq) {
		return
	}
	u, now := me(c), a.now().UnixMilli()
	remove := map[string]bool{}
	for _, id := range req.Remove {
		if id == u.ID {
			abort(c, http.StatusBadRequest, "use leave to remove yourself")
			return
		}
		remove[id] = true
	}
	err := a.db.Transaction(func(tx *gorm.DB) error {
		var ms []database.DocMember
		if err := tx.Where("doc_id = ?", d.ID).Find(&ms).Error; err != nil {
			return err
		}
		stay := 0
		for _, m := range ms {
			if remove[m.UserID] {
				continue
			}
			if req.Keys[m.UserID] == "" {
				return errKeysMismatch
			}
			stay++
		}
		if stay != len(req.Keys) {
			return errKeysMismatch
		}
		res := tx.Model(&database.Document{}).Where("id = ? AND version = ? AND key_epoch = ?", d.ID, req.BaseVersion, d.KeyEpoch).
			Updates(map[string]any{
				"version": req.BaseVersion + 1, "key_epoch": req.Epoch, "head_ct": req.HeadCt, "body_ct": req.BodyCt,
				"sig": req.Sig, "updated_by": u.ID, "updated_at": now, "needs_rekey": false,
			})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return errStale
		}
		if len(req.Remove) > 0 {
			if err := tx.Where("doc_id = ? AND user_id IN ?", d.ID, req.Remove).Delete(&database.DocMember{}).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("doc_id = ?", d.ID).Delete(&database.DocKey{}).Error; err != nil {
			return err
		}
		for uid, k := range req.Keys {
			if err := tx.Create(&database.DocKey{DocID: d.ID, UserID: uid, Epoch: req.Epoch, WrappedKey: k}).Error; err != nil {
				return err
			}
		}
		return tx.Model(&database.ShareLink{}).Where("doc_id = ?", d.ID).Update("revoked", true).Error
	})
	switch {
	case errors.Is(err, errKeysMismatch):
		abort(c, http.StatusConflict, "the member list changed; reload and try again")
	case errors.Is(err, errStale):
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "edited elsewhere", "version": d.Version, "epoch": d.KeyEpoch})
	case err != nil:
		dbError(c, err)
	default:
		// Changes sealed under the old key are no use to anyone now.
		a.live.drop(d.ID, "")
		c.JSON(http.StatusOK, gin.H{"version": req.BaseVersion + 1, "epoch": req.Epoch, "updated_at": now})
	}
}

var (
	errKeysMismatch = errors.New("keys don't match members")
	errStale        = errors.New("stale")
)

// ---- blobs ----

// putBlob stores an encrypted image for a document. Its key travels inside
// the document body, so the server only ever has ciphertext.
func (a *API) putBlob(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, database.CanWrite(role), "you can only view this document") {
		return
	}
	body, _ := c.Get("body")
	data := body.([]byte)
	if len(data) == 0 {
		abort(c, http.StatusBadRequest, "empty blob")
		return
	}
	id := proto.NewID()
	if err := writeFile(a.cfg.BlobDir, id, data); err != nil {
		abort(c, http.StatusInternalServerError, "couldn't store the image")
		return
	}
	doc := d.ID
	if err := a.db.Create(&database.Blob{ID: id, DocID: &doc, Uploader: me(c).ID, Size: int64(len(data)), CreatedAt: a.now().Unix()}).Error; err != nil {
		a.removeBlobFiles([]string{id})
		dbError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

func (a *API) getBlob(c *gin.Context) {
	d, _, ok := a.access(c, c.Param("id"))
	if !ok {
		return
	}
	var b database.Blob
	if err := a.db.Where("id = ? AND doc_id = ?", c.Param("bid"), d.ID).Take(&b).Error; err != nil {
		abort(c, http.StatusNotFound, "no such image")
		return
	}
	c.Header("Cache-Control", "private, max-age=31536000, immutable")
	c.File(blobPath(a.cfg.BlobDir, b.ID))
}
