{
  description = "@bounded-systems/installer — provisioning as VerbSpec verbs (install/doctor), effects via capability seams";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    {
      # Portable home-manager module. From any home-manager config:
      #   inputs.installer.url = "github:bounded-systems/installer";
      #   modules = [ installer.homeManagerModules.default ];
      #   programs.bounded-installer.enable = true;
      homeManagerModules.bounded-installer = import ./nix/hm-module.nix self;
      homeManagerModules.default = import ./nix/hm-module.nix self;
    }
    // flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # The `bounded-installer` CLI: a thin consumer (bin/cli.ts) that wires
        # real node-backed seams into the installer library and dispatches the
        # install/doctor verbs over a small TOY catalog (an idempotent state
        # marker + a read-only git check). The real seam-backed catalog is
        # prx-m445. Built hermetically: npm ci (deps pinned by npmDepsHash) →
        # tsc (build:cli) → a node wrapper.
        bounded-installer = pkgs.buildNpmPackage {
          pname = "bounded-installer";
          version = "0.1.0";
          src = ./.;
          npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
          nativeBuildInputs = [ pkgs.makeWrapper ];
          npmBuildScript = "build:cli";
          # Custom install: the CLI runs from its compiled JS with node_modules
          # (verbspec + zod) resolved alongside. buildNpmPackage's default
          # bin/files install doesn't apply — the published package ships no bin.
          dontNpmPrune = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/bounded-installer
            cp -r dist-cli node_modules package.json $out/lib/bounded-installer/
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/bounded-installer \
              --add-flags "$out/lib/bounded-installer/dist-cli/bin/cli.js"
            runHook postInstall
          '';
        };

        # The consumer smoke (14 checks) run against the repo checkout — same
        # $PWD pattern as prx's jsr-sync app. `nix run .#smoke`.
        smoke = pkgs.writeShellApplication {
          name = "installer-smoke";
          runtimeInputs = [ pkgs.bun pkgs.nodejs ];
          text = ''
            if [ ! -d node_modules ]; then bun install --frozen-lockfile; fi
            exec bun examples/consumer-smoke.ts "$@"
          '';
        };
      in
      {
        packages = {
          bounded-installer = bounded-installer;
          default = bounded-installer;
        };

        # `nix run` → the CLI; `nix run .#smoke` → the consumer example.
        apps = {
          default = {
            type = "app";
            program = "${bounded-installer}/bin/bounded-installer";
          };
          smoke = {
            type = "app";
            program = "${smoke}/bin/installer-smoke";
          };
        };

        # `nix develop` → bun + node + tsc (CI toolchain + local runners).
        devShells.default = pkgs.mkShell {
          buildInputs = [ pkgs.bun pkgs.nodejs pkgs.typescript ];
        };
      });
}
