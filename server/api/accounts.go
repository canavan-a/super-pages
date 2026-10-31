package api

import (
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"main/database"
	"main/otp"
	"main/proto"
	"main/regcode"
)

const (
	maxNameLen    = 64
	maxBundleLen  = 4 << 10
	maxAvatarSize = 512 << 10
)

// ---- email codes ----

// emailStart sends a sign-in code. The answer is the same whether or not the
// address has an account, and the email goes out in the background, so this
// can't be used to find out who's signed up.
func (a *API) emailStart(c *gin.Context) {
	var req struct {
		Email string `json:"email"`
	}
	if !bindJSON(c, &req) {
		return
	}
	email := otp.NormalizeEmail(req.Email)
	if email == "" {
		abort(c, http.StatusBadRequest, "enter a valid email address")
		return
	}
	if !a.mail.Ready() {
		abort(c, http.StatusServiceUnavailable, "email sign-in isn't set up on this server yet")
		return
	}
	if !a.limit(c, a.codeSendPerIP, a.clientIP(c)) || !a.limit(c, a.codeSendPerEmail, email) || !a.limit(c, a.codeSendAll, "all") {
		return
	}
	code, err := a.otp.NewCode(email, a.now())
	if err != nil {
		abort(c, http.StatusInternalServerError, "couldn't make a code")
		return
	}
	go func() {
		if err := a.mail.SendCode(email, code); err != nil {
			log.Printf("sign-in code for %s: %v", otp.Mask(email), err)
		}
	}()
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// emailVerify trades a code for a ticket. For an existing account it also
// returns the account's locked key bundle: only the user's passphrase (or
// recovery phrase) opens it, on their device.
func (a *API) emailVerify(c *gin.Context) {
	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if !bindJSON(c, &req) {
		return
	}
	if !a.limit(c, a.codeVerifyPerIP, a.clientIP(c)) {
		return
	}
	email := otp.NormalizeEmail(req.Email)
	code := strings.Join(strings.Fields(req.Code), "")
	if email == "" || !a.otp.Check(email, code, a.now()) {
		abort(c, http.StatusUnauthorized, "that code is wrong or has expired")
		return
	}
	resp := gin.H{"ticket": a.otp.NewTicket(email, a.now())}
	var u database.User
	err := a.db.Where("email = ?", email).Take(&u).Error
	switch {
	case err == nil:
		resp["account"] = gin.H{"bundle": u.KeyBundle, "sign_pub": u.SignPub, "key_gen": u.KeyGen}
	case errors.Is(err, gorm.ErrRecordNotFound):
		resp["account"] = nil
		resp["needs_code"] = a.needsRegCode(email)
	default:
		dbError(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

// needsRegCode reports whether email has to give a registration code to sign
// up: always when codes are required, unless someone shared a page with it.
func (a *API) needsRegCode(email string) bool {
	if !a.cfg.RequireRegCode {
		return false
	}
	if !a.cfg.ShareInvitesBypassCode {
		return true
	}
	var n int64
	a.db.Model(&database.PendingShare{}).Where("email = ?", email).Count(&n)
	return n == 0
}

// ---- accounts ----

type newKeys struct {
	Ticket  string `json:"ticket"`
	RegCode string `json:"reg_code"`
	BoxPub  string `json:"box_pub"`
	Bundle  string `json:"bundle"`
	Name    string `json:"name"`
}

// keysFromRequest checks the parts of a create or reset that don't touch
// the database. The request is signed by the new signing key, which proves
// the caller holds it.
func (a *API) keysFromRequest(c *gin.Context, req *newKeys) (email string, ok bool) {
	if !a.limit(c, a.accountPerIP, a.clientIP(c)) {
		return "", false
	}
	email = a.otp.TicketEmail(req.Ticket, a.now())
	if email == "" {
		abort(c, http.StatusUnauthorized, "this sign-in has expired; ask for a new code")
		return "", false
	}
	if !proto.IsKey(req.BoxPub) || req.Bundle == "" || len(req.Bundle) > maxBundleLen {
		abort(c, http.StatusBadRequest, "bad keys")
		return "", false
	}
	if _, err := proto.ParseKeyID(c.GetString("key")); err != nil {
		abort(c, http.StatusBadRequest, "bad keys")
		return "", false
	}
	return email, true
}

func cleanName(s string) (string, bool) {
	s = strings.TrimSpace(s)
	return s, utf8.RuneCountInString(s) <= maxNameLen && !strings.ContainsAny(s, "\n\r")
}

func (a *API) createAccount(c *gin.Context) {
	var req newKeys
	if !bindBody(c, &req) {
		return
	}
	email, ok := a.keysFromRequest(c, &req)
	if !ok {
		return
	}
	name, ok := cleanName(req.Name)
	if !ok {
		abort(c, http.StatusBadRequest, "names are at most 64 characters")
		return
	}
	// Decided before the transaction: there is one database connection.
	needsCode := a.needsRegCode(email)
	now := a.now()
	u := database.User{
		ID: proto.NewID(), SignPub: c.GetString("key"), BoxPub: req.BoxPub, Email: email,
		Name: name, KeyBundle: req.Bundle, KeyGen: 1, CreatedAt: now.Unix(),
	}
	err := a.db.Transaction(func(tx *gorm.DB) error {
		var n int64
		if err := tx.Model(&database.User{}).Where("email = ? OR sign_pub = ?", email, u.SignPub).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return errExists
		}
		if err := tx.Create(&u).Error; err != nil {
			return err
		}
		if needsCode {
			return regcode.Redeem(tx, req.RegCode, u.ID, now)
		}
		return nil
	})
	switch {
	case errors.Is(err, errExists):
		abort(c, http.StatusConflict, "there's already an account for this email")
		return
	case errors.Is(err, regcode.ErrInvalid):
		a.otp.FailTicket(req.Ticket)
		abort(c, http.StatusForbidden, regcode.ErrInvalid.Error())
		return
	case err != nil:
		dbError(c, err)
		return
	}
	a.otp.UseTicket(req.Ticket)
	c.JSON(http.StatusCreated, meJSON(&u))
}

var errExists = errors.New("exists")

// resetAccount gives an account new keys when its owner has lost both the
// passphrase and the recovery phrase. Everything sealed to the old keys is
// unreadable to them now: their doc keys go, documents nobody else can open
// go, and owners of shared documents are asked (GET /shares/todo) to seal
// the key again for the new keys.
func (a *API) resetAccount(c *gin.Context) {
	var req newKeys
	if !bindBody(c, &req) {
		return
	}
	email, ok := a.keysFromRequest(c, &req)
	if !ok {
		return
	}
	var u database.User
	var gone []string
	err := a.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("email = ?", email).Take(&u).Error; err != nil {
			return err
		}
		var n int64
		if err := tx.Model(&database.User{}).Where("sign_pub = ? AND id <> ?", c.GetString("key"), u.ID).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return errExists
		}
		if err := tx.Where("user_id = ?", u.ID).Delete(&database.DocKey{}).Error; err != nil {
			return err
		}
		var err error
		if gone, err = deleteOrphanDocs(tx, u.ID); err != nil {
			return err
		}
		u.SignPub, u.BoxPub, u.KeyBundle, u.KeyGen = c.GetString("key"), req.BoxPub, req.Bundle, u.KeyGen+1
		return tx.Model(&u).Updates(map[string]any{
			"sign_pub": u.SignPub, "box_pub": u.BoxPub, "key_bundle": u.KeyBundle, "key_gen": u.KeyGen,
		}).Error
	})
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		abort(c, http.StatusNotFound, "no account for this email")
		return
	case errors.Is(err, errExists):
		abort(c, http.StatusConflict, "key already in use")
		return
	case err != nil:
		dbError(c, err)
		return
	}
	a.otp.UseTicket(req.Ticket)
	a.removeBlobFiles(gone)
	c.JSON(http.StatusOK, meJSON(&u))
}

