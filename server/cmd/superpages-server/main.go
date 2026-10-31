package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/joho/godotenv"

	"main/api"
	"main/config"
	"main/database"
	"main/mail"
	"main/sweeper"
)

func main() {
	// .env is optional: local dev only; systemd sets the real environment.
	_ = godotenv.Load()
	cfg := config.Load()

	if err := os.MkdirAll(cfg.BlobDir, 0o750); err != nil {
		log.Fatalf("blob dir: %v", err)
	}
	db, err := database.Connect(cfg.DBPath)
	if err != nil {
		log.Fatalf("connect db: %v", err)
	}

	m := mail.New(cfg)
	if !m.Ready() {
		log.Printf("warning: SMTP isn't configured (SUPERPAGES_SMTP_EMAIL/_APP_PASSWORD); nobody can sign in")
	}
	if cfg.LogCodes {
		log.Printf("warning: SUPERPAGES_LOG_CODES is on: sign-in codes are written to this log (dev only)")
	}
	if !cfg.RequireRegCode {
		log.Printf("registration codes are off: anyone with an email address can sign up")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sweeper.Run(ctx, db, cfg.BlobDir, time.Hour)

	a := api.New(db, cfg, m)
	if cfg.StaticDir != "" {
		log.Printf("serving the web app from %s", cfg.StaticDir)
	}
	log.Printf("superpages listening on %s", cfg.ListenAddr)
	if err := a.Router().Run(cfg.ListenAddr); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
