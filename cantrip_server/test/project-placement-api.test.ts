import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentExecutionToolResultSchema,
  browserSummarySchema,
  cantripCliCommandResultSchema,
  explorerSummarySchema,
  executionPlacementResolutionSchema,
  executionTargetCatalogSchema,
  executionTargetResolutionSchema,
  terminalSummarySchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import {
  ExecutionPlacementUnavailableError,
  LOCAL_USER_ID,
} from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-placement-api-"),
);
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "test-worker-token",
};

const connectedWorkers = new Set(["worker-alpha", "worker-beta"]);
const routedCommands: Array<{ workerId: string; command: WorkerCommand }> = [];
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return connectedWorkers.has(workerId);
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  async request(workerId, command) {
    routedCommands.push({ workerId, command });
    switch (command.type) {
      case "explorer.directory.list":
        return {
          path: command.path,
          entries: [
            {
              name: "README.md",
              path: "README.md",
              kind: "file",
              size: 12,
              modifiedAt: "2026-08-12T00:00:00.000Z",
              viewable: true,
              markdown: true,
            },
          ],
          truncated: false,
        };
      case "explorer.file.read":
        return {
          path: command.path,
          content: "cross-worker file content",
          size: 25,
          markdown: true,
          version: "a".repeat(64),
        };
      case "explorer.file.write":
        return {
          path: command.path,
          content: command.content,
          size: Buffer.byteLength(command.content),
          markdown: command.path.endsWith(".md"),
          version: "b".repeat(64),
        };
      case "terminal.input":
      case "terminal.service.restart":
      case "surface.configure":
        return { accepted: true };
      case "terminal.snapshot":
        return {
          terminalId: command.terminalId,
          status: "running",
          data: "cross-worker terminal output",
          truncated: false,
          exitCode: null,
        };
      case "worktree.status":
        return {
          worktree: {
            path: command.worktreePath,
            head: "1".repeat(40),
            branch: "main",
            detached: false,
            isPrimary: true,
            managed: true,
            locked: false,
            lockReason: null,
            prunable: false,
            pruneReason: null,
            missing: false,
          },
          status: {
            branch: "main",
            head: "1".repeat(40),
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            files: [],
            branches: [],
          },
        };
      case "browser.services.discover":
        return [
          {
            workerId,
            host: "127.0.0.1",
            port: 4_173,
            protocol: "http",
            url: "http://127.0.0.1:4173",
            title: "Preview",
            processName: "vite",
            statusCode: 200,
          },
        ];
      default:
        throw new Error(`Unexpected placement command ${command.type}.`);
    }
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let alphaWorktreeId: string;
let betaWorktreeId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "worker-alpha",
    name: "Alpha",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    code: {
      available: true,
      version: "1.109.5",
      upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
      patchset: 1,
      transport: "web-proxy",
      maxSessions: 4,
      reason: null,
    },
    remoteSurfaces: {
      browser: true,
      desktop: true,
      transports: ["websocket"],
      maxSessions: 4,
    },
    startedAt: new Date().toISOString(),
  });
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "worker-beta",
    name: "Beta",
    platform: "linux",
    architecture: "x64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "worker-alpha",
    repositoryId: "placement-api",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  for (const workerId of ["worker-alpha", "worker-beta"]) {
    await database.repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      projectId,
      workerId,
      {
        path: path.join(dataDirectory, workerId),
        displayPath: `ArcaneArts/Cantrip (${workerId})`,
        reused: false,
        updated: false,
        warning: null,
      },
    );
  }
  const worktrees = await database.repository.listProjectWorktrees(
    LOCAL_USER_ID,
    projectId,
  );
  alphaWorktreeId = worktrees.find(
    ({ workerId }) => workerId === "worker-alpha",
  )!.id;
  betaWorktreeId = worktrees.find(
    ({ workerId }) => workerId === "worker-beta",
  )!.id;
  for (const worktree of worktrees) {
    await database.repository.recordProjectWorktreeStatus(
      LOCAL_USER_ID,
      projectId,
      worktree.id,
      {
        worktree: {
          path: worktree.path,
          head: "1".repeat(40),
          branch: "main",
          detached: false,
          isPrimary: true,
          managed: true,
          locked: false,
          lockReason: null,
          prunable: false,
          pruneReason: null,
          missing: false,
        },
        status: {
          branch: "main",
          head: "1".repeat(40),
          upstream: "origin/main",
          ahead: 0,
          behind: 0,
          files: [],
          branches: [],
        },
      },
    );
  }
  app = await buildApp({ config, database, logger: false, workerBridge });
});

