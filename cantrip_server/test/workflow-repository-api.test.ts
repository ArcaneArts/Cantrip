import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import {
  workflowDefinitionDetailSchema,
  workflowRepositoryInventorySchema,
  workflowRepositoryWriteResultSchema,
} from "@cantrip/protocol/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-workflow-repository-api-"),
);
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

const portableDefinition = {
  slug: "claude-review",
  name: "Claude review",
  description: "Review a change.",
  revision: {
    graph: {
      version: 1 as const,
      nodes: [
        {
          key: "review",
          type: "agent" as const,
          name: "Review",
          configuration: { prompt: "Review the change." },
        },
      ],
      edges: [],
    },
  },
};
const inventory = workflowRepositoryInventorySchema.parse({
  convention: ".cantrip/workflows/<slug>.json",
  diagnostics: [],
  items: [
    {
      id: "source-item-1",
      path: ".claude/workflows/review.json",
      source: "claude-code",
      status: "ready",
      diagnostic: null,
      contentHash: "a".repeat(64),
      definition: portableDefinition,
      conversionSource: null,
    },
  ],
});
let writeCommand: Extract<
  WorkerCommand,
  { type: "workflow.repository.write" }
> | null = null;

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
    if (command.type === "workflow.repository.scan") return inventory;
    if (command.type === "workflow.repository.write") {
      writeCommand = command;
      return {
        path: `.cantrip/workflows/${command.document.definition.slug}.json`,
        contentHash: "b".repeat(64),
        changed: true,
      };
    }
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
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
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "test-worker",
    ...protectedProjectFields(),
    repositoryId: "workflow-repository-api",
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
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("workflow repository API", () => {
  let workflowId: string;

  it("previews and imports a reviewed Claude definition as untrusted", async () => {
    const preview = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/workflow-repository`,
    });
    expect(preview.statusCode).toBe(200);
    expect(workflowRepositoryInventorySchema.parse(preview.json())).toEqual(
      inventory,
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/workflow-repository/import`,
      payload: { itemId: "source-item-1" },
    });
    expect(response.statusCode).toBe(201);
    const workflow = workflowDefinitionDetailSchema.parse(response.json());
    workflowId = workflow.workflow.id;
    expect(workflow.workflow).toMatchObject({
      projectId,
      slug: "claude-review",
      source: "imported",
      trustState: "untrusted",
      provenance: {
        origin: "claude-code",
        sourceId: ".claude/workflows/review.json",
        sourceRevision: "a".repeat(64),
      },
    });
  });

  it("rejects slug collisions instead of silently replacing state", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/workflow-repository/import`,
      payload: { itemId: "source-item-1" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("exports the exact project revision through the worker boundary", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/repository-export`,
      payload: { overwrite: false },
    });
    expect(response.statusCode).toBe(200);
    expect(
      workflowRepositoryWriteResultSchema.parse(response.json()),
    ).toMatchObject({
      path: ".cantrip/workflows/claude-review.json",
      changed: true,
    });
    expect(writeCommand).toMatchObject({
      type: "workflow.repository.write",
      cwd: projectPath,
      overwrite: false,
      document: {
        format: "cantrip.workflow",
        version: 1,
        definition: { slug: "claude-review" },
      },
    });
  });
});
