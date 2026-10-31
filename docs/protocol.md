# Super Pages protocol

How accounts, keys and pages work between the app (`app/src/crypto`,
`app/src/api.ts`, `app/src/pagesStore.ts`) and the server (`server/`). The two
must agree byte for byte; `app/__tests__/crypto.test.ts` writes
`server/proto/testdata/ts-sigs.json` and `server/proto/interop_test.go` checks
the server accepts it.

Encoding: binary on the wire is unpadded base64url ("b64"). IDs are 16 random
bytes in b64. A key ID is an Ed25519 public key in lowercase unpadded base32.

## Primitives

| | |
|---|---|
| Signatures | Ed25519 over `domain ‖ message`, strict RFC 8032 checks on both sides |
| Symmetric | XChaCha20-Poly1305, output `nonce(24) ‖ ciphertext` |
| Sealing to a key | ephemeral X25519, key = HKDF-SHA256(shared, salt `eph ‖ recipient`, info `sp-seal-v1`), then XChaCha20-Poly1305 |
| KDF | HKDF-SHA256, salt `superpages/v1` |
| Passphrases | scrypt N=2^16, r=8, p=1 |

## Accounts

An account's secret is 32 random bytes of **entropy**, made on the device
that signs up. Everything else is derived from it:

- signing key: Ed25519 seed = HKDF(entropy, `sp-ed25519`)
- box key: X25519 private = HKDF(entropy, `sp-x25519`)
- recovery phrase: the entropy as 24 BIP-39 words

The server keeps a **bundle**: the entropy sealed with XChaCha20-Poly1305
(associated data `sp-bundle`) under scrypt(passphrase, random salt). The
passphrase never leaves the device, so the server can't open it.

Sign-in is by email only:

