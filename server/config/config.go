package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	ListenAddr string
	DataDir    string
	DBPath     string
	BlobDir    string
	// PublicOrigin is the https origin share links and emails point at, e.g.
	// https://pages.superbadger.io.
	PublicOrigin string
	// AndroidCertSHA256 lists the release-key fingerprints served in
	// /.well-known/assetlinks.json so Android opens share links in the app.
	AndroidCertSHA256 []string
	MaxBlobBytes      int64
	// TrustProxy keys rate limits on the rightmost X-Forwarded-For entry of
	// requests arriving over loopback (the Super Matrix relay, cloudflared). See
	// api.clientIP.
	TrustProxy bool
	// StaticDir, when set, serves the built web client on the same listener
	// as the API (anything that isn't an API route).
	StaticDir string

	// SMTP for sign-in codes and share notices (Gmail + app password by
	// default, as in super-matrix).
	SMTPHost        string
	SMTPPort        int
	SMTPEmail       string
	SMTPAppPassword string
	// LogCodes prints sign-in codes to the log when SMTP isn't set up. Dev
	// only: anyone who can read the log can sign in as anyone.
	LogCodes bool

	// PrereleaseCode, when set, is the one invite code an address without
	// an account must give before a sign-in code is emailed to it. Existing
	// accounts sign in without it. Matching ignores case, spaces and dashes.
	PrereleaseCode string
}

func Load() Config {
	dataDir := getEnv("SUPERPAGES_DATA_DIR", ".data")
	maxMB, _ := strconv.Atoi(getEnv("SUPERPAGES_MAX_BLOB_MB", "25"))
	smtpPort, _ := strconv.Atoi(getEnv("SUPERPAGES_SMTP_PORT", "587"))
	return Config{
		ListenAddr:        getEnv("SUPERPAGES_LISTEN_ADDR", ":8080"),
		DataDir:           dataDir,
		DBPath:            getEnv("SUPERPAGES_DB_PATH", filepath.Join(dataDir, "superpages.db")),
		BlobDir:           filepath.Join(dataDir, "blobs"),
		PublicOrigin:      strings.TrimRight(os.Getenv("SUPERPAGES_PUBLIC_ORIGIN"), "/"),
		AndroidCertSHA256: splitList(os.Getenv("SUPERPAGES_ANDROID_CERT_SHA256")),
		MaxBlobBytes:      int64(maxMB) << 20,
		TrustProxy:        os.Getenv("SUPERPAGES_TRUST_PROXY") == "1",
		StaticDir:         os.Getenv("SUPERPAGES_STATIC_DIR"),
		SMTPHost:          getEnv("SUPERPAGES_SMTP_HOST", "smtp.gmail.com"),
		SMTPPort:          smtpPort,
		SMTPEmail:         os.Getenv("SUPERPAGES_SMTP_EMAIL"),
		SMTPAppPassword:   os.Getenv("SUPERPAGES_SMTP_APP_PASSWORD"),
		LogCodes:          os.Getenv("SUPERPAGES_LOG_CODES") == "1",
		PrereleaseCode:    strings.TrimSpace(os.Getenv("SUPERPAGES_PRERELEASE_CODE")),
	}
}

// splitList splits a comma-separated env value, dropping blanks.
func splitList(s string) []string {
	var out []string
	for _, v := range strings.Split(s, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
