import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { spawnGuardedProcess } from "../src/code/process-guard.js";

const temporaryDirectories: string[] = [];

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  inspect: () => Promise<T | null> | T | null,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await inspect();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for guarded process state.");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("spawnGuardedProcess", () => {
  it("preserves piped stdio for guarded RPC subprocesses", async () => {
    const guard = spawnGuardedProcess(
      process.execPath,
      [
        "--eval",
        "process.stdin.once('data', (data) => process.stdout.write(data.toString().toUpperCase()))",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdin: "pipe",
      },
    );
    guard.stderr.resume();
    const output = once(guard.stdout, "data");
    const exited = once(guard, "exit");
    guard.stdin.end("codex rpc");

    const [data] = await output;
    expect(String(data)).toBe("CODEX RPC");
    await exited;
  });

  it("terminates the complete subprocess tree when its owner dies", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-guard-"));
    temporaryDirectories.push(directory);
    const marker = path.join(directory, "processes.json");
    const owner = spawn(
      process.execPath,
      ["--eval", "setInterval(() => undefined, 1_000)"],
      { stdio: "ignore" },
    );
    if (!owner.pid) throw new Error("The process owner did not start.");

    const targetSource = String.raw`
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(
  process.execPath,
  ["--eval", "setInterval(() => undefined, 1_000)"],
  { stdio: "ignore" },
);
writeFileSync(
  process.argv[1],
  JSON.stringify({ pid: process.pid, grandchildPid: grandchild.pid }),
);
setInterval(() => undefined, 1_000);
`;
    const guard = spawnGuardedProcess(
      process.execPath,
      ["--eval", targetSource, marker],
      {
        cwd: directory,
        env: process.env,
        ownerPid: owner.pid,
      },
    );
    let targetPid: number | null = null;
    let grandchildPid: number | null = null;
    try {
      const processes = await waitFor(async () => {
        try {
          return JSON.parse(await readFile(marker, "utf8")) as {
            grandchildPid: number;
            pid: number;
          };
        } catch {
          return null;
        }
      });
      targetPid = processes.pid;
      grandchildPid = processes.grandchildPid;
      expect(processExists(targetPid)).toBe(true);
      expect(processExists(grandchildPid)).toBe(true);

      owner.kill("SIGKILL");
      await waitFor(() =>
        !processExists(processes.pid) && !processExists(processes.grandchildPid)
          ? true
          : null,
      );
      expect(processExists(processes.pid)).toBe(false);
      expect(processExists(processes.grandchildPid)).toBe(false);
    } finally {
      if (processExists(owner.pid)) owner.kill("SIGKILL");
      if (guard.pid && processExists(guard.pid)) guard.kill("SIGKILL");
      if (targetPid && processExists(targetPid)) {
        process.kill(targetPid, "SIGKILL");
      }
      if (grandchildPid && processExists(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
    }
  });
});
