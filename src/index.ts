/**
 * @bounded-systems/installer — the provisioning surface, authored once as
 * VerbSpec verbs and projected to every surface (CLI / MCP / Anthropic tool /
 * OpenAPI / NDJSON) by `@bounded-systems/verbspec`.
 *
 * This package is a **leaf**: its only edges are `zod` and `verbspec`. It owns
 * the installer's *interface* — the `install` / `doctor` verb schemas and the
 * orchestration over a component catalog — and **nothing else**. It performs no
 * effects and holds no ambient authority: every effect is a call through the
 * injected {@link InstallDeps} capability slice, which the *consumer* supplies.
 *
 *   - prx wires its in-monorepo `@bounded-systems/{fs,proc,host,env}` seams.
 *   - a standalone `bounded` binary wires the *published* seams.
 *   - tests pass fakes.
 *
 * The verb schema is the single source of truth; the four surfaces can't drift.
 * The catalog of *what* gets provisioned is the consumer's — keeping this repo
 * from becoming a second source of truth (see the drift-guard note in README).
 */
import { z } from "zod";
import { defineVerb, type AnyVerbSpec, type Registry } from "@bounded-systems/verbspec";

// ── the capability slice (the seam the consumer fills) ───────────────────────
//
// The narrow slice of system authority the installer needs. The SHAPE mirrors
// the real `@bounded-systems/*` seams one-for-one so a consumer can fill it
// straight from them (`@bounded-systems/fs` statPath/removeFile,
// `@bounded-systems/proc` defaultRunner, `@bounded-systems/host` homeDir/
// hostName, `@bounded-systems/env` getEnv). This package only ever sees the
// interface — structural, no seam import — so it stays a leaf with no power.
//
// Note the filesystem seam is READ + REMOVE only: there is no write capability,
// by design (it composes for reads — cas/scout decorate it). So provisioning
// effects run COMMANDS through `proc` (mkdir, a package manager, …) rather than
// writing files directly. `probe` reads via `fs`/`proc`; `apply` runs via `proc`.

/** A path's stat, mirroring `@bounded-systems/fs`'s `FileStat`. */
export type FileStat = {
  sizeBytes: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
};

/** A finished command, mirroring `@bounded-systems/proc`'s `CommandResult`. */
export type ProcResult = { stdout: string; stderr: string; status: number };

export type InstallDeps = {
  /** Read-side filesystem (the seam offers no write). */
  fs: {
    statPath: (path: string) => FileStat | null;
    removeFile: (path: string) => void;
  };
  /** Run a command (`[file, ...args]`) and capture it; never throws on non-zero. */
  proc: { run: (cmd: readonly string[]) => ProcResult };
  host: { homeDir: () => string; hostName: () => string };
  env: { get: (key: string) => string | undefined };
};

// A single provisionable unit. `probe` is read-only (so `doctor` reuses it and
// `--dry-run` is safe); `apply` is the effect — and every line of it must go
// through `deps`, never the OS directly. A per-package catalog of these is how
// the installer composes without becoming a god-binary.
export type Component = {
  /** Stable id — the CLI token and the unit shown in reports. */
  id: string;
  /** Optional human description. */
  summary?: string;
  /** Already-satisfied check. Read-only: no effects, safe in dry-run. */
  probe: (deps: InstallDeps) => boolean | Promise<boolean>;
  /** The effect. Every line goes through a `deps.*` seam (commands via `proc`). */
  apply: (deps: InstallDeps) => void | Promise<void>;
};

/** Everything a consumer supplies to project an installer: the catalog + the reals. */
export type InstallerConfig = {
  /** What can be provisioned. The consumer owns this — the single source of truth. */
  catalog: readonly Component[];
  /** Factory for the real capability slice (or fakes, in tests). */
  deps: () => InstallDeps;
};

// ── schemas: the canonical, multi-surface contract ───────────────────────────

/** `install` input. */
export const InstallInput = z.object({
  components: z
    .array(z.string())
    .default([])
    .describe("component ids to install; empty = the whole catalog"),
  profile: z
    .enum(["host", "vm", "box"])
    .default("host")
    .describe("provisioning target profile"),
  "dry-run": z.boolean().default(false).describe("plan only; perform no effects"),
  force: z.boolean().default(false).describe("re-apply even when the probe reports satisfied"),
});

/** One component's outcome. */
export const ComponentResult = z.object({
  id: z.string(),
  status: z.enum(["installed", "skipped", "failed", "planned"]),
  detail: z.string().optional(),
});

