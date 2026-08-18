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
    if (command.type === "terminal.close") return { closed: true };
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "folder-worker",
    name: "Folder Worker",
    platform: "linux",
    architecture: "x64",
    codexVersion: null,
    codexRuntime: unprobedCodexRuntimeReport,
    managedFolders: { create: true, remove: true },
    remoteSurfaces: {
      browser: false,
      desktop: false,
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
      browser: false,
      desktop: false,
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
});