1. `POST /v1/auth/email/start {email, invite_code}` emails a 6-digit code
   (10 minutes, 5 tries, only its hash kept in memory). While the server has
   a pre-release code (`SUPERPAGES_PRERELEASE_CODE`, one shared code;
   `GET /v1/config` says `prerelease`), an address without an account must
   send it as `invite_code` (case, spaces and dashes don't matter), or gets
   403 `{code: "prerelease"}` and no email. Existing accounts don't need it.
   That 403 does say an address has no account, so this route is limited per
   IP (5 per 10 minutes, 30 a day), per address and overall, and wrong
   invite codes are capped separately (5 an hour per IP, 100 an hour in all).
2. `POST /v1/auth/email/verify {email, code}` returns a **ticket** (single
   use, 30 minutes), and for an existing account its `bundle` and `sign_pub`.
3. New account: the app makes entropy, locks the bundle with the chosen
   passphrase and sends `POST /v1/accounts {ticket, box_pub, bundle, name}`,
   signed by the new signing key. Only a ticket whose sign-in passed the
   invite check can make an account.
4. Existing account: the app opens the bundle with the passphrase and checks
   the derived key ID equals `sign_pub`.
5. Forgot passphrase: the recovery phrase gives the same entropy; the app
   checks the key ID and uploads a new bundle (`PUT /v1/me/bundle`).
6. Lost both: `POST /v1/accounts/reset {ticket, box_pub, bundle}` gives the
   account new keys. Its document keys are dropped, documents only it could
   open are deleted, and other members' apps seal current keys to it again.

## Signed requests

Every request after sign-in carries:

```
X-SP-Key:   <key id>
X-SP-Ts:    <unix ms>            within ±60 s of the server
X-SP-Nonce: <≤64 chars>          not reused within 5 minutes
X-SP-Sig:   b64(Ed25519("SP1\n" METHOD "\n" path?query "\n" ts "\n" nonce "\n" hex(sha256(body))))
```

There are no sessions or tokens.

## Documents

Each document has a random 32-byte **document key** per **epoch**, sealed to
each member's box key with associated data `sp-dockey|<doc>`.

- `head_ct` = seal(key, JSON `{title, snippet}`, ad `sp-head|<doc>|<epoch>`):
  what the grid shows, without fetching bodies. The title is the page's
  own, set apart from its text.
- `body_ct` = seal(key, body, ad `sp-body|<doc>|<epoch>`). The body is JSON
  `{"v":2,"md":<markdown>,"y":<b64 Yjs state>}`: the shared editing state
  (the text as the XML fragment `default`, the title as the text `title`),
  with the markdown beside it. Pages saved before live editing are the
  markdown alone; an app opening one builds the Yjs state from it under the
  fixed client id 1, so every app builds the same state and the copies merge.
- Each save is signed: Ed25519(`sp-doc` ‖ `<doc>|<version>|<epoch>|hex(sha256(head_ct))|hex(sha256(body_ct))`)
  by the writer; the server checks it and keeps it, and readers check it
  against the writer's `sign_pub`.
- Saves name the version they started from (`base_version`). If someone
  else saved first, the server answers 409 with the current version; the app
  merges that saved state into its own (Yjs states always merge) and saves
  again.

**Live editing.** Every open copy of a page (each tab, each device) checks
in with `POST /v1/docs/:id/live {tab, since, gen, wait, leaving, aware,
updates}`, with a random tab id. `updates` are the Yjs updates typed there
and `aware` is its Yjs awareness state (its cursor, name and color), each
sealed under the document key with ad `sp-live|<doc>|<epoch>`. The server
keeps, in memory only: who is there (a closing tab says `leaving`; one that
vanishes is dropped after 30s), each tab's latest `aware`, and the updates of the
last 3 minutes, numbered. It answers with the updates after `since` from
other tabs, everyone there, and the saved version and epoch; with `wait`,
it holds the answer up to 20s until something happens, a tab joining or
leaving included, so everyone sees comings and goings at once. A tab that fell
behind the buffer is told to `reset` and merges the saved page in again.
View members can check in but not send updates. Each tab saves what was
typed in it, so nothing outlives the buffer unsaved.

**Images** are sealed under their own random key (ad `sp-blob`), uploaded as
blobs of the document, and referenced in the markdown as
`sp-img:<blob id>#<b64 key>`. Their keys are only as readable as the body.
The editor never loads any other kind of image URL.

## Roles

| | read | edit | share, change roles, remove people | delete |
|---|---|---|---|---|
| owner | ✓ | ✓ | ✓ | ✓ |
| edit | ✓ | ✓ | | |
| view | ✓ | | | |

The server enforces these on every route. A document always has an owner.

## Sharing

**By email** (owners only): `POST /v1/docs/:id/share {email, role}` matches an
exact address. A match returns the person's ID, name and box key (never an
email), and the owner's app seals the key to them with `POST
/v1/docs/:id/members`. No match records a **pending share** and emails an
invitation. Once that address signs up, the next owner app to run sees it in
`GET /v1/shares/todo` and finishes the share.

**By link** (owners only, edit or view): the link is
`https://<server>/s/<link id>#<secret>`; the secret never reaches the server.
From it: a link signing key (HKDF `sp-link-sign`) whose public half the
server stores, and a key (HKDF `sp-link`) sealing the document key (ad
`sp-linkkey|<doc>`). To join, the app opens the document key and sends a
proof, Ed25519(`sp-join` ‖ `<link>|<doc>|<user>`) by the link key, with the
document key sealed to itself.

**Removing someone** is a rekey: an owner's app makes epoch + 1, re-seals
head and body, seals the new key to everyone who stays and sends it all in
`POST /v1/docs/:id/rekey`. Share links are revoked with the old key. When
someone leaves on their own, the document is marked and an owner's app
rekeys it (`shares/todo`).

## What the server sees

Email addresses, names, profile pictures (plaintext, shown to collaborators),
public keys, locked bundles, who is in which document with which role, sizes
and times, and who has which page open right now. Never: passphrases,
entropy, document keys, titles, text, images or where anyone's cursor is.

Other users' email addresses are never in any response; only `GET /v1/me`
returns the caller's own. Every email route is rate limited (see
`server/api/api.go`).
