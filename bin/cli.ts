/**
 * `bounded-installer` — a thin CLI consumer of the installer library.
 *
 * This is the *consumer*, not the library: it lives outside `src/` and is the
 * one place that holds ambient authority. It fills `InstallDeps` from the REAL
 * @bounded-systems capability seams — `fs` (statPath/removeFile), `proc`
 * (defaultRunner), `host` (homeDir/hostName), `env` (getEnv) — and dispatches
 * the install/doctor verbs over a small catalog. The library (`src/index.ts`)
 * stays a pure leaf; effects are governed, flowing through the seams.
 *
 * CATALOG (honest status): the fs seam is read+remove only, so installs run
 * COMMANDS through `proc`. The demo catalog ensures an XDG state dir (a real,
 * idempotent `mkdir -p` through the proc seam) and reports git presence. A
 * fuller provisioning catalog is prx-m445.
 */
import { statPath, removeFile } from "@bounded-systems/fs";
import { defaultRunner } from "@bounded-systems/proc";
import { homeDir, hostName } from "@bounded-systems/host";
import { getEnv } from "@bounded-systems/env";

import { dispatch, render, type AnyVerbSpec } from "@bounded-systems/verbspec";
import { installRegistry, type Component, type InstallDeps } from "../src/index.ts";

// Fill the capability slice from the real seams — one-for-one, no node:* here.
const realDeps = (): InstallDeps => ({
  fs: { statPath, removeFile },
  // `check: false` → a non-zero exit comes back as a ProcResult, never throws.
  proc: { run: (cmd) => defaultRunner([...cmd], { check: false }) },
  host: { homeDir, hostName },
  env: { get: getEnv },
});

const stateDir = (d: InstallDeps): string =>
  `${d.env.get("XDG_STATE_HOME") ?? `${d.host.homeDir()}/.local/state`}/bounded-installer`;

const catalog: Component[] = [
  {
    id: "state-dir",
    summary: "an XDG state dir for bounded-installer (idempotent mkdir via the proc seam)",
    probe: (d) => statPath(stateDir(d))?.isDirectory === true,
    apply: (d) => {
      const r = d.proc.run(["mkdir", "-p", stateDir(d)]);
      if (r.status !== 0) throw new Error(r.stderr.trim() || "mkdir failed");
    },
  },
  {
    id: "git",
    summary: "git present on PATH (read-only check)",
    probe: (d) => d.proc.run(["git", "--version"]).status === 0,
    apply: () => {
      throw new Error("install git via your system package manager");
    },
  },
];

async function main(): Promise<number> {
  const registry = installRegistry({ catalog, deps: realDeps });
  const argv = process.argv.slice(2);
  // Default to `doctor` (read-only) when invoked with no verb.
  const res = await dispatch(registry, argv.length ? argv : ["doctor"], "bounded-installer");
  if (res.kind === "help") {
    console.log(res.text);
    return 0;
  }
  const verb = registry[res.id] as AnyVerbSpec;
  for (const w of verb.warnings?.(res.output, res.input) ?? []) console.error(w);
  console.log(verb.render ? verb.render(res.output, res.input) : render(res.output));
  return verb.exitCode ? verb.exitCode(res.output, res.input) : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
