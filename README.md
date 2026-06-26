# @bounded-systems/installer

Spec-driven provisioning — author `install` / `doctor` once, project them
everywhere, perform effects only through capability seams.

The installer is a set of [VerbSpec](https://jsr.io/@bounded-systems/verbspec)
verbs. The verb's input and output are Zod schemas, and every surface — the CLI
and `--help`, the MCP tool, the Anthropic tool-use schema, the OpenAPI
operation, the NDJSON daemon method — is a pure projection of the one spec, so
they can't drift. Humans and agents provision through the same governed verb.

```
install / doctor  (VerbSpec — one definition)
  └─ verbspec projections ──▶ CLI · MCP tool · Anthropic tool · OpenAPI · NDJSON
  run(input, deps) ──▶ effects ONLY through the injected InstallDeps slice
                          (fs · proc · host · env capability seams)
```

## Why its own package

This is the one surface that must run **before** the rest of the stack exists —
it bootstraps the host. So it cannot live behind the thing it provisions. It is
a **leaf**: its only dependencies are `zod` and `@bounded-systems/verbspec`. It
holds **no ambient authority** — it performs no filesystem, subprocess, or env
access itself. Every effect is a call through the `InstallDeps` slice the
*consumer* supplies. An `extractability` test enforces the leaf boundary in CI.

- **prx** wires its in-monorepo `@bounded-systems/{fs,proc,host,env}` seams.
- A standalone `bounded` binary wires the *published* seams.
- Tests pass fakes (see `src/__tests__/index.test.ts`).

## Install

```sh
npm install @bounded-systems/installer @bounded-systems/verbspec zod
```

Both `@bounded-systems/verbspec` and `zod` are peer dependencies.

## Usage

The consumer supplies a **catalog** (what can be provisioned) and a **deps**
factory (the real capability seams). The package projects the verbs.

```ts
import { installRegistry, type Component } from "@bounded-systems/installer";
import { dispatch, toMcpToolset } from "@bounded-systems/verbspec";

const catalog: Component[] = [
  {
    id: "ssh-key",
    probe: async (d) => d.fs.exists("/home/agent/.ssh/id_ed25519"),
    apply: async (d) => d.proc.run("ssh-keygen", ["-t", "ed25519", "-N", ""]).then(() => {}),
  },
];

// Wire the REAL seams here (in prx: the @bounded-systems/* capability libs).
const deps = () => ({ fs: realFs, proc: realProc, host: realHost, env: realEnv });

const registry = installRegistry({ catalog, deps });

// CLI: argv → validated input → run → printed report
await dispatch(registry, ["install", "ssh-key", "--dry-run"]);

// agent surface: the same verbs as MCP tools
toMcpToolset(registry); // → [{ name: "install", ... }, { name: "doctor", ... }]
```

`install` performs effects (each through `deps`); `doctor` is the same probes,
read-only. Both carry a `--help`, an MCP/Anthropic tool schema, and an OpenAPI
operation for free.

## The one rule: the catalog is the consumer's

This package owns the install *interface*, not the *list of what gets
installed*. The catalog lives with the consumer (prx) so there is a single
source of truth for provisioning steps. If you mirror a catalog here, add a
**contract test in the consumer** that fails CI when its real provisioning
diverges from the catalog — the same "specs execute against the engine, docs
fail CI on drift" bar the rest of Bounded Systems holds itself to. Don't let the
installer become a second, silently-drifting description of the system.

## Status

`0.1.0` — the interface and its projections are complete and unit-tested
against fake seams. It has **no production consumer yet**: no real catalog and
no real `deps()` are wired in this repo (that is the consumer's job). Graded
honestly: the *projection* is **Enforced**, a *running end-to-end install* is
**Aspirational** until a consumer wires real seams.

## License

[MIT](./LICENSE) © Bounded Systems
