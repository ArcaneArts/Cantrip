import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  workflowDefinitionDetailSchema,
  workflowRunDetailSchema,
  workflowRunEventPageSchema,
  workflowRunListSchema,
} from "@cantrip/protocol/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { DEFAULT_MODEL_ROUTE_ID, LOCAL_USER_ID } from "../src/db/repository.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-workflow-run-api-"),
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

const timestamp = "2026-08-08T17:00:00.000Z";
const permissionManifest = {
  filesystem: "workspace-write" as const,
  network: "restricted" as const,
  approvalMode: "interactive" as const,
  skills: ["review"],
  mcpServers: ["github"],
  nativeSubagents: false,
};

function launchPayload(revisionId: string, idempotencyKey: string) {
  return {
    workflowRevisionId: revisionId,
    structuredInput: { target: "src" },
    budget: { maxNodes: 3, maxParallelism: 2 },
    permissionManifest,
    selectedModelRouteId: DEFAULT_MODEL_ROUTE_ID,
    selectedPermissionProfileId: ":workspace",
    trigger: {
      type: "manual" as const,
      actorType: "user" as const,
      actorId: LOCAL_USER_ID,
      deliveredAt: timestamp,
      metadata: { surface: "workflow-api-test" },
    },
    idempotencyKey,
  };
}

