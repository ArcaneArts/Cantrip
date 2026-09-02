import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cantripCliCommandResultSchema,
  projectFolderSetupJobSummarySchema,
  projectGithubConversionJobSummarySchema,
  projectGithubConversionPreflightResultSchema,
  projectWorktreeListSchema,
  projectWireListSchema,
  projectWireSummarySchema,
  encryptedChatTurnCreateSchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  encryptedProjectAutomationCreateSchema,
  projectAutomationDispatchResultSchema,
  projectAutomationWireSchema,
} from "@cantrip/protocol/automations";
import type { TaskOpaqueContent } from "@cantrip/protocol/tasks";
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
import {
  protectedProjectFields,
  protectedRemoteDesktopFields,
  protectedRemoteDesktopInventory,
} from "./private-label-fixture.js";

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

const encryptedTaskFixture = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

function protectedBytes(seed: string, count: number): string {
  return createHash("sha256")
    .update(seed)
    .digest()
    .subarray(0, count)
    .toString("base64url");
}

function protectedWorkflowEnvelope(seed: string) {
  return {
    formatVersion: 1 as const,
    keyRevision: 1,
    envelope: {
      version: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      nonce: protectedBytes(`${seed}:nonce`, 12),
      ciphertext: protectedBytes(`${seed}:ciphertext`, 32),
    },
  };
}

function protectedAutomationTurn(
  command: Extract<WorkerCommand, { type: "automation.dispatch.protect" }>,
) {
  const classification = {
    role: "user" as const,
    mode: command.mode,
    attachmentIds: [],
  };
  const message = {
    id: command.messageId,
    classification,
    protectedContent: protectedWorkflowEnvelope("folder-automation-message"),
    reasoningEffort: command.reasoningEffort,
    idempotencyKey: command.idempotencyKey,
  };
  return encryptedChatTurnCreateSchema.parse({
    message,
    queuedPrompt: {
      id: command.promptId,
      classification: { mode: command.mode, attachmentIds: [] },
      protectedContent: protectedWorkflowEnvelope("folder-automation-prompt"),
      modelId: command.modelId,
      reasoningEffort: command.reasoningEffort,
      worktreeId: null,
      frozen: false,
      idempotencyKey: command.idempotencyKey,
      pendingMessage: message,
    },
    modelId: command.modelId,
  });
}

function opaqueTaskDraft(): TaskOpaqueContent {
  return {
    classification: {
      state: "draft",
      stableStateBeforeFailure: null,
      activeOperationKind: null,
      planAuthorship: "agent",
      planningRound: 0,
      hasPlan: false,
      hasQuestions: false,
      hasFinalPlan: false,
      hasGoalPrompt: false,
      lastError: null,
    },
    protectedContent: encryptedTaskFixture,
  };
}

const connectedWorkers = new Set(["folder-worker"]);
const commands: Array<{ command: WorkerCommand; workerId: string }> = [];
const authenticatedAttachedPath = `ctrr_${"A".repeat(43)}`;
let releaseHeldConversion: (() => void) | null = null;
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
      const target =
        command.existingPath ??
        path.join(dataDirectory, "folders", command.projectId);
      const repositoryDetected = target === authenticatedAttachedPath;
      return {
        status: "ready",
        jobId: command.jobId,
        attempt: command.attempt,
        path: target,
        displayPath: command.existingPath ?? `folders/${command.projectId}`,
        reused: Boolean(command.existingPath),
        repositoryFingerprint: repositoryDetected ? "d".repeat(64) : null,
        github: repositoryDetected
          ? {
              repositoryId: "detected-repository",
              nameWithOwner: "ArcaneArts/Detected",
              url: "https://github.com/ArcaneArts/Detected",
            }
          : null,
      };
    }
    if (command.type === "project.folder.delete") return { deleted: true };
    if (command.type === "project.folder-conversion.preflight") {
      return {
        status: "ready",
        projectId: command.projectId,
        repository: command.repository,
        confirmationToken: "a".repeat(64),
        localState: "not-initialized",
        branch: null,
        head: null,
        dirty: false,
        originUrl: null,
        requiresInitialCommit: true,
        warnings: ["Conversion is one-way in V1."],
      };
    }
    if (command.type === "project.folder-conversion.execute") {
      if (command.repository.repositoryId === "held-conversion-repository") {
        await new Promise<void>((resolve) => {
          releaseHeldConversion = resolve;
        });
      }
      return {
        status: "ready",
        jobId: command.jobId,
        attempt: command.attempt,
        repository: command.repository,
        path: path.join(dataDirectory, "folders", command.projectId),
        displayPath: `folders/${command.projectId}`,
        repositoryFingerprint: "b".repeat(64),
        branch: "main",
        head: "c".repeat(40),
        worktreePolicy: "agent-managed",
      };
    }
    if (command.type === "automation.dispatch.protect") {
      return {
        allowed: true,
        protectedTurn: protectedAutomationTurn(command),
      };
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
      return {
        operationId: command.operationId,
        stateProtection: protectedRemoteDesktopInventory(),
        monitorCount: 0,
        windowCount: 0,
        truncated: false,
      };
    }
    if (command.type === "browser.services.discover") return [];
    if (command.type === "terminal.close") return { closed: true };
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;