// deleteOrphanDocs deletes the documents user is the only member of and
// returns their blob IDs so the files can go too.
func deleteOrphanDocs(tx *gorm.DB, user string) ([]string, error) {
	var ids []string
	err := tx.Raw(`SELECT doc_id FROM doc_members WHERE user_id = ?
		AND doc_id NOT IN (SELECT doc_id FROM doc_members WHERE user_id <> ?)`, user, user).Scan(&ids).Error
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	var blobs []string
	if err := tx.Model(&database.Blob{}).Where("doc_id IN ?", ids).Pluck("id", &blobs).Error; err != nil {
		return nil, err
	}
	return blobs, tx.Where("id IN ?", ids).Delete(&database.Document{}).Error
}

func meJSON(u *database.User) gin.H {
	return gin.H{
		"id": u.ID, "email": u.Email, "name": u.Name, "avatar": u.AvatarBlob,
		"sign_pub": u.SignPub, "box_pub": u.BoxPub, "key_gen": u.KeyGen,
	}
}

// getMe is the only response anywhere that carries an email address, and
// only the caller's own.
func (a *API) getMe(c *gin.Context) { c.JSON(http.StatusOK, meJSON(me(c))) }

func (a *API) patchMe(c *gin.Context) {
	var req struct {
		Name *string `json:"name"`
	}
	if !bindBody(c, &req) {
		return
	}
	u := me(c)
	if req.Name != nil {
		name, ok := cleanName(*req.Name)
		if !ok {
			abort(c, http.StatusBadRequest, "names are at most 64 characters")
			return
		}
		if err := a.db.Model(u).Update("name", name).Error; err != nil {
			dbError(c, err)
			return
		}
		u.Name = name
	}
	c.JSON(http.StatusOK, meJSON(u))
}

