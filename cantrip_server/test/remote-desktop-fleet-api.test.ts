import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  remoteDesktopFleetWireSchema,
  remoteDesktopWireSummarySchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import {
  protectedDisplayLabelFields,
  protectedProjectFields,
  protectedRemoteDesktopFields,
  protectedRemoteDesktopInventory,
  protectedRemoteDesktopState,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-remote-desktop-fleet-api-"),
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

const connectedWorkers = new Set([
  "primary-worker",
  "healthy-worker",
  "failing-worker",
]);
const requested: Array<{ workerId: string; command: WorkerCommand }> = [];
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
    requested.push({ workerId, command });
    if (command.type === "surface.desktop.targets") {
      if (workerId === "failing-worker") {
        throw new Error("Worker command surface.desktop.targets timed out.");
      }
      return {
        operationId: command.operationId,
        stateProtection: protectedRemoteDesktopInventory(),
        monitorCount: 1,
        windowCount: 1,
        truncated: false,
      };
    }
    if (command.type === "surface.desktop.probe") {
      return { available: true, message: null };
    }
    if (command.type === "surface.configure") return { accepted: true };
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let createdDesktopId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  for (const [workerId, name, desktop] of [
    ["primary-worker", "Primary Mac", true],
    ["healthy-worker", "Healthy Linux", true],
    ["offline-worker", "Offline PC", true],
    ["failing-worker", "Slow Worker", true],
    ["unsupported-worker", "No Desktop", false],
  ] as const) {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId,
      name,
      platform: workerId.includes("Mac") ? "darwin" : "linux",
      architecture: "arm64",
      codexVersion: "0.146.1",
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: false,
        desktop,
        transports: ["websocket"],
        maxSessions: 4,
      },
      startedAt: new Date().toISOString(),
    });
  }
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "primary-worker",
    ...protectedProjectFields(),
    repositoryId: "remote-desktop-fleet-api",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "primary-worker",
    {
      path: path.join(dataDirectory, "project"),
      displayPath: path.join(dataDirectory, "project"),
      reused: false,
      updated: false,
      warning: null,
    },
  );
  await database.repository.createRemoteDesktop(
    LOCAL_USER_ID,
    projectId,
    "existing-desktop",
    protectedDisplayLabelFields("project-view").titleProtection,
    "healthy-worker",
    protectedRemoteDesktopState(),
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("Remote Desktop fleet API", () => {
  it("returns healthy inventories beside independent offline and timeout states", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/remote-desktop-fleet`,
    });
    expect(response.statusCode).toBe(200);
    const fleet = remoteDesktopFleetWireSchema.parse(response.json());
    expect(fleet).toMatchObject({ projectId, partial: true, truncated: false });
    expect(
      fleet.workers.find(({ workerId }) => workerId === "healthy-worker"),
    ).toMatchObject({
      workerName: "Healthy Linux",
      status: "ok",
      inventoryOperationId: expect.any(String),
      inventoryProtection: expect.objectContaining({
        classification: { recordKind: "remote-desktop-inventory" },
      }),
      monitorCount: 1,
      windowCount: 1,
      desktops: [
        expect.objectContaining({
          id: "existing-desktop",
          workerId: "healthy-worker",
        }),
      ],
      error: null,
    });
    expect(
      fleet.workers.find(({ workerId }) => workerId === "offline-worker"),
    ).toMatchObject({
      status: "offline",
      inventoryOperationId: null,
      inventoryProtection: null,
      error: { code: "worker-offline" },
    });
    expect(
      fleet.workers.find(({ workerId }) => workerId === "failing-worker"),
    ).toMatchObject({
      status: "timed-out",
      error: { code: "worker-timeout" },
    });
    expect(
      fleet.workers.some(({ workerId }) => workerId === "unsupported-worker"),
    ).toBe(false);
    expect(requested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workerId: "primary-worker",
          command: expect.objectContaining({
            type: "surface.desktop.targets",
            resourceId: "primary-worker",
          }),
        }),
        expect.objectContaining({
          workerId: "healthy-worker",
          command: expect.objectContaining({
            type: "surface.desktop.targets",
            resourceId: "healthy-worker",
          }),
        }),
      ]),
    );
    expect(
      requested.some(({ workerId }) => workerId === "offline-worker"),
    ).toBe(false);
  });

  it("creates a worker-specific stream with an opaque selected target", async () => {
    const protectedFields = protectedRemoteDesktopFields();
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/remote-desktops`,
      payload: {
        ...protectedFields,
        target: { kind: "worker", projectId, workerId: "healthy-worker" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(remoteDesktopWireSummarySchema.parse(response.json())).toMatchObject(
      {
        projectId,
        workerId: "healthy-worker",
        stateRevision: 1,
        stateProtection: protectedFields.stateProtection,
      },
    );
    createdDesktopId = (response.json() as { id: string }).id;
    expect(response.body).not.toContain("Studio Display");
    expect(response.body).not.toContain("Cantrip");
    expect(requested.at(-1)).toEqual({
      workerId: "healthy-worker",
      command: { type: "surface.desktop.probe" },
    });
  });

  it("updates the active target with only revisioned ciphertext and rejects stale writes", async () => {
    const stateProtection = protectedRemoteDesktopState();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/remote-desktops/${createdDesktopId}`,
      payload: { expectedStateRevision: 1, stateProtection },
    });
    expect(response.statusCode).toBe(200);
    expect(remoteDesktopWireSummarySchema.parse(response.json())).toMatchObject(
      {
        id: createdDesktopId,
        stateProtection,
        stateRevision: 2,
      },
    );
    expect(requested.at(-1)).toEqual({
      workerId: "healthy-worker",
      command: {
        type: "surface.configure",
        surfaceId: createdDesktopId,
        serverId: expect.any(String),
        configuration: { kind: "desktop" },
        stateResource: "remote-desktop-row",
        stateRevision: 2,
        stateProtection,
      },
    });
    expect(JSON.stringify(requested.at(-1))).not.toContain("window-1");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/remote-desktops/${createdDesktopId}`,
          payload: { expectedStateRevision: 1, stateProtection },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/remote-desktops/${createdDesktopId}`,
          payload: {
            target: {
              kind: "window",
              id: "private-window",
              application: "Private App",
              title: "Private Window",
            },
          },
        })
      ).statusCode,
    ).toBe(400);
  });
});
