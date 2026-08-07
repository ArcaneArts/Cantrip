import { createHash } from "node:crypto";
import path from "node:path";

import type { WorkerCommand, WorkerEvent } from "@cantrip/protocol";

import { CodexAppServer } from "./codex/app-server.js";
import { discoverCodexVersion } from "./codex/discovery.js";
import { readWorkerConfig } from "./config.js";
import { GithubClient } from "./github.js";
import { readGitHistory } from "./git.js";
import { createHeartbeat, sendHeartbeat } from "./heartbeat.js";
import { TerminalManager } from "./terminal-manager.js";
import { WorkerConnection } from "./transport.js";

const HEARTBEAT_INTERVAL_MS = 5_000;

async function start(): Promise<void> {
  const config = readWorkerConfig();
  const codexVersion = await discoverCodexVersion(config.codexBinary);
  const heartbeat = createHeartbeat(
    config,
    codexVersion,
    new Date().toISOString(),
  );
  let connected = false;
  let lastConnectionError: string | null = null;
  let stopping = false;
  const github = new GithubClient(config.dataDirectory);
  const codexRuntimes = new Map<string, CodexAppServer>();
  const terminals = new TerminalManager();

  const runtimeFor = (
    command: Extract<WorkerCommand, { type: "chat.turn" }>,
  ) => {
    const runtimeId = `${command.provider.id}:${command.model.id}`;
    let runtime = codexRuntimes.get(runtimeId);
    if (!runtime) {
      const directoryName = createHash("sha256")
        .update(runtimeId)
        .digest("hex");
      runtime = new CodexAppServer(
        config.codexBinary,
        path.join(config.dataDirectory, "codex-runtimes", directoryName),
      );
      codexRuntimes.set(runtimeId, runtime);
    }
    return runtime;
  };

  const handleCommand = async (
    command: WorkerCommand,
    emit: (event: WorkerEvent) => void,
  ): Promise<unknown> => {
    switch (command.type) {
      case "github.auth.status":
        return github.authStatus();
      case "github.repositories.list":
        return github.listRepositories();
      case "project.clone":
        return github.cloneRepository(command.repository.nameWithOwner);
      case "git.history":
        return readGitHistory(command.cwd, command.limit);
      case "terminal.open":
        return terminals.open(
          command.terminalId,
          command.attachmentId,
          command.cwd,
          command.cols,
          command.rows,
          emit,
        );
      case "terminal.detach":
        return terminals.detach(command.terminalId, command.attachmentId);
      case "terminal.input":
        terminals.input(command.terminalId, command.data);
        return { accepted: true };
      case "terminal.resize":
        terminals.resize(command.terminalId, command.cols, command.rows);
        return { accepted: true };
      case "terminal.close":
        terminals.close(command.terminalId);
        return { accepted: true };
      case "chat.turn":
        return runtimeFor(command).runTurn({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          prompt: command.prompt,
          threadId: command.threadId,
          onActivity: (activity) => emit({ type: "agent.activity", activity }),
        });
    }
  };
  const commandConnection = new WorkerConnection(config, handleCommand);

  console.log(
    `[cantrip_worker] Starting ${heartbeat.name} (${heartbeat.workerId}); Codex: ${codexVersion ?? "not found"}`,
  );

  const publish = async () => {
    try {
      await sendHeartbeat(config, heartbeat);
      if (!connected) {
        console.log(`[cantrip_worker] Connected to ${config.serverUrl}`);
      }
      connected = true;
      lastConnectionError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!stopping && (connected || message !== lastConnectionError)) {
        console.warn(`[cantrip_worker] Waiting for server: ${message}`);
      }
      connected = false;
      lastConnectionError = message;
    }
  };

  await publish();
  commandConnection.start();
  const heartbeatTimer = setInterval(
    () => void publish(),
    HEARTBEAT_INTERVAL_MS,
  );

  await new Promise<void>((resolve) => {
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) {
        return;
      }

      stopping = true;
      clearInterval(heartbeatTimer);
      commandConnection.close();
      terminals.closeAll();
      for (const runtime of codexRuntimes.values()) {
        runtime.close();
      }
      console.log(`[cantrip_worker] Received ${signal}; stopped.`);
      resolve();
    };

    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
}

start().catch((error: unknown) => {
  console.error("Cantrip Worker failed to start", error);
  process.exitCode = 1;
});