beforeEach(async () => {
  routedCommands.length = 0;
  connectedWorkers.clear();
  connectedWorkers.add("worker-alpha");
  connectedWorkers.add("worker-beta");
  await database.repository.updateSettings(LOCAL_USER_ID, {
    defaultWorkerId: "worker-alpha",
  });
  await database.repository.updateProjectPreferredWorker(
    LOCAL_USER_ID,
    projectId,
    "worker-beta",
  );
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("project execution placement API", () => {
  it("serializes logical branch mutation across worker replicas", async () => {
    const alphaChat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        title: "Alpha branch owner",
        worktreeId: alphaWorktreeId,
        worktreeMode: "pinned",
      },
    );
    const betaChat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        title: "Beta branch contender",
        worktreeId: betaWorktreeId,
        worktreeMode: "pinned",
      },
    );
    expect(alphaChat).not.toBeNull();
    expect(betaChat).not.toBeNull();

    const alphaLane = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      alphaChat!.id,
      "agent",
      "Mutate main on Alpha",
    );
    expect(alphaLane).toMatchObject({
      workerId: "worker-alpha",
      worktreeId: alphaWorktreeId,
    });
    await expect(
      database.repository.startChatExecutionLane(
        LOCAL_USER_ID,
        betaChat!.id,
        "agent",
        "Mutate main on Beta",
      ),
    ).rejects.toThrow(/Logical branch main is already leased/u);

    await database.repository.finishChatExecutionLane(
      alphaChat!.id,
      alphaLane!.executionLaneId,
      "idle",
    );
    const betaLane = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      betaChat!.id,
      "agent",
      "Mutate main after Alpha",
    );
    expect(betaLane).toMatchObject({
      workerId: "worker-beta",
      worktreeId: betaWorktreeId,
    });
    await database.repository.finishChatExecutionLane(
      betaChat!.id,
      betaLane!.executionLaneId,
      "idle",
    );
  });

  it("uses project preference, global default, then a stable compatible fallback", async () => {
    const terminal = await database.repository.resolveProjectExecutionPlacement(
      LOCAL_USER_ID,
      projectId,
      "terminal",
      undefined,
      workerBridge.isConnected.bind(workerBridge),
    );
    expect(terminal).toMatchObject({
      selection: "project-preference",
      placement: {
        workerId: "worker-beta",
        worktreeId: betaWorktreeId,
      },
    });

    const code = await database.repository.resolveProjectExecutionPlacement(
      LOCAL_USER_ID,
      projectId,
      "code",
      undefined,
      workerBridge.isConnected.bind(workerBridge),
    );
    expect(code).toMatchObject({
      selection: "default-worker",
      placement: {
        workerId: "worker-alpha",
        worktreeId: alphaWorktreeId,
      },
    });

    await database.repository.updateSettings(LOCAL_USER_ID, {
      defaultWorkerId: null,
    });
    await database.repository.updateProjectPreferredWorker(
      LOCAL_USER_ID,
      projectId,
      null,
    );
    expect(
      await database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "explorer",
        undefined,
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).toMatchObject({
      selection: "fallback",
      placement: { workerId: "worker-alpha" },
    });
  });

  it("honors explicit worktrees and never silently moves an invalid target", async () => {
    expect(
      await database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "terminal",
        { kind: "worktree", projectId, worktreeId: alphaWorktreeId },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).toMatchObject({
      selection: "explicit",
      placement: {
        workerId: "worker-alpha",
        worktreeId: alphaWorktreeId,
      },
    });

    connectedWorkers.delete("worker-beta");
    await expect(
      database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "terminal",
        { kind: "worker", projectId, workerId: "worker-beta" },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).rejects.toMatchObject<Partial<ExecutionPlacementUnavailableError>>({
      code: "worker-offline",
    });
    await expect(
      database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "browser",
        { kind: "worker", projectId, workerId: "worker-beta" },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).rejects.toMatchObject<Partial<ExecutionPlacementUnavailableError>>({
      code: "worker-offline",
    });
  });

  it("exposes structured resolution failures and persists surface ownership", async () => {
    const resolved = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/placement/resolve`,
      payload: {
        surfaceKind: "terminal",
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(
      executionPlacementResolutionSchema.parse(resolved.json()),
    ).toMatchObject({
      selection: "explicit",
      placement: { workerId: "worker-alpha" },
    });

    connectedWorkers.delete("worker-beta");
    const unavailable = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/placement/resolve`,
      payload: {
        surfaceKind: "terminal",
        target: { kind: "worker", projectId, workerId: "worker-beta" },
      },
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({ code: "worker-offline" });
    connectedWorkers.add("worker-beta");

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browsers`,
      payload: {
        title: "Placed browser",
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(browserSummarySchema.parse(created.json())).toMatchObject({
      workerId: "worker-alpha",
    });

    const terminalCreated = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/terminals`,
      payload: {
        title: "Alpha shell",
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(terminalCreated.statusCode).toBe(201);
    const terminal = terminalSummarySchema.parse(terminalCreated.json());

    const resolvedTarget = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/execution-targets/resolve`,
      payload: {
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "terminal",
          surfaceId: terminal.id,
        },
      },
    });
    expect(resolvedTarget.statusCode).toBe(200);
    expect(
      executionTargetResolutionSchema.parse(resolvedTarget.json()),
    ).toMatchObject({
      availability: "available",
      placement: {
        workerId: "worker-alpha",
        worktreeId: alphaWorktreeId,
        surface: { kind: "terminal", id: terminal.id },
      },
    });

    const catalogResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/execution-targets`,
    });
    expect(catalogResponse.statusCode).toBe(200);
    const catalog = executionTargetCatalogSchema.parse(catalogResponse.json());
    expect(catalog.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKind: "terminal",
          title: "Alpha shell",
          placement: expect.objectContaining({ workerId: "worker-alpha" }),
        }),
        expect.objectContaining({
          resourceKind: "browser",
          title: "Placed browser",
          placement: expect.objectContaining({ workerId: "worker-alpha" }),
        }),
        expect.objectContaining({
          resourceKind: "worker",
          title: "Alpha",
        }),
        expect.objectContaining({
          resourceKind: "worker",
          title: "Beta",
        }),
      ]),
    );

    connectedWorkers.delete("worker-alpha");
    const offline = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/execution-targets/resolve`,
      payload: {
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "terminal",
          surfaceId: terminal.id,
        },
      },
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json()).toMatchObject({ code: "worker-offline" });
    const offlineVisible = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/execution-targets/resolve`,
      payload: {
        allowUnavailable: true,
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "terminal",
          surfaceId: terminal.id,
        },
      },
    });
    expect(offlineVisible.statusCode).toBe(200);
    expect(
      executionTargetResolutionSchema.parse(offlineVisible.json()),
    ).toMatchObject({
      availability: "worker-offline",
      worker: { workerId: "worker-alpha", online: false },
    });
    connectedWorkers.add("worker-alpha");

    const wrongProject = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/execution-targets/resolve`,
      payload: {
        target: {
          kind: "surface",
          projectId: "another-project",
          surfaceKind: "terminal",
          surfaceId: terminal.id,
        },
      },
    });
    expect(wrongProject.statusCode).toBe(409);
    expect(wrongProject.json()).toMatchObject({ code: "target-mismatch" });

    const wrongSurfaceKind = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/execution-targets/resolve`,
      payload: {
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "explorer",
          surfaceId: terminal.id,
        },
      },
    });
    expect(wrongSurfaceKind.statusCode).toBe(409);
    expect(wrongSurfaceKind.json()).toMatchObject({ code: "target-not-found" });

    const unsupportedBrowser = await database.repository.createRemoteSurface(
      LOCAL_USER_ID,
      projectId,
      {
        workerId: "worker-beta",
        title: "Unsupported browser",
        configuration: {
          kind: "browser",
          initialUrl: "https://example.com",
          profileId: null,
        },
      },
    );
    expect(unsupportedBrowser).not.toBeNull();
    await expect(
      database.repository.resolveExecutionTarget(
        LOCAL_USER_ID,
        projectId,
        {
          kind: "surface",
          projectId,
          surfaceKind: "remote-surface",
          surfaceId: unsupportedBrowser!.id,
        },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).rejects.toMatchObject<Partial<ExecutionPlacementUnavailableError>>({
      code: "capability-unavailable",
    });
    expect(
      await database.repository.resolveExecutionTarget(
        LOCAL_USER_ID,
        projectId,
        {
          kind: "surface",
          projectId,
          surfaceKind: "remote-surface",
          surfaceId: unsupportedBrowser!.id,
        },
        workerBridge.isConnected.bind(workerBridge),
        true,
      ),
    ).toMatchObject({ availability: "capability-unavailable" });
  });

  it("routes lane-authorized read tools to exact cross-worker targets", async () => {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "worker-beta",
      name: "Beta",
      platform: "linux",
      architecture: "x64",
      codexVersion: "0.146.1",
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: true,
        desktop: false,
        transports: ["websocket"],
        maxSessions: 4,
      },
      startedAt: new Date().toISOString(),
    });
    const explorer = explorerSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/explorers`,
          payload: {
            title: "Beta Explorer",
            target: {
              kind: "worktree",
              projectId,
              worktreeId: betaWorktreeId,
            },
          },
        })
      ).json(),
    );
    const terminal = terminalSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/terminals`,
          payload: {
            title: "Beta Terminal",
            target: {
              kind: "worktree",
              projectId,
              worktreeId: betaWorktreeId,
            },
          },
        })
      ).json(),
    );
    const browser = browserSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/browsers`,
          payload: {
            title: "Beta Browser",
            target: { kind: "worker", projectId, workerId: "worker-beta" },
          },
        })
      ).json(),
    );
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        title: "Alpha source chat",
        worktreeId: alphaWorktreeId,
        worktreeMode: "pinned",
      },
    );
    expect(chat).not.toBeNull();
    const lane = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat!.id,
      "agent",
      "Read cross-worker targets",
    );
    expect(lane).not.toBeNull();
    const call = async (
      tool:
        | "cantrip_targets_list"
        | "cantrip_target_inspect"
        | "cantrip_explorer_list"
        | "cantrip_explorer_read"
        | "cantrip_terminal_read"
        | "cantrip_browser_services"
        | "cantrip_explorer_write"
        | "cantrip_terminal_input"
        | "cantrip_terminal_service_restart"
        | "cantrip_browser_navigate"
        | "cantrip_worktree_status",
      arguments_: Record<string, unknown>,
      callId: string,
    ) =>
      app.inject({
        method: "POST",
        url: tool.startsWith("cantrip_worktree")
          ? "/api/internal/agent-tools/worktree"
          : "/api/internal/agent-tools/execution",
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {
          arguments: arguments_,
          callId,
          chatId: chat!.id,
          executionLaneId: lane!.executionLaneId,
          tool,
          workerId: "worker-alpha",
        },
      });
    const explorerTarget = {
      kind: "surface" as const,
      projectId,
      surfaceKind: "explorer" as const,
      surfaceId: explorer.id,
    };
    const terminalTarget = {
      kind: "surface" as const,
      projectId,
      surfaceKind: "terminal" as const,
      surfaceId: terminal.id,
    };
    const browserTarget = {
      kind: "surface" as const,
      projectId,
      surfaceKind: "browser" as const,
      surfaceId: browser.id,
    };
    const cli = (
      command:
        | "status"
        | "target.list"
        | "target.show"
        | "terminal.read"
        | "worktree.create",
      arguments_: Record<string, unknown> = {},
    ) =>
      app.inject({
        method: "POST",
        url: "/api/internal/cli",
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {
          command,
          context: {
            codexThreadId: null,
            terminalId: null,
            cwd: path.join(dataDirectory, "worker-alpha"),
          },
          arguments: arguments_,
          requestId: `cli-${command}`,
          workerId: "worker-alpha",
        },
      });

    const cliStatus = await cli("status");
    expect(cliStatus.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliStatus.json()).data,
    ).toMatchObject({
      worker: { id: "worker-alpha", online: true },
      context: { projectId, worktreeId: alphaWorktreeId },
    });
    const cliCurrentTarget = await cli("target.show");
    expect(cliCurrentTarget.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliCurrentTarget.json()),
    ).toMatchObject({
      target: { kind: "worktree", worktreeId: alphaWorktreeId },
    });
    const cliTargets = await cli("target.list", { kind: "terminal" });
    expect(cliTargets.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliTargets.json()).data,
    ).toMatchObject({
      targets: expect.arrayContaining([
        expect.objectContaining({ title: "Beta Terminal" }),
      ]),
    });
    const cliTerminal = await cli("terminal.read", {
      target: "Beta Terminal",
    });
    expect(cliTerminal.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliTerminal.json()).data,
    ).toMatchObject({
      terminalId: terminal.id,
      data: "cross-worker terminal output",
    });
    const worktreesBeforeRejectedSwitch =
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId);
    const rejectedTerminalSwitch = await cli("worktree.create", {
      name: "Must not be created",
      intent: "newBranch",
      switch: true,
    });
    expect(rejectedTerminalSwitch.statusCode).toBe(409);
    expect(rejectedTerminalSwitch.json()).toMatchObject({ code: "conflict" });
    expect(
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId),
    ).toHaveLength(worktreesBeforeRejectedSwitch.length);

    const unauthorizedCli = await app.inject({
      method: "POST",
      url: "/api/internal/cli",
      payload: {
        command: "status",
        context: { codexThreadId: null, terminalId: null, cwd: null },
        arguments: {},
        requestId: "unauthorized-cli",
        workerId: "worker-alpha",
      },
    });
    expect(unauthorizedCli.statusCode).toBe(401);

    const listed = await call(
      "cantrip_targets_list",
      { limit: 1 },
      "targets-list",
    );
    expect(listed.statusCode).toBe(200);
    expect(
      agentExecutionToolResultSchema.parse(listed.json()).data,
    ).toMatchObject({
      projectId,
      targets: [expect.any(Object)],
      nextCursor: 1,
      truncated: true,
    });

    const inspected = await call(
      "cantrip_target_inspect",
      { target: terminalTarget },
      "target-inspect",
    );
    expect(inspected.statusCode).toBe(200);
    expect(
      agentExecutionToolResultSchema.parse(inspected.json()),
    ).toMatchObject({
      target: terminalTarget,
      worktreeId: betaWorktreeId,
      data: { placement: { workerId: "worker-beta" } },
    });

    const directory = await call(
      "cantrip_explorer_list",
      { target: explorerTarget, path: "" },
      "explorer-list",
    );
    expect(directory.statusCode).toBe(200);
    expect(
      agentExecutionToolResultSchema.parse(directory.json()).data,
    ).toMatchObject({ entries: [{ name: "README.md" }] });

    const file = await call(
      "cantrip_explorer_read",
      { target: explorerTarget, path: "README.md", maxChars: 12 },
      "explorer-read",
    );
    expect(file.statusCode).toBe(200);
    expect(
      agentExecutionToolResultSchema.parse(file.json()).data,
    ).toMatchObject({
      content: "cross-worker",
      truncated: true,
    });

    const terminalRead = await call(
      "cantrip_terminal_read",
      { target: terminalTarget, maxChars: 2_000 },
      "terminal-read",
    );
    expect(terminalRead.statusCode).toBe(200);
    expect(
      agentExecutionToolResultSchema.parse(terminalRead.json()).data,
    ).toMatchObject({
      terminalId: terminal.id,
      data: "cross-worker terminal output",
    });

    const services = await call(
      "cantrip_browser_services",
      { target: browserTarget },
      "browser-services",
    );
    expect(services.statusCode).toBe(200);
    expect(agentExecutionToolResultSchema.parse(services.json()).data).toEqual([
      expect.objectContaining({ workerId: "worker-beta", port: 4_173 }),
    ]);

    const worktreeStatus = await call(
      "cantrip_worktree_status",
      {
        target: {
          kind: "worktree",
          projectId,
          worktreeId: betaWorktreeId,
        },
      },
      "worktree-status",
    );
    expect(worktreeStatus.statusCode).toBe(200);
    expect(
      agentExecutionToolResultSchema.parse(worktreeStatus.json()),
    ).toMatchObject({ worktreeId: betaWorktreeId });
    expect(routedCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workerId: "worker-beta",
          command: expect.objectContaining({ type: "explorer.directory.list" }),
        }),
        expect.objectContaining({
          workerId: "worker-beta",
          command: expect.objectContaining({ type: "terminal.snapshot" }),
        }),
        expect.objectContaining({
          workerId: "worker-beta",
          command: expect.objectContaining({
            type: "browser.services.discover",
          }),
        }),
      ]),
    );

    await database.repository.updateTerminalService(
      LOCAL_USER_ID,
      terminal.id,
      { enabled: true, command: "pnpm dev" },
    );
    const write = await call(
      "cantrip_explorer_write",
      {
        target: explorerTarget,
        path: "README.md",
        content: "updated cross-worker content",
        version: "a".repeat(64),
      },
      "explorer-write",
    );
    expect(write.statusCode).toBe(200);
    expect(agentExecutionToolResultSchema.parse(write.json())).toMatchObject({
      target: explorerTarget,
      mutated: true,
      data: {
        path: "README.md",
        size: 28,
        version: "b".repeat(64),
      },
    });
    expect(JSON.stringify(write.json())).not.toContain(
      "updated cross-worker content",
    );

    const input = await call(
      "cantrip_terminal_input",
      { target: terminalTarget, data: "status\r" },
      "terminal-input",
    );
    expect(input.statusCode).toBe(200);
    expect(agentExecutionToolResultSchema.parse(input.json()).mutated).toBe(
      true,
    );

    const restarted = await call(
      "cantrip_terminal_service_restart",
      { target: terminalTarget },
      "terminal-restart",
    );
    expect(restarted.statusCode).toBe(200);
    expect(agentExecutionToolResultSchema.parse(restarted.json()).mutated).toBe(
      true,
    );

    const patchedBrowser = await app.inject({
      method: "PATCH",
      url: `/api/browsers/${browser.id}`,
      payload: { url: "https://example.com/from-app" },
    });
    expect(patchedBrowser.statusCode).toBe(200);
    expect(browserSummarySchema.parse(patchedBrowser.json()).url).toBe(
      "https://example.com/from-app",
    );

    const navigated = await call(
      "cantrip_browser_navigate",
      { target: browserTarget, url: "https://example.com/from-agent" },
      "browser-navigate",
    );
    expect(navigated.statusCode).toBe(200);
    expect(
      agentExecutionToolResultSchema.parse(navigated.json()),
    ).toMatchObject({
      target: browserTarget,
      mutated: true,
      data: { url: "https://example.com/from-agent" },
    });
    expect(
      (await database.repository.listBrowsers(LOCAL_USER_ID, projectId)).find(
        ({ id }) => id === browser.id,
      )?.url,
    ).toBe("https://example.com/from-agent");
    expect(routedCommands).toEqual(
      expect.arrayContaining([
        {
          workerId: "worker-beta",
          command: expect.objectContaining({
            type: "explorer.file.write",
            path: "README.md",
            version: "a".repeat(64),
          }),
        },
        {
          workerId: "worker-beta",
          command: expect.objectContaining({
            type: "terminal.input",
            terminalId: terminal.id,
            data: "status\r",
          }),
        },
        {
          workerId: "worker-beta",
          command: expect.objectContaining({
            type: "terminal.service.restart",
            terminalId: terminal.id,
          }),
        },
        {
          workerId: "worker-beta",
          command: expect.objectContaining({
            type: "surface.configure",
            surfaceId: browser.id,
            configuration: expect.objectContaining({
              initialUrl: "https://example.com/from-agent",
            }),
          }),
        },
      ]),
    );
    const mutationAudits = await database.repository.listAuditEvents(
      { limit: 100 },
      LOCAL_USER_ID,
    );
    expect(
      mutationAudits.items.filter(
        ({ action, result }) =>
          action === "agent.execution-target-mutated" && result === "succeeded",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: { sessionId: null, userId: null },
          resource: { id: explorer.id, type: "execution-target" },
          metadata: expect.objectContaining({
            tool: "cantrip_explorer_write",
          }),
        }),
        expect.objectContaining({
          actor: { sessionId: null, userId: null },
          resource: { id: browser.id, type: "execution-target" },
          metadata: expect.objectContaining({
            tool: "cantrip_browser_navigate",
          }),
        }),
      ]),
    );

    const spoofed = await app.inject({
      method: "POST",
      url: "/api/internal/agent-tools/execution",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: {
        arguments: { target: terminalTarget },
        callId: "spoofed-source",
        chatId: chat!.id,
        executionLaneId: lane!.executionLaneId,
        tool: "cantrip_terminal_read",
        workerId: "worker-beta",
      },
    });
    expect(spoofed.statusCode).toBe(409);
    expect(spoofed.json().error).toContain("active chat lane");

    const wrongProject = await call(
      "cantrip_terminal_read",
      { target: { ...terminalTarget, projectId: "another-project" } },
      "wrong-project",
    );
    expect(wrongProject.statusCode).toBe(409);
    expect(wrongProject.json()).toMatchObject({ code: "target-mismatch" });

    const incorrectPlacement = await call(
      "cantrip_explorer_read",
      {
        target: {
          ...terminalTarget,
          surfaceKind: "explorer",
        },
        path: "README.md",
      },
      "incorrect-placement",
    );
    expect(incorrectPlacement.statusCode).toBe(404);
    expect(incorrectPlacement.json()).toMatchObject({
      code: "target-not-found",
    });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/internal/agent-tools/execution",
      payload: {
        arguments: { target: terminalTarget },
        callId: "unauthorized",
        chatId: chat!.id,
        executionLaneId: lane!.executionLaneId,
        tool: "cantrip_terminal_read",
        workerId: "worker-alpha",
      },
    });
    expect(unauthorized.statusCode).toBe(401);

    connectedWorkers.delete("worker-beta");
    const offline = await call(
      "cantrip_terminal_read",
      { target: terminalTarget },
      "offline-target",
    );
    expect(offline.statusCode).toBe(409);
    expect(offline.json()).toMatchObject({ code: "worker-offline" });
    const offlineMutation = await call(
      "cantrip_terminal_input",
      { target: terminalTarget, data: "date\r" },
      "offline-mutation",
    );
    expect(offlineMutation.statusCode).toBe(409);
    expect(offlineMutation.json()).toMatchObject({ code: "worker-offline" });
    connectedWorkers.add("worker-beta");

    await database.repository.finishChatExecutionLane(
      chat!.id,
      lane!.executionLaneId,
      "idle",
    );
    const stale = await call(
      "cantrip_terminal_input",
      { target: terminalTarget, data: "pwd\r" },
      "stale-lane",
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("active chat lane");
    const finalMutationAudits = await database.repository.listAuditEvents(
      { limit: 100 },
      LOCAL_USER_ID,
    );
    expect(finalMutationAudits.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "agent.execution-target-mutated",
          result: "failed",
          metadata: expect.objectContaining({
            tool: "cantrip_terminal_input",
          }),
        }),
        expect.objectContaining({
          action: "agent.execution-target-mutated",
          result: "denied",
          metadata: expect.objectContaining({
            tool: "cantrip_terminal_input",
          }),
        }),
      ]),
    );
  });
});
