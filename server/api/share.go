package api

import (
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"main/database"
	"main/otp"
	"main/proto"
)

// shareByEmail is the only way to find someone by email, and it only works
// on a document the caller owns. An exact address matches or it doesn't;
// there's no search. A match returns the person's public keys (never their
// email) so the owner's app can seal the key to them with addMember. No
// match records a pending share and emails the address an invitation.
func (a *API) shareByEmail(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can share a document") {
		return
	}
	u := me(c)
	if !a.limit(c, a.resolvePerHour, u.ID) || !a.limit(c, a.resolvePerDay, u.ID) || !a.limit(c, a.resolvePerDoc, d.ID) {
		return
	}
	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if !bindBody(c, &req) {
		return
	}
	email := otp.NormalizeEmail(req.Email)
	if email == "" || !database.ValidRole(req.Role) {
		abort(c, http.StatusBadRequest, "enter a valid email address")
		return
	}
	if email == u.Email {
		abort(c, http.StatusBadRequest, "that's you")
		return
	}
	var target database.User
	err := a.db.Where("email = ?", email).Take(&target).Error
	if err == nil {
		var n int64
		a.db.Model(&database.DocMember{}).Where("doc_id = ? AND user_id = ?", d.ID, target.ID).Count(&n)
		if n > 0 {
			abort(c, http.StatusConflict, "they already have access")
			return
		}
		c.JSON(http.StatusOK, gin.H{"user": gin.H{
			"id": target.ID, "name": target.Name, "avatar": target.AvatarBlob, "box_pub": target.BoxPub,
		}})
		return
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		dbError(c, err)
		return
	}
	p := database.PendingShare{ID: proto.NewID(), DocID: d.ID, Email: email, Role: req.Role, InvitedBy: u.ID, CreatedAt: a.now().Unix()}
	var existing database.PendingShare
	if err := a.db.Where("doc_id = ? AND email = ?", d.ID, email).Take(&existing).Error; err == nil {
		p.ID = existing.ID
		if err := a.db.Model(&existing).Update("role", req.Role).Error; err != nil {
			dbError(c, err)
			return
		}
	} else if err := a.db.Create(&p).Error; err != nil {
		dbError(c, err)
		return
	}
	// The share is recorded either way; the invitation email is limited per
	// sender and per address so this can't be used to spam anyone.
	now := a.now()
	if a.noticePerSender.allow(u.ID, now) && a.noticePerEmail.allow(email, now) {
		name, origin, invite := u.Name, a.cfg.PublicOrigin, a.cfg.PrereleaseCode != ""
		go func() {
			if err := a.mail.SendShareNotice(email, name, origin, invite); err != nil {
				log.Printf("share notice for %s: %v", otp.Mask(email), err)
			}
		}()
	}
	c.JSON(http.StatusOK, gin.H{"pending": pendingView{ID: p.ID, Email: otp.Mask(email), Role: req.Role}})
}

// addMember adds someone with the document key sealed to them: a match from
// shareByEmail, or a pending share whose address has since signed up.
// The page waits in their "Shared with me" list until they accept it.
func (a *API) addMember(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can share a document") {
		return
	}
	var req struct {
		UserID     string `json:"user_id"`
		Role       string `json:"role"`
		Epoch      int64  `json:"epoch"`
		WrappedKey string `json:"wrapped_key"`
		PendingID  string `json:"pending_id"`
	}
	if !bindBody(c, &req) {
		return
	}
	if req.WrappedKey == "" {
		abort(c, http.StatusBadRequest, "missing key")
		return
	}
	if req.Epoch != d.KeyEpoch {
		abort(c, http.StatusConflict, "the document's key changed; reload it")
		return
	}
	u, now := me(c), a.now()
	err := a.db.Transaction(func(tx *gorm.DB) error {
		var target database.User
		if err := tx.Where("id = ?", req.UserID).Take(&target).Error; err != nil {
			return err
		}
		memberRole := req.Role
		if req.PendingID != "" {
			var p database.PendingShare
			if err := tx.Where("id = ? AND doc_id = ? AND email = ?", req.PendingID, d.ID, target.Email).Take(&p).Error; err != nil {
				return err
			}
			memberRole = p.Role
			if err := tx.Delete(&p).Error; err != nil {
				return err
			}
		}
		if !database.ValidRole(memberRole) {
			return errBadRole
		}
		var n int64
		if err := tx.Model(&database.DocMember{}).Where("doc_id = ? AND user_id = ?", d.ID, target.ID).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return errExists
		}
		if err := tx.Create(&database.DocMember{DocID: d.ID, UserID: target.ID, Role: memberRole, AddedBy: u.ID, AddedAt: now.UnixMilli()}).Error; err != nil {
			return err
		}
		return tx.Save(&database.DocKey{DocID: d.ID, UserID: target.ID, Epoch: d.KeyEpoch, WrappedKey: req.WrappedKey}).Error
	})
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		abort(c, http.StatusNotFound, "no such person or invitation")
	case errors.Is(err, errBadRole):
		abort(c, http.StatusBadRequest, "bad role")
	case errors.Is(err, errExists):
		abort(c, http.StatusConflict, "they already have access")
	case err != nil:
		dbError(c, err)
	default:
		c.Status(http.StatusNoContent)
	}
}

