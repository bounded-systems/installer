{
  description = "@bounded-systems/installer — provisioning as VerbSpec verbs (install/doctor), effects via capability seams";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # The consumer smoke runs against the repo checkout (it needs the
        # node_modules a prior `bun install` produced — verbspec + zod), not a
        # hermetic store copy. Same pattern as prx's jsr-sync app: invoked from
        # $PWD, run from the repo root. `nix run .#smoke`.
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
        # `nix develop` → the toolchain this repo's CI uses (bun) plus node +
        # tsc for the local `smoke:node` runner and editor tooling.
        devShells.default = pkgs.mkShell {
          buildInputs = [ pkgs.bun pkgs.nodejs pkgs.typescript ];
        };

        # `nix run .#smoke` → the consumer example end-to-end (14 checks).
        apps.smoke = {
          type = "app";
          program = "${smoke}/bin/installer-smoke";
        };
      });
}
