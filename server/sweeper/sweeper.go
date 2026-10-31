// Package sweeper removes what nothing points at any more: blob files with
// no row (a crash between writing the file and the row, or between deleting
// the row and the file), and dead share links.
package sweeper

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"time"

	"gorm.io/gorm"

	"main/database"
)

// Run sweeps every interval until ctx ends.
func Run(ctx context.Context, db *gorm.DB, blobDir string, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		Sweep(db, blobDir, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Sweep does one pass.
func Sweep(db *gorm.DB, blobDir string, now time.Time) {
	// Links stay a week after they die so an owner can still see what
	// happened to them; then they go.
	cutoff := now.Add(-7 * 24 * time.Hour).Unix()
	if err := db.Where("(revoked = 1 AND created_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?)", cutoff, cutoff).
		Delete(&database.ShareLink{}).Error; err != nil {
		log.Printf("sweeper: links: %v", err)
	}

	entries, err := os.ReadDir(blobDir)
	if err != nil {
		return
	}
	var known []string
	if err := db.Model(&database.Blob{}).Pluck("id", &known).Error; err != nil {
		log.Printf("sweeper: blobs: %v", err)
		return
	}
	keep := make(map[string]bool, len(known))
	for _, id := range known {
		keep[id] = true
	}
	for _, e := range entries {
		if e.IsDir() || keep[e.Name()] {
			continue
		}
		// A file younger than an hour may be an upload whose row is being
		// written right now.
		if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > time.Hour {
			_ = os.Remove(filepath.Join(blobDir, e.Name()))
		}
	}
}
