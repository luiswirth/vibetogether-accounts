# The account service as a NixOS service. It acts for no one, so it runs as a
# user of its own, which reaches nothing but its database. It listens on
# 127.0.0.1 only: the host proxies /api/ and /.well-known/ to it, and never
# /agentwire/, which is for the relay alone.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.vibetogether-accounts;
in {
  options.services.vibetogether-accounts = {
    enable = lib.mkEnableOption "Vibe Together's account service";
    port = lib.mkOption {
      type = lib.types.port;
      default = 8793;
      description = "The port the service listens on, on 127.0.0.1.";
    };
    url = lib.mkOption {
      type = lib.types.str;
      example = "https://vibetogether.agentics.lwirth.com";
      description = "Where the service is reached from outside.";
    };
    relay = lib.mkOption {
      type = lib.types.str;
      example = "https://agentwire.agentics.lwirth.com";
      description = "The relay the rooms live on, as participants reach it.";
    };
    github.clientId = lib.mkOption {
      type = lib.types.str;
      description = "The GitHub OAuth app's client ID.";
    };
    github.clientSecretFile = lib.mkOption {
      type = lib.types.path;
      description = "The file holding the GitHub OAuth app's client secret, read as a credential, so that it never enters the store.";
    };
  };

  config.systemd.services.vibetogether-accounts = lib.mkIf cfg.enable {
    description = "Vibe Together's account service";
    after = ["network.target"];
    wantedBy = ["multi-user.target"];
    environment = {
      ACCOUNTS_URL = cfg.url;
      ACCOUNTS_PORT = toString cfg.port;
      ACCOUNTS_DATABASE = "/var/lib/vibetogether-accounts/accounts.db";
      # The key that signs sessions, which the service makes on its first start.
      ACCOUNTS_SECRET_FILE = "/var/lib/vibetogether-accounts/secret";
      AGENTWIRE_RELAY = cfg.relay;
      GITHUB_CLIENT_ID = cfg.github.clientId;
    };
    serviceConfig = {
      ExecStart = lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      Restart = "on-failure";
      # Read by the service from $CREDENTIALS_DIRECTORY/github.
      LoadCredential = "github:${cfg.github.clientSecretFile}";
      DynamicUser = true;
      StateDirectory = "vibetogether-accounts";
      ProtectHome = true;
      PrivateDevices = true;
      ProtectClock = true;
      ProtectControlGroups = true;
      ProtectHostname = true;
      ProtectKernelLogs = true;
      ProtectKernelModules = true;
      ProtectKernelTunables = true;
      ProtectProc = "invisible";
      CapabilityBoundingSet = "";
      LockPersonality = true;
      RestrictAddressFamilies = ["AF_INET" "AF_INET6" "AF_UNIX"];
      RestrictNamespaces = true;
      RestrictRealtime = true;
      SystemCallArchitectures = "native";
      SystemCallFilter = ["@system-service" "~@privileged"];
      UMask = "0077";
    };
  };
}
