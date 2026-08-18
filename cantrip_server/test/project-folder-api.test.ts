import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  projectFolderSetupJobSummarySchema,
  projectListSchema,
  projectSummarySchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  projectAutomationDispatchResultSchema,
  projectAutomationSchema,
} from "@cantrip/protocol/automations";
import {
  workflowAutomationTriggerSchema,
  workflowDefinitionDetailSchema,
} from "@cantrip/protocol/workflows";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-folder-api-"),
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

const connectedWorkers = new Set(["folder-worker"]);
const commands: Array<{ command: WorkerCommand; workerId: string }> = [];
const bridge: WorkerCommandBus = {
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
    commands.push({ workerId, command });
    if (command.type === "project.folder.materialize") {
      return {
        status: "ready",
        jobId: command.jobId,
        attempt: command.attempt,
        path: path.join(dataDirectory, "folders", command.projectId),
        displayPath: `folders/${command.projectId}`,
        reused: false,
      };
    }
    if (command.type === "project.folder.delete") return { deleted: true };
    if (command.type === "automation.condition.evaluate") {
      return { allowed: true, detail: "Condition passed." };
    }
    if (command.type === "project.folder-stats") {
      return {
        kind: "folder",
        fileCount: 0,
        byteCount: 0,
        textFileCount: 0,
        lineCount: 0,
        excludedFileCount: 0,
        truncated: false,
      };
    }
    if (command.type === "surface.desktop.probe") {
      return { available: true, message: null };
    }
    if (command.type === "surface.desktop.targets") {
      return { monitors: [], windows: [] };
    }
    if (command.type === "browser.services.discover") return [];
    if (command.type === "terminal.close") return { closed: true };
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "folder-worker",
    name: "Folder Worker",
    platform: "linux",
    architecture: "x64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    managedFolders: { create: true, remove: true },
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
      iceTransportPolicies: ["relay"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "legacy-worker",
    name: "Legacy Worker",
    platform: "linux",
    architecture: "x64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: true,
      desktop: true,
      transports: ["websocket"],
      iceTransportPolicies: ["relay"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  app = await buildApp({
    config,
    database,
    logger: false,
    workerBridge: bridge,
  });
});

afterAll(async () => {
  await app.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

async function createFolder(name = "Scratch prototype") {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/from-folder",
    payload: { name, workerId: "folder-worker" },
  });
  expect(response.statusCode).toBe(202);
  return projectSummarySchema.parse(response.json());
}

async function waitUntilReady(projectId: string) {
  return vi.waitFor(async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
    });
    const project = projectListSchema
      .parse(response.json())
      .find(({ id }) => id === projectId)!;
    expect(project.setupStatus).toBe("ready");
    return project;
  });
}