var errBadRole = errors.New("bad role")

// setRole changes a member's role. A document always keeps at least one
// owner.
func (a *API) setRole(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can change roles") {
		return
	}
	var req struct {
		Role string `json:"role"`
	}
	if !bindBody(c, &req) {
		return
	}
	if !database.ValidRole(req.Role) {
		abort(c, http.StatusBadRequest, "bad role")
		return
	}
	uid := c.Param("uid")
	err := a.db.Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&database.DocMember{}).Where("doc_id = ? AND user_id = ?", d.ID, uid).Update("role", req.Role)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		var owners int64
		if err := tx.Model(&database.DocMember{}).Where("doc_id = ? AND role = ?", d.ID, database.RoleOwner).Count(&owners).Error; err != nil {
			return err
		}
		if owners == 0 {
			return errLastOwner
		}
		return nil
	})
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		abort(c, http.StatusNotFound, "not a member")
	case errors.Is(err, errLastOwner):
		abort(c, http.StatusConflict, "a document needs at least one owner")
	case err != nil:
		dbError(c, err)
	default:
		c.Status(http.StatusNoContent)
	}
}

// putMemberKey seals the current key for a member who lacks it (they reset
// their account, or the key changed while a share was being finished). That
// isn't sharing (they already have access), so editors may do it too, which
// keeps a document whose only owner reset their account recoverable.
func (a *API) putMemberKey(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, database.CanWrite(role), "you can only view this document") {
		return
	}
	var req struct {
		Epoch      int64  `json:"epoch"`
		WrappedKey string `json:"wrapped_key"`
	}
	if !bindBody(c, &req) {
		return
	}
	if req.Epoch != d.KeyEpoch || req.WrappedKey == "" {
		abort(c, http.StatusConflict, "the document's key changed; reload it")
		return
	}
	uid := c.Param("uid")
	var n int64
	a.db.Model(&database.DocMember{}).Where("doc_id = ? AND user_id = ?", d.ID, uid).Count(&n)
	if n == 0 {
		abort(c, http.StatusNotFound, "not a member")
		return
	}
	if err := a.db.Save(&database.DocKey{DocID: d.ID, UserID: uid, Epoch: d.KeyEpoch, WrappedKey: req.WrappedKey}).Error; err != nil {
		dbError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *API) deletePending(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can change sharing") {
		return
	}
	if err := a.db.Where("id = ? AND doc_id = ?", c.Param("pid"), d.ID).Delete(&database.PendingShare{}).Error; err != nil {
		dbError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// TodoUser is exported so gorm fills it when embedded in a scan row.
type TodoUser struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	BoxPub string `json:"box_pub"`
}

type todo struct {
	// Kind is "pending" (an invited email signed up: seal the key and add
	// them), "key" (a member lacks the current key: seal it), or "rekey" (a
	// member left: make a fresh key).
	Kind      string    `json:"kind"`
	DocID     string    `json:"doc_id"`
	Epoch     int64     `json:"epoch"`
	PendingID string    `json:"pending_id,omitempty"`
	Role      string    `json:"role,omitempty"`
	User      *TodoUser `json:"user,omitempty"`
}