// putBundle replaces the locked key bundle after a passphrase change. The
// keys inside are the same; only the lock changes.
func (a *API) putBundle(c *gin.Context) {
	var req struct {
		Bundle string `json:"bundle"`
	}
	if !bindBody(c, &req) {
		return
	}
	if req.Bundle == "" || len(req.Bundle) > maxBundleLen {
		abort(c, http.StatusBadRequest, "bad bundle")
		return
	}
	if err := a.db.Model(me(c)).Update("key_bundle", req.Bundle).Error; err != nil {
		dbError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// deleteMe deletes the account. Documents only they could open go with it;
// shared documents they were the last owner of pass to their longest-standing
// remaining member.
func (a *API) deleteMe(c *gin.Context) {
	u := me(c)
	var gone []string
	err := a.db.Transaction(func(tx *gorm.DB) error {
		var err error
		if gone, err = deleteOrphanDocs(tx, u.ID); err != nil {
			return err
		}
		var joined []string
		if err := tx.Model(&database.DocMember{}).Where("user_id = ?", u.ID).Pluck("doc_id", &joined).Error; err != nil {
			return err
		}
		for _, doc := range joined {
			if err := tx.Where("doc_id = ? AND user_id = ?", doc, u.ID).Delete(&database.DocMember{}).Error; err != nil {
				return err
			}
			if err := ensureOwner(tx, doc); err != nil {
				return err
			}
		}
		var avatars []string
		if err := tx.Model(&database.Blob{}).Where("doc_id IS NULL AND uploader = ?", u.ID).Pluck("id", &avatars).Error; err != nil {
			return err
		}
		gone = append(gone, avatars...)
		if err := tx.Where("doc_id IS NULL AND uploader = ?", u.ID).Delete(&database.Blob{}).Error; err != nil {
			return err
		}
		return tx.Delete(u).Error
	})
	if err != nil {
		dbError(c, err)
		return
	}
	a.removeBlobFiles(gone)
	c.Status(http.StatusNoContent)
}

// ensureOwner promotes the longest-standing member of doc if it has no owner
// left, and marks it for a rekey since someone left.
func ensureOwner(tx *gorm.DB, doc string) error {
	var n int64
	if err := tx.Model(&database.DocMember{}).Where("doc_id = ? AND role = ?", doc, database.RoleOwner).Count(&n).Error; err != nil {
		return err
	}
	if n == 0 {
		var next database.DocMember
		err := tx.Where("doc_id = ?", doc).Order("added_at, user_id").Take(&next).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return tx.Where("id = ?", doc).Delete(&database.Document{}).Error
		}
		if err != nil {
			return err
		}
		if err := tx.Model(&next).Update("role", database.RoleOwner).Error; err != nil {
			return err
		}
	}
	return tx.Model(&database.Document{}).Where("id = ?", doc).Update("needs_rekey", true).Error
}

// ---- profile pictures ----

// putAvatar stores the caller's profile picture. Pictures are not
// encrypted: everyone a document is shared with sees them, and the user was
// told so.
func (a *API) putAvatar(c *gin.Context) {
	body, _ := c.Get("body")
	data := body.([]byte)
	if len(data) == 0 || len(data) > maxAvatarSize {
		abort(c, http.StatusRequestEntityTooLarge, "pictures are at most 512 KB")
		return
	}
	switch http.DetectContentType(data) {
	case "image/jpeg", "image/png", "image/webp":
	default:
		abort(c, http.StatusUnsupportedMediaType, "use a JPEG, PNG or WebP picture")
		return
	}
	u := me(c)
	id := proto.NewID()
	if err := writeFile(a.cfg.BlobDir, id, data); err != nil {
		abort(c, http.StatusInternalServerError, "couldn't store the picture")
		return
	}
	var old []string
	err := a.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&database.Blob{}).Where("doc_id IS NULL AND uploader = ?", u.ID).Pluck("id", &old).Error; err != nil {
			return err
		}
		if err := tx.Where("doc_id IS NULL AND uploader = ?", u.ID).Delete(&database.Blob{}).Error; err != nil {
			return err
		}
		if err := tx.Create(&database.Blob{ID: id, Uploader: u.ID, Size: int64(len(data)), CreatedAt: a.now().Unix()}).Error; err != nil {
			return err
		}
		return tx.Model(u).Update("avatar_blob", id).Error
	})
	if err != nil {
		a.removeBlobFiles([]string{id})
		dbError(c, err)
		return
	}
	a.removeBlobFiles(old)
	u.AvatarBlob = &id
	c.JSON(http.StatusOK, meJSON(u))
}

