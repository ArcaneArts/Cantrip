import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(manager.snapshot("missing-terminal", 100)).toEqual({
      terminalId: "missing-terminal",
      status: "not-running",
      data: "",
      truncated: false,
      exitCode: null,
    });
    let output = "";
    const events: string[] = [];
    const exited = manager.open(
      "terminal-1",
      "attachment-1",
      directory,
      80,
      24,
      { type: "shell" },
      (event) => {
        events.push(event.type);
        if (event.type === "terminal.output") output += event.data;
      },
    );

    expect(events[0]).toBe("terminal.ready");
    manager.input(
      "terminal-1",
      process.platform === "win32"
        ? "echo CANTRIP_PTY_OK\r"
        : "printf 'CANTRIP_PTY_OK\\n'\r",
    );
    await expect
      .poll(() => output, { timeout: 5_000 })
      .toContain("CANTRIP_PTY_OK");
    expect(manager.snapshot("terminal-1", 8)).toMatchObject({
      terminalId: "terminal-1",
      status: "running",
      truncated: true,
    });
    expect(manager.snapshot("terminal-1", 100_000).data).toContain(
      "CANTRIP_PTY_OK",
    );
    manager.input("terminal-1", "exit\r");

    await expect(exited).resolves.toMatchObject({
      status: "exited",
      exitCode: 0,
    });
    expect(manager.snapshot("terminal-1", 100)).toMatchObject({
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
      { type: "shell" },
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

  it.skipIf(process.platform === "win32")(
    "keeps a configured service running without an attached viewer",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "cantrip-service-"));
      directories.push(directory);
      const manager = new TerminalManager({ serviceRestartDelayMs: 50 });
      manager.reconcileServices([
        {
          terminalId: "terminal-service",
          cwd: directory,
          command: "printf 'SERVICE_TICK\\n'; exit 7",
        },
      ]);

      let output = "";
      const exited = manager.open(
        "terminal-service",
        "attachment-service",
        directory,
        80,
        24,
        { type: "shell" },
        (event) => {
          if (event.type === "terminal.output") output += event.data;
        },
      );

      await expect
        .poll(() => output.match(/SERVICE_TICK/gu)?.length ?? 0, {
          timeout: 5_000,
        })
        .toBeGreaterThanOrEqual(2);
      manager.close("terminal-service");
      await expect(exited).resolves.toMatchObject({ status: "exited" });
      const stoppedOutput = output;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(output).toBe(stoppedOutput);
      manager.closeAll();
    },
  );

  it.skipIf(process.platform === "win32")(
    "restarts an active service immediately on request",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-service-restart-"),
      );
      directories.push(directory);
      const manager = new TerminalManager({ serviceRestartDelayMs: 5_000 });
      manager.reconcileServices([
        {
          terminalId: "terminal-service",
          cwd: directory,
          command: "printf 'SERVICE_RUNNING\\n'; while :; do sleep 1; done",
        },
      ]);

      let output = "";
      const exited = manager.open(
        "terminal-service",
        "attachment-service",
        directory,
        80,
        24,
        { type: "shell" },
        (event) => {
          if (event.type === "terminal.output") output += event.data;
        },
      );
      await expect
        .poll(() => output.match(/SERVICE_RUNNING/gu)?.length ?? 0, {
          timeout: 5_000,
        })
        .toBe(1);

      manager.restartService("terminal-service");
      await expect
        .poll(() => output.match(/SERVICE_RUNNING/gu)?.length ?? 0, {
          timeout: 5_000,
        })
        .toBeGreaterThanOrEqual(2);
      manager.reconcileServices([]);
      await expect(exited).resolves.toMatchObject({ status: "exited" });
      manager.closeAll();
    },
  );

  it.skipIf(process.platform === "win32")(
    "launches a linked Codex terminal with the chat runtime and thread",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "cantrip-codex-"));
      directories.push(directory);
      const fakeCodex = path.join(directory, "fake-codex");
      const codexHome = path.join(directory, "codex-home");
      await writeFile(
        fakeCodex,
        [
          "#!/bin/sh",
          "printf 'ARGS:%s\\n' \"$*\"",
          "printf 'CODEX_HOME:%s\\n' \"$CODEX_HOME\"",
          "printf 'API_KEY:%s\\n' \"$CANTRIP_PROVIDER_API_KEY\"",
        ].join("\n"),
      );
      await chmod(fakeCodex, 0o755);

      const manager = new TerminalManager();
      let output = "";
      const exited = manager.open(
        "terminal-codex",
        "attachment-codex",
        directory,
        120,
        40,
        {
          type: "codex",
          binary: fakeCodex,
          codexHome,
          remoteUrl: "ws://127.0.0.1:4500",
          threadId: "019fdc2c-e848-7552-b2ea-6fc7ef09e9f2",
          model: {
            id: "model-1",
            name: "openai/gpt-5.6-sol",
            reasoningEffort: "high",
          },
          provider: {
            id: "provider-1",
            name: "OpenRouter",
            kind: "openai-compatible",
            baseUrl: "https://openrouter.ai/api/v1/chat/completions",
            apiKey: "test-key",
          },
        },
        (event) => {
          if (event.type === "terminal.output") output += event.data;
        },
      );

      await expect(exited).resolves.toMatchObject({
        status: "exited",
        exitCode: 0,
      });
      expect(output).toContain("resume 019fdc2c-e848-7552-b2ea-6fc7ef09e9f2");
      expect(output).toContain("--remote ws://127.0.0.1:4500");
      expect(output).toContain('model="openai/gpt-5.6-sol"');
      expect(output).toContain(
        'model_providers.cantrip_runtime.base_url="https://openrouter.ai/api/v1"',
      );
      expect(output).toContain(`CODEX_HOME:${codexHome}`);
      expect(output).toContain("API_KEY:test-key");
      manager.closeAll();
    },
  );
});
