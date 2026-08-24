import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  main,
  repositoryRoot,
  validationSteps,
} from "./verify-run-configurations.mjs";

test("Run configuration verification owns a labeled cross-package matrix", async () => {
  assert.deepEqual(
    validationSteps.map(({ label }) => label),
    [
      "Build shared Run contracts",
      "Protocol contracts",
      "Server authoring, lifecycle, CLI, and MCP",
      "Server active-worktree cleanup",
      "Worker providers, process ownership, environment, and security",
      "App controls, editor, terminal, and responsive surfaces",
      "CLI contract",
      "Legacy cutover audit",
    ],
  );
  assert.equal(new Set(validationSteps.map(({ label }) => label)).size, 8);
  assert.ok(validationSteps.every(({ inputs }) => inputs.length > 0));
  await Promise.all(
    validationSteps.flatMap(({ inputs }) =>
      inputs.map((path) => access(resolve(repositoryRoot, path))),
    ),
  );
});

test("Run configuration verification list mode is side-effect free", async () => {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (value) => {
    writes.push(String(value));
    return true;
  };
  try {
    await main(["--list"]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(
    writes.join(""),
    `${validationSteps.map(({ label }) => label).join("\n")}\n`,
  );
});

test("Run configuration verification rejects unknown arguments", async () => {
  await assert.rejects(main(["--unknown"]), /Unknown argument: --unknown/u);
});
