import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TerminalManager } from "../src/terminal-manager.js";
import { readWorkerLogs } from "../src/logger.js";
import { TerminalCanonicalState } from "../src/terminal-canonical-state.js";

class SnapshotFailingTerminalState extends TerminalCanonicalState {
  override snapshot(): never {
    throw new Error("forced snapshot failure");
  }
}

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
    await expect(
      manager.canonicalSnapshot("terminal-replay"),
    ).resolves.toMatchObject({
      activeBuffer: "normal",
      data: expect.stringContaining("CANTRIP_REPLAY_MARKER"),
    });
    await expect(
      manager.canonicalSnapshot("missing-terminal"),
    ).resolves.toBeNull();
    manager.detach("terminal-replay", "attachment-initial");
    await expect(initialAttachment).resolves.toEqual({ status: "detached" });

    const replayEvents: Array<{
      type: string;
      data?: string;
      hydration?: { format: string; version: number };
    }> = [];
    const reattached = manager.attachExisting(
      "terminal-replay",
      "attachment-replay",
      (event) => replayEvents.push(event),
    );
    const secondReplayEvents: typeof replayEvents = [];
    const secondReattached = manager.attachExisting(
      "terminal-replay",
      "attachment-second-replay",
      (event) => secondReplayEvents.push(event),
    );
    manager.input(
      "terminal-replay",
      process.platform === "win32"
        ? "-join (67,65,78,84,82,73,80,95,65,84,79,77,73,67,95,68,69,76,84,65 | ForEach-Object {[char]$_})\r"
        : "printf '\\103\\101\\116\\124\\122\\111\\120\\137\\101\\124\\117\\115\\111\\103\\137\\104\\105\\114\\124\\101\\n'\r",
    );

    await expect
      .poll(
        () => replayEvents.some((event) => event.type === "terminal.ready"),
        { timeout: 5_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          secondReplayEvents.some((event) => event.type === "terminal.ready"),
        { timeout: 5_000 },
      )
      .toBe(true);
    expect(replayEvents[0]).toMatchObject({
      type: "terminal.output",
      data: expect.stringContaining("CANTRIP_REPLAY_MARKER"),
      hydration: {
        format: "canonical-xterm",
        processGeneration: 1,
        version: 1,
      },
    });
    expect(secondReplayEvents[0]).toMatchObject({
      hydration: {
        format: "canonical-xterm",
        processGeneration: 1,
        version: 1,
      },
    });
    expect(
      replayEvents.findIndex((event) => event.type === "terminal.ready"),
    ).toBeGreaterThan(0);
    await expect
      .poll(() => replayEvents.map((event) => event.data ?? "").join(""), {
        timeout: 5_000,
      })
      .toContain("CANTRIP_ATOMIC_DELTA");
    expect(
      replayEvents
        .map((event) => event.data ?? "")
        .join("")
        .match(/CANTRIP_ATOMIC_DELTA/gu),
    ).toHaveLength(1);
    await expect
      .poll(
        () => secondReplayEvents.map((event) => event.data ?? "").join(""),
        {
          timeout: 5_000,
        },
      )
      .toContain("CANTRIP_ATOMIC_DELTA");
    expect(
      secondReplayEvents
        .map((event) => event.data ?? "")
        .join("")
        .match(/CANTRIP_ATOMIC_DELTA/gu),
    ).toHaveLength(1);
    manager.detach("terminal-replay", "attachment-replay");
    manager.detach("terminal-replay", "attachment-second-replay");
    await expect(reattached).resolves.toEqual({ status: "detached" });
    await expect(secondReattached).resolves.toEqual({ status: "detached" });
    manager.close("terminal-replay");
  });

  it.skipIf(process.platform === "win32")(
    "requests one bounded PTY redraw when only a truncated legacy replay remains",
    async () => {
      const afterCursor = readWorkerLogs({
        afterCursor: 0,
        limit: 200,
        minimumLevel: "trace",
      }).latestCursor;
      const directory = await mkdtemp(path.join(tmpdir(), "cantrip-terminal-"));
      directories.push(directory);
      const manager = new TerminalManager({
        canonicalStateFactory: (cols, rows) =>
          new SnapshotFailingTerminalState(cols, rows),
        maxScrollbackCharacters: 128,
      });
      const initialEvents: Array<{ type: string; data?: string }> = [];
      const initial = manager.open(
        "terminal-recovery",
        "attachment-initial",
        directory,
        80,
        24,
        { type: "shell" },
        (event) => initialEvents.push(event),
      );
      await expect
        .poll(
          () => initialEvents.some((event) => event.type === "terminal.ready"),
          { timeout: 5_000 },
        )
        .toBe(true);
      manager.input(
        "terminal-recovery",
        "trap 'echo CANTRIP_RECOVERY_REDRAW' WINCH; echo CANTRIP_TRAP_READY\r",
      );
      await expect
        .poll(() => initialEvents.map((event) => event.data ?? "").join(""), {
          timeout: 5_000,
        })
        .toContain("CANTRIP_TRAP_READY");
      manager.input("terminal-recovery", "printf '%0200d\\n' 0\r");
      await expect
        .poll(
          () => initialEvents.map((event) => event.data ?? "").join("").length,
          {
            timeout: 5_000,
          },
        )
        .toBeGreaterThan(300);
      manager.detach("terminal-recovery", "attachment-initial");
      await expect(initial).resolves.toEqual({ status: "detached" });

      const replayEvents: Array<{
        type: string;
        data?: string;
        hydration?: {
          format: string;
          processGeneration?: number;
          recovery?: string;
          truncated?: boolean;
        };
      }> = [];
      const reattached = manager.attachExisting(
        "terminal-recovery",
        "attachment-recovery",
        (event) => replayEvents.push(event),
      );
      await expect
        .poll(
          () => replayEvents.some((event) => event.type === "terminal.ready"),
          { timeout: 5_000 },
        )
        .toBe(true);
      expect(replayEvents[0]).toMatchObject({
        hydration: {
          format: "legacy-raw",
          processGeneration: 1,
          recovery: "redraw-requested",
          truncated: true,
        },
      });
      await expect
        .poll(
          () =>
            replayEvents
              .map((event) => event.data ?? "")
              .join("")
              .match(/CANTRIP_RECOVERY_REDRAW/gu)?.length ?? 0,
          { timeout: 5_000 },
        )
        .toBeGreaterThanOrEqual(1);
      await expect
        .poll(
          () =>
            readWorkerLogs({
              afterCursor,
              limit: 500,
              minimumLevel: "trace",
            }).records.some(
              (entry) =>
                entry.context?.event === "terminal.recovery-redraw.restored",
            ),
          { timeout: 5_000 },
        )
        .toBe(true);
      manager.input(
        "terminal-recovery",
        "printf 'CANTRIP_RECOVERY_SIZE:'; stty size\r",
      );
      await expect
        .poll(() => replayEvents.map((event) => event.data ?? "").join(""), {
          timeout: 5_000,
        })
        .toMatch(/CANTRIP_RECOVERY_SIZE:\s*24 80/);

      const secondEvents: Array<{ type: string }> = [];
      const second = manager.attachExisting(
        "terminal-recovery",
        "attachment-second",
        (event) => secondEvents.push(event),
      );
      await expect
        .poll(
          () => secondEvents.some((event) => event.type === "terminal.ready"),
          { timeout: 5_000 },
        )
        .toBe(true);
      const logs = readWorkerLogs({
        afterCursor,
        limit: 500,
        minimumLevel: "trace",
      }).records.filter(
        (entry) =>
          entry.context?.event === "terminal.recovery-redraw.requested",
      );
      expect(logs).toHaveLength(1);

      manager.detach("terminal-recovery", "attachment-recovery");
      manager.detach("terminal-recovery", "attachment-second");
      await expect(reattached).resolves.toEqual({ status: "detached" });
      await expect(second).resolves.toEqual({ status: "detached" });
      manager.close("terminal-recovery");
    },
  );

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

    await expect
      .poll(() => events.includes("terminal.ready"), { timeout: 5_000 })
      .toBe(true);
    expect(events.slice(0, 2)).toEqual(["terminal.output", "terminal.ready"]);
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
