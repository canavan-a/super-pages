package migrations

import (
	"context"
	"database/sql"
	"io/fs"
	"path/filepath"
	"testing"

	_ "github.com/glebarez/go-sqlite"
	"github.com/pressly/goose/v3"
)

// Memberships that exist before 00003 (your own pages and ones you already
// had) must stay in your pages, not move to "Shared with me".
func TestExistingMembershipsStayAccepted(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "old.db")+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sub, _ := fs.Sub(migrationFiles, "sql")
	p, err := goose.NewProvider(goose.DialectSQLite3, db, sub)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpTo(context.Background(), 2); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO users (id, sign_pub, box_pub, email, key_bundle, created_at) VALUES ('u1','s1','b1','a@x','k',0), ('u2','s2','b2','b@x','k',0)`,
		`INSERT INTO documents (id, created_by, version, key_epoch, head_ct, body_ct, sig, updated_by, updated_at, created_at) VALUES ('d1','u1',1,1,'h','b','s','u1',0,0)`,
		`INSERT INTO doc_members (doc_id, user_id, role, added_by, added_at) VALUES ('d1','u1','owner','u1',0), ('d1','u2','edit','u1',0)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err := Run(db); err != nil {
		t.Fatal(err)
	}
	var unaccepted int
	if err := db.QueryRow(`SELECT COUNT(*) FROM doc_members WHERE accepted <> 1`).Scan(&unaccepted); err != nil {
		t.Fatal(err)
	}
	if unaccepted != 0 {
		t.Fatalf("%d existing memberships became unaccepted", unaccepted)
	}
}
