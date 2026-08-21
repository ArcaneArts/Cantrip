import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  encryptedWorkflowDefinitionCreateSchema,
  workflowDefinitionWireDetailSchema,
  workflowDefinitionWireListSchema,
} from "@cantrip/protocol/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-workflow-catalog-encryption-"),
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

function opaque() {
  return {
    formatVersion: 1 as const,
    keyRevision: 1,
    envelope: {
      version: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      nonce: randomBytes(12).toString("base64url"),
      ciphertext: randomBytes(32).toString("base64url"),
    },
  };
}

function workflowPayload() {
  const revisionNodeId = randomUUID();
  return encryptedWorkflowDefinitionCreateSchema.parse({
    id: randomUUID(),
    scope: "personal",
    projectId: null,
    source: "manual",
    trustState: "untrusted",
    slugBlindIndex: randomBytes(32).toString("base64url"),
    content: {
      protectedSlug: opaque(),
      protectedName: opaque(),
      protectedDescription: opaque(),
      protectedProvenance: opaque(),
    },
    revision: {
      id: randomUUID(),
      manifest: {
        version: 1,
        nodes: [
          {
            id: revisionNodeId,
            type: "agent",
            mutationMode: "read-only",
            modelRouteId: null,
            permissionProfileId: null,
          },
        ],
        edges: [],
      },
      source: "manual",
      trustState: "untrusted",
      contentBlindIndex: randomBytes(32).toString("base64url"),
      content: {
        protectedProvenance: opaque(),
        protectedContentHash: opaque(),
        protectedDefinition: opaque(),
      },
    },
  });
}

let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  database = await connectDatabase(config);
  app = await buildApp({ config, database, logger: false });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("workflow catalog encryption boundary", () => {
  it("persists and relays opaque catalog fields while plaintext producers fail closed", async () => {
    const payload = workflowPayload();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload,
    });
    expect(response.statusCode).toBe(201);
    const created = workflowDefinitionWireDetailSchema.parse(response.json());
    expect(created.workflow.content).toEqual(payload.content);
    expect(created.revision?.content).toEqual(payload.revision.content);
    expect(created.revision?.manifest.nodes).toEqual([
      expect.objectContaining(payload.revision.manifest.nodes[0]!),
    ]);

    const loaded = workflowDefinitionWireDetailSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflows/${payload.id}`,
        })
      ).json(),
    );
    expect(loaded).toEqual(created);
    expect(
      workflowDefinitionWireListSchema.parse(
        (await app.inject({ method: "GET", url: "/api/workflows" })).json(),
      )[0]?.content,
    ).toEqual(payload.content);

    expect(
      await app.inject({
        method: "POST",
        url: "/api/workflows",
        payload: {
          scope: "personal",
          slug: "plaintext-is-rejected",
          name: "Plaintext is rejected",
          revision: {
            graph: {
              version: 1,
              nodes: [
                {
                  key: "inspect",
                  type: "agent",
                  name: "Inspect",
                  configuration: { prompt: "Inspect." },
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({ statusCode: 400 });

    for (const [method, url] of [
      ["POST", "/api/chats/chat-one/workflow-generation"],
      ["GET", "/api/projects/project-one/workflow-repository"],
      ["POST", "/api/projects/project-one/workflow-repository/import"],
      ["POST", `/api/workflows/${payload.id}/repository-export`],
      ["POST", "/api/workflow-runs/run-one/save-revision"],
      ["POST", "/api/workflow-runs"],
      ["POST", "/api/workflow-triggers"],
      ["PATCH", "/api/workflow-triggers/trigger-one"],
      ["POST", "/api/workflow-triggers/trigger-one/deliver"],
      ["POST", "/api/workflow-hooks/trigger-one"],
      ["POST", "/api/workflow-triggers/trigger-one/git-event"],
      ["POST", "/api/workflow-triggers/trigger-one/invoke"],
    ] as const) {
      expect(await app.inject({ method, url })).toMatchObject({
        statusCode: 410,
      });
    }
  });
});
