-- +goose Up
-- A page shared by email waits in the person's "Shared with me" list until
-- they accept it (or decline, which leaves it), so nobody can fill someone
-- else's pages by sharing at them. Existing memberships, pages people made
-- and pages joined through a link count as accepted.
ALTER TABLE doc_members ADD COLUMN accepted INTEGER NOT NULL DEFAULT 1;

-- +goose Down
ALTER TABLE doc_members DROP COLUMN accepted;
