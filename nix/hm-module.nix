self:
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.bounded-installer;
in
{
  options.programs.bounded-installer = {
    enable = lib.mkEnableOption "the bounded-installer provisioning CLI (install/doctor verbs)";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.bounded-installer;
      defaultText = lib.literalExpression "installer.packages.\${system}.bounded-installer";
      description = "The bounded-installer package to install onto PATH.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
