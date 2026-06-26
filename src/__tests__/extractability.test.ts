import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, "..");

// installer is a leaf: its only outward edges are `zod` and `verbspec`. It owns
// the install/doctor *interface* and performs no effects — every effect is a
// call through the injected InstallDeps slice, supplied by the consumer. Prod
// files may import only those two packages; tests may additionally import
// bun:test, the node builtins this test uses, and the module's own barrel. Any
// other edge means the installer has grown an upward dependency (e.g. onto a
// capability seam or prx) — which would make it un-extractable and would mean
// the package holds ambient authority it must not.
const PROD_ALLOWLIST = new Set<string>(["zod", "@bounded-systems/verbspec"]);
const TEST_ALLOWLIST = new Set<string>([
  ...PROD_ALLOWLIST,
  "bun:test",
  "node:fs",
  "node:path",
  "node:url",
  "@bounded-systems/installer",
]);

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function isRelative(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/");
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) if (m[1]) specs.push(m[1]);
  return specs;
}

describe("installer is a leaf (extractable, no ambient authority)", () => {
  const files = listTsFiles(MODULE_ROOT);

  test("there are source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const isTest = file.endsWith(".test.ts") || file.includes("__tests__");
    const allow = isTest ? TEST_ALLOWLIST : PROD_ALLOWLIST;
    test(`outward imports are allowlisted: ${file.slice(MODULE_ROOT.length + 1)}`, () => {
      for (const spec of importsOf(file)) {
        if (isRelative(spec)) continue; // intra-module edges are fine
        expect(allow.has(spec)).toBe(true);
      }
    });
  }
});
