<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img alt="Super Pages" src="docs/assets/wordmark-light.svg" width="420">
  </picture>
</h1>

End-to-end encrypted notes and documents, on the web and as a sideloaded
Android app. Built from the same parts as super-chat and super-matrix: the
same themes, boot screen (a scroll that unrolls) and release flow.

- **Sign in with your email.** A code proves the address. Your account key is
  made on your device and stored on the server locked with your passphrase,
  which never leaves your device. A 24-word recovery phrase is the way back if
  you forget it.
- **The server can't read your pages.** Titles, text and images are encrypted
  on your device. The server knows your email, name and picture, and who each
  page is shared with.
- **Writing without markdown.** Pages are stored as markdown, but you edit
  them with a toolbar (headings, lists, checklists, quotes, code, images) and
  never see the syntax.
- **Sharing.** Each page can be shared by email or by link, as owner (full
  control), edit (edit only) or view. Removing someone gives the page a new
  key. Nobody can look up anyone's email address.
- **Invite-only for now.** New accounts need a registration code.

## Running it

```sh
nix develop
dev-up                 # server on 127.0.0.1:8080 (codes go to .data/logs/superpages.log)
superpages-admin codes create --uses 5 --label "me"
run-app-web            # web app on :5173, talking to the dev server
run-tests              # server tests, app tests, then end to end
```

`run-app-web-build` builds `app/dist`, which the dev server also serves on
:8080. After changing anything in `app/src/editor/`, run
`run-app-editor-build` so the Android app's WebView editor picks it up.

On NixOS:

```nix
services.superpages = {
  enable = true;
  publicOrigin = "https://pages.superbadger.io";
  web.enable = true;
  environmentFile = "/run/secrets/superpages.env"; # SUPERPAGES_SMTP_EMAIL / _APP_PASSWORD
};
```

It listens on loopback; put a tunnel or TLS proxy in front. The API and the
web app share one address.

## Releases

`release/gen-keystore.sh` once, then `release/release.sh` builds, signs and
publishes `superpages-app-v*.apk` to GitHub Releases, where the app's
Settings → App updates finds it. Put the key's SHA-256 in
`services.superpages.androidCertSha256` so share links open in the app.

## Layout

- `server/`: Go (Gin, SQLite via GORM, goose migrations). See `docs/protocol.md`.
- `app/`: React Native + react-native-web. The editor (`app/src/editor/`) is
  TipTap, mounted directly on the web and in a WebView on Android.
- `art/`, `tools/appart/`: the pixel-art logo and the generator for icons.
