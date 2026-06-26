/**
 * Consumer smoke test / executable usage example.
 *
 * Runs the README's usage shape end-to-end: a downstream consumer supplies a
 * catalog + a `deps` factory, then dispatches `install` / `doctor` and projects
 * the agent + HTTP surfaces — all from one registry. The `deps` here are fakes
 * that *record* effects instead of performing them, so the example asserts that
 * effects flow only through the injected capability slice and never escape it.
 *
 * Run:  bun examples/consumer-smoke.ts   (exits non-zero on any failure)
 */
import { installRegistry, type Component, type InstallDeps } from "@bounded-systems/installer";
import { dispatch, toMcpToolset, toOpenApiPaths } from "@bounded-systems/verbspec";

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log("   got :", JSON.stringify(got));
    console.log("   want:", JSON.stringify(want));
  }
}

// A fake capability slice — records effects instead of performing them. No
// filesystem, no subprocess, no env: the installer only ever talks to InstallDeps.
function fakeDeps(): { deps: InstallDeps; writes: string[]; runs: string[] } {
  const writes: string[] = [];
  const runs: string[] = [];
  const present = new Set<string>();
  return {
    writes,
    runs,
    deps: {
      fs: {
        exists: async (p) => present.has(p),
        writeFile: async (p) => {
          writes.push(p);
          present.add(p);
        },
      },
      proc: {
        run: async (cmd, args) => {
          runs.push([cmd, ...args].join(" "));
          return { code: 0, stderr: "" };
        },
      },
      host: { platform: () => "linux", arch: () => "arm64" },
      env: { get: () => undefined },
    },
  };
}

// alpha: never satisfied (installs). beta: satisfied (skips unless --force).
const catalog = (): Component[] => [
  {
    id: "alpha",
    probe: async () => false,
    apply: async (d) => {
      await d.fs.writeFile("/etc/alpha.conf", "x");
    },
  },
  {
    id: "beta",
    probe: async () => true,
    apply: async (d) => {
      await d.proc.run("provision-beta", []);
    },
  },
];

// 1. install: alpha installs (effect fires), beta skips (no effect).
{
  const f = fakeDeps();
  const r = await dispatch(installRegistry({ catalog: catalog(), deps: () => f.deps }), ["install"]);
  const out = (r as { output: { results: unknown } }).output;
  eq("install — statuses", out.results, [
    { id: "alpha", status: "installed" },
    { id: "beta", status: "skipped", detail: "already satisfied" },
  ]);
  eq("install — alpha effect through deps.fs", f.writes, ["/etc/alpha.conf"]);
  eq("install — beta skipped, no proc effect", f.runs, []);
}

// 2. dry-run: plans, performs nothing.
{
  const f = fakeDeps();
  const r = await dispatch(
    installRegistry({ catalog: catalog(), deps: () => f.deps }),
    ["install", "--dry-run"],
  );
  const out = (r as { output: { dryRun: boolean; results: { status: string }[] } }).output;
  eq("dry-run — flag honored", out.dryRun, true);
  eq("dry-run — statuses planned/skipped", out.results.map((x) => x.status), ["planned", "skipped"]);
  eq("dry-run — zero effects", [f.writes.length, f.runs.length], [0, 0]);
}

// 3. --force re-applies a satisfied component.
{
  const f = fakeDeps();
  const r = await dispatch(
    installRegistry({ catalog: catalog(), deps: () => f.deps }),
    ["install", "beta", "--force"],
  );
  const out = (r as { output: { results: unknown } }).output;
  eq("force — beta installed", out.results, [{ id: "beta", status: "installed" }]);
  eq("force — beta proc effect fired", f.runs, ["provision-beta"]);
}

// 4. a throwing apply is captured, not thrown.
{
  const f = fakeDeps();
  const boom: Component[] = [
    {
      id: "boom",
      probe: async () => false,
      apply: async () => {
        throw new Error("disk full");
      },
    },
  ];
  const r = await dispatch(installRegistry({ catalog: boom, deps: () => f.deps }), ["install"]);
  const out = (r as { output: { results: unknown } }).output;
  eq("failure — captured as failed+detail", out.results, [
    { id: "boom", status: "failed", detail: "disk full" },
  ]);
}

// 5. doctor: read-only health, no effects.
{
  const f = fakeDeps();
  const r = await dispatch(installRegistry({ catalog: catalog(), deps: () => f.deps }), ["doctor"]);
  const out = (r as { output: { ok: boolean; checks: unknown } }).output;
  eq("doctor — ok=false (alpha unsatisfied)", out.ok, false);
  eq("doctor — per-component checks", out.checks, [
    { id: "alpha", satisfied: false },
    { id: "beta", satisfied: true },
  ]);
  eq("doctor — read-only, no effects", [f.writes.length, f.runs.length], [0, 0]);
}

// 6. agent + HTTP surfaces project from the same registry.
{
  const reg = installRegistry({ catalog: catalog(), deps: () => fakeDeps().deps });
  eq("MCP toolset names", toMcpToolset(reg).map((t) => t.name).sort(), ["doctor", "install"]);
  eq("OpenAPI paths", Object.keys(toOpenApiPaths(reg)).sort(), ["/doctor", "/install"]);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
