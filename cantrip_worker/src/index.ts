import { createHash } from "node:crypto";
import path from "node:path";

import type { WorkerCommand, WorkerEvent } from "@cantrip/protocol";

import { AttachmentStore } from "./attachment-store.js";
import { codexAccountHome } from "./codex/account-home.js";
import { CodexAppServer, codexRuntimeId } from "./codex/app-server.js";
import { CodexAuthClient } from "./codex/auth-client.js";
import { verifyCodexInstallation } from "./codex/bundled-runtime.js";
import { discoverCodexRuntime } from "./codex/discovery.js";
import type { CodexRuntime } from "./codex/runtime.js";
import { invokeCantripWorktreeTool } from "./codex/worktree-tool-client.js";
import { BrowserRemoteSurfaceAdapter } from "./browser/browser-adapter.js";
import { discoverCantripCode } from "./code/installation.js";
import { CodeSupervisor } from "./code/supervisor.js";
import { CodeTunnelProxy } from "./code/tunnel-proxy.js";
import { readWorkerConfig } from "./config.js";
import { ManagedDesktopRemoteSurfaceAdapter } from "./desktop/desktop-adapter.js";
import { listExplorerDirectory, readExplorerFile } from "./explorer.js";
import { GithubClient } from "./github.js";
import {
  readGitFileDiff,
  readGitHistory,
  readGitStatus,
  runGitAction,
} from "./git.js";
import { createHeartbeat, sendHeartbeat } from "./heartbeat.js";
import { ProjectShareManager } from "./project-share-manager.js";
import { ProjectShareTunnelProxy } from "./project-share-tunnel-proxy.js";
import { TerminalManager } from "./terminal-manager.js";
import { RemoteSurfaceManager } from "./remote-surface-manager.js";
import { WorkerConnection } from "./transport.js";
import { WorktreeManager } from "./worktrees.js";
import {
  scanWorkflowRepository,
  writeWorkflowRepositoryDocument,
} from "./workflow-repository.js";

const HEARTBEAT_INTERVAL_MS = 5_000;

