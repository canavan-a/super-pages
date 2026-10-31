// Command superpages-admin is the operator's view of a superpages database.
// It can't read any document (they're ciphertext). It hands out the
// pre-release registration codes new accounts need.
//
//	superpages-admin stats
//	superpages-admin codes create [--uses N] [--expires 30d] [--label "beta 1"]
//	superpages-admin codes list
//	superpages-admin codes revoke <id>
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"main/database"
	"main/regcode"
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

	case "codes":
		if len(os.Args) < 3 {
			usage()
		}
		switch os.Args[2] {
		case "create":
			fs := flag.NewFlagSet("codes create", flag.ExitOnError)
			uses := fs.Int64("uses", 1, "how many accounts the code can make")
			expires := fs.String("expires", "30d", "how long it lasts (e.g. 12h, 30d; 0 for never)")
			label := fs.String("label", "", "a note to yourself, e.g. who it's for")
			_ = fs.Parse(os.Args[3:])
			ttl, err := parseTTL(*expires)
			if err != nil || *uses < 1 {
				fail(fmt.Errorf("bad --expires or --uses"))
			}
			code, rc, err := regcode.Create(db, *label, *uses, ttl, time.Now())
			if err != nil {
				fail(err)
			}
			fmt.Printf("%s\n\n(id %s, %d use(s), %s; this is the only time the code is shown)\n", code, rc.ID, rc.MaxUses, expiryText(rc.ExpiresAt))
		case "list":
			var codes []database.RegistrationCode
			if err := db.Order("created_at").Find(&codes).Error; err != nil {
				fail(err)
			}
			w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tLABEL\tUSES\tEXPIRES\tSTATE")
			now := time.Now().Unix()
			for _, c := range codes {
				state := "active"
				switch {
				case c.Revoked:
					state = "revoked"
				case c.ExpiresAt != nil && now >= *c.ExpiresAt:
					state = "expired"
				case c.Uses >= c.MaxUses:
					state = "used up"
				}
				fmt.Fprintf(w, "%s\t%s\t%d/%d\t%s\t%s\n", c.ID, c.Label, c.Uses, c.MaxUses, expiryText(c.ExpiresAt), state)
			}
			_ = w.Flush()
		case "revoke":
			if len(os.Args) < 4 {
				usage()
			}
			res := db.Model(&database.RegistrationCode{}).Where("id = ?", os.Args[3]).Update("revoked", true)
			if res.Error != nil {
				fail(res.Error)
			}
			if res.RowsAffected == 0 {
				fail(fmt.Errorf("no code with id %s", os.Args[3]))
			}
			fmt.Println("revoked", os.Args[3])
		default:
			usage()
		}
	default:
		usage()
	}
}

// parseTTL reads "30d", "12h", "90m" or "0".
func parseTTL(s string) (time.Duration, error) {
	if s == "0" || s == "" {
		return 0, nil
	}
	if d, ok := strings.CutSuffix(s, "d"); ok {
		n, err := strconv.Atoi(d)
		return time.Duration(n) * 24 * time.Hour, err
	}
	return time.ParseDuration(s)
}

func expiryText(exp *int64) string {
	if exp == nil {
		return "never expires"
	}
	return "expires " + time.Unix(*exp, 0).Format("2006-01-02 15:04")
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  superpages-admin stats
  superpages-admin codes create [--uses N] [--expires 30d] [--label "beta 1"]
  superpages-admin codes list
  superpages-admin codes revoke <id>`)
	os.Exit(2)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "superpages-admin:", err)
	os.Exit(1)
}
