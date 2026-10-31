// Package api is superpages' HTTP surface (see docs/protocol.md). The
// server sees email addresses, names, profile pictures and ciphertext. It
// enforces who may read, write and share each document; it can't read one.
package api

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"main/config"
	"main/mail"
	"main/otp"
	"main/static"
)

type API struct {
	db     *gorm.DB
	cfg    config.Config
	mail   mail.Mailer
	otp    *otp.Store
	nonces *nonces
	now    func() time.Time

	// Email routes. Every one is limited per IP and per address.
	codeSendPerIP    *limiter
	codeSendPerEmail *limiter
	codeSendAll      *limiter
	codeSendPerIPDay *limiter
	inviteFailPerIP  *limiter
	inviteFailAll    *limiter
	codeVerifyPerIP  *limiter
	accountPerIP     *limiter
	resolvePerHour   *limiter
	resolvePerDay    *limiter
	resolvePerDoc    *limiter
	noticePerSender  *limiter
	noticePerEmail   *limiter

	writesPerUser *limiter
	readsPerUser  *limiter
	blobsPerUser  *limiter
	linksPerIP    *limiter
}

func New(db *gorm.DB, cfg config.Config, m mail.Mailer) *API {
	return &API{
		db: db, cfg: cfg, mail: m, otp: otp.NewStore(), nonces: newNonces(), now: time.Now,

		codeSendPerIP:    newLimiter(5, 10*time.Minute),
		codeSendPerEmail: newLimiter(3, 10*time.Minute),
		codeSendAll:      newLimiter(200, time.Minute),
		// Asking for a code says whether an address has an account (a new
		// one needs the pre-release code), so cap that per day too.
		codeSendPerIPDay: newLimiter(30, 24*time.Hour),
		// Wrong pre-release codes. The code is memorable text, so guessing
		// is capped per address and across everyone.
		inviteFailPerIP: newLimiter(5, time.Hour),
		inviteFailAll:   newLimiter(100, time.Hour),
		codeVerifyPerIP: newLimiter(20, 10*time.Minute),
		accountPerIP:    newLimiter(10, time.Hour),
		resolvePerHour:  newLimiter(30, time.Hour),
		resolvePerDay:   newLimiter(200, 24*time.Hour),
		resolvePerDoc:   newLimiter(50, 24*time.Hour),
		noticePerSender: newLimiter(20, 24*time.Hour),
		noticePerEmail:  newLimiter(5, 24*time.Hour),

		writesPerUser: newLimiter(600, time.Hour),
		readsPerUser:  newLimiter(1200, time.Minute),
		blobsPerUser:  newLimiter(120, time.Hour),
		linksPerIP:    newLimiter(60, time.Hour),
	}
}

// SetClock replaces the API's clock (tests).
func (a *API) SetClock(now func() time.Time) { a.now = now }

