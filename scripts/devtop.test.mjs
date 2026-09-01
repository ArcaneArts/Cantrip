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
  resolveRepositoryCommonDirectory,
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
  assert.match(launcher, /resolveRepositoryCommonDirectory\(repositoryRoot\)/u);
  assert.match(
    launcher,
    /forceKillDevelopmentPortListeners\(undefined, undefined, repositoryRoot\)/u,
  );
  assert.match(launcher, /forceKillSpawnedProcessGroup\(activeChild\.pid\)/u);
  assert.match(launcher, /parseDevtopProfileArguments\(\)/u);
  assert.match(
    launcher,
    /await ensureDevtopTauriConfig\(\{\s*profileName: developmentProfile,\s*repositoryCommonDirectory,\s*repositoryRoot,/u,
  );
  assert.match(launcher, /tauri dev --config \$\{tauriConfigPath\}/u);
  assert.match(launcher, /CARGO_TARGET_DIR=\$\{tauriTargetDirectory\}/u);
  assert.match(launcher, /CANTRIP_DEVELOPMENT_KEY_VAULT=1/u);
  assert.match(launcher, /VITE_CANTRIP_DISABLE_LEGACY_WEBCRYPTO=true/u);
  assert.match(launcher, /CANTRIP_DATA_DIR=\$\{packageStateDirectory\}/u);
  assert.match(
    launcher,
    /CANTRIP_WORKER_DATA_DIR=\$\{packageStateDirectory\}\/worker/u,
  );
  assert.match(
    launcher,
    /CANTRIP_LOCAL_ONLY=true VITE_CANTRIP_LOCAL_ONLY=true/u,
  );
  assert.ok(
    launcher.indexOf(
      "const developmentIdentity = await ensureDevtopTauriConfig",
    ) < launcher.indexOf("await forceKillRecordedDevtop"),
    "validate the worktree identity before stopping the active devtop",
  );
  const processLifecycle = await readFile(
    path.join(repositoryRoot, "scripts", "devtop-processes.mjs"),
    "utf8",
  );
  assert.match(
    processLifecycle,
    /if \(wrapper\) forceKillProcessTree\(wrapper\.pid\);\s*if \(child\) forceKillSpawnedProcessGroup\(child\.pid\);/u,
  );
  assert.match(
    processLifecycle,
    /await waitForIdentitiesToExit\(identities\)/u,
  );
  const commonDirectory = resolveRepositoryCommonDirectory(repositoryRoot);
  assert.equal(path.basename(commonDirectory), ".git");
  assert.equal(path.isAbsolute(commonDirectory), true);
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
        "node /workspace/Cantrip/node_modules/concurrently --names glitch,protocol,server,worker,desktop",
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
      pid: 11,
      ppid: 1,
      command: "/workspace/Cantrip/.cantrip/dev/tauri/target/debug/cantrip-app",
    },
    {
      pid: 20,
      ppid: 1,
      command: "/Applications/Cantrip.app/Contents/MacOS/cantrip-app",
    },
  ];
  assert.deepEqual(findLegacyDevtopRootPids(processes), [10, 11]);
});

test("legacy cleanup recognizes orphaned service watchers in Cantrip worktrees", () => {
  const roots = ["/workspace/Cantrip", "/private/tmp/cantrip-cycle"];
  const processes = [
    {
      pid: 10,
      ppid: 1,
      command: "node tsx watch src/index.ts",
      cwd: "/workspace/Cantrip/cantrip_worker",
    },
    {
      pid: 11,
      ppid: 10,
      command: "node --import tsx src/index.ts",
      cwd: "/workspace/Cantrip/cantrip_worker",
    },
    {
      pid: 20,
      ppid: 1,
      command: "node node_modules/tsx/dist/cli.mjs watch src/index.ts",
      cwd: "/private/tmp/cantrip-cycle/cantrip_server",
    },
    {
      pid: 30,
      ppid: 1,
      command: "node tsx watch src/index.ts",
      cwd: "/workspace/AnotherProject/cantrip_worker",
    },
    {
      pid: 40,
      ppid: 1,
      command: "node tsc -p tsconfig.json --watch --preserveWatchOutput",
      cwd: "/private/tmp/cantrip-cycle/packages/glitch",
    },
  ];
  assert.deepEqual(findLegacyDevtopRootPids(processes, roots), [10, 20, 40]);
});

test("legacy cleanup collapses nested Cantrip launchers to the owning root", () => {
  const processes = [
    {
      pid: 10,
      ppid: 1,
      command: "node concurrently --names protocol,server,worker,desktop",
    },
    {
      pid: 11,
      ppid: 10,
      command: "pnpm --filter @cantrip/worker dev",
    },
    {
      pid: 12,
      ppid: 11,
      command: "node tsx watch src/index.ts",
      cwd: "/workspace/Cantrip/cantrip_worker",
    },
  ];
  assert.deepEqual(
    findLegacyDevtopRootPids(processes, ["/workspace/Cantrip"]),
    [10],
  );
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
