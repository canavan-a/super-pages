-- +goose Up

-- An account. id is stable for the account's life; sign_pub/box_pub change
-- only on an account reset (key_gen counts those). key_bundle is the
-- account's 32-byte secret sealed under a key derived from the user's
-- passphrase on their device; the server can't open it.
CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    sign_pub    TEXT NOT NULL UNIQUE,
    box_pub     TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    avatar_blob TEXT,
    key_bundle  TEXT NOT NULL,
    key_gen     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
);

-- Pre-release registration codes. Only a hash of the code is kept.
CREATE TABLE registration_codes (
    id         TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL DEFAULT '',
    max_uses   INTEGER NOT NULL,
    uses       INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    revoked    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE code_redemptions (
    code_id TEXT NOT NULL REFERENCES registration_codes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at      INTEGER NOT NULL,
    PRIMARY KEY (code_id, user_id)
);

-- A document. head_ct ({title, snippet}) and body_ct (markdown) are sealed
-- under the document key of epoch key_epoch. sig is the last writer's
-- signature over proto.DocSigningString. needs_rekey is set when a member
-- leaves on their own, so an owner's app makes a fresh key.
CREATE TABLE documents (
    id          TEXT PRIMARY KEY,
    created_by  TEXT NOT NULL,
    version     INTEGER NOT NULL,
    key_epoch   INTEGER NOT NULL,
    head_ct     TEXT NOT NULL,
    body_ct     TEXT NOT NULL,
    sig         TEXT NOT NULL,
    updated_by  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    needs_rekey INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE doc_members (
    doc_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role     TEXT NOT NULL CHECK (role IN ('owner', 'edit', 'view')),
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (doc_id, user_id)
);
CREATE INDEX doc_members_user ON doc_members(user_id);

-- The document key for one member, sealed to their box_pub. Only the
-- current epoch's keys are kept; a member without a row for the current
-- epoch (just reset their account, or a share still being finished) waits
-- for an owner's app to seal one.
CREATE TABLE doc_keys (
    doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    epoch       INTEGER NOT NULL,
    wrapped_key TEXT NOT NULL,
    PRIMARY KEY (doc_id, user_id)
);

-- A share to an email with no account yet. An owner's app finishes it (seals
-- the key) once that email signs up.
CREATE TABLE pending_shares (
    id         TEXT PRIMARY KEY,
    doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    email      TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'edit', 'view')),
    invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (doc_id, email)
);
CREATE INDEX pending_shares_email ON pending_shares(email);

-- A share link. The secret after '#' never reaches the server; link_pub is
-- the Ed25519 key derived from it, and key_ct is the document key sealed
-- under a key derived from it. A rekey revokes every link.
CREATE TABLE share_links (
    id         TEXT PRIMARY KEY,
    doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('edit', 'view')),
    link_pub   TEXT NOT NULL,
    key_ct     TEXT NOT NULL,
    epoch      INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    expires_at INTEGER,
    max_uses   INTEGER,
    uses       INTEGER NOT NULL DEFAULT 0,
    revoked    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX share_links_doc ON share_links(doc_id);

-- Encrypted images in a document (doc_id set) and plaintext profile pictures
-- (doc_id NULL). Bytes live in <dataDir>/blobs/<id>.
CREATE TABLE blobs (
    id         TEXT PRIMARY KEY,
    doc_id     TEXT REFERENCES documents(id) ON DELETE CASCADE,
    uploader   TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX blobs_doc ON blobs(doc_id);

-- +goose Down
DROP TABLE blobs;
DROP TABLE share_links;
DROP TABLE pending_shares;
DROP TABLE doc_keys;
DROP TABLE doc_members;
DROP TABLE documents;
DROP TABLE code_redemptions;
DROP TABLE registration_codes;
DROP TABLE users;