function protectedTunnelRecord(operationId: string) {
  return {
    operationId,
    revision: 1,
    protectedContent: {
      formatVersion: 1,
      domain: "tunnel-content" as const,
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  };
}

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
    managedFolders: {
      create: true,
      attachExisting: true,
      convertToGithub: true,
      remove: true,
    },
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

async function createFolder(_name = "Scratch prototype") {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/from-folder",
    payload: { ...protectedProjectFields(), workerId: "folder-worker" },
  });
  expect(response.statusCode).toBe(202);
  return projectWireSummarySchema.parse(response.json());
}

async function waitUntilReady(projectId: string) {
  return vi.waitFor(async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
    });
    const project = projectWireListSchema
      .parse(response.json())
      .find(({ id }) => id === projectId)!;
    expect(project.setupStatus).toBe("ready");
    return project;
  });
}

describe("managed folder project lifecycle", () => {
  it("enables Git and GitHub surfaces for an authenticated attached checkout", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/from-folder",
      payload: {
        existingPath: authenticatedAttachedPath,
        ...protectedProjectFields(),
        workerId: "folder-worker",
      },
    });
    expect(response.statusCode).toBe(202);
    const ready = await waitUntilReady(
      projectWireSummarySchema.parse(response.json()).id,
    );

    expect(ready.capabilities).toEqual({
      git: true,
      github: true,
      worktrees: false,
      replicas: false,
      relocation: false,
    });
    expect(ready.source?.sourceKind).toBe("git");
    expect(ready.github).toMatchObject({
      repositoryId: "detected-repository",
      nameWithOwner: "ArcaneArts/Detected",
    });
    expect(ready.replicas[0]?.repositoryFingerprint).toBe("d".repeat(64));
    expect(
      (
        await database.repository.listProjectWorktrees(LOCAL_USER_ID, ready.id)
      )[0]?.rootKind,
    ).toBe("git-worktree");
  });

  it("attaches an existing worker folder without taking deletion ownership", async () => {
    const existingPath = path.join(dataDirectory, "outside-managed-root");
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/from-folder",
      payload: {
        existingPath,
        ...protectedProjectFields(),
        workerId: "folder-worker",
      },
    });
    expect(response.statusCode).toBe(202);
    const created = projectWireSummarySchema.parse(response.json());
    expect(created.folderManagement).toBe("external");
    const ready = await waitUntilReady(created.id);
    expect(ready).toMatchObject({
      folderManagement: "external",
      source: { path: existingPath },
    });
    expect(
      commands.find(
        ({ command }) =>
          command.type === "project.folder.materialize" &&
          command.projectId === created.id,
      )?.command,
    ).toMatchObject({ existingPath });
    expect(
      (
        await database.repository.listProjectWorktrees(
          LOCAL_USER_ID,
          created.id,
        )
      )[0],
    ).toMatchObject({ origin: "external", path: existingPath });

    const conversion = await app.inject({
      method: "POST",
      url: `/api/projects/${created.id}/github-conversion/preflight`,
      payload: {
        repository: {
          repositoryId: "external-folder-conversion",
          nameWithOwner: "ArcaneArts/ExternalFolder",
          url: "https://github.com/ArcaneArts/ExternalFolder",
        },
      },
    });
    expect(conversion.statusCode).toBe(409);

    const deleteFiles = await app.inject({
      method: "DELETE",
      url: `/api/projects/${created.id}`,
      payload: { deleteLocalFiles: true },
    });
    expect(deleteFiles.statusCode).toBe(409);
    expect(deleteFiles.json()).toMatchObject({
      code: "external-folder-delete-forbidden",
    });
    expect(
      commands.some(
        ({ command }) =>
          command.type === "project.folder.delete" &&
          command.projectId === created.id,
      ),
    ).toBe(false);

    expect(
      await app.inject({
        method: "DELETE",
        url: `/api/projects/${created.id}`,
        payload: { deleteLocalFiles: false },
      }),
    ).toMatchObject({ statusCode: 204 });
  });

  it("creates duplicate display names with distinct folder roots", async () => {
    const first = await createFolder();
    const second = await createFolder();
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({
      nameProtection: { classification: { recordKind: "project" } },
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
      payload: { ...protectedProjectFields(), workerId: "legacy-worker" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "managed-folder-capability-unavailable",
    });
  });

  it("rejects unknown workers and invalid workspace assignments before setup", async () => {
    const unknownWorker = await app.inject({
      method: "POST",
      url: "/api/projects/from-folder",
      payload: { ...protectedProjectFields(), workerId: "missing-worker" },
    });
    expect(unknownWorker.statusCode).toBe(404);
    expect(unknownWorker.json()).toEqual({ error: "Worker not found." });

    const unknownWorkspace = await app.inject({
      method: "POST",
      url: "/api/projects/from-folder",
      payload: {
        ...protectedProjectFields(),
        workerId: "folder-worker",
        workspaceId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb999",
      },
    });
    expect(unknownWorkspace.statusCode).toBe(400);
    expect(unknownWorkspace.json()).toMatchObject({
      error: expect.stringContaining("workspace"),
    });

    const legacyMultipleWorkspaces = await app.inject({
      method: "POST",
      url: "/api/projects/from-folder",
      payload: {
        ...protectedProjectFields(),
        workerId: "folder-worker",
        workspaceIds: ["workspace-a", "workspace-b"],
      },
    });
    expect(legacyMultipleWorkspaces.statusCode).toBe(400);
    expect(legacyMultipleWorkspaces.json()).toMatchObject({
      error: "Invalid request body",
    });
  });

  it("converts only after explicit preflight, push reconciliation, and atomic kind transition", async () => {
    const project = await createFolder("Convert me");
    const ready = await waitUntilReady(project.id);
    const sourceId = ready.source!.id;
    const rootBefore = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, project.id)
    )[0]!;
    const repository = {
      repositoryId: "conversion-repository-42",
      nameWithOwner: "ArcaneArts/ConvertedFolder",
      url: "https://github.com/ArcaneArts/ConvertedFolder",
    };

    const preflightResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/github-conversion/preflight`,
      payload: { repository },
    });
    expect(preflightResponse.statusCode).toBe(200);
    const preflight = projectGithubConversionPreflightResultSchema.parse(
      preflightResponse.json(),
    );
    expect(preflight).toMatchObject({
      status: "ready",
      requiresInitialCommit: true,
    });
    if (preflight.status !== "ready") throw new Error("preflight failed");
    expect(
      commands.find(
        ({ command }) =>
          command.type === "project.folder-conversion.preflight" &&
          command.projectId === project.id,
      )?.command,
    ).not.toHaveProperty("path");

    const startResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/github-conversion`,
      payload: {
        repository,
        confirmationToken: preflight.confirmationToken,
        initialCommit: { message: "Initial commit" },
      },
    });
    expect(startResponse.statusCode).toBe(202);
    expect(
      projectGithubConversionJobSummarySchema.parse(startResponse.json()),
    ).toMatchObject({
      projectId: project.id,
      state: "queued",
      initialCommitRequested: true,
    });

    const converted = await vi.waitFor(async () => {
      const current = await database.repository.getProject(
        LOCAL_USER_ID,
        project.id,
      );
      expect(current?.originKind).toBe("github");
      return current!;
    });
    expect(converted).toMatchObject({
      id: project.id,
      source: {
        id: sourceId,
        sourceKind: "git",
        path: ready.source!.path,
      },
      github: {
        repositoryId: repository.repositoryId,
        nameWithOwner: repository.nameWithOwner,
        url: repository.url,
      },
      capabilities: {
        git: true,
        github: true,
        worktrees: true,
        replicas: true,
        relocation: true,
      },
    });
    expect(
      await database.repository.listProjectReplicas(LOCAL_USER_ID, project.id),
    ).toEqual([
      expect.objectContaining({
        id: sourceId,
        sourceKind: "git",
        repositoryFingerprint: "b".repeat(64),
      }),
    ]);
    const rootAfter = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, project.id)
    )[0]!;
    expect(rootAfter).toMatchObject({
      id: rootBefore.id,
      rootKind: "git-worktree",
      path: rootBefore.path,
      branch: "main",
      head: "c".repeat(40),
    });
    expect(
      commands.find(
        ({ command }) =>
          command.type === "project.folder-conversion.execute" &&
          command.projectId === project.id,
      )?.command,
    ).not.toHaveProperty("path");

    const collisionProject = await createFolder("Collision");
    await waitUntilReady(collisionProject.id);
    const collision = await app.inject({
      method: "POST",
      url: `/api/projects/${collisionProject.id}/github-conversion/preflight`,
      payload: { repository },
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({
      code: "repository-collision",
    });

    const deletionCommandsStart = commands.length;
    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: { deleteLocalFiles: true },
    });
    expect(deletion.statusCode).toBe(204);
    expect(commands.slice(deletionCommandsStart)).toContainEqual({
      workerId: "folder-worker",
      command: { type: "project.folder.delete", projectId: project.id },
    });
    expect(
      commands
        .slice(deletionCommandsStart)
        .some(({ command }) => command.type === "project.files.delete"),
    ).toBe(false);
  });

  it("requires the owning worker online for conversion preflight", async () => {
    const project = await createFolder("Offline conversion");
    await waitUntilReady(project.id);
    connectedWorkers.delete("folder-worker");
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/github-conversion/preflight`,
      payload: {
        repository: {
          repositoryId: "offline-conversion-repository",
          nameWithOwner: "ArcaneArts/OfflineConversion",
          url: "https://github.com/ArcaneArts/OfflineConversion",
        },
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "worker-offline" });
    connectedWorkers.add("folder-worker");
  });

  it("refuses project deletion while a durable conversion is active", async () => {
    const project = await createFolder("Held conversion");
    await waitUntilReady(project.id);
    const repository = {
      repositoryId: "held-conversion-repository",
      nameWithOwner: "ArcaneArts/HeldConversion",
      url: "https://github.com/ArcaneArts/HeldConversion",
    };
    const preflightResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/github-conversion/preflight`,
      payload: { repository },
    });
    const preflight = projectGithubConversionPreflightResultSchema.parse(
      preflightResponse.json(),
    );
    if (preflight.status !== "ready") throw new Error("preflight failed");
    const start = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/github-conversion`,
      payload: {
        repository,
        confirmationToken: preflight.confirmationToken,
        initialCommit: { message: "Initial commit" },
      },
    });
    expect(start.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/github-conversion`,
      });
      expect(
        projectGithubConversionJobSummarySchema.parse(response.json()).state,
      ).toBe("running");
    });

    const removal = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: { deleteLocalFiles: false },
    });
    expect(removal.statusCode).toBe(409);
    expect(removal.json()).toMatchObject({
      error: expect.stringContaining("active GitHub conversion"),
    });

    releaseHeldConversion?.();
    releaseHeldConversion = null;
    await vi.waitFor(async () => {
      expect(
        (await database.repository.getProject(LOCAL_USER_ID, project.id))
          ?.originKind,
      ).toBe("github");
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
    const durable = projectWireListSchema
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

  it("lists the Primary folder root for read-only execution consumers", async () => {
    const project = await createFolder("Readable folder root");
    await waitUntilReady(project.id);
    const root = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, project.id)
    )[0]!;
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/worktrees`,
    });

    expect(response.statusCode).toBe(200);
    expect(projectWorktreeListSchema.parse(response.json())).toEqual([
      expect.objectContaining({
        id: root.id,
        rootKind: "folder-root",
        isPrimary: true,
      }),
    ]);
  });

  it("binds every runtime surface and target to the folder owner", async () => {
    const project = await createFolder("Runtime folder");
    const ready = await waitUntilReady(project.id);
    const root = (
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, project.id)
    )[0]!;

    for (const [suffix, payload] of [
      ["chats", { title: "Folder agent" }],
      [
        "tasks",
        {
          chatId: randomUUID(),
          title: "Folder task",
          task: opaqueTaskDraft(),
        },
      ],
      ["terminals", { title: "Folder terminal" }],
      ["explorers", { title: "Folder explorer" }],
      ["code-tabs", { title: "Folder code" }],
      ["browsers", { title: "Folder browser" }],
      ["remote-desktops", protectedRemoteDesktopFields()],
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

    const wrongTunnelId = randomUUID();
    const wrongTunnel = await app.inject({
      method: "POST",
      url: "/api/tunnels",
      payload: {
        id: wrongTunnelId,
        projectId: project.id,
        protocolHint: "http",
        destination: {
          kind: "worker-tcp",
          workerId: "legacy-worker",
        },
        protectedRecord: protectedTunnelRecord(wrongTunnelId),
      },
    });
    expect(wrongTunnel.statusCode).toBe(409);
    expect(wrongTunnel.json()).toMatchObject({
      error: "This worker-managed folder is bound to its owning worker.",
    });

    const ownerTunnelId = randomUUID();
    const ownerTunnel = await app.inject({
      method: "POST",
      url: "/api/tunnels",
      payload: {
        id: ownerTunnelId,
        projectId: project.id,
        protocolHint: "http",
        destination: {
          kind: "worker-tcp",
          workerId: "folder-worker",
        },
        protectedRecord: protectedTunnelRecord(ownerTunnelId),
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
    const automationInput = encryptedProjectAutomationCreateSchema.parse({
      id: randomUUID(),
      chatId,
      schedule: {
        kind: "interval",
        every: 5,
        unit: "minute",
        startsAt,
      },
      enabled: true,
      content: {
        protectedName: protectedWorkflowEnvelope("folder-review-name"),
        protectedPrompt: protectedWorkflowEnvelope("folder-review-prompt"),
        protectedCondition: protectedWorkflowEnvelope(
          "folder-review-condition",
        ),
      },
    });
    const createAutomationResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/automations`,
      payload: automationInput,
    });
    expect(createAutomationResponse.statusCode).toBe(201);
    const automation = projectAutomationWireSchema.parse(
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
    expect(commands.at(-1)).toMatchObject({
      workerId: "folder-worker",
      command: {
        type: "automation.dispatch.protect",
        automationId: automation.id,
        content: automationInput.content,
        cwd: root.path,
        repository: null,
      },
    });

    const openIssues = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/automations`,
      payload: encryptedProjectAutomationCreateSchema.parse({
        id: randomUUID(),
        chatId,
        schedule: {
          kind: "interval",
          every: 5,
          unit: "minute",
          startsAt,
        },
        enabled: true,
        content: {
          protectedName: protectedWorkflowEnvelope("issue-review-name"),
          protectedPrompt: protectedWorkflowEnvelope("issue-review-prompt"),
          protectedCondition: protectedWorkflowEnvelope(
            "issue-review-condition",
          ),
        },
      }),
    });
    expect(openIssues.statusCode).toBe(201);

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

    const fullCatalog = vi.spyOn(
      database.repository,
      "listProjectExecutionTargets",
    );
    const invokeTargetCommand = (
      command: "target.show" | "target.resolve-browser",
    ) =>
      app.inject({
        method: "POST",
        url: "/api/internal/cli",
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {
          command,
          chatContext: null,
          context: {
            codexThreadId: null,
            terminalId: null,
            cwd: root.path,
          },
          arguments: {},
          requestId: `folder-${command}`,
          workerId: "folder-worker",
        },
      });
    const shownTarget = await invokeTargetCommand("target.show");
    expect(shownTarget.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(shownTarget.json()),
    ).toMatchObject({
      target: {
        kind: "worker",
        projectId: project.id,
        workerId: "folder-worker",
      },
    });
    const browserFallback = await invokeTargetCommand("target.resolve-browser");
    expect(browserFallback.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(browserFallback.json()),
    ).toMatchObject({
      target: {
        kind: "worker",
        projectId: project.id,
        workerId: "folder-worker",
      },
    });
    expect(fullCatalog).not.toHaveBeenCalled();
    fullCatalog.mockRestore();

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
      projectWireListSchema
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
