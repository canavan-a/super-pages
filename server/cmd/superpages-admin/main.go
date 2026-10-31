// Command superpages-admin is the operator's view of a superpages database.
// It can't read any document (they're ciphertext). The pre-release
// invite code is SUPERPAGES_PRERELEASE_CODE in the server's environment.
//
//	superpages-admin stats
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"main/database"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	dataDir := os.Getenv("SUPERPAGES_DATA_DIR")
	if dataDir == "" {
		dataDir = ".data"
	}
	dbPath := os.Getenv("SUPERPAGES_DB_PATH")
	if dbPath == "" {
		dbPath = filepath.Join(dataDir, "superpages.db")
	}
	db, err := database.Connect(dbPath)
	if err != nil {
		fail(err)
	}

	switch os.Args[1] {
	case "stats":
		count := func(table string) int64 {
			var n int64
			db.Table(table).Count(&n)
			return n
		}
		var bytes int64
		db.Raw("SELECT COALESCE(SUM(size), 0) FROM blobs").Scan(&bytes)
		fmt.Printf("users          %d\ndocuments      %d\nmemberships    %d\npending shares %d\nshare links    %d\nblobs          %d (%.1f MB)\n",
			count("users"), count("documents"), count("doc_members"), count("pending_shares"), count("share_links"),
			count("blobs"), float64(bytes)/(1<<20))

	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  superpages-admin stats`)
	os.Exit(2)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "superpages-admin:", err)
	os.Exit(1)
}
