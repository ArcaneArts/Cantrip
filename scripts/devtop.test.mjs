import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectProcessTreePids,
  findLegacyDevtopRootPids,
  forceKillSpawnedProcessGroup,
  forceKillUnixProcessTree,
  parsePidList,
  parseUnixProcessTable,
} from "./devtop-processes.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("devtop is launched through the hard-stop lifecycle wrapper", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.scripts?.devtop, "node scripts/devtop.mjs");

  const launcher = await readFile(
    path.join(repositoryRoot, "scripts", "devtop.mjs"),
    "utf8",
  );
  assert.match(launcher, /"--kill-signal",\s*\n\s*"SIGKILL"/u);
  assert.match(launcher, /forceKillDevelopmentPortListeners\(\)/u);
  assert.match(launcher, /forceKillSpawnedProcessGroup\(activeChild\.pid\)/u);
});

test("process table parsing and tree collection include all descendants", () => {
  const processes = parseUnixProcessTable(`
    100 1 node concurrently --names protocol,server,worker,desktop
    101 100 pnpm server
    102 100 pnpm worker
    103 101 node server.js
  `);
  assert.deepEqual(
    collectProcessTreePids(100, processes),
    [100, 102, 101, 103],
  );
});

test("legacy cleanup selects devtop roots across worktrees", () => {
  const processes = [
    {
      pid: 10,
      ppid: 1,
      command:
        "node /workspace/Cantrip/node_modules/concurrently --names protocol,server,worker,desktop",
    },
    {
      pid: 20,
      ppid: 1,
      command:
        "node /other/Cantrip/node_modules/concurrently --names protocol,server,worker,desktop",
    },
    {
      pid: 30,
      ppid: 1,
      command:
        "node /workspace/Cantrip/node_modules/concurrently --names server,app",
    },
  ];
  assert.deepEqual(findLegacyDevtopRootPids(processes), [10, 20]);
});

test("legacy cleanup recognizes an orphaned Tauri development binary", () => {
  const processes = [
    { pid: 10, ppid: 1, command: "target/debug/cantrip-app" },
    {
      pid: 20,
      ppid: 1,
      command: "/Applications/Cantrip.app/Contents/MacOS/cantrip-app",
    },
  ];
  assert.deepEqual(findLegacyDevtopRootPids(processes), [10]);
});

test("hard process-tree cleanup sends SIGKILL without a graceful signal", () => {
  const processes = [
    { pid: 100, ppid: 1, command: "parent" },
    { pid: 101, ppid: 100, command: "child" },
    { pid: 102, ppid: 101, command: "grandchild" },
  ];
  const kills = [];
  forceKillUnixProcessTree(100, processes, (pid, signal) => {
    kills.push([pid, signal]);
  });
  assert.deepEqual(kills, [
    [100, "SIGKILL"],
    [101, "SIGKILL"],
    [102, "SIGKILL"],
  ]);
});

test("Ctrl+C cleanup kills the complete detached process group", () => {
  const kills = [];
  forceKillSpawnedProcessGroup(100, "darwin", (pid, signal) => {
    kills.push([pid, signal]);
  });
  assert.deepEqual(kills, [[-100, "SIGKILL"]]);
});

test("listener pid parsing deduplicates numeric output", () => {
  assert.deepEqual(parsePidList("42\n99\n42\nnot-a-pid\n"), [42, 99]);
});
