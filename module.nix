# NixOS module for the Super Pages server.
#
# As in super-chat, the server is built by an activation script rather than a
# buildGoModule derivation: keeping a vendorHash in sync by hand on every
# go.sum change costs more than it's worth for a binary with no
# reproducibility requirement. It rebuilds from ${self}/server on every
# activation; goCache keeps that fast after the first run. The optional web
# app follows the same tradeoff via npmCache, and is served by the server
# itself on the same address as the API.
{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.superpages;
  stateDir = "/var/lib/superpages";
  serverBin = "${stateDir}/bin/superpages-server";
  adminBin = "${stateDir}/bin/superpages-admin";
  goCache = "/var/cache/superpages-go";
  npmCache = "/var/cache/superpages-npm";
  webDir = "${stateDir}/web";

  # `superpages-admin codes create` etc. against the running service's database.
  adminWrapper = pkgs.writeShellScriptBin "superpages-admin" ''
    export SUPERPAGES_DATA_DIR="${cfg.dataDir}"
    exec ${pkgs.sudo}/bin/sudo -u superpages -E ${adminBin} "$@"
  '';
in
{
  options.services.superpages = {
    enable = lib.mkEnableOption "the Super Pages end-to-end encrypted documents server";

    listenAddr = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1:8080";
      description = ''
        Address for the server (API and, with web.enable, the web app) to
        listen on. Loopback by default: put a tunnel (cloudflared) or reverse
        proxy in front of it for TLS.
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${stateDir}/data";
      description = "Where the SQLite database and encrypted blobs live.";
    };

    publicOrigin = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "https://pages.superbadger.io";
      description = "The public https origin; sharing emails link to it.";
    };

    androidCertSha256 = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "AB:CD:…" ];
      description = ''
        SHA-256 fingerprints of the APK signing key, served in
        /.well-known/assetlinks.json so share links open straight in the app.
        Get it with `keytool -list -v -keystore release/release.keystore`.
      '';
    };

    maxBlobMB = lib.mkOption {
      type = lib.types.ints.positive;
      default = 25;
      description = "Largest encrypted image accepted, in MB.";
    };

    trustProxy = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Rate-limit by the client address a local tunnel (Pangolin/newt,
        cloudflared) reports: the rightmost X-Forwarded-For entry, believed
        only on loopback connections, so clients can't forge it. Turn off if
        clients connect to the server directly.
      '';
    };

    requireRegistrationCode = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        New accounts need a registration code (`superpages-admin codes
        create`). Turn off to let anyone with an email address sign up.
      '';
    };

    shareInvitesBypassCode = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Someone a page was shared with by email can sign up without a
        registration code: the share is their invitation.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/superpages.env";
      description = ''
        Environment file with the SMTP settings for sign-in codes:
        SUPERPAGES_SMTP_EMAIL and SUPERPAGES_SMTP_APP_PASSWORD (and, if not
        Gmail, SUPERPAGES_SMTP_HOST / SUPERPAGES_SMTP_PORT). Give a runtime
        path as a string, not a Nix path literal, which would copy the secret
        into the store.
      '';
    };

    web.enable = lib.mkEnableOption "serving the web app from the server's own address";
  };

  config = lib.mkIf cfg.enable {
    users.users.superpages = {
      isSystemUser = true;
      group = "superpages";
      home = stateDir;
    };
    users.groups.superpages = { };

    systemd.tmpfiles.rules = [
      "d ${stateDir} 0750 superpages superpages -"
      "d ${stateDir}/bin 0755 root root -"
      "d ${cfg.dataDir} 0700 superpages superpages -"
      "d ${goCache} 0755 root root -"
    ] ++ lib.optionals cfg.web.enable [
      "d ${npmCache} 0755 root root -"
    ];

    system.activationScripts.superpagesBuild = {
      deps = [ ];
      text = ''
        export PATH=${pkgs.go}/bin:${pkgs.bash}/bin:${pkgs.nodejs_22}/bin:$PATH
        export HOME=${goCache}
        export GOCACHE=${goCache}/build
        export GOPATH=${goCache}/path
        # modernc sqlite is pure Go; no C toolchain needed.
        export CGO_ENABLED=0
        mkdir -p ${stateDir}/bin ${goCache}
        cd ${self}/server
        ${pkgs.go}/bin/go build -buildvcs=false -o ${serverBin}.new ./cmd/superpages-server
        mv -f ${serverBin}.new ${serverBin}
        ${pkgs.go}/bin/go build -buildvcs=false -o ${adminBin}.new ./cmd/superpages-admin
        mv -f ${adminBin}.new ${adminBin}
      '' + lib.optionalString cfg.web.enable ''
        # ${self}/app is in the read-only store and npm ci writes
        # node_modules into the project, so build from a scratch copy.
        export npm_config_cache=${npmCache}
        appBuild=${stateDir}/app-build
        rm -rf "$appBuild"
        mkdir -p "$appBuild"
        cp -r ${self}/app/. "$appBuild"/
        chmod -R u+w "$appBuild"
        cd "$appBuild"
        ${pkgs.nodejs_22}/bin/npm ci
        ${pkgs.nodejs_22}/bin/npm run build:web
        rm -rf ${webDir}.new
        cp -r dist ${webDir}.new
        chown -R superpages:superpages ${webDir}.new
        rm -rf ${webDir}
        mv -f ${webDir}.new ${webDir}
      '' + ''
        ${pkgs.systemd}/bin/systemctl try-restart superpages.service || true
      '';
    };

    environment.systemPackages = [ adminWrapper ];

    systemd.services.superpages = {
      description = "Super Pages server";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      environment = {
        SUPERPAGES_LISTEN_ADDR = cfg.listenAddr;
        SUPERPAGES_DATA_DIR = cfg.dataDir;
        SUPERPAGES_PUBLIC_ORIGIN = cfg.publicOrigin;
        SUPERPAGES_ANDROID_CERT_SHA256 = lib.concatStringsSep "," cfg.androidCertSha256;
        SUPERPAGES_MAX_BLOB_MB = toString cfg.maxBlobMB;
        SUPERPAGES_TRUST_PROXY = if cfg.trustProxy then "1" else "0";
        SUPERPAGES_REQUIRE_REG_CODE = if cfg.requireRegistrationCode then "1" else "0";
        SUPERPAGES_SHARE_INVITES_BYPASS_CODE = if cfg.shareInvitesBypassCode then "1" else "0";
      } // lib.optionalAttrs cfg.web.enable {
        SUPERPAGES_STATIC_DIR = webDir;
      };
      serviceConfig = {
        ExecStart = serverBin;
        Restart = "always";
        RestartSec = 2;
        User = "superpages";
        Group = "superpages";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.dataDir ];
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        CapabilityBoundingSet = "";
        UMask = "0077";
      } // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
    };
  };
}