describe("managed folder project lifecycle", () => {
  it("creates duplicate display names with distinct folder roots", async () => {
    const first = await createFolder();
    const second = await createFolder();
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({
      name: "Scratch prototype",
      originKind: "managed-folder",
      setupStatus: "preparing",
      capabilities: {
        git: false,
        github: false,
        worktrees: false,
        replicas: false,
        relocation: false,
      },
    });
    await waitUntilReady(first.id);
    await waitUntilReady(second.id);

    const firstRoots = await database.repository.listProjectWorktrees(
      LOCAL_USER_ID,
      first.id,
    );
    const secondRoots = await database.repository.listProjectWorktrees(
      LOCAL_USER_ID,
      second.id,
    );
    expect(firstRoots).toEqual([
      expect.objectContaining({
        rootKind: "folder-root",
        workerId: "folder-worker",
        isPrimary: true,
        isDefault: true,
      }),
    ]);
    expect(firstRoots[0]?.path).not.toBe(secondRoots[0]?.path);

    expect(
      await app.inject({
        method: "DELETE",
        url: `/api/projects/${first.id}`,
        payload: { deleteLocalFiles: false },
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      commands.some(
        ({ command }) =>
          command.type === "project.folder.delete" &&
          command.projectId === first.id,
      ),
    ).toBe(false);

    expect(
      await app.inject({
        method: "DELETE",
        url: `/api/projects/${second.id}`,
        payload: { deleteLocalFiles: true },
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(commands.at(-1)).toEqual({
      workerId: "folder-worker",
      command: { type: "project.folder.delete", projectId: second.id },
    });
  });

  it("refuses creation on workers without the additive capability", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/from-folder",
      payload: { name: "Legacy", workerId: "legacy-worker" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "managed-folder-capability-unavailable",
    });
  });

  it("keeps offline setup durable and resumes through explicit retry", async () => {
    connectedWorkers.delete("folder-worker");
    const project = await createFolder("Offline setup");
    const blocked = await vi.waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/folder-setup`,
      });
      const job = projectFolderSetupJobSummarySchema.parse(response.json());
      expect(job.state).toBe("blocked");
      expect(job.error?.code).toBe("worker-offline");
      return job;
    });
    const durable = projectListSchema
      .parse(
        (
          await app.inject({
            method: "GET",
            url: "/api/projects",
          })
        ).json(),
      )
      .find(({ id }) => id === project.id)!;
    expect(durable).toMatchObject({
      setupStatus: "preparing",
      source: null,
    });

    connectedWorkers.add("folder-worker");
    const retry = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/folder-setup/retry`,
      payload: { stateRevision: blocked.stateRevision },
    });
    expect(retry.statusCode).toBe(200);
    await waitUntilReady(project.id);
  });

  it("never unlinks when requested local deletion cannot reach the owner", async () => {
    const project = await createFolder("Offline deletion");
    await waitUntilReady(project.id);
    connectedWorkers.delete("folder-worker");
    const response = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: { deleteLocalFiles: true },
    });
    expect(response.statusCode).toBe(503);
    expect(
      (await database.repository.getProject(LOCAL_USER_ID, project.id))
        ?.originKind,
    ).toBe("managed-folder");
    connectedWorkers.add("folder-worker");
    expect(
      await app.inject({
        method: "DELETE",
        url: `/api/projects/${project.id}`,
        payload: { deleteLocalFiles: false },
      }),
    ).toMatchObject({ statusCode: 204 });
  });

  it("binds every runtime surface and target to the folder owner", async () => {
    const project = await createFolder("Runtime folder");
    const ready = await waitUntilReady(project.id);
    const root = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, project.id)
    )[0]!;

    for (const [suffix, payload] of [
      ["chats", { title: "Folder agent" }],
      ["tasks", { title: "Folder task" }],
      ["terminals", { title: "Folder terminal" }],
      ["explorers", { title: "Folder explorer" }],
      ["code-tabs", { title: "Folder code" }],
      ["browsers", { title: "Folder browser" }],
      ["remote-desktops", {}],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/${suffix}`,
        payload,
      });
      expect(response.statusCode, `${suffix}: ${response.body}`).toBe(201);
    }

    const resolved = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/placement/resolve`,
      payload: { surfaceKind: "browser" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      placement: {
        workerId: "folder-worker",
        projectReplicaId: ready.source!.id,
        worktreeId: root.id,
      },
    });

    const wrongWorker = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/placement/resolve`,
      payload: {
        surfaceKind: "terminal",
        target: {
          kind: "worker",
          projectId: project.id,
          workerId: "legacy-worker",
        },
      },
    });
    expect(wrongWorker.statusCode).toBe(409);
    expect(wrongWorker.json()).toMatchObject({ code: "target-mismatch" });

    const catalog = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/execution-targets`,
    });
    expect(catalog.statusCode).toBe(200);
    const catalogPayload = catalog.json();
    expect(catalogPayload.targets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceKind: "replica" }),
      ]),
    );
    expect(catalogPayload.targets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceKind: "worktree" }),
      ]),
    );
    expect(
      catalogPayload.targets.every(
        (target: { placement: { workerId: string } }) =>
          target.placement.workerId === "folder-worker",
      ),
    ).toBe(true);

    const chatTarget = catalogPayload.targets.find(
      (target: { resourceKind: string }) => target.resourceKind === "chat",
    );
    expect(chatTarget).toBeDefined();
    const chatId = chatTarget!.target.surfaceId as string;
    for (const request of [
      {
        method: "PATCH" as const,
        url: `/api/chats/${chatId}/worktree`,
        payload: { worktreeId: root.id, mode: "pinned" },
        capability: "worktrees",
      },
      {
        method: "GET" as const,
        url: `/api/chats/${chatId}/relocations`,
        capability: "relocation",
      },
      {
        method: "POST" as const,
        url: `/api/projects/${project.id}/views`,
        payload: { title: "History", kind: "history" },
        capability: "git",
      },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "project-capability-unavailable",
        capability: request.capability,
      });
    }

    expect(
      await database.repository.listWorkerWorktreeObservationTargets(
        LOCAL_USER_ID,
        "folder-worker",
      ),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: project.id }),
      ]),
    );
    expect(
      await database.repository.listWorkerExecutionRootContexts(
        LOCAL_USER_ID,
        "folder-worker",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: project.id,
          rootKind: "folder-root",
          worktreePath: root.path,
        }),
      ]),
    );

    const stats = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/repository-stats`,
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toMatchObject({ kind: "folder", fileCount: 0 });
    expect(commands.at(-1)).toMatchObject({
      workerId: "folder-worker",
      command: { type: "project.folder-stats", root: root.path },
    });

    for (const fleetPath of ["browser-services", "remote-desktop-fleet"]) {
      const fleet = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/${fleetPath}`,
      });
      expect(fleet.statusCode).toBe(200);
      expect(fleet.json().workers).toEqual([
        expect.objectContaining({ workerId: "folder-worker" }),
      ]);
    }

    const wrongTunnel = await app.inject({
      method: "POST",
      url: "/api/tunnels",
      payload: {
        name: "Wrong worker",
        projectId: project.id,
        protocolHint: "http",
        destination: {
          kind: "worker-tcp",
          workerId: "legacy-worker",
          host: "127.0.0.1",
          port: 4_173,
        },
      },
    });
    expect(wrongTunnel.statusCode).toBe(409);
    expect(wrongTunnel.json()).toMatchObject({
      error: "This worker-managed folder is bound to its owning worker.",
    });

    const ownerTunnel = await app.inject({
      method: "POST",
      url: "/api/tunnels",
      payload: {
        name: "Folder preview",
        projectId: project.id,
        protocolHint: "http",
        destination: {
          kind: "worker-tcp",
          workerId: "folder-worker",
          host: "127.0.0.1",
          port: 4_173,
        },
      },
    });
    expect(ownerTunnel.statusCode).toBe(201);
  });

  it("keeps scheduled prompts and non-Git workflow triggers available", async () => {
    const project = await createFolder("Automated folder");
    await waitUntilReady(project.id);
    const root = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, project.id)
    )[0]!;
    const chatResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/chats`,
      payload: { title: "Scheduled folder work" },
    });
    expect(chatResponse.statusCode).toBe(201);
    const chatId = (chatResponse.json() as { id: string }).id;
    await database.repository.setChatAutomationPaused(
      LOCAL_USER_ID,
      chatId,
      true,
    );
    const startsAt = new Date(Date.now() + 10_000).toISOString();
    const createAutomationResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/automations`,
      payload: {
        name: "Folder review",
        chatId,
        prompt: "Review the current folder contents.",
        schedule: {
          kind: "interval",
          every: 5,
          unit: "minute",
          startsAt,
        },
        condition: { type: "script", script: "test -f README.md" },
        enabled: true,
      },
    });
    expect(createAutomationResponse.statusCode).toBe(201);
    const automation = projectAutomationSchema.parse(
      createAutomationResponse.json(),
    );
    const dispatch = await app.inject({
      method: "POST",
      url: `/api/internal/workers/automations/${automation.id}/dispatch?workerId=folder-worker`,
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: {
        revision: automation.revision,
        scheduledFor: automation.nextRunAt,
      },
    });
    expect(dispatch.statusCode).toBe(202);
    expect(
      projectAutomationDispatchResultSchema.parse(dispatch.json()),
    ).toMatchObject({ accepted: true, status: "queued" });
    expect(commands.at(-1)).toEqual({
      workerId: "folder-worker",
      command: {
        type: "automation.condition.evaluate",
        condition: { type: "script", script: "test -f README.md" },
        cwd: root.path,
        repository: null,
      },
    });

    const openIssues = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/automations`,
      payload: {
        name: "Issue review",
        chatId,
        prompt: "Review open issues.",
        schedule: {
          kind: "interval",
          every: 5,
          unit: "minute",
          startsAt,
        },
        condition: { type: "open-issues", minimum: 1 },
        enabled: true,
      },
    });
    expect(openIssues.statusCode).toBe(409);
    expect(openIssues.json()).toMatchObject({
      code: "project-capability-unavailable",
      capability: "github",
    });
    const updateToOpenIssues = await app.inject({
      method: "PATCH",
      url: `/api/automations/${automation.id}`,
      payload: { condition: { type: "open-issues", minimum: 1 } },
    });
    expect(updateToOpenIssues.statusCode).toBe(409);
    expect(updateToOpenIssues.json()).toMatchObject({
      code: "project-capability-unavailable",
      capability: "github",
    });

    const preauthorized = {
      filesystem: "read-only",
      network: "none",
      approvalMode: "preauthorized",
      skills: [],
      mcpServers: [],
      nativeSubagents: false,
    } as const;
    const workflowResponse = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: {
        scope: "project",
        projectId: project.id,
        slug: "scheduled-folder-review",
        name: "Scheduled folder review",
        trustState: "trusted",
        revision: {
          graph: {
            version: 1,
            nodes: [
              {
                key: "gate",
                type: "gate",
                name: "Folder gate",
                configuration: { prompt: "Approve completion." },
                permissionRequirements: preauthorized,
              },
            ],
            edges: [],
          },
          permissionRequirements: preauthorized,
          trustState: "trusted",
        },
      },
    });
    expect(workflowResponse.statusCode).toBe(201);
    const revisionId = workflowDefinitionDetailSchema.parse(
      workflowResponse.json(),
    ).revision!.id;
    const triggerBase = {
      workflowRevisionId: revisionId,
      projectId: project.id,
      name: "Folder automation",
      enabled: true,
      structuredInput: {},
      permissionManifest: preauthorized,
    };
    const scheduleTrigger = await app.inject({
      method: "POST",
      url: "/api/workflow-triggers",
      payload: {
        ...triggerBase,
        type: "schedule",
        configuration: {
          intervalSeconds: 60,
          startAt: startsAt,
          catchUpPolicy: "once",
          offlinePolicy: "pause",
        },
      },
    });
    expect(scheduleTrigger.statusCode).toBe(201);
    expect(
      workflowAutomationTriggerSchema.parse(scheduleTrigger.json()),
    ).toMatchObject({ type: "schedule", projectId: project.id });

    const gitTrigger = await app.inject({
      method: "POST",
      url: "/api/workflow-triggers",
      payload: {
        ...triggerBase,
        type: "git",
        configuration: {
          event: "push",
          branchPattern: "*",
          minimumIntervalSeconds: 1,
        },
      },
    });
    expect(gitTrigger.statusCode).toBe(409);
    expect(gitTrigger.json()).toMatchObject({
      code: "project-capability-unavailable",
      capability: "git",
    });
  });

  it("keeps durable state readable offline and rejects folder worktree CLI commands", async () => {
    const project = await createFolder("Offline runtime");
    const ready = await waitUntilReady(project.id);
    const root = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, project.id)
    )[0]!;

    const unsupported = await app.inject({
      method: "POST",
      url: "/api/internal/cli",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: {
        command: "worktree.list",
        chatContext: null,
        context: {
          codexThreadId: null,
          terminalId: null,
          cwd: root.path,
        },
        arguments: {},
        requestId: "folder-worktree-list",
        workerId: "folder-worker",
      },
    });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json()).toEqual({
      code: "unsupported-capability",
      error:
        "This worker-managed folder does not support Cantrip worktree commands.",
    });

    connectedWorkers.delete("folder-worker");
    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    expect(projects.statusCode).toBe(200);
    expect(
      projectListSchema
        .parse(projects.json())
        .find(({ id }) => id === project.id),
    ).toMatchObject({ id: project.id, source: ready.source });
    const placement = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/placement/resolve`,
      payload: { surfaceKind: "terminal" },
    });
    expect(placement.statusCode).toBe(409);
    expect(placement.json()).toMatchObject({
      code: "worker-offline",
    });
    connectedWorkers.add("folder-worker");
  });
});
