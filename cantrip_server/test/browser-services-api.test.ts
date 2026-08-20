import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  browserServiceFleetDiscoverySchema,
  browserServiceListSchema,
  browserSummarySchema,
  cantripVersionSchema,
  tunnelAttachmentCreateResultSchema,
  tunnelSummarySchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import { cantripVersion } from "@cantrip/version";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-browser-services-api-"),
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

const services = browserServiceListSchema.parse([
  {
    workerId: "test-worker",
    host: "127.0.0.1",
    port: 5173,
    protocol: "http",
    url: "http://127.0.0.1:5173/",
    title: "Cantrip Dev",
    processName: "Vite",
    statusCode: 200,
  },
]);
const commands: WorkerCommand[] = [];
const requestedWorkers: string[] = [];
const connectedWorkers = new Set([
  "test-worker",
  "healthy-worker",
  "failing-worker",
]);
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
    commands.push(command);
    requestedWorkers.push(workerId);
    if (command.type === "browser.services.discover") {
      if (workerId === "failing-worker") {
        throw new Error("Worker command browser.services.discover timed out.");
      }
      return services.map((service) => ({
        ...service,
        port: workerId === "healthy-worker" ? 8080 : service.port,
        title:
          workerId === "healthy-worker" ? "Healthy Service" : service.title,
        url:
          workerId === "healthy-worker"
            ? "http://127.0.0.1:8080/"
            : service.url,
        workerId: "untrusted-worker-claim",
      }));
    }
    if (command.type === "worker.version") return cantripVersion;
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let browserId: string;
let browserTunnelId: string;
let projectId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "test-worker",
    name: "Test Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: true,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "secondary-worker",
    name: "Secondary Worker",
    platform: "linux",
    architecture: "x64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  for (const [workerId, name] of [
    ["healthy-worker", "Healthy Worker"],
    ["offline-worker", "Offline Worker"],
    ["failing-worker", "Failing Worker"],
  ] as const) {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId,
      name,
      platform: "linux",
      architecture: "x64",
      codexVersion: "0.146.1",
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: true,
        transports: ["websocket"],
        maxSessions: 2,
      },
      startedAt: new Date().toISOString(),
    });
  }
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "test-worker",
    ...protectedProjectFields(),
    repositoryId: "browser-services-api",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    project.id,
    "test-worker",
    {
      path: path.join(dataDirectory, "project"),
      displayPath: path.join(dataDirectory, "project"),
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const browser = await database.repository.createBrowser(
    LOCAL_USER_ID,
    project.id,
    {
      title: "Browser",
      target: {
        kind: "worker",
        projectId: project.id,
        workerId: "test-worker",
      },
    },
  );
  if (!browser) throw new Error("Expected test browser creation to succeed.");
  browserId = browser.id;
  app = await buildApp({ config, database, logger: false, workerBridge });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("browser service discovery API", () => {
  it("reports the embedded server and worker versions", async () => {
    const serverResponse = await app.inject({ method: "GET", url: "/version" });
    const workerResponse = await app.inject({
      method: "GET",
      url: "/api/workers/test-worker/version",
    });
    const bootstrapResponse = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
    });

    expect(serverResponse.statusCode).toBe(200);
    expect(cantripVersionSchema.parse(serverResponse.json())).toEqual(
      cantripVersion,
    );
    expect(workerResponse.statusCode).toBe(200);
    expect(cantripVersionSchema.parse(workerResponse.json())).toEqual(
      cantripVersion,
    );
    expect(commands.at(-1)).toEqual({ type: "worker.version" });
    expect(bootstrapResponse.json().server.version).toEqual(cantripVersion);
  });

  it("routes discovery through the browser's owning worker", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/browsers/${browserId}/services`,
    });

    expect(response.statusCode).toBe(200);
    expect(browserServiceListSchema.parse(response.json())).toEqual(services);
    expect(commands.at(-1)).toEqual({ type: "browser.services.discover" });
  });

  it("returns healthy fleet results alongside bounded per-worker failures", async () => {
    requestedWorkers.length = 0;
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/browser-services`,
    });

    expect(response.statusCode).toBe(200);
    const fleet = browserServiceFleetDiscoverySchema.parse(response.json());
    expect(fleet).toMatchObject({
      projectId,
      partial: true,
      truncated: false,
    });
    expect(
      fleet.workers.find(({ workerId }) => workerId === "healthy-worker"),
    ).toMatchObject({
      status: "ok",
      error: null,
      services: [
        {
          workerId: "healthy-worker",
          workerName: "Healthy Worker",
          port: 8080,
          placement: {
            projectId,
            workerId: "healthy-worker",
            projectReplicaId: null,
            worktreeId: null,
          },
        },
      ],
    });
    expect(
      fleet.workers.find(({ workerId }) => workerId === "offline-worker"),
    ).toMatchObject({
      status: "offline",
      services: [],
      error: { code: "worker-offline" },
    });
    expect(
      fleet.workers.find(({ workerId }) => workerId === "failing-worker"),
    ).toMatchObject({
      status: "timed-out",
      services: [],
      error: { code: "worker-timeout" },
    });
    expect(requestedWorkers).toEqual(
      expect.arrayContaining([
        "test-worker",
        "healthy-worker",
        "failing-worker",
      ]),
    );
    expect(requestedWorkers).not.toContain("offline-worker");
    expect(requestedWorkers).not.toContain("secondary-worker");
  });

  it("creates a discovered-service Browser pinned to its worker", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browsers`,
      payload: {
        title: "Healthy Service",
        url: "http://127.0.0.1:8080/",
        target: {
          kind: "worker",
          projectId,
          workerId: "healthy-worker",
        },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(browserSummarySchema.parse(response.json())).toMatchObject({
      title: "Healthy Service",
      url: "http://127.0.0.1:8080/",
      workerId: "healthy-worker",
    });
  });

  it("creates an attachable managed tunnel using the Browser surface worker", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/browsers/${browserId}/tunnel`,
      payload: { url: "http://localhost:5173/app?mode=dev#ready" },
    });

    expect(response.statusCode).toBe(200);
    const tunnel = tunnelSummarySchema.parse(response.json());
    browserTunnelId = tunnel.id;
    expect(tunnel).toMatchObject({
      projectId: expect.any(String),
      origin: "browser",
      management: "managed-ephemeral",
      protocolHint: "http-websocket",
      source: { kind: "desktop-loopback" },
      destination: {
        kind: "worker-tcp",
        workerId: "test-worker",
        host: "localhost",
        port: 5173,
      },
      managedBy: { kind: "browser", id: browserId },
      capabilities: {
        canEdit: false,
        canDelete: false,
        canAttach: true,
        canOpenOwner: true,
      },
    });

    const attachmentResponse = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnel.id}/attachments`,
      payload: { clientId: "browser-desktop" },
    });
    expect(attachmentResponse.statusCode).toBe(201);
    const attachment = tunnelAttachmentCreateResultSchema.parse(
      attachmentResponse.json(),
    );

    const sameTarget = await app.inject({
      method: "POST",
      url: `/api/browsers/${browserId}/tunnel`,
      payload: {
        url: "http://localhost:5173/another-path",
        workerId: "test-worker",
      },
    });
    expect(tunnelSummarySchema.parse(sameTarget.json()).id).toBe(tunnel.id);

    const retarget = await app.inject({
      method: "POST",
      url: `/api/browsers/${browserId}/tunnel`,
      payload: { url: "https://127.0.0.1:8443/stream" },
    });
    const retargeted = tunnelSummarySchema.parse(retarget.json());
    expect(retargeted).toMatchObject({
      id: tunnel.id,
      protocolHint: "https-websocket",
      destination: { workerId: "test-worker", port: 8443 },
    });
    expect(
      retargeted.attachments.find(({ id }) => id === attachment.attachmentId)
        ?.status,
    ).toBe("stopped");

    const explicitWorker = await app.inject({
      method: "POST",
      url: `/api/browsers/${browserId}/tunnel`,
      payload: {
        url: "http://127.0.0.1:3000/",
        workerId: "secondary-worker",
      },
    });
    expect(tunnelSummarySchema.parse(explicitWorker.json())).toMatchObject({
      id: tunnel.id,
      projectId: tunnel.projectId,
      status: "offline",
      destination: {
        kind: "worker-tcp",
        workerId: "secondary-worker",
        port: 3000,
      },
    });
  });

  it("rejects non-loopback and credentialed Browser tunnel targets", async () => {
    const external = await app.inject({
      method: "POST",
      url: `/api/browsers/${browserId}/tunnel`,
      payload: { url: "https://example.com/" },
    });
    const credentialed = await app.inject({
      method: "POST",
      url: `/api/browsers/${browserId}/tunnel`,
      payload: { url: "http://user:password@localhost:5173/" },
    });
    expect(external.statusCode).toBe(400);
    expect(credentialed.statusCode).toBe(400);
  });

  it("reports an offline project worker", async () => {
    connectedWorkers.delete("test-worker");
    const response = await app.inject({
      method: "GET",
      url: `/api/browsers/${browserId}/services`,
    });
    connectedWorkers.add("test-worker");

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Project worker is offline." });
  });

  it("does not expose another or missing browser", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/browsers/missing/services",
    });
    expect(response.statusCode).toBe(404);
  });

  it("removes the managed tunnel with its owning Browser tab", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/browsers/${browserId}`,
    });
    expect(response.statusCode).toBe(204);
    expect(
      await database.repository.getTunnel(LOCAL_USER_ID, browserTunnelId),
    ).toBeNull();
  });
});
