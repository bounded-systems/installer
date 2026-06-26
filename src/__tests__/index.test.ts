import { describe, expect, test } from "bun:test";
import { dispatch, toMcpToolset } from "@bounded-systems/verbspec";

import {
  installRegistry,
  type Component,
  type InstallDeps,
  type InstallOutput,
  type DoctorOutput,
} from "@bounded-systems/installer";

// A fake capability slice that records effects instead of performing them — the
// installer only ever talks to InstallDeps, so a test wires its own and asserts
// on what the verbs *tried* to do. No filesystem, no subprocess, no env.
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
        writeFile: async (p, _body) => {
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

// A two-component catalog: `alpha` is never satisfied (always installs),
// `beta` reports satisfied (always skips unless --force).
function catalog(): readonly Component[] {
  return [
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
}

describe("install verb", () => {
  test("installs unsatisfied, skips satisfied, performs effects through deps", async () => {
    const f = fakeDeps();
    const reg = installRegistry({ catalog: catalog(), deps: () => f.deps });
    const res = await dispatch(reg, ["install"]);
    expect(res.kind).toBe("ok");
    const out = (res as { output: InstallOutput }).output;
    expect(out.results).toEqual([
      { id: "alpha", status: "installed" },
      { id: "beta", status: "skipped", detail: "already satisfied" },
    ]);
    expect(f.writes).toEqual(["/etc/alpha.conf"]); // alpha's effect ran
    expect(f.runs).toEqual([]); // beta was skipped — no effect
  });

  test("--dry-run plans without performing effects", async () => {
    const f = fakeDeps();
    const reg = installRegistry({ catalog: catalog(), deps: () => f.deps });
    const res = await dispatch(reg, ["install", "--dry-run"]);
    const out = (res as { output: InstallOutput }).output;
    expect(out.dryRun).toBe(true);
    expect(out.results.map((r) => r.status)).toEqual(["planned", "skipped"]);
    expect(f.writes).toEqual([]); // nothing written in dry-run
  });

  test("--force re-applies a satisfied component", async () => {
    const f = fakeDeps();
    const reg = installRegistry({ catalog: catalog(), deps: () => f.deps });
    const res = await dispatch(reg, ["install", "beta", "--force"]);
    const out = (res as { output: InstallOutput }).output;
    expect(out.results).toEqual([{ id: "beta", status: "installed" }]);
    expect(f.runs).toEqual(["provision-beta"]);
  });

  test("a failing apply is captured, not thrown", async () => {
    const f = fakeDeps();
    const boom: Component = {
      id: "boom",
      probe: async () => false,
      apply: async () => {
        throw new Error("disk full");
      },
    };
    const reg = installRegistry({ catalog: [boom], deps: () => f.deps });
    const res = await dispatch(reg, ["install"]);
    const out = (res as { output: InstallOutput }).output;
    expect(out.results).toEqual([{ id: "boom", status: "failed", detail: "disk full" }]);
  });
});

describe("doctor verb", () => {
  test("reports per-component satisfaction, read-only", async () => {
    const f = fakeDeps();
    const reg = installRegistry({ catalog: catalog(), deps: () => f.deps });
    const res = await dispatch(reg, ["doctor"]);
    const out = (res as { output: DoctorOutput }).output;
    expect(out.ok).toBe(false);
    expect(out.checks).toEqual([
      { id: "alpha", satisfied: false },
      { id: "beta", satisfied: true },
    ]);
    expect(f.writes).toEqual([]); // doctor performs no effects
    expect(f.runs).toEqual([]);
  });
});

describe("surface projection", () => {
  test("the registry projects to an MCP toolset", () => {
    const f = fakeDeps();
    const tools = toMcpToolset(installRegistry({ catalog: catalog(), deps: () => f.deps }));
    expect(tools.map((t) => t.name).sort()).toEqual(["doctor", "install"]);
    for (const t of tools) expect(t.inputSchema).toBeDefined();
  });
});