// shareTodo lists sharing work only a key holder's app can do, because the
// server can't seal keys. The app does it quietly in the background.
func (a *API) shareTodo(c *gin.Context) {
	u := me(c)
	out := []todo{}
	var pending []struct {
		DocID     string
		PendingID string
		Role      string
		Epoch     int64
		TodoUser
	}
	err := a.db.Raw(`SELECT p.doc_id, p.id AS pending_id, p.role, d.key_epoch AS epoch, u.id, u.name, u.box_pub
		FROM pending_shares p
		JOIN doc_members m ON m.doc_id = p.doc_id AND m.user_id = ? AND m.role = 'owner'
		JOIN doc_keys k ON k.doc_id = p.doc_id AND k.user_id = m.user_id
		JOIN documents d ON d.id = p.doc_id AND d.key_epoch = k.epoch
		JOIN users u ON u.email = p.email`, u.ID).Scan(&pending).Error
	if err != nil {
		dbError(c, err)
		return
	}
	for _, p := range pending {
		user := p.TodoUser
		out = append(out, todo{Kind: "pending", DocID: p.DocID, Epoch: p.Epoch, PendingID: p.PendingID, Role: p.Role, User: &user})
	}
	var keyless []struct {
		DocID string
		Epoch int64
		TodoUser
	}
	err = a.db.Raw(`SELECT d.id AS doc_id, d.key_epoch AS epoch, u.id, u.name, u.box_pub
		FROM doc_members mine
		JOIN documents d ON d.id = mine.doc_id
		JOIN doc_keys mk ON mk.doc_id = d.id AND mk.user_id = mine.user_id AND mk.epoch = d.key_epoch
		JOIN doc_members m ON m.doc_id = d.id AND m.user_id <> mine.user_id
		JOIN users u ON u.id = m.user_id
		LEFT JOIN doc_keys k ON k.doc_id = d.id AND k.user_id = m.user_id AND k.epoch = d.key_epoch
		WHERE mine.user_id = ? AND mine.role IN ('owner', 'edit') AND k.user_id IS NULL`, u.ID).Scan(&keyless).Error
	if err != nil {
		dbError(c, err)
		return
	}
	for _, k := range keyless {
		user := k.TodoUser
		out = append(out, todo{Kind: "key", DocID: k.DocID, Epoch: k.Epoch, User: &user})
	}
	var rekey []struct {
		ID       string
		KeyEpoch int64
	}
	err = a.db.Raw(`SELECT d.id, d.key_epoch FROM documents d
		JOIN doc_members m ON m.doc_id = d.id AND m.user_id = ? AND m.role = 'owner'
		JOIN doc_keys k ON k.doc_id = d.id AND k.user_id = m.user_id AND k.epoch = d.key_epoch
		WHERE d.needs_rekey = 1`, u.ID).Scan(&rekey).Error
	if err != nil {
		dbError(c, err)
		return
	}
	for _, r := range rekey {
		out = append(out, todo{Kind: "rekey", DocID: r.ID, Epoch: r.KeyEpoch})
	}
	c.JSON(http.StatusOK, gin.H{"todo": out})
}

// ---- share links ----

type linkView struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	ExpiresAt *int64 `json:"expires_at"`
	MaxUses   *int64 `json:"max_uses"`
	Uses      int64  `json:"uses"`
	CreatedAt int64  `json:"created_at"`
}

func linkJSON(l *database.ShareLink) linkView {
	return linkView{ID: l.ID, Role: l.Role, ExpiresAt: l.ExpiresAt, MaxUses: l.MaxUses, Uses: l.Uses, CreatedAt: l.CreatedAt}
}

func (a *API) listLinks(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can see share links") {
		return
	}
	var links []database.ShareLink
	if err := a.db.Where("doc_id = ? AND revoked = 0", d.ID).Order("created_at").Find(&links).Error; err != nil {
		dbError(c, err)
		return
	}
	out := []linkView{}
	now := a.now().Unix()
	for i := range links {
		if live(&links[i], now) {
			out = append(out, linkJSON(&links[i]))
		}
	}
	c.JSON(http.StatusOK, gin.H{"links": out})
}

func live(l *database.ShareLink, now int64) bool {
	return !l.Revoked && (l.ExpiresAt == nil || now < *l.ExpiresAt) && (l.MaxUses == nil || l.Uses < *l.MaxUses)
}

// createLink stores a share link. The secret in the link's #fragment never
// reaches the server: link_pub is the key derived from it that signs joins,
// and key_ct is the document key sealed under another key derived from it.
// Links give edit or view, never owner.
func (a *API) createLink(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can share a document") {
		return
	}
	var req struct {
		Role         string `json:"role"`
		LinkPub      string `json:"link_pub"`
		KeyCt        string `json:"key_ct"`
		Epoch        int64  `json:"epoch"`
		ExpiresHours int64  `json:"expires_hours"`
		MaxUses      int64  `json:"max_uses"`
	}
	if !bindBody(c, &req) {
		return
	}
	if (req.Role != database.RoleEdit && req.Role != database.RoleView) || !proto.IsKey(req.LinkPub) || req.KeyCt == "" || len(req.KeyCt) > 1024 {
		abort(c, http.StatusBadRequest, "bad link")
		return
	}
	if req.Epoch != d.KeyEpoch {
		abort(c, http.StatusConflict, "the document's key changed; reload it")
		return
	}
	now := a.now()
	l := database.ShareLink{
		ID: proto.NewID(), DocID: d.ID, Role: req.Role, LinkPub: req.LinkPub, KeyCt: req.KeyCt, Epoch: d.KeyEpoch,
		CreatedBy: me(c).ID, CreatedAt: now.Unix(),
	}
	if req.ExpiresHours > 0 {
		exp := now.Add(time.Duration(req.ExpiresHours) * time.Hour).Unix()
		l.ExpiresAt = &exp
	}
	if req.MaxUses > 0 {
		l.MaxUses = &req.MaxUses
	}
	if err := a.db.Create(&l).Error; err != nil {
		dbError(c, err)
		return
	}
	c.JSON(http.StatusCreated, linkJSON(&l))
}