async function start(): Promise<void> {
  const config = readWorkerConfig();
  const bundledCodex = await verifyCodexInstallation(config.codexInstallation);
  const codexHome = path.join(config.dataDirectory, "codex-home");
  const codexRuntime = await discoverCodexRuntime(
    config.codexBinary,
    path.join(config.dataDirectory, "codex-compatibility-probe"),
  );
  if (bundledCodex && codexRuntime.version?.semantic !== bundledCodex.version) {
    throw new Error(
      `Bundled Codex reports ${codexRuntime.version?.semantic ?? "no version"}; manifest expects ${bundledCodex.version}.`,
    );
  }
  const browserAdapter = new BrowserRemoteSurfaceAdapter({
    dataDirectory: config.dataDirectory,
  });
  const desktopAdapter = new ManagedDesktopRemoteSurfaceAdapter();
  await desktopAdapter.initialize();
  const codeDiscovery = await discoverCantripCode();
  const code = new CodeSupervisor({
    capabilities: codeDiscovery.capabilities,
    dataDirectory: config.dataDirectory,
    idleTimeoutMs: config.codeIdleTimeoutMs,
    installation: codeDiscovery.installation,
    workerId: config.workerId,
    workerName: config.name,
  });
  await code.start();
  const codeTunnel = new CodeTunnelProxy(code);
  const heartbeat = createHeartbeat(
    config,
    codexRuntime,
    new Date().toISOString(),
    {
      browser: browserAdapter.available,
      desktop: desktopAdapter.available,
      transports: ["websocket", "webrtc"],
      maxSessions: 4,
    },
    codeDiscovery.capabilities,
  );
  let connected = false;
  let commandChannelStarted = false;
  let lastConnectionError: string | null = null;
  let stopping = false;
  const attachments = new AttachmentStore(config.dataDirectory);
  const github = new GithubClient(config.dataDirectory);
  const codexAuthClients = new Map<string, CodexAuthClient>();
  const codexRuntimes = new Map<string, CodexRuntime>();
  const pausedChats = new Set<string>();
  const projectShares = new ProjectShareManager();
  const projectShareTunnel = new ProjectShareTunnelProxy(projectShares);
  const terminals = new TerminalManager();
  const remoteSurfaces = new RemoteSurfaceManager({
    browser: browserAdapter,
    desktop: desktopAdapter,
  });
  const worktrees = new WorktreeManager(config.dataDirectory);

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

  const runtimeFor = (command: {
    model: Extract<WorkerCommand, { type: "chat.turn" }>["model"];
    provider: Extract<WorkerCommand, { type: "chat.turn" }>["provider"];
  }) => {
    const runtimeId = codexRuntimeId(command.model, command.provider);
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
        codexRuntime,
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
      case "github.repositories.cached":
        return github.cachedRepositories(command.login);
      case "github.repositories.list":
        return github.listRepositories();
      case "github.issues.list":
        return github.listIssues(
          command.repository,
          command.kind,
          command.state,
          command.page,
          command.limit,
        );
      case "github.issue.get":
        return github.getIssue(command.repository, command.number);
      case "github.issue.comment":
        return github.commentOnIssue(
          command.repository,
          command.number,
          command.body,
        );
      case "github.issue.close":
        return github.closeIssue(
          command.repository,
          command.number,
          command.comment,
        );
      case "project.clone":
        return github.cloneRepository(command.repository.nameWithOwner);
      case "project.files.delete":
        return github.deleteRepository(command.path);
      case "project.share.open":
        return projectShares.open(command);
      case "project.share.close":
        projectShareTunnel.closeShare(command.shareId);
        await projectShares.close(command.shareId);
        return { accepted: true };
      case "git.history":
        return readGitHistory(
          command.cwd,
          command.limit,
          command.cursor,
          command.revisions,
        );
      case "git.status":
        return readGitStatus(command.cwd);
      case "git.diff":
        return readGitFileDiff(command.cwd, command.path, command.scope);
      case "git.action":
        return runGitAction(command.cwd, command.action);
      case "worktree.list":
        return worktrees.list(command.sourcePath);
      case "worktree.reconcile":
        return worktrees.reconcile(command.sourcePath);
      case "worktree.create":
        return worktrees.create(
          command.sourcePath,
          command.worktreeId,
          command.name,
          command.mode,
        );
      case "worktree.remove":
        return worktrees.remove(command.sourcePath, command.worktreePath, {
          allowExternal: command.allowExternal,
          force: command.force,
        });
      case "worktree.lock":
        return worktrees.lock(
          command.sourcePath,
          command.worktreePath,
          command.reason,
        );
      case "worktree.unlock":
        return worktrees.unlock(command.sourcePath, command.worktreePath);
      case "worktree.prune":
        return worktrees.prune(command.sourcePath, command.allowExternal);
      case "worktree.status":
        return worktrees.status(command.sourcePath, command.worktreePath);
      case "worktree.observation.configure":
        worktrees.configureObservation(command.targets);
        return { accepted: true };
      case "explorer.directory.list":
        return listExplorerDirectory(command.root, command.path);
      case "explorer.file.read":
        return readExplorerFile(command.root, command.path);
      case "code.probe":
        return code.probe();
      case "code.open":
        return code.open(command);
      case "code.status":
        return code.status(command.sessionId);
      case "code.stop":
        return code.stop(command.sessionId);
      case "code.saveAll":
        return code.saveAll(command.sessionId);
      case "code.getDirtyEditors":
        return code.dirtyEditors(command.sessionId);
      case "code.setTheme":
        return code.setTheme(
          command.sessionId,
          command.themeMode,
          command.appearance,
        );
      case "code.prepareAgentTurn":
        return code.prepareAgentTurn(command.cwd);
      case "code.agentTurnState":
        return code.agentTurnState(command.cwd, command.phase, command.paths);
      case "skills.list":
        return runtimeFor(command).listSkills({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
        });
      case "customization.inventory.read":
        return runtimeFor(command).readCustomizationInventory(
          {
            cwd: command.cwd,
            model: command.model,
            provider: command.provider,
          },
          command.forceReload,
        );
      case "customization.external.preview":
        return runtimeFor(command).previewExternalAgentConfig({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
        });
      case "customization.mcp.resource.read":
        return runtimeFor(command).readMcpResource({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          server: command.server,
          uri: command.uri,
        });
      case "customization.skill.configure":
        return runtimeFor(command).configureSkill({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          path: command.path,
          enabled: command.enabled,
        });
      case "customization.skill-roots.set":
        return runtimeFor(command).setSkillRoots({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          roots: command.roots,
        });
      case "customization.mcp.oauth.start":
        return runtimeFor(command).startMcpOauth({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          server: command.server,
        });
      case "customization.mcp.oauth.status":
        return runtimeFor(command).mcpOauthStatus(command.server);
      case "customization.mcp.reload":
        return runtimeFor(command).reloadMcpServers({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
        });
      case "customization.external.apply":
        return runtimeFor(command).applyExternalAgentConfig({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          itemIds: command.itemIds,
        });
      case "customization.external.status":
        return runtimeFor(command).externalImportStatus(command.importId);
      case "permission-profiles.list":
        return runtimeFor(command).listPermissionProfiles({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
        });
      case "attachment.upload.begin":
        await attachments.begin(
          command.chatId,
          command.attachmentId,
          command.fileName,
          command.sizeBytes,
        );
        return { accepted: true };
      case "attachment.upload.chunk":
        await attachments.append(
          command.chatId,
          command.attachmentId,
          command.chunkIndex,
          Buffer.from(command.data, "base64"),
        );
        return { accepted: true };
      case "attachment.upload.complete":
        return attachments.complete(command.chatId, command.attachmentId);
      case "attachment.read": {
        const result = await attachments.read(
          command.chatId,
          command.attachmentId,
          command.fileName,
          command.offset,
          command.limit,
        );
        return {
          data: Buffer.from(result.bytes).toString("base64"),
          eof: result.eof,
          sizeBytes: result.sizeBytes,
        };
      }
      case "attachment.delete":
        await attachments.remove(command.chatId, command.attachmentId);
        return { accepted: true };
      case "terminal.open":
        if (command.launch.type === "codex") {
          const runtime = runtimeFor(command.launch);
          if (
            command.launch.threadId &&
            !terminals.hasLiveSession(command.terminalId)
          ) {
            await runtime.prepareExternalSync({
              cwd: command.cwd,
              model: command.launch.model,
              provider: command.launch.provider,
              threadId: command.launch.threadId,
            });
          }
          return terminals.open(
            command.terminalId,
            command.attachmentId,
            command.cwd,
            command.cols,
            command.rows,
            {
              ...command.launch,
              binary: config.codexBinary,
              codexHome:
                command.launch.provider.kind === "chatgpt"
                  ? accountHomeFor(command.launch.provider.id)
                  : codexHome,
              remoteUrl: await runtime.remoteEndpoint(
                command.launch.model,
                command.launch.provider,
              ),
            },
            emit,
          );
        }
        return terminals.open(
          command.terminalId,
          command.attachmentId,
          command.cwd,
          command.cols,
          command.rows,
          command.launch,
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
      case "surface.attach":
        return remoteSurfaces.attach(command);
      case "surface.detach":
        await remoteSurfaces.detach(command.surfaceId, command.attachmentId);
        return { accepted: true };
      case "surface.configure":
        await remoteSurfaces.configure(
          command.surfaceId,
          command.configuration,
        );
        return { accepted: true };
      case "surface.suspend":
        await remoteSurfaces.suspend(command.surfaceId);
        return { accepted: true };
      case "surface.resume":
        await remoteSurfaces.resume(command.surfaceId);
        return { accepted: true };
      case "surface.close":
        await remoteSurfaces.close(command.surfaceId);
        return { accepted: true };
      case "surface.desktop.probe":
        return desktopAdapter.probe();
      case "chat.turn": {
        if (command.automationPaused) pausedChats.add(command.chatId);
        const runtime = runtimeFor(command);
        runtime.setChatPaused(command.chatId, pausedChats.has(command.chatId));
        return runtime.runTurn({
          automationPaused: pausedChats.has(command.chatId),
          attachments: command.attachments.map((attachment) => ({
            ...attachment,
            path: attachments.resolve(
              command.chatId,
              attachment.id,
              attachment.fileName,
            ),
          })),
          chatId: command.chatId,
          clientMessageId: command.clientMessageId,
          cwd: command.cwd,
          isPrimary: command.isPrimary,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          planMode: command.planMode,
          prompt: command.prompt,
          skillNames: command.skillNames,
          threadId: command.threadId,
          worktreeMode: command.worktreeMode,
          worktreePolicy: command.worktreePolicy,
          onActivity: (activity) => emit({ type: "agent.activity", activity }),
          onMessage: (message) => emit({ type: "agent.message", message }),
          onInteractionRequest: (request) =>
            emit({ type: "agent.interaction.requested", request }),
          onInteractionCleared: (requestKey) =>
            emit({ type: "agent.interaction.cleared", requestKey }),
          onInteractionExpired: (requestKey) =>
            emit({ type: "agent.interaction.expired", requestKey }),
          onCheckpoint: ({ text, turnId }) =>
            emit({ type: "agent.checkpoint", text, turnId }),
          onPlan: ({ explanation, steps, turnId }) =>
            emit({ type: "agent.plan.updated", explanation, steps, turnId }),
          onPlanQuestion: (question) =>
            emit({ type: "agent.plan.question", question }),
          onPlanQuestionResolved: (questionId) =>
            emit({ type: "agent.plan.question-resolved", questionId }),
          onWorktreeToolCall: async ({
            arguments: toolArguments,
            callId,
            tool,
          }) => {
            try {
              const result = await invokeCantripWorktreeTool({
                arguments: toolArguments,
                callId,
                chatId: command.chatId,
                executionLaneId: command.executionLaneId,
                serverUrl: config.serverUrl,
                token: config.token,
                tool,
                workerId: config.workerId,
              });
              emit({
                type: "agent.activity",
                activity: {
                  type: "worktree",
                  id: `worktree-tool:${callId}`,
                  operation: tool,
                  status: "completed",
                  summary: result.summary,
                  worktreeId: result.worktreeId,
                },
              });
              return result;
            } catch (error) {
              emit({
                type: "agent.activity",
                activity: {
                  type: "worktree",
                  id: `worktree-tool:${callId}`,
                  operation: tool,
                  status: "failed",
                  summary:
                    error instanceof Error ? error.message : String(error),
                  worktreeId: null,
                },
              });
              throw error;
            }
          },
        });
      }
      case "workflow.node.execute":
        return runtimeFor(command).runWorkflowNode({
          workflowRunId: command.workflowRunId,
          runNodeId: command.runNodeId,
          attemptId: command.attemptId,
          idempotencyKey: command.idempotencyKey,
          worktreeId: command.worktreeId,
          cwd: command.cwd,
          threadId: command.threadId,
          prompt: command.prompt,
          developerInstructions: command.developerInstructions,
          skillNames: command.skillNames,
          outputSchema: command.outputSchema,
          mutationMode: command.mutationMode,
          networkAccess: command.networkAccess,
          approvalMode: command.approvalMode,
          permissionProfileId: command.permissionProfileId,
          timeoutMs: command.timeoutMs,
          model: command.model,
          provider: command.provider,
          onActivity: (activity) =>
            emit({
              type: "workflow.node.activity",
              attemptId: command.attemptId,
              activity,
            }),
          onMessage: (message) =>
            emit({
              type: "workflow.node.message",
              attemptId: command.attemptId,
              message,
            }),
          onInteractionRequest: (request) =>
            emit({
              type: "workflow.node.interaction.requested",
              attemptId: command.attemptId,
              request,
            }),
          onInteractionCleared: (requestKey) =>
            emit({
              type: "workflow.node.interaction.cleared",
              attemptId: command.attemptId,
              requestKey,
            }),
          onInteractionExpired: (requestKey) =>
            emit({
              type: "workflow.node.interaction.expired",
              attemptId: command.attemptId,
              requestKey,
            }),
          onPlan: ({ explanation, steps, turnId }) =>
            emit({
              type: "workflow.node.plan.updated",
              attemptId: command.attemptId,
              explanation,
              steps,
              turnId,
            }),
        });
      case "workflow.definition.generate":
        return runtimeFor(command).runWorkflowNode({
          workflowRunId: `generation:${command.generationId}`,
          runNodeId: "definition",
          attemptId: command.generationId,
          idempotencyKey: command.generationId,
          worktreeId: null,
          cwd: command.cwd,
          threadId: null,
          prompt: command.prompt,
          developerInstructions: command.developerInstructions,
          skillNames: [],
          outputSchema: command.outputSchema,
          mutationMode: "read-only",
          networkAccess: "none",
          approvalMode: "preauthorized",
          permissionProfileId: null,
          timeoutMs: command.timeoutMs,
          model: command.model,
          provider: command.provider,
        });
      case "workflow.repository.scan":
        return scanWorkflowRepository(command.cwd);
      case "workflow.repository.write":
        return writeWorkflowRepositoryDocument(
          command.cwd,
          command.document,
          command.overwrite,
        );
      case "workflow.node.interrupt":
        return runtimeFor(command).interruptThread(command.threadId);
      case "chat.pause.set":
        if (command.paused) {
          pausedChats.add(command.chatId);
        } else {
          pausedChats.delete(command.chatId);
        }
        for (const runtime of codexRuntimes.values()) {
          runtime.setChatPaused(command.chatId, command.paused);
        }
        return { paused: command.paused };
      case "chat.compact":
        return runtimeFor(command).compactThread({
          cwd: command.cwd,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.interrupt":
        return runtimeFor(command).interruptThread(command.threadId);
      case "chat.goal.get":
        return runtimeFor(command).getGoal({
          cwd: command.cwd,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.goal.create":
        return runtimeFor(command).createGoal({
          cwd: command.cwd,
          model: command.model,
          objective: command.objective,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
          tokenBudget: command.tokenBudget,
        });
      case "chat.goal.update":
        return runtimeFor(command).updateGoal({
          cwd: command.cwd,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          status: command.status,
          threadId: command.threadId,
        });
      case "chat.goal.clear":
        return runtimeFor(command).clearGoal({
          cwd: command.cwd,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.thread.ensure":
        return runtimeFor(command).ensureThread({
          cwd: command.cwd,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          planMode: command.planMode,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.plan.get":
        return runtimeFor(command).getPlanMode({
          cwd: command.cwd,
          fallbackMode: command.fallbackMode,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.plan.set":
        return runtimeFor(command).setPlanMode({
          cwd: command.cwd,
          mode: command.mode,
          model: command.model,
          permissionProfileId: command.permissionProfileId,
          provider: command.provider,
          threadId: command.threadId,
        });
      case "chat.plan.answer":
        return runtimeFor(command).answerPlanQuestion(
          command.questionId,
          command.answers,
        );
      case "agent.interaction.respond":
        return runtimeFor(command).answerAgentInteraction(
          command.requestKey,
          command.response,
        );
      case "agent.interaction.cancel":
        return runtimeFor(command).cancelAgentInteraction(
          command.requestKey,
          command.reason,
        );
      case "chat.steer":
        return runtimeFor(command).steerThread(
          command.chatId,
          command.threadId,
          command.prompt,
          command.attachments.map((attachment) => ({
            ...attachment,
            path: attachments.resolve(
              command.chatId,
              attachment.id,
              attachment.fileName,
            ),
          })),
          command.model,
          command.provider,
        );
      case "chat.sync":
        return runtimeFor(command).syncThread({
          cwd: command.cwd,
          model: command.model,
          provider: command.provider,
          threadId: command.threadId,
        });
    }
  };
  const commandConnection = new WorkerConnection(
    config,
    handleCommand,
    (header, payload) => remoteSurfaces.handleFrame(header, payload),
    (header, payload) => codeTunnel.handleFrame(header, payload),
    (header, payload) => projectShareTunnel.handleFrame(header, payload),
  );
  worktrees.setObservationEmitter((notification) =>
    commandConnection.sendNotification(notification),
  );
  remoteSurfaces.setFrameEmitter((header, payload) =>
    commandConnection.sendSurfaceFrame(header, payload),
  );
  codeTunnel.setFrameEmitter(
    (header, payload) => commandConnection.sendCodeTunnelFrame(header, payload),
    () => commandConnection.waitForCodeTunnelCapacity(),
  );
  projectShareTunnel.setFrameEmitter(
    (header, payload) =>
      commandConnection.sendProjectShareTunnelFrame(header, payload),
    () => commandConnection.waitForProjectShareTunnelCapacity(),
  );

  console.log(
    `[cantrip_worker] Starting ${heartbeat.name} (${heartbeat.workerId}); Codex: ${codexRuntime.version?.raw ?? "not found"} (${codexRuntime.compatibility}, ${config.codexInstallation.source}); Code: ${codeDiscovery.capabilities.available ? `${codeDiscovery.capabilities.version} (${codeDiscovery.installation?.source ?? "unknown"})` : `unavailable (${codeDiscovery.capabilities.reason ?? "unknown error"})`}; Browser: ${browserAdapter.executable ?? "Chromium not found"}; Desktop: ${desktopAdapter.available ? `${desktopAdapter.frameBackend} capture ready` : `unavailable (${desktopAdapter.initializationError ?? "unknown error"})`}`,
  );

  const publish = async () => {
    try {
      await sendHeartbeat(config, heartbeat);
      if (!connected) {
        console.log(`[cantrip_worker] Connected to ${config.serverUrl}`);
      }
      connected = true;
      lastConnectionError = null;
      if (!commandChannelStarted) {
        commandConnection.start();
        commandChannelStarted = true;
      }
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
  const heartbeatTimer = setInterval(
    () => void publish(),
    HEARTBEAT_INTERVAL_MS,
  );

  await new Promise<void>((resolve) => {
    const stop = async (signal: NodeJS.Signals) => {
      if (stopping) {
        return;
      }

      stopping = true;
      clearInterval(heartbeatTimer);
      worktrees.close();
      commandConnection.close();
      for (const client of codexAuthClients.values()) client.close();
      terminals.closeAll();
      projectShareTunnel.close();
      await projectShares.closeAll();
      codeTunnel.close();
      await code.close();
      await remoteSurfaces.closeAll();
      await desktopAdapter.shutdown();
      for (const runtime of codexRuntimes.values()) {
        runtime.close();
      }
      console.log(`[cantrip_worker] Received ${signal}; stopped.`);
      resolve();
    };

    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  });
}

start().catch((error: unknown) => {
  console.error("Cantrip Worker failed to start", error);
  process.exitCode = 1;
});
