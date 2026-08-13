import assert from "node:assert/strict";
import test from "node:test";

import { pnpmCommand } from "./pnpm-command.mjs";

test("runs the active pnpm JavaScript CLI directly on Windows", () => {
  assert.deepEqual(
    pnpmCommand(["--filter", "@cantrip/server", "build"], {
      environment: { npm_execpath: "C:\\pnpm\\pnpm.cjs" },
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    }),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      arguments: ["C:\\pnpm\\pnpm.cjs", "--filter", "@cantrip/server", "build"],
    },
  );
});

test("uses the PATH command outside a pnpm lifecycle on Unix", () => {
  assert.deepEqual(
    pnpmCommand(["test"], { environment: {}, platform: "linux" }),
    { command: "pnpm", arguments: ["test"] },
  );
});

test("fails clearly when a direct Windows invocation cannot resolve pnpm", () => {
  assert.throws(
    () => pnpmCommand(["test"], { environment: {}, platform: "win32" }),
    /Run this operation through a repository pnpm script/u,
  );
});