let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
let workflowId: string;
let revisionId: string;
let runId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    config.agentModel,
    config.ollamaBaseUrl,
  );
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "test-worker",
    ...protectedProjectFields(),
    repositoryId: "workflow-run-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  app = await buildApp({ config, database, logger: false });

  const definition = workflowDefinitionDetailSchema.parse(
    (
      await app.inject({
        method: "POST",
        url: "/api/workflows",
        payload: {
          scope: "project",
          projectId,
          slug: "verified-change",
          name: "Verified change",
          trustState: "trusted",
          revision: {
            graph: {
              version: 1,
              nodes: [
                {
                  key: "inspect",
                  type: "agent",
                  name: "Inspect",
                  configuration: { prompt: "Inspect the project." },
                  permissionRequirements: {
                    network: "restricted",
                    skills: ["review"],
                  },
                },
                {
                  key: "apply",
                  type: "agent",
                  name: "Apply",
                  configuration: { prompt: "Apply the change." },
                  mutationMode: "write",
                  permissionRequirements: {
                    filesystem: "workspace-write",
                    mcpServers: ["github"],
                  },
                },
                {
                  key: "verify",
                  type: "verify",
                  name: "Verify",
                  configuration: {
                    prompt: "Verify the applied change.",
                    passCondition: {
                      path: "/passed",
                      operator: "equals",
                      value: true,
                    },
                  },
                },
              ],
              edges: [
                { from: "inspect", to: "apply" },
                { from: "apply", to: "verify" },
              ],
            },
            permissionRequirements: permissionManifest,
            trustState: "trusted",
          },
        },
      })
    ).json(),
  );
  workflowId = definition.workflow.id;
  revisionId = definition.revision!.id;
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("workflow run API", () => {
  it("rejects launches that cannot satisfy the immutable revision", async () => {
    expect(
      await app.inject({
        method: "POST",
        url: "/api/workflow-runs",
        payload: {
          ...launchPayload(revisionId, "underprivileged"),
          permissionManifest: { filesystem: "read-only" },
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/workflow-runs",
        payload: {
          ...launchPayload(revisionId, "undersized"),
          budget: { maxNodes: 2 },
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/workflow-runs",
        payload: {
          ...launchPayload(revisionId, "missing-route"),
          selectedModelRouteId: "missing-route",
        },
      }),
    ).toMatchObject({ statusCode: 409 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/workflow-runs",
        payload: launchPayload("missing-revision", "missing-revision"),
      }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/workflow-runs",
        payload: {
          ...launchPayload(revisionId, "wrong-project"),
          projectId: "different-project",
        },
      }),
    ).toMatchObject({ statusCode: 404 });
  });

  it("atomically materializes roots, blocked dependencies, and provenance", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow-runs",
      payload: launchPayload(revisionId, "launch-1"),
    });
    expect(response.statusCode).toBe(201);
    const detail = workflowRunDetailSchema.parse(response.json());
    runId = detail.run.id;
    expect(detail.run).toMatchObject({
      workflowId,
      workflowRevisionId: revisionId,
      projectId,
      status: "queued",
      recoveryState: "stable",
      selectedModelRouteId: DEFAULT_MODEL_ROUTE_ID,
    });
    expect(detail.nodes).toMatchObject([
      {
        nodeKey: "inspect",
        status: "ready",
        dependencyState: { remaining: 0 },
        structuredInput: { target: "src" },
        writeCapable: false,
        modelRouteId: DEFAULT_MODEL_ROUTE_ID,
      },
      {
        nodeKey: "apply",
        status: "blocked",
        dependencyState: { remaining: 1 },
        structuredInput: {},
        writeCapable: true,
      },
      {
        nodeKey: "verify",
        status: "blocked",
        dependencyState: { remaining: 1 },
        structuredInput: {},
        writeCapable: false,
      },
    ]);
    expect(detail.dependencies).toHaveLength(2);
    expect(
      detail.dependencies.every(({ status }) => status === "blocked"),
    ).toBe(true);
    expect(detail.attempts).toEqual([]);
    expect(detail.gates).toEqual([]);

    const events = workflowRunEventPageSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflow-runs/${runId}/events`,
        })
      ).json(),
    );
    expect(events).toMatchObject({
      events: [
        {
          sequence: 0,
          type: "run.created",
          actorType: "user",
          payload: { nodeCount: 3, readyNodeCount: 1 },
        },
      ],
      nextSequence: null,
    });
  });

  it("returns exact idempotent retries and rejects key reuse drift", async () => {
    const retry = await app.inject({
      method: "POST",
      url: "/api/workflow-runs",
      payload: launchPayload(revisionId, "launch-1"),
    });
    expect(retry.statusCode).toBe(200);
    expect(workflowRunDetailSchema.parse(retry.json()).run.id).toBe(runId);

    expect(
      await app.inject({
        method: "POST",
        url: "/api/workflow-runs",
        payload: {
          ...launchPayload(revisionId, "launch-1"),
          structuredInput: { target: "tests" },
        },
      }),
    ).toMatchObject({ statusCode: 409 });
  });

  it("lists and reloads materialized run state through owner-scoped APIs", async () => {
    const listed = workflowRunListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflow-runs?workflowId=${workflowId}&projectId=${projectId}&status=queued`,
        })
      ).json(),
    );
    expect(listed.map(({ id }) => id)).toEqual([runId]);
    expect(
      workflowRunDetailSchema
        .parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/workflow-runs/${runId}`,
            })
          ).json(),
        )
        .nodes.map(({ nodeKey }) => nodeKey),
    ).toEqual(["inspect", "apply", "verify"]);
    expect(
      await app.inject({
        method: "GET",
        url: "/api/workflow-runs/missing-run",
      }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await app.inject({
        method: "POST",
        url: `/api/workflow-runs/${runId}/save-revision`,
        payload: {},
      }),
    ).toMatchObject({ statusCode: 409 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/workflow-runs/missing-run/save-revision",
        payload: {},
      }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      workflowRunEventPageSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/workflow-runs/${runId}/events?afterSequence=0`,
          })
        ).json(),
      ),
    ).toEqual({ events: [], nextSequence: null });
  });

  it("blocks new launches after trust changes without breaking exact retries", async () => {
    expect(
      await app.inject({
        method: "PATCH",
        url: `/api/workflows/${workflowId}`,
        payload: { trustState: "blocked" },
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/workflow-runs",
        payload: launchPayload(revisionId, "blocked-launch"),
      }),
    ).toMatchObject({ statusCode: 409 });
    const retry = await app.inject({
      method: "POST",
      url: "/api/workflow-runs",
      payload: launchPayload(revisionId, "launch-1"),
    });
    expect(retry.statusCode).toBe(200);
    expect(workflowRunDetailSchema.parse(retry.json()).run.id).toBe(runId);
  });

  it("enforces owner boundaries for run details and event streams", async () => {
    expect(
      await database.repository.workflowRuns.getRun("different-owner", runId),
    ).toBeNull();
    expect(
      await database.repository.workflowRuns.listEvents(
        "different-owner",
        runId,
        { afterSequence: -1, limit: 200 },
      ),
    ).toBeNull();
  });

  it("reloads the materialized run graph after a server restart", async () => {
    await app.close();
    database = await connectDatabase(config);
    app = await buildApp({ config, database, logger: false });
    const restored = workflowRunDetailSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflow-runs/${runId}`,
        })
      ).json(),
    );
    expect(restored).toMatchObject({
      run: { id: runId, status: "queued", projectId },
      nodes: [
        { nodeKey: "inspect", status: "ready" },
        { nodeKey: "apply", status: "blocked" },
        { nodeKey: "verify", status: "blocked" },
      ],
      dependencies: [{ status: "blocked" }, { status: "blocked" }],
    });
  }, 15_000);
});
