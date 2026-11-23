-- +goose Up
-- A page published to the web at /p/<slug>. Publishing is the one place a
-- page leaves end-to-end encryption: the apps hand the server the page in
-- the clear (body is the same JSON as a decrypted body_ct, image keys
-- included), and every writer's app sends it again after each save so the
-- public view stays live. version counts writes to this public copy. With
-- public_edit, anyone with the link may write it too, and members' apps
-- merge those edits back into the page.
CREATE TABLE published_pages (
    slug         TEXT PRIMARY KEY,
    doc_id       TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    public_edit  INTEGER NOT NULL DEFAULT 0,
    title        TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL,
    version      INTEGER NOT NULL,
    updated_by   TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

-- +goose Down
DROP TABLE published_pages;
