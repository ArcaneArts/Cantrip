import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  effectivePolicyWireListSchema,
  policyAssignmentWireListSchema,
  policyTemplateDetailSchema,
  policyTemplateListSchema,
  policyWireDetailSchema,
  policyWireListSchema,
} from "@cantrip/protocol/policies";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

import { opaquePolicyCreate } from "./policy-encryption-fixture.js";
import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(path.join(tmpdir(), "cantrip-policy-api-"));
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

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;

beforeAll(async () => {
  database = await connectDatabase(config);
  app = await buildApp({ config, database, logger: false });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("opaque policy API", () => {
  it("keeps public templates separate from client-encrypted account policies", async () => {
    const templatesResponse = await app.inject({
      method: "GET",
      url: "/api/policy-templates",
    });
    const templates = policyTemplateListSchema.parse(templatesResponse.json());
    expect(templates).toHaveLength(1);
    expect(
      templates.find(
        ({ templateKey }) => templateKey === "manual-change-protocol",
      )?.suggestedDefault,
    ).toBe(false);
    expect(templates[0]).not.toHaveProperty("bodyMarkdown");
    const templateResponse = await app.inject({
      method: "GET",
      url: "/api/policy-templates/manual-change-protocol",
    });
    expect(
      policyTemplateDetailSchema.parse(templateResponse.json()).bodyMarkdown,
    ).toContain("## Delivery requirements");

    const empty = policyWireListSchema.parse(
      (await app.inject({ method: "GET", url: "/api/policies" })).json(),
    );
    expect(empty).toMatchObject({ bootstrapVersion: 0, policies: [] });
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/policies/bootstrap",
      payload: {
        expectedBootstrapVersion: 0,
        policies: [],
      },
    });
    expect(bootstrap.statusCode).toBe(200);
    const bootstrapped = policyWireListSchema.parse(bootstrap.json());
    expect(bootstrapped).toMatchObject({ bootstrapVersion: 2 });
    expect(bootstrapped.policies).toHaveLength(0);
    expect(JSON.stringify(bootstrapped)).not.toContain(
      "Manual Change Protocol",
    );
  });

  it("creates, edits, orders, assigns, and returns only opaque records", async () => {
    const input = opaquePolicyCreate("api-custom", { mandatory: true });
    const create = await app.inject({
      method: "POST",
      url: "/api/policies",
      payload: input,
    });
    expect(create.statusCode).toBe(201);
    const created = policyWireDetailSchema.parse(create.json());
    expect(created.content).toEqual(input.content);
    expect(created).not.toHaveProperty("name");
    expect(created).not.toHaveProperty("bodyMarkdown");

    const replacement = opaquePolicyCreate("api-custom-updated");
    const update = await app.inject({
      method: "PATCH",
      url: `/api/policies/${created.id}`,
      payload: {
        rowVersion: created.rowVersion,
        content: {
          protectedSummary: replacement.content.protectedSummary,
          protectedBody: replacement.content.protectedBody,
        },
        mandatory: false,
      },
    });
    expect(update.statusCode).toBe(200);
    const updated = policyWireDetailSchema.parse(update.json());
    expect(updated).toMatchObject({ rowVersion: 2, mandatory: false });
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/policies/${created.id}`,
      payload: { rowVersion: created.rowVersion, enabled: false },
    });
    expect(stale.statusCode).toBe(409);

    const current = policyWireListSchema.parse(
      (await app.inject({ method: "GET", url: "/api/policies" })).json(),
    );
    const reversed = current.policies.map(({ id }) => id).reverse();
    const order = await app.inject({
      method: "PATCH",
      url: "/api/policies/order",
      payload: {
        collectionVersion: current.collectionVersion,
        policyIds: reversed,
      },
    });
    expect(
      policyWireListSchema.parse(order.json()).policies.map(({ id }) => id),
    ).toEqual(reversed);

    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "policy-api-worker",
      name: "Policy API worker",
      platform: "linux",
      architecture: "x64",
      codexVersion: "0.149.0",
      codexRuntime: unprobedCodexRuntimeReport,
      startedAt: new Date().toISOString(),
    });
    const project = await database.repository.createGithubProject(
      LOCAL_USER_ID,
      {
        workerId: "policy-api-worker",
        ...protectedProjectFields(),
        repositoryBlindIndex: Buffer.alloc(32, 29).toString("base64url"),
        repositoryId: "policy-api-project",
        nameWithOwner: "ArcaneArts/PolicyApiProject",
        url: "https://github.com/ArcaneArts/PolicyApiProject",
      },
    );
    const assignmentState = policyAssignmentWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/policies`,
        })
      ).json(),
    );
    const assignment = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/policies`,
      payload: {
        collectionVersion: assignmentState.collectionVersion,
        policyIds: [created.id],
      },
    });
    expect(
      policyAssignmentWireListSchema.parse(assignment.json()).directPolicyIds,
    ).toEqual([created.id]);
    const effective = effectivePolicyWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/effective-policies`,
        })
      ).json(),
    );
    expect(
      effective.policies.find(({ id }) => id === created.id)?.sources,
    ).toEqual([{ type: "project", projectId: project.id }]);
    expect(effective.policies[0]).not.toHaveProperty("summary");
  });
});
