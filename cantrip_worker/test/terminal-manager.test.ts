import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TerminalManager } from "../src/terminal-manager.js";
import { readWorkerLogs } from "../src/logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("TerminalManager", () => {
  it("replays buffered output before signaling that a reattached view is ready", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-terminal-"));
    directories.push(directory);
    const manager = new TerminalManager();
    let initialOutput = "";
    const initialAttachment = manager.open(
      "terminal-replay",
      "attachment-initial",
      directory,
      80,
      24,
      { type: "shell" },
      (event) => {
        if (event.type === "terminal.output") initialOutput += event.data;
      },
    );
    manager.input(
      "terminal-replay",
      process.platform === "win32"
        ? "echo CANTRIP_REPLAY_MARKER\r"
        : "printf 'CANTRIP_REPLAY_MARKER\\n'\r",
    );
    await expect
      .poll(() => initialOutput, { timeout: 5_000 })
      .toContain("CANTRIP_REPLAY_MARKER");
    manager.detach("terminal-replay", "attachment-initial");
    await expect(initialAttachment).resolves.toEqual({ status: "detached" });

    const replayEvents: Array<{ type: string; data?: string }> = [];
    const reattached = manager.attachExisting(
      "terminal-replay",
      "attachment-replay",
      (event) => replayEvents.push(event),
    );

    expect(replayEvents[0]).toMatchObject({
      type: "terminal.output",
      data: expect.stringContaining("CANTRIP_REPLAY_MARKER"),
    });
    expect(replayEvents[1]).toEqual({ type: "terminal.ready" });
    manager.detach("terminal-replay", "attachment-replay");
    await expect(reattached).resolves.toEqual({ status: "detached" });
    manager.close("terminal-replay");
  });

  it.skipIf(process.platform === "win32")(
    "preserves the live PTY dimensions while a terminal view reattaches",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "cantrip-terminal-"));
      directories.push(directory);
      const manager = new TerminalManager();
      const initialAttachment = manager.open(
        "terminal-dimensions",
        "attachment-initial",
        directory,
        80,
        24,
        { type: "shell" },
        () => undefined,
      );
      manager.resize("terminal-dimensions", 132, 43);
      manager.detach("terminal-dimensions", "attachment-initial");
      await expect(initialAttachment).resolves.toEqual({ status: "detached" });

      let output = "";
      const reattached = manager.attachExisting(
        "terminal-dimensions",
        "attachment-replay",
        (event) => {
          if (event.type === "terminal.output") output += event.data;
        },
      );
      manager.input(
        "terminal-dimensions",
        "printf 'CANTRIP_SIZE:'; stty size\r",
      );
      await expect
        .poll(() => output, { timeout: 5_000 })
        .toMatch(/CANTRIP_SIZE:\s*43 132/);

      manager.detach("terminal-dimensions", "attachment-replay");
      await expect(reattached).resolves.toEqual({ status: "detached" });
      manager.close("terminal-dimensions");
    },
  );

  it("runs an interactive shell in the requested source folder", async () => {
    const afterCursor = readWorkerLogs({
      afterCursor: 0,
      limit: 200,
      minimumLevel: "trace",
    }).latestCursor;
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-terminal-"));
    directories.push(directory);
    const manager = new TerminalManager({
      environmentForCwd: (cwd) =>
        cwd === directory ? { SETUP_TERMINAL_FIXTURE: "captured" } : {},
    });
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
        ? "echo CANTRIP_PTY_OK:$env:SETUP_TERMINAL_FIXTURE\r"
        : "printf 'CANTRIP_PTY_OK:%s\\n' \"$SETUP_TERMINAL_FIXTURE\"\r",
    );
    await expect
      .poll(() => output, { timeout: 5_000 })
      .toContain("CANTRIP_PTY_OK:captured");
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
    const serializedLogs = JSON.stringify(
      readWorkerLogs({
        afterCursor,
        limit: 200,
        minimumLevel: "trace",
      }).records,
    );
    expect(serializedLogs).toContain("terminal.process.started");
    expect(serializedLogs).not.toContain(directory);
    expect(serializedLogs).not.toContain("CANTRIP_PTY_OK");
    expect(serializedLogs).not.toContain("printf");
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
          "printf 'OSS_BASE_URL:%s\\n' \"$CODEX_OSS_BASE_URL\"",
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
      expect(output).toContain("features.fast_mode=false");
      expect(output).toContain(
        'model_providers.cantrip_runtime.base_url="https://openrouter.ai/api/v1"',
      );
      expect(output).toContain(`CODEX_HOME:${codexHome}`);
      expect(output).toContain("API_KEY:test-key");
      manager.closeAll();
    },
  );

  it.skipIf(process.platform === "win32")(
    "launches Ollama consoles through Codex's built-in local provider",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "cantrip-ollama-"));
      directories.push(directory);
      const fakeCodex = path.join(directory, "fake-codex");
      const codexHome = path.join(directory, "codex-home");
      await writeFile(
        fakeCodex,
        [
          "#!/bin/sh",
          "printf 'ARGS:%s\\n' \"$*\"",
          "printf 'OSS_BASE_URL:%s\\n' \"$CODEX_OSS_BASE_URL\"",
        ].join("\n"),
      );
      await chmod(fakeCodex, 0o755);

      const manager = new TerminalManager();
      let output = "";
      const exited = manager.open(
        "terminal-ollama",
        "attachment-ollama",
        directory,
        120,
        40,
        {
          type: "codex",
          binary: fakeCodex,
          codexHome,
          remoteUrl: "ws://127.0.0.1:4500",
          threadId: null,
          model: {
            id: "model-ollama",
            name: "gemma4:12b",
            reasoningEffort: null,
          },
          provider: {
            id: "provider-ollama",
            name: "Ollama",
            kind: "ollama",
            baseUrl: "http://127.0.0.1:11434/v1/responses",
            apiKey: null,
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
      expect(output).toContain('model_provider="ollama"');
      expect(output).not.toContain("model_providers.cantrip_runtime");
      expect(output).toContain("OSS_BASE_URL:http://127.0.0.1:11434/v1");
      manager.closeAll();
    },
  );
});
