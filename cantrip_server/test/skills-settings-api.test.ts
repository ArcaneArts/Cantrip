import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  protectedCustomizationRequestSchema,
  protectedCustomizationResponseSchema,
  unprobedCodexRuntimeReport,
  type CustomizationContentOperation,
  type CustomizationContentScope,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(path.join(tmpdir(), "cantrip-skills-api-"));
const projectPath = path.join(dataDirectory, "project");
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

const protectedCustomizationContent = {
  formatVersion: 1 as const,
  keyRevision: 1,
  domain: "customization-content" as const,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

function protectedResponse(
  operationId: string,
  operation: CustomizationContentOperation,
  scope: CustomizationContentScope,
) {
  return protectedCustomizationResponseSchema.parse({
    operationId,
    operation,
    scope,
    result: "succeeded",
    lifecycle: null,
    protectedResponse: protectedCustomizationContent,
  });
}

function protectedRequest(
  operationId: string,
  operation: CustomizationContentOperation,
  scope: CustomizationContentScope,
) {
  return protectedCustomizationRequestSchema.parse({
    operationId,
    operation,
    scope,
    protectedRequest: protectedCustomizationContent,
  });
}

const commands: WorkerCommand[] = [];
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return workerId === "test-worker";
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
  async request(_workerId, command) {
    commands.push(command);
    if (command.type.startsWith("skills.settings.")) {
      return protectedResponse(
        command.operationId,
        command.type,
        command.scope,
      );
    }
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let providerId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "test-worker",
    name: "Test Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "test-worker",
    ...protectedProjectFields(),
    repositoryBlindIndex: "A".repeat(43),
    repositoryId: "skills-settings-api",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    project.id,
    "test-worker",
    {
      path: projectPath,
      displayPath: projectPath,
      reused: false,
      updated: false,
      warning: null,
    },
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
  providerId = (await database.repository.getSettings(LOCAL_USER_ID))
    .providers[0]!.id;
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("skills settings API", () => {
  it("lists project and global skills through the owning worker", async () => {
    const operationId = crypto.randomUUID();
    const response = await app.inject({
      method: "GET",
      url: `/api/skills?workerId=test-worker&providerId=${providerId}&projectId=${projectId}&operationId=${operationId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(
      protectedCustomizationResponseSchema.parse(response.json()),
    ).toMatchObject({ operationId, operation: "skills.settings.list" });
    expect(commands.at(-1)).toMatchObject({
      type: "skills.settings.list",
      cwd: projectPath,
      providerId,
    });
  });

  it("reads and updates a selected skill file", async () => {
    const scope = {
      workerId: "test-worker",
      providerId,
      projectId,
      chatId: null,
    };
    const readOperationId = crypto.randomUUID();
    const readResponse = await app.inject({
      method: "POST",
      url: "/api/skills/read",
      payload: protectedRequest(readOperationId, "skills.settings.read", scope),
    });
    expect(readResponse.statusCode).toBe(200);
    expect(
      protectedCustomizationResponseSchema.parse(readResponse.json()),
    ).toMatchObject({
      operationId: readOperationId,
      operation: "skills.settings.read",
    });

    const writeOperationId = crypto.randomUUID();
    const writeResponse = await app.inject({
      method: "PUT",
      url: "/api/skills/file",
      payload: protectedRequest(
        writeOperationId,
        "skills.settings.write",
        scope,
      ),
    });
    expect(writeResponse.statusCode).toBe(200);
    expect(commands.at(-1)).toMatchObject({
      type: "skills.settings.write",
      cwd: projectPath,
      protectedRequest: protectedCustomizationContent,
    });
  });

  it("deletes through the recovery-aware worker command", async () => {
    const operationId = crypto.randomUUID();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/skills",
      payload: protectedRequest(operationId, "skills.settings.delete", {
        workerId: "test-worker",
        providerId,
        projectId,
        chatId: null,
      }),
    });
    expect(response.statusCode).toBe(200);
    expect(
      protectedCustomizationResponseSchema.parse(response.json()),
    ).toMatchObject({ operationId, operation: "skills.settings.delete" });
  });

  it("rejects a worker that does not own the project", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/skills?workerId=other-worker&providerId=${providerId}&projectId=${projectId}&operationId=${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(409);
  });
});