func (a *API) Router() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// clientIP reads forwarding headers itself, only from the local tunnel.
	_ = r.SetTrustedProxies(nil)
	// gin.Logger is left out on purpose: request lines would record who
	// opened which document and when.
	r.Use(gin.Recovery())

	// Any origin: a self-hosted web client may live elsewhere, and every
	// request is authenticated by signature, not cookies.
	corsConfig := cors.DefaultConfig()
	corsConfig.AllowAllOrigins = true
	corsConfig.AllowHeaders = []string{"Content-Type", "X-SP-Key", "X-SP-Ts", "X-SP-Nonce", "X-SP-Sig"}
	corsConfig.AllowMethods = []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
	corsConfig.ExposeHeaders = []string{"Retry-After"}
	r.Use(cors.New(corsConfig))

	r.GET("/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true, "app": "superpages"}) })
	r.GET("/.well-known/assetlinks.json", a.assetLinks)
	r.GET("/s/:id", a.landing)

	byUser := func(c *gin.Context) string { return me(c).ID }
	byIP := func(c *gin.Context) string { return a.clientIP(c) }

	v1 := r.Group("/v1")
	v1.GET("/config", a.serverConfig)
	v1.POST("/auth/email/start", a.emailStart)
	v1.POST("/auth/email/verify", a.emailVerify)
	v1.GET("/users/:id/avatar", a.getAvatar)
	v1.GET("/links/:id", a.rateLimit(a.linksPerIP, byIP), a.previewLink)

	// Signed by a key that has no account yet: the account it's creating.
	newKey := v1.Group("", a.requireSignature(maxJSONBody))
	newKey.POST("/accounts", a.createAccount)
	newKey.POST("/accounts/reset", a.resetAccount)

	signed := v1.Group("", a.requireSignature(maxJSONBody), a.requireUser)
	reads := a.rateLimit(a.readsPerUser, byUser)
	writes := a.rateLimit(a.writesPerUser, byUser)
	signed.GET("/me", reads, a.getMe)
	signed.PATCH("/me", writes, a.patchMe)
	signed.PUT("/me/bundle", writes, a.putBundle)
	signed.DELETE("/me/avatar", writes, a.deleteAvatar)
	signed.DELETE("/me", writes, a.deleteMe)

	signed.GET("/docs", reads, a.listDocs)
	signed.GET("/docs/:id", reads, a.getDoc)
	signed.DELETE("/docs/:id", writes, a.deleteDoc)
	signed.POST("/docs/:id/leave", writes, a.leaveDoc)
	signed.POST("/docs/:id/share", a.shareByEmail)
	signed.POST("/docs/:id/members", writes, a.addMember)
	signed.PATCH("/docs/:id/members/:uid", writes, a.setRole)
	signed.PUT("/docs/:id/keys/:uid", writes, a.putMemberKey)
	signed.DELETE("/docs/:id/pending/:pid", writes, a.deletePending)
	signed.GET("/docs/:id/links", reads, a.listLinks)
	signed.POST("/docs/:id/links", writes, a.createLink)
	signed.DELETE("/docs/:id/links/:lid", writes, a.revokeLink)
	signed.GET("/docs/:id/blobs/:bid", reads, a.getBlob)
	signed.GET("/shares/todo", reads, a.shareTodo)
	signed.POST("/links/:id/join", a.rateLimit(a.linksPerIP, byIP), writes, a.joinLink)

	docs := v1.Group("", a.requireSignature(maxDocBody), a.requireUser)
	docs.POST("/docs", a.rateLimit(a.writesPerUser, byUser), a.createDoc)
	docs.PUT("/docs/:id", a.rateLimit(a.writesPerUser, byUser), a.saveDoc)
	docs.POST("/docs/:id/rekey", a.rateLimit(a.writesPerUser, byUser), a.rekeyDoc)

	blobs := v1.Group("", a.requireSignature(a.cfg.MaxBlobBytes), a.requireUser)
	blobs.PUT("/me/avatar", a.rateLimit(a.blobsPerUser, byUser), a.putAvatar)
	blobs.PUT("/docs/:id/blobs", a.rateLimit(a.blobsPerUser, byUser), a.putBlob)

	if a.cfg.StaticDir != "" {
		web := static.Handler(a.cfg.StaticDir)
		r.NoRoute(func(c *gin.Context) {
			if strings.HasPrefix(c.Request.URL.Path, "/v1/") {
				abort(c, http.StatusNotFound, "not found")
				return
			}
			web.ServeHTTP(c.Writer, c.Request)
		})
	}
	return r
}

// serverConfig tells the app what this server asks of new accounts.
func (a *API) serverConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"app":            "superpages",
		"prerelease":     a.cfg.PrereleaseCode != "",
		"email_ready":    a.mail.Ready(),
		"max_blob_bytes": a.cfg.MaxBlobBytes,
		"public_origin":  a.cfg.PublicOrigin,
	})
}

func bindBody(c *gin.Context, v any) bool {
	body, _ := c.Get("body")
	if err := json.Unmarshal(body.([]byte), v); err != nil {
		abort(c, http.StatusBadRequest, "bad json")
		return false
	}
	return true
}

// bindJSON is bindBody for unsigned routes.
func bindJSON(c *gin.Context, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10))
	if err := dec.Decode(v); err != nil {
		abort(c, http.StatusBadRequest, "bad json")
		return false
	}
	return true
}

func dbError(c *gin.Context, err error) {
	log.Printf("db error on %s: %v", c.FullPath(), err)
	abort(c, http.StatusInternalServerError, "server error")
}

// removeBlobFiles deletes blob files after their rows are gone. A missing
// file is fine; the sweeper also catches anything left behind.
func (a *API) removeBlobFiles(ids []string) {
	for _, id := range ids {
		_ = os.Remove(blobPath(a.cfg.BlobDir, id))
	}
}

func blobPath(dir, id string) string { return filepath.Join(dir, id) }

// writeFile stores a blob's bytes. IDs are random b64url, so they're safe
// as file names.
func writeFile(dir, id string, data []byte) error {
	return os.WriteFile(blobPath(dir, id), data, 0o640)
}
