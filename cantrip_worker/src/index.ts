import { createHash } from "node:crypto";
import path from "node:path";

import type { WorkerCommand, WorkerEvent } from "@cantrip/protocol";

import { codexAccountHome } from "./codex/account-home.js";
import { CodexAppServer } from "./codex/app-server.js";
import { CodexAuthClient } from "./codex/auth-client.js";
import { discoverCodexVersion } from "./codex/discovery.js";
import { readWorkerConfig } from "./config.js";
import { listExplorerDirectory, readExplorerFile } from "./explorer.js";
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
  const codexHome = path.join(config.dataDirectory, "codex-home");
  const codexAuthClients = new Map<string, CodexAuthClient>();
  const codexRuntimes = new Map<string, CodexAppServer>();
  const terminals = new TerminalManager();

  const accountHomeFor = (providerId: string) =>
    codexAccountHome(config.dataDirectory, providerId);

  const authFor = (providerId: string) => {
    let client = codexAuthClients.get(providerId);
    if (!client) {
      client = new CodexAuthClient(
        config.codexBinary,
        accountHomeFor(providerId),
      );
      codexAuthClients.set(providerId, client);
    }
    return client;
  };

  const runtimeFor = (
    command: Extract<
      WorkerCommand,
      { type: "chat.turn" | "chat.compact" | "chat.interrupt" }
    >,
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
        command.provider.kind === "chatgpt"
          ? accountHomeFor(command.provider.id)
          : codexHome,
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
      case "codex.auth.status":
        return authFor(command.providerId).status();
      case "codex.auth.login.start":
        return authFor(command.providerId).startDeviceLogin();
      case "codex.auth.logout":
        await authFor(command.providerId).logout();
        for (const [runtimeId, runtime] of codexRuntimes) {
          if (!runtimeId.startsWith(`${command.providerId}:`)) continue;
          runtime.close();
          codexRuntimes.delete(runtimeId);
        }
        return { accepted: true };
      case "github.auth.status":
        return github.authStatus();
      case "github.repositories.list":
        return github.listRepositories();
      case "project.clone":
        return github.cloneRepository(command.repository.nameWithOwner);
      case "project.files.delete":
        return github.deleteRepository(command.path);
      case "git.history":
        return readGitHistory(command.cwd, command.limit, command.cursor);
      case "explorer.directory.list":
        return listExplorerDirectory(command.root, command.path);
      case "explorer.file.read":
        return readExplorerFile(command.root, command.path);
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
      case "chat.compact":
        return runtimeFor(command).compactThread({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.interrupt":
        return runtimeFor(command).interruptThread(command.threadId);
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
      for (const client of codexAuthClients.values()) client.close();
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
