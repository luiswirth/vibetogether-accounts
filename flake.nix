{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    treefmt-nix,
    ...
  }: let
    forEachSystem = f:
      nixpkgs.lib.genAttrs ["aarch64-darwin" "x86_64-linux"]
      (system: f nixpkgs.legacyPackages.${system});

    # One environment, entered by the shell and by the checks alike. The
    # compiler and the type definitions are pinned by pnpm instead, since
    # editors look for them in node_modules.
    tools = pkgs: with pkgs; [nodejs pnpm biome just];
  in {
    # The service as it runs: its sources and its production dependencies,
    # which Node runs as they are, stripping the types itself.
    packages = forEachSystem (pkgs: {
      default = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
        pname = "vibetogether-accounts";
        version = "0.1.0";
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [./package.json ./pnpm-lock.yaml ./src];
        };
        nativeBuildInputs = [pkgs.nodejs pkgs.pnpm pkgs.pnpmConfigHook pkgs.makeWrapper];
        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src;
          fetcherVersion = 4;
          hash = "sha256-aDf1XT9Eati9sYUplR4/aFaQwJv4veRJFy3J/zeW1wk=";
          # pnpm leaves an empty `links` in its store on Darwin only, which
          # fetchPnpmDeps keeps, so the hash would differ between platforms.
          preFixup = "rm -rf $storePath/v11/links";
        };
        pnpmInstallFlags = ["--prod"];
        installPhase = ''
          mkdir -p $out/lib/vibetogether-accounts
          cp -r package.json src node_modules $out/lib/vibetogether-accounts
          makeWrapper ${pkgs.lib.getExe pkgs.nodejs} $out/bin/vibetogether-accounts \
            --add-flags $out/lib/vibetogether-accounts/src/main.ts
        '';
        meta.mainProgram = "vibetogether-accounts";
      });
    });

    nixosModules.default = import ./nixos-module.nix self;

    # Every language in the tree, behind one command. The global pre-commit
    # hook checks a repository by running this, so a language left out here is
    # a language nothing checks.
    formatter = forEachSystem (pkgs:
      treefmt-nix.lib.mkWrapper pkgs {
        projectRootFile = "flake.nix";
        programs.biome.enable = true;
        # One configuration for both, rather than treefmt's own default. treefmt
        # names the files itself, and Biome would look for the ignore file next
        # to the copy in the store. Biome checks the configuration as it loads,
        # and treefmt-nix's schema lags behind it.
        programs.biome.validate.enable = false;
        programs.biome.settings = removeAttrs (builtins.fromJSON (builtins.readFile ./biome.json)) ["vcs"];
        programs.alejandra.enable = true;
        programs.just.enable = true;
      });

    devShells = forEachSystem (pkgs: {
      default = pkgs.mkShell {packages = tools pkgs;};
    });
  };
}
