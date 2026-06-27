/**
 * Consumer smoke test / executable usage example.
 *
 * Runs the README's usage shape end-to-end with FAKE seams (matching the real
 * @bounded-systems/{fs,proc,host,env} contracts) that record effects instead of
 * performing them. The filesystem seam is read+remove only, so installs run
 * COMMANDS through `proc` — the fake's `mkdir` mutates an in-memory fs and the
 * assertions check that state, never raw effects on the host.
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

// Fake seams mirroring the real contracts. `present` is the in-memory fs;
// `mkdir` (run via proc) is the only mutation; `git --version` is a read.
function fakeSeams(): { deps: InstallDeps; present: Set<string>; runs: string[] } {
  const present = new Set<string>();
  const runs: string[] = [];
  return {
    present,
    runs,
    deps: {
      fs: {
        statPath: (p) =>
          present.has(p)
            ? { sizeBytes: 0, mtimeMs: 0, isFile: false, isDirectory: true }
            : null,
        removeFile: (p) => {
          present.delete(p);
        },
      },
      proc: {
        run: (cmd) => {
          runs.push(cmd.join(" "));
          if (cmd[0] === "mkdir") present.add(cmd[cmd.length - 1] ?? "");
          if (cmd[0] === "git") return { stdout: "git version 2.x", stderr: "", status: 0 };
          return { stdout: "", stderr: "", status: 0 };
        },
      },
      host: { homeDir: () => "/home/test", hostName: () => "testhost" },
      env: { get: () => undefined },
    },
  };
}

const DIR = "/home/test/.local/state/demo";

// state-dir: created by `mkdir -p` via proc (the fs seam can't write).
// git: read-only presence check; apply can't install it.
const catalog = (): Component[] => [
  {
    id: "state-dir",
    probe: (d) => d.fs.statPath(`${d.host.homeDir()}/.local/state/demo`)?.isDirectory === true,
    apply: (d) => {
      const r = d.proc.run(["mkdir", "-p", `${d.host.homeDir()}/.local/state/demo`]);
      if (r.status !== 0) throw new Error(r.stderr || "mkdir failed");
    },
  },
  {
    id: "git",
    probe: (d) => d.proc.run(["git", "--version"]).status === 0,
    apply: () => {
      throw new Error("install git via your system package manager");
    },
  },
];

// 1. install: state-dir created via proc mkdir, git already present → skipped.
{
  const f = fakeSeams();
  const r = await dispatch(installRegistry({ catalog: catalog(), deps: () => f.deps }), ["install"]);
  const out = (r as { output: { results: unknown } }).output;
  eq("install — statuses", out.results, [
    { id: "state-dir", status: "installed" },
    { id: "git", status: "skipped", detail: "already satisfied" },
  ]);
  eq("install — effect ran via proc mkdir", f.runs.includes(`mkdir -p ${DIR}`), true);
  eq("install — dir now exists in the fake fs", f.present.has(DIR), true);
}

// 2. dry-run: plans, runs no mutation (probes may still read via proc/fs).
{
  const f = fakeSeams();
  const r = await dispatch(
    installRegistry({ catalog: catalog(), deps: () => f.deps }),
    ["install", "--dry-run"],
  );
  const out = (r as { output: { dryRun: boolean; results: { status: string }[] } }).output;
  eq("dry-run — flag honored", out.dryRun, true);
  eq("dry-run — statuses planned/skipped", out.results.map((x) => x.status), ["planned", "skipped"]);
  eq("dry-run — no mkdir mutation", f.runs.some((c) => c.startsWith("mkdir")), false);
  eq("dry-run — dir not created", f.present.has(DIR), false);
}

// 3. --force re-applies a satisfied component.
{
  const f = fakeSeams();
  const r = await dispatch(
    installRegistry({ catalog: catalog(), deps: () => f.deps }),
    ["install", "git", "--force"],
  );
  const out = (r as { output: { results: { id: string; status: string }[] } }).output;
  // git's apply throws ("can't install") → captured as failed, not thrown.
  eq("force — git apply fails honestly", out.results, [
    { id: "git", status: "failed", detail: "install git via your system package manager" },
  ]);
}

// 4. doctor: read-only health, creates nothing.
{
  const f = fakeSeams();
  const r = await dispatch(installRegistry({ catalog: catalog(), deps: () => f.deps }), ["doctor"]);
  const out = (r as { output: { ok: boolean; checks: unknown } }).output;
  eq("doctor — ok=false (state-dir absent)", out.ok, false);
  eq("doctor — per-component checks", out.checks, [
    { id: "state-dir", satisfied: false },
    { id: "git", satisfied: true },
  ]);
  eq("doctor — no dir created", f.present.has(DIR), false);
}

// 5. agent + HTTP surfaces project from the same registry.
{
  const reg = installRegistry({ catalog: catalog(), deps: () => fakeSeams().deps });
  eq("MCP toolset names", toMcpToolset(reg).map((t) => t.name).sort(), ["doctor", "install"]);
  eq("OpenAPI paths", Object.keys(toOpenApiPaths(reg)).sort(), ["/doctor", "/install"]);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
