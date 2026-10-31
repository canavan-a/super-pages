-- +goose Up
-- Per-person registration codes are gone: new accounts now give the one
-- pre-release code from the environment (SUPERPAGES_PRERELEASE_CODE) when
-- they ask for a sign-in code.
DROP TABLE code_redemptions;
DROP TABLE registration_codes;

-- +goose Down
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