func (a *API) revokeLink(c *gin.Context) {
	d, role, ok := a.access(c, c.Param("id"))
	if !ok || !need(c, role == database.RoleOwner, "only owners can change sharing") {
		return
	}
	if err := a.db.Model(&database.ShareLink{}).Where("id = ? AND doc_id = ?", c.Param("lid"), d.ID).Update("revoked", true).Error; err != nil {
		dbError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// previewLink is what an app opening a link sees before joining: enough to
// show "Join <title> as a viewer" once it decrypts the title with the
// link's secret. The link ID (128 random bits) is the capability here.
func (a *API) previewLink(c *gin.Context) {
	var l database.ShareLink
	if err := a.db.Where("id = ?", c.Param("id")).Take(&l).Error; err != nil || !live(&l, a.now().Unix()) {
		abort(c, http.StatusNotFound, "this link has expired or was turned off")
		return
	}
	var d database.Document
	if err := a.db.Select("id", "head_ct", "key_epoch").Where("id = ?", l.DocID).Take(&d).Error; err != nil {
		abort(c, http.StatusNotFound, "this link has expired or was turned off")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"doc_id": l.DocID, "role": l.Role, "epoch": l.Epoch, "key_ct": l.KeyCt, "head_ct": d.HeadCt, "expires_at": l.ExpiresAt,
	})
}

// joinLink makes the caller a member through a link. proof is the link
// key's signature over (link, doc, caller), which only someone holding the
// secret can make; wrapped_key is the document key the caller sealed to
// themselves after opening key_ct.
func (a *API) joinLink(c *gin.Context) {
	var req struct {
		Proof      string `json:"proof"`
		WrappedKey string `json:"wrapped_key"`
	}
	if !bindBody(c, &req) {
		return
	}
	u, now := me(c), a.now()
	var l database.ShareLink
	if err := a.db.Where("id = ?", c.Param("id")).Take(&l).Error; err != nil || !live(&l, now.Unix()) {
		abort(c, http.StatusNotFound, "this link has expired or was turned off")
		return
	}
	proof, err := proto.B64.DecodeString(req.Proof)
	if err != nil || req.WrappedKey == "" ||
		!proto.VerifyKey(l.LinkPub, append([]byte("sp-join"), proto.JoinSigningString(l.ID, l.DocID, u.ID)...), proof) {
		abort(c, http.StatusForbidden, "this link doesn't check out")
		return
	}
	err = a.db.Transaction(func(tx *gorm.DB) error {
		var m database.DocMember
		err := tx.Where("doc_id = ? AND user_id = ?", l.DocID, u.ID).Take(&m).Error
		if err == nil {
			// Already in: a link never lowers or raises a role, but it can
			// hand back a key the member was missing. Opening a link to a
			// page waiting in "Shared with me" accepts it.
			if err := tx.Model(&database.DocMember{}).Where("doc_id = ? AND user_id = ?", l.DocID, u.ID).Update("accepted", true).Error; err != nil {
				return err
			}
			return tx.Save(&database.DocKey{DocID: l.DocID, UserID: u.ID, Epoch: l.Epoch, WrappedKey: req.WrappedKey}).Error
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		res := tx.Model(&database.ShareLink{}).Where("id = ? AND revoked = 0 AND (max_uses IS NULL OR uses < max_uses)", l.ID).
			Update("uses", gorm.Expr("uses + 1"))
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		if err := tx.Create(&database.DocMember{DocID: l.DocID, UserID: u.ID, Role: l.Role, AddedBy: l.CreatedBy, AddedAt: now.UnixMilli(), Accepted: true}).Error; err != nil {
			return err
		}
		return tx.Create(&database.DocKey{DocID: l.DocID, UserID: u.ID, Epoch: l.Epoch, WrappedKey: req.WrappedKey}).Error
	})
	if errors.Is(err, gorm.ErrRecordNotFound) {
		abort(c, http.StatusNotFound, "this link has expired or was turned off")
		return
	}
	if err != nil {
		dbError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"doc_id": l.DocID})
}
