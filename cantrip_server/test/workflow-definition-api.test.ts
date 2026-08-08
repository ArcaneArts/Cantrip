import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  workflowDefinitionCreateSchema,
  workflowDefinitionDetailSchema,
  workflowDefinitionListSchema,
  workflowDefinitionSummarySchema,
  workflowRevisionListSchema,
  workflowRevisionSchema,
} from "@cantrip/protocol/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-workflow-api-"),
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

function graph(reviewName = "Apply review") {
  return {
    version: 1 as const,
    nodes: [
      {
        key: "inspect",
        type: "agent" as const,
        name: "Inspect",
        configuration: { prompt: "Inspect the project." },
      },
      {
        key: "apply",
        type: "agent" as const,
        name: reviewName,
        configuration: { prompt: "Apply the review." },
        mutationMode: "write" as const,
        permissionRequirements: {
          filesystem: "workspace-write" as const,
        },
      },
    ],
    edges: [{ from: "inspect", to: "apply" }],
  };
}

let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
let personalWorkflowId: string;
let initialRevisionHash: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "test-worker",
    repositoryId: "workflow-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  app = await buildApp({ config, database, logger: false });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("workflow definition API", () => {
  it("atomically creates and reads a normalized immutable definition", async () => {
    const provenance = {
      origin: "claude-code" as const,
      sourceId: "commands/review.md",
      metadata: { importer: "claude-bridge" },
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: {
        scope: "personal",
        slug: "review-change",
        name: "Review change",
        description: "Inspect and apply a review.",
        source: "imported",
        provenance,
        revision: {
          graph: graph(),
          declaredInputs: { type: "object" },
          declaredOutputs: { type: "object" },
          source: "imported",
          provenance,
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const created = workflowDefinitionDetailSchema.parse(response.json());
    personalWorkflowId = created.workflow.id;
    initialRevisionHash = created.revision!.contentHash;
    expect(created.workflow).toMatchObject({
      projectId: null,
      scope: "personal",
      slug: "review-change",
      source: "imported",
      latestRevision: { revision: 1 },
    });
    expect(created.revision).toMatchObject({
      revision: 1,
      graph: { version: 1 },
      nodes: [
        { key: "inspect", position: 0, mutationMode: "read-only" },
        { key: "apply", position: 1, mutationMode: "write" },
      ],
      edges: [{ from: "inspect", to: "apply", position: 0 }],
    });

    const loaded = workflowDefinitionDetailSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflows/${personalWorkflowId}`,
        })
      ).json(),
    );
    expect(loaded).toEqual(created);
  });

  it("guards scope ownership, duplicate slugs, and malformed DAGs", async () => {
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: {
        scope: "personal",
        slug: "review-change",
        name: "Duplicate",
        revision: { graph: graph() },
      },
    });
    expect(duplicate).toMatchObject({ statusCode: 409 });

    const missingProject = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: {
        scope: "project",
        projectId: "missing-project",
        slug: "missing-project",
        name: "Missing project",
        revision: { graph: graph() },
      },
    });
    expect(missingProject).toMatchObject({ statusCode: 404 });

    const cyclic = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: {
        scope: "personal",
        slug: "cyclic",
        name: "Cyclic",
        revision: {
          graph: {
            ...graph(),
            edges: [
              { from: "inspect", to: "apply" },
              { from: "apply", to: "inspect" },
            ],
          },
        },
      },
    });
    expect(cyclic).toMatchObject({ statusCode: 400 });
  });

  it("filters project workflows and archives metadata without rewriting history", async () => {
    const created = workflowDefinitionDetailSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/workflows",
          payload: {
            scope: "project",
            projectId,
            slug: "project-audit",
            name: "Project audit",
            trustState: "trusted",
            revision: {
              graph: {
                version: 1,
                nodes: [
                  {
                    key: "audit",
                    type: "agent",
                    name: "Audit",
                    configuration: { prompt: "Audit the project." },
                  },
                ],
              },
              trustState: "trusted",
            },
          },
        })
      ).json(),
    );
    const projectList = workflowDefinitionListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflows?scope=project&projectId=${projectId}`,
        })
      ).json(),
    );
    expect(projectList.map(({ id }) => id)).toEqual([created.workflow.id]);

    expect(
      await app.inject({
        method: "PATCH",
        url: `/api/workflows/${created.workflow.id}`,
        payload: {},
      }),
    ).toMatchObject({ statusCode: 400 });
    const archived = workflowDefinitionSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/workflows/${created.workflow.id}`,
          payload: {
            name: "Archived project audit",
            trustState: "modified",
            archived: true,
          },
        })
      ).json(),
    );
    expect(archived).toMatchObject({
      name: "Archived project audit",
      trustState: "modified",
      archivedAt: expect.any(String),
      latestRevision: { revision: 1, trustState: "trusted" },
    });

    const active = workflowDefinitionListSchema.parse(
      (await app.inject({ method: "GET", url: "/api/workflows" })).json(),
    );
    expect(active.map(({ id }) => id)).toEqual([personalWorkflowId]);
    const withArchived = workflowDefinitionListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/api/workflows?includeArchived=true",
        })
      ).json(),
    );
    expect(withArchived.map(({ id }) => id).sort()).toEqual(
      [created.workflow.id, personalWorkflowId].sort(),
    );
  });

  it("appends content-addressed revisions and deduplicates equivalent JSON", async () => {
    const revisionInput = {
      graph: graph("Apply verified review"),
      source: "generated" as const,
      provenance: {
        origin: "generated" as const,
        sourceId: "generation-1",
        metadata: { model: "gpt-5.6-sol", prompt: "review" },
      },
      trustState: "untrusted" as const,
    };
    const first = workflowRevisionSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/workflows/${personalWorkflowId}/revisions`,
          payload: revisionInput,
        })
      ).json(),
    );
    expect(first).toMatchObject({ revision: 2, source: "generated" });
    expect(first.contentHash).not.toBe(initialRevisionHash);

    const duplicate = workflowRevisionSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/workflows/${personalWorkflowId}/revisions`,
          payload: {
            ...revisionInput,
            provenance: {
              ...revisionInput.provenance,
              metadata: { prompt: "review", model: "gpt-5.6-sol" },
            },
          },
        })
      ).json(),
    );
    expect(duplicate.id).toBe(first.id);

    const revisions = workflowRevisionListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflows/${personalWorkflowId}/revisions`,
        })
      ).json(),
    );
    expect(revisions.map(({ revision }) => revision)).toEqual([2, 1]);
    expect(
      workflowRevisionSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/workflows/${personalWorkflowId}/revisions/2`,
          })
        ).json(),
      ).id,
    ).toBe(first.id);
    expect(
      await app.inject({
        method: "GET",
        url: `/api/workflows/${personalWorkflowId}/revisions/1.5`,
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await app.inject({
        method: "GET",
        url: `/api/workflows/${personalWorkflowId}/revisions/99`,
      }),
    ).toMatchObject({ statusCode: 404 });
  });

  it("persists normalized constrained orchestration primitives", async () => {
    const nodes = [
      {
        key: "map-items",
        type: "map" as const,
        name: "Map items",
        configuration: {
          prompt: "Inspect this item.",
          collectionPath: "/items",
          maxConcurrency: 3,
        },
      },
      {
        key: "pipeline-items",
        type: "pipeline" as const,
        name: "Pipeline items",
        configuration: {
          collectionPath: "/items",
          maxConcurrency: 2,
          steps: [
            { key: "inspect", name: "Inspect", prompt: "Inspect the item." },
            { key: "review", name: "Review", prompt: "Review the item." },
          ],
        },
      },
      {
        key: "reduce-findings",
        type: "reduce" as const,
        name: "Reduce findings",
        configuration: { prompt: "Synthesize the findings." },
      },
      {
        key: "verify-result",
        type: "verify" as const,
        name: "Verify result",
        configuration: {
          prompt: "Verify the synthesis.",
          passCondition: {
            path: "/passed",
            operator: "equals" as const,
            value: true,
          },
        },
      },
      {
        key: "choose-path",
        type: "condition" as const,
        name: "Choose path",
        configuration: {},
      },
      {
        key: "improve-result",
        type: "repeatUntil" as const,
        name: "Improve result",
        configuration: {
          prompt: "Improve the synthesis.",
          successCondition: {
            path: "/score",
            operator: "greater-than-or-equals" as const,
            value: 0.9,
          },
          progressPath: "/score",
          maxUnchangedIterations: 2,
          maxIterations: 5,
          maxDurationMs: 60_000,
        },
      },
      {
        key: "approve-result",
        type: "gate" as const,
        name: "Approve result",
        configuration: { prompt: "Approve the synthesized result?" },
      },
    ];
    const edges = [
      { from: "map-items", to: "pipeline-items" },
      { from: "pipeline-items", to: "reduce-findings" },
      { from: "reduce-findings", to: "verify-result" },
      { from: "verify-result", to: "choose-path" },
      {
        from: "choose-path",
        to: "improve-result",
        condition: {
          path: "/passed",
          operator: "equals" as const,
          value: false,
        },
      },
      { from: "choose-path", to: "approve-result" },
    ];
    const response = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: {
        scope: "personal",
        slug: "orchestration-primitives",
        name: "Orchestration primitives",
        revision: { graph: { version: 1, nodes, edges } },
      },
    });
    expect(response.statusCode).toBe(201);
    const created = workflowDefinitionDetailSchema.parse(response.json());
    expect(created.revision?.nodes.map(({ type }) => type)).toEqual([
      "map",
      "pipeline",
      "reduce",
      "verify",
      "condition",
      "repeatUntil",
      "gate",
    ]);
    expect(created.revision?.nodes).toMatchObject([
      {
        configuration: {
          itemInputKey: "item",
          failurePolicy: "fail-fast",
        },
      },
      { configuration: { itemInputKey: "item" } },
      { configuration: { emptyCollection: "fail" } },
      { configuration: { failurePolicy: "fail-run" } },
      { configuration: { requireMatch: true } },
      { configuration: { maxIterations: 5 } },
      { configuration: { denialPolicy: "fail-run", expiresAfterMs: null } },
    ]);
    expect(
      workflowDefinitionDetailSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/workflows/${created.workflow.id}`,
          })
        ).json(),
      ),
    ).toEqual(created);

    expect(
      await app.inject({
        method: "POST",
        url: "/api/workflows",
        payload: {
          scope: "personal",
          slug: "unbounded-map",
          name: "Unbounded map",
          revision: {
            graph: {
              version: 1,
              nodes: [
                {
                  key: "map-items",
                  type: "map",
                  name: "Map items",
                  configuration: { prompt: "Inspect this item." },
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({ statusCode: 400 });
  });

  it("enforces owner boundaries in repository reads and writes", async () => {
    expect(
      await database.repository.workflows.getDefinition(
        "different-owner",
        personalWorkflowId,
      ),
    ).toBeNull();
    expect(
      await database.repository.workflows.updateDefinition(
        "different-owner",
        personalWorkflowId,
        { name: "Forbidden" },
      ),
    ).toBeNull();
    expect(
      await database.repository.workflows.createDefinition(
        "different-owner",
        workflowDefinitionCreateSchema.parse({
          scope: "project",
          projectId,
          slug: "foreign-project",
          name: "Foreign project",
          revision: { graph: graph() },
        }),
      ),
    ).toBeNull();
  });

  it("reloads definitions and revision graphs after a server restart", async () => {
    await app.close();
    database = await connectDatabase(config);
    app = await buildApp({ config, database, logger: false });
    const restored = workflowDefinitionDetailSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workflows/${personalWorkflowId}`,
        })
      ).json(),
    );
    expect(restored).toMatchObject({
      workflow: { id: personalWorkflowId, latestRevision: { revision: 2 } },
      revision: {
        revision: 2,
        nodes: [{ key: "inspect" }, { key: "apply" }],
        edges: [{ from: "inspect", to: "apply" }],
      },
    });
  }, 15_000);
});
