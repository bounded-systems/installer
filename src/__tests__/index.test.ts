import { describe, expect, test } from "bun:test";
import { dispatch, toMcpToolset } from "@bounded-systems/verbspec";

import {
  installRegistry,
  type Component,
  type InstallDeps,
  type InstallOutput,
  type DoctorOutput,
} from "@bounded-systems/installer";

// Fake seams mirroring the real @bounded-systems/{fs,proc,host,env} contracts.
// The fs seam is read+remove only, so installs run commands through proc; the
// fake's `mkdir` mutates an in-memory fs and tests assert on that state.
function fakeSeams(): { deps: InstallDeps; present: Set<string>; runs: string[] } {
  const present = new Set<string>();
  const runs: string[] = [];
  return {
    present,
    runs,
    deps: {
      fs: {
        statPath: (p) =>
          present.has(p) ? { sizeBytes: 0, mtimeMs: 0, isFile: false, isDirectory: true } : null,
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

// state-dir: created by `mkdir -p` via proc. git: read-only presence check.
function catalog(): Component[] {
  return [
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
}

describe("install verb", () => {
  test("installs unsatisfied via proc, skips satisfied", async () => {
    const f = fakeSeams();
    const reg = installRegistry({ catalog: catalog(), deps: () => f.deps });
    const res = await dispatch(reg, ["install"]);
    expect(res.kind).toBe("ok");
    const out = (res as { output: InstallOutput }).output;
    expect(out.results).toEqual([
      { id: "state-dir", status: "installed" },
      { id: "git", status: "skipped", detail: "already satisfied" },
    ]);
    expect(f.runs).toContain(`mkdir -p ${DIR}`); // effect ran through the proc seam
    expect(f.present.has(DIR)).toBe(true);
  });

  test("--dry-run plans without mutating", async () => {
    const f = fakeSeams();
    const reg = installRegistry({ catalog: catalog(), deps: () => f.deps });
    const res = await dispatch(reg, ["install", "--dry-run"]);
    const out = (res as { output: InstallOutput }).output;
    expect(out.dryRun).toBe(true);
    expect(out.results.map((r) => r.status)).toEqual(["planned", "skipped"]);
    expect(f.runs.some((c) => c.startsWith("mkdir"))).toBe(false); // no mutation
    expect(f.present.has(DIR)).toBe(false);
  });

  test("a failing apply is captured, not thrown", async () => {
    const f = fakeSeams();
    const reg = installRegistry({ catalog: catalog(), deps: () => f.deps });
    const res = await dispatch(reg, ["install", "git", "--force"]);
    const out = (res as { output: InstallOutput }).output;
    expect(out.results).toEqual([
      { id: "git", status: "failed", detail: "install git via your system package manager" },
    ]);
  });
});

describe("doctor verb", () => {
  test("reports per-component satisfaction, read-only", async () => {
    const f = fakeSeams();
    const reg = installRegistry({ catalog: catalog(), deps: () => f.deps });
    const res = await dispatch(reg, ["doctor"]);
    const out = (res as { output: DoctorOutput }).output;
    expect(out.ok).toBe(false);
    expect(out.checks).toEqual([
      { id: "state-dir", satisfied: false },
      { id: "git", satisfied: true },
    ]);
    expect(f.present.has(DIR)).toBe(false); // doctor creates nothing
  });
});

describe("surface projection", () => {
  test("the registry projects to an MCP toolset", () => {
    const f = fakeSeams();
    const tools = toMcpToolset(installRegistry({ catalog: catalog(), deps: () => f.deps }));
    expect(tools.map((t) => t.name).sort()).toEqual(["doctor", "install"]);
    for (const t of tools) expect(t.inputSchema).toBeDefined();
  });
});
