import { test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSeam } from "@bounded-systems/seam-check";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// installer is a leaf: its only outward edges are zod and verbspec. It owns the
// install/doctor *interface* and performs no effects — every effect is a call
// through the injected InstallDeps slice, supplied by the consumer. The harness
// proves that edge set and that it holds no ambient authority (the comment's
// "must not" turned into an enforced check the old import-only test lacked).
test("@bounded-systems/installer upholds its seam claim", () => {
  assertSeam({
    root: SRC,
    prod: ["zod", "@bounded-systems/verbspec"],
    test: ["@bounded-systems/installer", "@bounded-systems/seam-check", "node:fs"],
  });
});
