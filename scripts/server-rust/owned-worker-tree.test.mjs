import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { link, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { killOwnedWorkerTree } from "./owned-worker-tree.mjs";

const execute = promisify(execFile);

test("termination includes reparented tool daemons and leaves foreign groups alive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-owned-tree-"));
  const executable = path.join(root, "owned-node");
  await link(process.execPath, executable);
  const keepAlive = "setInterval(() => {}, 1000)";
  const foreign = spawn(process.execPath, ["-e", keepAlive], {
    detached: true,
    stdio: "ignore",
  });
  const intermediate = `
    const { spawn } = require("node:child_process");
    const daemon = spawn(process.argv[1], ["-e", ${JSON.stringify(keepAlive)}], {
      detached: true, stdio: "ignore"
    });
    daemon.unref();
    process.stdout.write(String(daemon.pid));
  `;
  const supervisor = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(intermediate)}, process.argv[1]]);
    let pid = "";
    child.stdout.on("data", data => pid += data);
    child.on("close", () => process.stdout.write(pid + "\\n"));
    setInterval(() => {}, 1000);
  `;
  const worker = spawn(process.execPath, ["-e", supervisor, executable], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let daemon;
  try {
    const [data] = await once(worker.stdout, "data");
    daemon = Number(data.toString().trim());
    assert.ok(Number.isSafeInteger(daemon) && daemon > 0);
    const { stdout } = await execute("ps", [
      "-p",
      String(daemon),
      "-o",
      "ppid=",
    ]);
    assert.equal(
      Number(stdout.trim()),
      1,
      "The helper has already been reparented",
    );
    const killed = await killOwnedWorkerTree(worker, {
      executableRoots: [path.join(root, "already-removed"), root],
    });
    assert.ok(killed.processes.some((entry) => entry.pid === worker.pid));
    assert.ok(killed.processes.some((entry) => entry.pid === daemon));
    assert.ok(killed.groups.includes(daemon));
    assert.equal(worker.signalCode, "SIGKILL");
    process.kill(foreign.pid, 0);
    assert.equal(
      killed.processes.some((entry) => entry.pid === foreign.pid),
      false,
    );
  } finally {
    for (const child of [worker, foreign]) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        process.kill(-child.pid, "SIGKILL");
        await closed;
      }
    }
    if (daemon) {
      try {
        process.kill(daemon, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await rm(root, { recursive: true });
  }
});

test("a scoped executable does not confer ownership of its foreign supervisor group", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-shared-owned-tree-"));
  const executable = path.join(root, "owned-node");
  await link(process.execPath, executable);
  const keepAlive = "setInterval(() => {}, 1000)";
  const supervisor = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.argv[1], ["-e", ${JSON.stringify(keepAlive)}], { stdio: "ignore" });
    process.stdout.write(String(child.pid) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const foreign = spawn(process.execPath, ["-e", supervisor, executable], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const worker = spawn(process.execPath, ["-e", keepAlive], {
    detached: true,
    stdio: "ignore",
  });
  try {
    const [data] = await once(foreign.stdout, "data");
    const scopedPid = Number(data.toString().trim());
    const killed = await killOwnedWorkerTree(worker, {
      executableRoots: [root],
    });
    assert.ok(killed.processes.some((row) => row.pid === scopedPid));
    assert.ok(!killed.processes.some((row) => row.pid === foreign.pid));
    assert.ok(!killed.groups.includes(foreign.pid));
    process.kill(foreign.pid, 0);
  } finally {
    for (const child of [worker, foreign]) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        process.kill(-child.pid, "SIGKILL");
        await closed;
      }
    }
    await rm(root, { recursive: true });
  }
});
