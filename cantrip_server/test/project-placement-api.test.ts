import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  browserWireSummarySchema,
  cantripCliCommandResultSchema,
  explorerWireSummarySchema,
  executionPlacementResolutionSchema,
  executionTargetWireCatalogSchema,
  executionTargetResolutionSchema,
  projectTabLayoutWireSummarySchema,
  terminalWireSummarySchema,
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

import {
  protectedChatFields,
  protectedBrowserFields,
  protectedBrowserRemoteSurfaceFields,
  protectedDisplayLabelFields,
  protectedExplorerFields,
  protectedProjectFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";

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
    ...protectedProjectFields(),
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
        ...protectedChatFields(),
        worktreeId: alphaWorktreeId,
        worktreeMode: "pinned",
      },
    );
    const betaChat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        ...protectedChatFields(),
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
        ...protectedBrowserFields(),
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBrowser = browserWireSummarySchema.parse(created.json());
    expect(createdBrowser).toMatchObject({
      workerId: "worker-alpha",
    });
    const staleBrowserUpdate = await app.inject({
      method: "PATCH",
      url: `/api/browsers/${createdBrowser.id}`,
      payload: {
        expectedStateRevision: createdBrowser.stateRevision + 1,
        stateProtection: protectedBrowserFields(createdBrowser.id)
          .stateProtection,
      },
    });
    expect(staleBrowserUpdate.statusCode).toBe(409);
    expect(staleBrowserUpdate.json()).toMatchObject({ code: "stale-state" });

    const terminalCreated = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/terminals`,
      payload: {
        ...protectedTerminalFields(),
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(terminalCreated.statusCode).toBe(201);
    const terminal = terminalWireSummarySchema.parse(terminalCreated.json());

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
    const catalog = executionTargetWireCatalogSchema.parse(
      catalogResponse.json(),
    );
    expect(catalog.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKind: "terminal",
          title: null,
          titleProtection: expect.objectContaining({
            classification: { recordKind: "terminal" },
          }),
          placement: expect.objectContaining({ workerId: "worker-alpha" }),
        }),
        expect.objectContaining({
          resourceKind: "browser",
          title: null,
          titleProtection: expect.objectContaining({
            classification: { recordKind: "browser" },
          }),
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
        ...protectedBrowserRemoteSurfaceFields(),
        workerId: "worker-beta",
        configuration: {
          kind: "browser",
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

  it("routes CLI operations to exact cross-worker targets", async () => {
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
    const explorer = explorerWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/explorers`,
          payload: {
            ...protectedExplorerFields(),
            target: {
              kind: "worktree",
              projectId,
              worktreeId: betaWorktreeId,
            },
          },
        })
      ).json(),
    );
    const terminal = terminalWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/terminals`,
          payload: {
            ...protectedTerminalFields(),
            target: {
              kind: "worktree",
              projectId,
              worktreeId: betaWorktreeId,
            },
          },
        })
      ).json(),
    );
    const browser = browserWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/browsers`,
          payload: {
            ...protectedBrowserFields(),
            target: { kind: "worker", projectId, workerId: "worker-beta" },
          },
        })
      ).json(),
    );
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        ...protectedChatFields(),
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
    const cli = (
      command:
        | "status"
        | "policy.list"
        | "policy.read"
        | "target.list"
        | "target.show"
        | "explorer.list"
        | "explorer.read"
        | "explorer.write"
        | "terminal.read"
        | "terminal.send"
        | "terminal.restart"
        | "browser.services"
        | "browser.open"
        | "worktree.create"
        | "worktree.status"
        | "worktree.switch",
      arguments_: Record<string, unknown> = {},
      fromChat = false,
    ) =>
      app.inject({
        method: "POST",
        url: "/api/internal/cli",
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {
          command,
          chatContext: fromChat
            ? {
                chatId: chat!.id,
                executionLaneId: lane!.executionLaneId,
              }
            : null,
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
    const hiddenPolicy = await database.repository.policies.create(
      LOCAL_USER_ID,
      {
        key: "hidden-project-policy",
        name: "Hidden project policy",
        summary: "This policy has not been assigned to the current project.",
        bodyMarkdown: "# Hidden policy\n\nDo not expose this body.",
        enabled: true,
        mandatory: false,
      },
    );
    const visiblePolicy = await database.repository.policies.create(
      LOCAL_USER_ID,
      {
        key: "visible-project-policy",
        name: "Visible project policy",
        summary: "This mandatory policy is effective in the current project.",
        bodyMarkdown: "# Visible policy",
        enabled: true,
        mandatory: true,
      },
    );
    const policyOrder = await database.repository.policies.list(LOCAL_USER_ID);
    await database.repository.policies.reorder(LOCAL_USER_ID, {
      collectionVersion: policyOrder.collectionVersion,
      policyIds: [
        visiblePolicy.id,
        hiddenPolicy.id,
        ...policyOrder.policies
          .filter(({ id }) => id !== visiblePolicy.id && id !== hiddenPolicy.id)
          .map(({ id }) => id),
      ],
    });
    const cliPolicies = await cli("policy.list");
    expect(cliPolicies.statusCode).toBe(200);
    const listedPolicies = cantripCliCommandResultSchema.parse(
      cliPolicies.json(),
    ).data as { policies: Array<{ key: string }> };
    expect(listedPolicies.policies.map(({ key }) => key)).toEqual([
      visiblePolicy.key,
      "manual-change-protocol",
      "codegraph",
    ]);
    expect(listedPolicies.policies[0]).toMatchObject({
      mandatory: true,
      sources: [{ type: "mandatory" }],
    });
    expect(JSON.stringify(cliPolicies.json())).not.toContain(
      "# Visible policy",
    );
    expect(JSON.stringify(cliPolicies.json())).not.toContain(
      hiddenPolicy.bodyMarkdown,
    );
    const cliPolicy = await cli("policy.read", {
      key: "manual-change-protocol",
    });
    expect(cliPolicy.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliPolicy.json()).data,
    ).toMatchObject({
      policy: {
        key: "manual-change-protocol",
        bodyMarkdown: expect.stringContaining("# Manual Change Protocol"),
      },
    });
    expect(JSON.stringify(cliPolicy.json())).not.toContain("rowVersion");
    const defaultPolicy = await database.repository.policies.getByKey(
      LOCAL_USER_ID,
      "manual-change-protocol",
    );
    expect(defaultPolicy).not.toBeNull();
    await database.repository.policies.update(
      LOCAL_USER_ID,
      defaultPolicy!.id,
      {
        rowVersion: defaultPolicy!.rowVersion,
        bodyMarkdown: "# Updated instructions\n\nUse the current value.",
      },
    );
    const updatedCliPolicy = await cli("policy.read", {
      key: "manual-change-protocol",
    });
    expect(
      cantripCliCommandResultSchema.parse(updatedCliPolicy.json()).data,
    ).toMatchObject({
      policy: {
        bodyMarkdown: "# Updated instructions\n\nUse the current value.",
      },
    });
    const hiddenPolicyRead = await cli("policy.read", {
      key: hiddenPolicy.key,
    });
    expect(hiddenPolicyRead.statusCode).toBe(404);
    expect(JSON.stringify(hiddenPolicyRead.json())).not.toContain(
      hiddenPolicy.bodyMarkdown,
    );
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
        expect.objectContaining({
          title: null,
          titleProtection: expect.objectContaining({
            classification: { recordKind: "terminal" },
          }),
        }),
      ]),
    });
    const cliTerminal = await cli("terminal.read", {
      target: terminal.id,
    });
    expect(cliTerminal.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliTerminal.json()).data,
    ).toMatchObject({
      terminalId: terminal.id,
      data: "cross-worker terminal output",
    });
    const cliExplorerList = await cli("explorer.list", {
      target: explorer.id,
      path: ".",
    });
    expect(cliExplorerList.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliExplorerList.json()).data,
    ).toMatchObject({ entries: [{ name: "README.md" }] });
    const cliExplorerRead = await cli("explorer.read", {
      target: explorer.id,
      path: "README.md",
    });
    expect(cliExplorerRead.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliExplorerRead.json()).data,
    ).toMatchObject({ content: "cross-worker file content" });
    const cliBrowserServices = await cli("browser.services", {
      target: browser.id,
    });
    expect(cliBrowserServices.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliBrowserServices.json()).data,
    ).toEqual([
      expect.objectContaining({ workerId: "worker-beta", port: 4_173 }),
    ]);
    const cliWorktreeStatus = await cli("worktree.status", {
      worktree: betaWorktreeId,
    });
    expect(cliWorktreeStatus.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliWorktreeStatus.json()),
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

    await database.repository.updateTerminalService(
      LOCAL_USER_ID,
      terminal.id,
      {
        enabled: true,
        stateProtection: protectedTerminalFields(terminal.id).stateProtection,
      },
    );
    const cliWrite = await cli("explorer.write", {
      target: explorer.id,
      path: "README.md",
      content: "updated cross-worker content",
    });
    expect(cliWrite.statusCode).toBe(200);
    expect(cantripCliCommandResultSchema.parse(cliWrite.json())).toMatchObject({
      target: {
        kind: "surface",
        surfaceKind: "explorer",
        surfaceId: explorer.id,
      },
      mutated: true,
      data: { path: "README.md", size: 28, version: "b".repeat(64) },
    });
    expect(JSON.stringify(cliWrite.json())).not.toContain(
      "updated cross-worker content",
    );
    const cliInput = await cli("terminal.send", {
      target: terminal.id,
      data: "status\r",
    });
    expect(cliInput.statusCode).toBe(200);
    expect(cantripCliCommandResultSchema.parse(cliInput.json()).mutated).toBe(
      true,
    );
    const cliRestart = await cli("terminal.restart", {
      target: terminal.id,
    });
    expect(cliRestart.statusCode).toBe(200);
    const cliNavigate = await cli("browser.open", {
      target: browser.id,
      expectedStateRevision: browser.stateRevision,
      stateProtection: protectedBrowserFields(browser.id).stateProtection,
    });
    expect(cliNavigate.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliNavigate.json()),
    ).toMatchObject({
      target: {
        kind: "surface",
        surfaceKind: "browser",
        surfaceId: browser.id,
      },
      mutated: true,
      data: { stateRevision: browser.stateRevision + 1 },
    });
    expect(JSON.stringify(cliNavigate.json())).not.toContain("from-cli");
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
      ]),
    );
    const mutationAudits = await database.repository.listAuditEvents(
      { limit: 100 },
      LOCAL_USER_ID,
    );
    expect(mutationAudits.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "cli.command.mutated",
          result: "succeeded",
          metadata: expect.objectContaining({ command: "explorer.write" }),
        }),
        expect.objectContaining({
          action: "cli.command.mutated",
          result: "succeeded",
          metadata: expect.objectContaining({ command: "browser.open" }),
        }),
      ]),
    );

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

    for (const obsoletePath of [
      "/api/internal/agent-tools/worktree",
      "/api/internal/agent-tools/execution",
    ]) {
      const removed = await app.inject({
        method: "POST",
        url: obsoletePath,
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {},
      });
      expect(removed.statusCode).toBe(404);
    }

    await database.repository.finishChatExecutionLane(
      chat!.id,
      lane!.executionLaneId,
      "idle",
    );
    const stale = await cli(
      "worktree.switch",
      { worktree: betaWorktreeId },
      true,
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("active chat lane");
  });

  it("keeps custom tab-group labels opaque through rename, reorder, split, and merge", async () => {
    const terminal = terminalWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/terminals`,
          payload: {
            ...protectedTerminalFields(),
            target: {
              kind: "worktree",
              projectId,
              worktreeId: alphaWorktreeId,
            },
          },
        })
      ).json(),
    );
    let layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/tab-groups`,
        })
      ).json(),
    );
    const groupId = layout.groups.find(({ members }) =>
      members.some(({ tabId }) => tabId === terminal.id),
    )!.id;
    const explorer = explorerWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/explorers`,
          payload: {
            ...protectedExplorerFields(),
            tabGroupId: groupId,
            target: {
              kind: "worktree",
              projectId,
              worktreeId: alphaWorktreeId,
            },
          },
        })
      ).json(),
    );
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/tab-groups`,
        })
      ).json(),
    );
    const renameRevision = layout.revision;
    const titleProtection = protectedDisplayLabelFields(
      "tab-group",
      groupId,
    ).titleProtection;
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tab-groups/${groupId}`,
      payload: { revision: renameRevision, titleProtection },
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      (
        renamed.json() as { groups: Array<Record<string, unknown>> }
      ).groups.find(({ id }) => id === groupId),
    ).not.toHaveProperty("title");
    layout = projectTabLayoutWireSummarySchema.parse(renamed.json());
    expect(JSON.stringify(renamed.json())).not.toContain(
      "Cycle 5 private group",
    );
    expect(layout.groups.find(({ id }) => id === groupId)).toMatchObject({
      titleProtection: {
        classification: { recordKind: "tab-group" },
      },
      members: expect.arrayContaining([
        expect.objectContaining({ tabId: terminal.id, tabKind: "terminal" }),
        expect.objectContaining({ tabId: explorer.id, tabKind: "explorer" }),
      ]),
    });

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tab-groups/${groupId}`,
      payload: { revision: renameRevision, titleProtection },
    });
    expect(stale.statusCode).toBe(409);

    const memberKeys = layout.groups
      .find(({ id }) => id === groupId)!
      .members.map(({ tabKey }) => tabKey)
      .reverse();
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/tab-groups/${groupId}/members/order`,
          payload: { revision: layout.revision, tabKeys: memberKeys },
        })
      ).json(),
    );
    expect(
      layout.groups
        .find(({ id }) => id === groupId)!
        .members.map(({ tabKey }) => tabKey),
    ).toEqual(memberKeys);

    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/tab-groups/member`,
          payload: {
            revision: layout.revision,
            tabKey: `explorer:${explorer.id}`,
            targetGroupId: null,
            targetMemberPosition: 0,
            targetGroupPosition: layout.groups.length,
          },
        })
      ).json(),
    );
    expect(
      layout.groups.find(({ id }) => id === groupId)?.titleProtection,
    ).toBeNull();
    const splitGroup = layout.groups.find(({ members }) =>
      members.some(({ tabId }) => tabId === explorer.id),
    )!;
    expect(splitGroup.titleProtection).toBeNull();

    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/tab-groups/member`,
          payload: {
            revision: layout.revision,
            tabKey: `explorer:${explorer.id}`,
            targetGroupId: groupId,
            targetMemberPosition: 1,
          },
        })
      ).json(),
    );
    expect(layout.groups.some(({ id }) => id === splitGroup.id)).toBe(false);
    expect(
      layout.groups.find(({ id }) => id === groupId)?.members,
    ).toHaveLength(2);

    const reversedGroups = layout.groups.map(({ id }) => id).reverse();
    const reordered = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tab-groups/order`,
      payload: { revision: layout.revision, groupIds: reversedGroups },
    });
    expect(reordered.statusCode).toBe(200);
    expect(
      projectTabLayoutWireSummarySchema
        .parse(reordered.json())
        .groups.map(({ id }) => id),
    ).toEqual(reversedGroups);
  });
});