/** `install` output — the structured report every surface receives. */
export const InstallOutput = z.object({
  profile: z.string(),
  dryRun: z.boolean(),
  results: z.array(ComponentResult),
});

/** `doctor` output — the read-only health projection of the catalog. */
export const DoctorOutput = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ id: z.string(), satisfied: z.boolean() })),
});

export type InstallInput = z.infer<typeof InstallInput>;
export type InstallOutput = z.infer<typeof InstallOutput>;
export type DoctorOutput = z.infer<typeof DoctorOutput>;

// ── the verbs ────────────────────────────────────────────────────────────────

/** Project an `install` verb over the consumer's catalog and seams. */
export function makeInstall(config: InstallerConfig): AnyVerbSpec {
  return defineVerb({
    id: "install",
    summary: "Provision bounded-systems components into the target profile",
    actor: "provision", // binds to the capability/permission model
    positionals: ["components"], // `install fs proc` → components: ["fs","proc"]
    input: InstallInput,
    output: InstallOutput,
    deps: config.deps,
    run: async (input, deps): Promise<InstallOutput> => {
      const d = deps as InstallDeps; // dispatch always passes deps(); tests pass their own
      const selected =
        input.components.length === 0
          ? config.catalog
          : config.catalog.filter((c) => input.components.includes(c.id));

      const results: z.infer<typeof ComponentResult>[] = [];
      for (const c of selected) {
        const satisfied = await c.probe(d); // read-only — safe even in dry-run
        if (satisfied && !input.force) {
          results.push({ id: c.id, status: "skipped", detail: "already satisfied" });
          continue;
        }
        if (input["dry-run"]) {
          results.push({ id: c.id, status: "planned" });
          continue;
        }
        try {
          await c.apply(d); // ← the only effect, and it is all `deps.*`
          results.push({ id: c.id, status: "installed" });
        } catch (e) {
          results.push({
            id: c.id,
            status: "failed",
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return { profile: input.profile, dryRun: input["dry-run"], results };
    },

    // ── CLI-only projections (MCP/OpenAPI/NDJSON consume `output`, not these) ──
    render: (o: InstallOutput): string =>
      [
        `profile=${o.profile}${o.dryRun ? " (dry-run)" : ""}`,
        ...o.results.map(
          (r) => `  ${r.status.padEnd(9)} ${r.id}${r.detail ? ` — ${r.detail}` : ""}`,
        ),
      ].join("\n"),
    // "Success but non-zero": the run completed but a component failed. Agents
    // over MCP/OpenAPI still get the full report in `output.results`.
    exitCode: (o: InstallOutput): number =>
      o.results.some((r) => r.status === "failed") ? 1 : 0,
    // Operator notes to stderr; the same data also lives in `output`.
    warnings: (o: InstallOutput): readonly string[] =>
      o.results
        .filter((r) => r.status === "skipped")
        .map((r) => `skipped ${r.id}: ${r.detail ?? ""}`),
  });
}

/** Project a read-only `doctor` verb — the same probes, no `apply`. */
export function makeDoctor(config: InstallerConfig): AnyVerbSpec {
  return defineVerb({
    id: "doctor",
    summary: "Report which bounded-systems components are satisfied (read-only)",
    actor: "provision",
    input: z.object({}),
    output: DoctorOutput,
    deps: config.deps,
    run: async (_input, deps): Promise<DoctorOutput> => {
      const d = deps as InstallDeps;
      const checks: { id: string; satisfied: boolean }[] = [];
      for (const c of config.catalog) checks.push({ id: c.id, satisfied: await c.probe(d) });
      return { ok: checks.every((c) => c.satisfied), checks };
    },
    render: (o: DoctorOutput): string =>
      o.checks.map((c) => `  ${c.satisfied ? "✓" : "✗"} ${c.id}`).join("\n"),
    exitCode: (o: DoctorOutput): number => (o.ok ? 0 : 1),
  });
}

/**
 * The installer registry: every surface is a projection of these two verbs.
 *
 *   CLI:    await dispatch(installRegistry(cfg), ["install", "fs", "--dry-run"])
 *   agent:  toMcpToolset(installRegistry(cfg))   // → install + doctor tools
 *   HTTP:   toOpenApiPaths(installRegistry(cfg))
 *   daemon: dispatchNdjson(installRegistry(cfg), line)
 */
export function installRegistry(config: InstallerConfig): Registry {
  return { install: makeInstall(config), doctor: makeDoctor(config) };
}
