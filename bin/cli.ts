/**
 * `bounded-installer` — a thin CLI consumer of the installer library.
 *
 * This is the *consumer*, not the library: it lives outside `src/` and is the
 * one place that holds ambient authority. It wires real node-backed capability
 * seams into `InstallDeps` and dispatches the install/doctor verbs over a small
 * catalog. The library (`src/index.ts`) stays a pure leaf — see its
 * extractability test.
 *
 * TOY CATALOG (honest status): the components here are a safe demo — an
 * idempotent state-marker this binary genuinely writes, plus a read-only `git`
 * presence check. The *real* provisioning catalog backed by the published
 * @bounded-systems/{fs,proc,host,env} seam repos is prx-m445.
 */
import { promises as fsp } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { dirname } from "node:path";

import { dispatch, render, type AnyVerbSpec } from "@bounded-systems/verbspec";
import { installRegistry, type Component, type InstallDeps } from "../src/index.ts";

// Real capability seams, backed by node. (In prx these become the published
// @bounded-systems/{fs,proc,host,env} seams — prx-m445.)
const realDeps = (): InstallDeps => ({
  fs: {
    exists: async (p) => {
      try {
        await fsp.access(p);
        return true;
      } catch {
        return false;
      }
    },
    writeFile: async (p, body) => {
      await fsp.mkdir(dirname(p), { recursive: true });
      await fsp.writeFile(p, body);
    },
  },
  proc: {
    run: async (cmd, args) => {
      const r = spawnSync(cmd, [...args], { encoding: "utf8" });
      return { code: r.status ?? 1, stderr: r.stderr ?? "" };
    },
  },
  host: {
    platform: () => (osPlatform() === "darwin" ? "darwin" : "linux"),
    arch: () => osArch(),
  },
  env: { get: (k) => process.env[k] },
});

const stateDir = `${process.env.XDG_STATE_HOME ?? `${homedir()}/.local/state`}/bounded-installer`;
const marker = `${stateDir}/installed`;

const catalog: Component[] = [
  {
    id: "state-marker",
    summary: "an idempotent marker file under XDG_STATE_HOME (safe demo of the install loop)",
    probe: (d) => d.fs.exists(marker),
    apply: (d) => d.fs.writeFile(marker, "installed by bounded-installer\n"),
  },
  {
    id: "git",
    summary: "git present on PATH (read-only check)",
    probe: async (d) => (await d.proc.run("git", ["--version"])).code === 0,
    apply: async () => {
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