func (a *API) deleteAvatar(c *gin.Context) {
	u := me(c)
	var old []string
	err := a.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&database.Blob{}).Where("doc_id IS NULL AND uploader = ?", u.ID).Pluck("id", &old).Error; err != nil {
			return err
		}
		if err := tx.Where("doc_id IS NULL AND uploader = ?", u.ID).Delete(&database.Blob{}).Error; err != nil {
			return err
		}
		return tx.Model(u).Update("avatar_blob", nil).Error
	})
	if err != nil {
		dbError(c, err)
		return
	}
	a.removeBlobFiles(old)
	u.AvatarBlob = nil
	c.JSON(http.StatusOK, meJSON(u))
}

// getAvatar serves a profile picture. User IDs are random and only handed
// to people who share a document, so this needs no signature (an <img> tag
// can load it). The app asks for ?v=<blob id>, so it can be cached for good.
func (a *API) getAvatar(c *gin.Context) {
	var u database.User
	if err := a.db.Select("avatar_blob").Where("id = ?", c.Param("id")).Take(&u).Error; err != nil || u.AvatarBlob == nil {
		c.Status(http.StatusNotFound)
		return
	}
	f, err := os.Open(blobPath(a.cfg.BlobDir, *u.AvatarBlob))
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	_, _ = f.Seek(0, io.SeekStart)
	c.Header("Content-Type", http.DetectContentType(head[:n]))
	c.Header("X-Content-Type-Options", "nosniff")
	if c.Query("v") == *u.AvatarBlob {
		c.Header("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		c.Header("Cache-Control", "no-cache")
	}
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, f)
}
