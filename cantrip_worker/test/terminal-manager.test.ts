import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TerminalManager } from "../src/terminal-manager.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("TerminalManager", () => {
  it("runs an interactive shell in the requested source folder", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-terminal-"));
    directories.push(directory);
    const manager = new TerminalManager();
    let output = "";
    const exited = manager.open(
      "terminal-1",
      "attachment-1",
      directory,
      80,
      24,
      (event) => {
        if (event.type === "terminal.output") output += event.data;
      },
    );

    manager.input(
      "terminal-1",
      process.platform === "win32"
        ? "echo CANTRIP_PTY_OK\r"
        : "printf 'CANTRIP_PTY_OK\\n'\r",
    );
    await expect
      .poll(() => output, { timeout: 5_000 })
      .toContain("CANTRIP_PTY_OK");
    manager.input("terminal-1", "exit\r");

    await expect(exited).resolves.toMatchObject({
      status: "exited",
      exitCode: 0,
    });

    output = "";
    const restarted = manager.open(
      "terminal-1",
      "attachment-2",
      directory,
      80,
      24,
      (event) => {
        if (event.type === "terminal.output") output += event.data;
      },
    );
    manager.input(
      "terminal-1",
      process.platform === "win32"
        ? "echo CANTRIP_PTY_RESTARTED\r"
        : "printf 'CANTRIP_PTY_RESTARTED\\n'\r",
    );
    await expect
      .poll(() => output, { timeout: 5_000 })
      .toContain("CANTRIP_PTY_RESTARTED");
    manager.input("terminal-1", "exit\r");
    await expect(restarted).resolves.toMatchObject({ status: "exited" });
    manager.closeAll();
  });
});
